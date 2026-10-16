// @ts-check
// WHICH ACCOUNT WAS THIS SESSION WORKED ON? keyflip does not ask — it infers, from the one
// timeline already on disk that holds no secrets: its own action log of switches (#50).
// `keyflip sessions attribute` prints PROPOSALS; only --apply writes them.
//
// Provenance is the whole design. An inference written into session-accounts.json would be
// indistinguishable from `keyflip sessions assign` — from the USER saying so — and the threads
// screen would present a guess as a fact. So every applied inference is recorded per session in
// <configDir>/session-accounts-source.json (reserved state file, 0600, names + timestamps only,
// never a path list or transcript text), a stated assignment is never overwritten, and a stated
// assignment is never relabelled as inferred.
import fs from 'fs';
import path from 'path';
import * as auditview from './auditview.js';
import * as sessions from './sessions.js';
import * as sessionmap from './sessionmap.js';
import * as profiles from './profiles.js';
import * as fsutil from './fsutil.js';

// Basename WITHOUT the .json suffix, exactly the way profiles.RESERVED_FILES lists it. Exported so
// the cross-module test can pin the registration: a state file that is not reserved shows up in
// `keyflip list`, in the menu and in every account count as a phantom account.
const SOURCE_NAME = 'session-accounts-source';

// Only log messages that prove a switch LANDED. `switch requested -> x` is intent and can fail;
// `provider -> x` is a different axis (which endpoint, not which account); `oauth refresh: x`
// says nothing about identity. `active -> x` is written by core.performSwitch, so from now on
// EVERY path (cli, menu, tui, mcp, fleet, autoswitch) records the boundary — the rest are the
// legacy lines that already exist in real logs and must still be read.
const SWITCH_RES = [
  /^active -> (\S+)/,
  /^switched -> (\S+)/,
  /^mcp switch -> (\S+)/,
  /^mcp next -> (\S+)/,
  /^autoswitch: \S+ -> (\S+)$/,
];

function iso(ms) {
  return new Date(ms).toISOString();
}

function switchName(msg) {
  for (let i = 0; i < SWITCH_RES.length; i++) {
    const m = SWITCH_RES[i].exec(msg);
    if (m) return m[1];
  }
  return null;
}

// ── provenance sidecar ──────────────────────────────────────────────────────────────────────
function sourcePath(ctx) {
  return path.join(ctx.configDir, SOURCE_NAME + '.json');
}

// Whole map, keyed by session id. Same swallow-on-parse rule as sessionmap.read: a corrupt
// provenance file must degrade to "unknown", never crash the threads screen — and never delete
// the assignments themselves, which live in the other file.
function sources(ctx) {
  try {
    const v = JSON.parse(fs.readFileSync(sourcePath(ctx), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeSources(ctx, map) {
  // Atomic + 0600 for the same reason sessionmap does it: read() swallows a torn parse and
  // returns {}, so a half-written file would silently erase every recorded provenance.
  fsutil.atomicWrite(sourcePath(ctx), JSON.stringify(map, null, 2), 0o600);
}

function setSource(ctx, id, rec) {
  const m = sources(ctx);
  m[id] = rec;
  writeSources(ctx, m);
}

function removeSource(ctx, id) {
  const m = sources(ctx);
  if (!(id in m)) return false;
  delete m[id];
  writeSources(ctx, m);
  return true;
}

// Is this session in the assignment map? The map arrives either as the plain object from
// sessionmap.read() (CLI) or as the Map threads builds once per command — both are the same fact.
function isAssigned(assigned, id) {
  if (!assigned || !id) return false;
  if (typeof assigned.has === 'function') return !!assigned.get(id);
  return !!assigned[id];
}

// Is this assignment the user's word or keyflip's guess? Absent provenance means STATED: the map
// predates inference, so anything already in it could only have come from `sessions assign`.
function provenanceFor(id, assigned, src) {
  if (!isAssigned(assigned, id)) return null;
  const rec = src && src[id];
  return rec && rec.source === 'inferred' ? 'inferred' : 'stated';
}

// ── the timeline ────────────────────────────────────────────────────────────────────────────
// Switch events, oldest-first, collapsed so a boundary is a CHANGE of account: one switch emits
// two lines (`active ->` + the caller's own message), and re-switching to the account already
// live is not a boundary at all.
//
// `coverage` is what the log could actually show — the earliest visible switch and whether older
// history was cut by the bounded read. A timeline that cannot see the beginning must not pretend
// sessions older than it belong to anyone.
function timeline(ctx, opts) {
  opts = opts || {};
  const found = auditview.scan(ctx, {
    limit: opts.events || 20000,
    bytes: opts.bytes || auditview.HARD_MAX_BYTES,
  });
  const events = [];
  found.entries.forEach(function (e) {
    const ms = Date.parse(e.ts);
    if (Number.isNaN(ms)) return;
    const name = switchName(e.msg);
    if (!name) return;
    events.push({ ms: ms, name: name });
  });
  events.sort(function (a, b) {
    return a.ms - b.ms;
  });
  const boundaries = [];
  events.forEach(function (ev) {
    const last = boundaries[boundaries.length - 1];
    if (last && last.name === ev.name) {
      last.count++;
      return;
    }
    boundaries.push({ ms: ev.ms, name: ev.name, count: 1 });
  });
  return {
    boundaries: boundaries,
    from: boundaries.length ? boundaries[0].ms : null,
    events: events.length,
    truncated: found.truncated,
  };
}

// Milliseconds of [start,end] that fall under each account, oldest-first. The LAST window is
// open-ended: whatever account the final switch installed holds everything after it, up to `end`.
function spans(boundaries, start, end) {
  const out = [];
  for (let i = 0; i < boundaries.length; i++) {
    const from = Math.max(start, boundaries[i].ms);
    const to = i + 1 < boundaries.length ? Math.min(end, boundaries[i + 1].ms) : end;
    if (to <= from) continue;
    const prev = out[out.length - 1];
    if (prev && prev.name === boundaries[i].name) {
      prev.ms += to - from;
      prev.to = to;
      continue;
    }
    out.push({ name: boundaries[i].name, ms: to - from, from: from, to: to });
  }
  return out;
}

// The account live at an instant: the last switch at/before `ms`. Null when `ms` precedes every
// recorded switch.
function activeAt(boundaries, ms) {
  let cur = null;
  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i].ms <= ms) cur = boundaries[i];
    else break;
  }
  return cur;
}

// A session's logged life is [first timestamp it wrote, last write]. Before the first recorded
// switch the log says nothing, so that part of the session is simply not evidence.
function verdict(tl, row) {
  const end = row.mtimeMs;
  if (!tl.boundaries.length) {
    return { confidence: 'none', why: 'the action log holds no switch yet' };
  }
  if (end < tl.from) {
    return {
      confidence: 'none',
      why: 'its last write predates the first switch keyflip logged (' + iso(tl.from) + ')',
    };
  }
  // No transcript timestamp: the only fact is the instant it was last written. That is a point in
  // time, not a span — resolve it against the timeline directly (a zero-length span would straddle
  // every boundary and claim "spans a switch" for a session that never did).
  if (row.startedAtMs == null) {
    const b = activeAt(tl.boundaries, end);
    return {
      confidence: 'medium',
      account: b.name,
      spanning: false,
      from: end,
      to: end,
      why: 'last write ' + iso(end) + ' falls in the ' + b.name + ' window (no start timestamp)',
    };
  }
  const start = row.startedAtMs;
  // Starting before the logged history caps the answer at 'medium': a span fully inside one window
  // is still a strong hint, but its opening is unobservable, so it is not proof.
  const thin = start < tl.from;
  const segs = spans(tl.boundaries, Math.max(start, tl.from), end);
  if (!segs.length) {
    return { confidence: 'none', why: 'it sits exactly on a switch instant, which decides nothing' };
  }
  const held = {};
  segs.forEach(function (s) {
    held[s.name] = (held[s.name] || 0) + s.ms;
  });
  const names = Object.keys(held).sort(function (a, b) {
    return held[b] - held[a];
  });
  const account = names[0];
  const from = segs[0].from;
  const to = segs[segs.length - 1].to;
  if (names.length === 1) {
    let why = 'everything visible sits inside the ' + account + ' window ' + iso(from) + ' → ' + iso(to);
    if (start < tl.from) why += ', but it opens before the logged history';
    return {
      confidence: thin ? 'medium' : 'high',
      account: account,
      spanning: false,
      from: from,
      to: to,
      why: why,
    };
  }
  return {
    confidence: 'low',
    account: account,
    spanning: true,
    from: from,
    to: to,
    spanned: names,
    why:
      'it spans ' +
      names.join(' / ') +
      '; the most logged time (' +
      Math.round((held[account] / Math.max(1, end - Math.max(start, tl.from))) * 100) +
      '%) is under ' +
      account,
  };
}

// ── proposals ───────────────────────────────────────────────────────────────────────────────
// Read-only: nothing here writes. Sessions that already carry an assignment are counted, never
// proposed over. An account that is no longer a saved profile is NOT proposed either — naming a
// deleted account would make `keyflip resume --run` point at credentials that do not exist.
function proposals(ctx, opts) {
  opts = opts || {};
  const tl = timeline(ctx, opts);
  const known = {};
  profiles.list(ctx.configDir).forEach(function (n) {
    known[n] = true;
  });
  const assigned = sessionmap.read(ctx);
  const src = sources(ctx);
  const rows = sessions.list(ctx, { limit: opts.limit || 200, nowMs: opts.nowMs });
  const out = { list: [], stated: 0, inferred: 0, unknownAccount: 0, noEvidence: 0 };
  rows.forEach(function (row) {
    const id = row.sessionId;
    if (assigned[id]) {
      if (provenanceFor(id, assigned, src) === 'inferred') out.inferred++;
      else out.stated++;
      return;
    }
    const v = verdict(tl, row);
    if (v.confidence === 'none') {
      out.noEvidence++;
      return;
    }
    if (!known[v.account]) {
      out.unknownAccount++;
      return;
    }
    out.list.push({
      session: id,
      project: row.project,
      account: v.account,
      confidence: v.confidence,
      spanning: !!v.spanning,
      from: iso(v.from),
      to: iso(v.to),
      lastActivity: row.mtime,
      started: row.startedAt || null,
      why: v.why,
      spanned: v.spanned || null,
    });
  });
  return {
    proposals: out.list,
    counts: {
      scanned: rows.length,
      stated: out.stated,
      inferred: out.inferred,
      proposed: out.list.length,
      unknownAccount: out.unknownAccount,
      noEvidence: out.noEvidence,
      high: out.list.filter(function (p) {
        return p.confidence === 'high';
      }).length,
      uncertain: out.list.filter(function (p) {
        return p.confidence !== 'high';
      }).length,
    },
    coverage: {
      from: tl.from ? iso(tl.from) : null,
      switches: tl.boundaries.length,
      partial: tl.truncated,
    },
  };
}

// Write the proposals: the assignment goes in the live map (so resume/threads use it), the reason
// goes in the sidecar (so it is never mistaken for the user's word).
function apply(ctx, list, opts) {
  opts = opts || {};
  const at = opts.at || new Date().toISOString();
  const written = [];
  (list || []).forEach(function (p) {
    if (!p || !p.session || !p.account) return;
    sessionmap.set(ctx, p.session, p.account);
    setSource(ctx, p.session, {
      source: 'inferred',
      confidence: p.confidence,
      account: p.account,
      at: at,
      evidence: p.why,
    });
    written.push(p.session);
  });
  return written;
}

// Called by `keyflip sessions assign`: the user has now stated it, so the guess is replaced by
// the word — the sidecar must not keep saying "inferred" for a session the user just confirmed.
function recordStated(ctx, id, opts) {
  opts = opts || {};
  setSource(ctx, id, {
    source: 'stated',
    account: (opts && opts.account) || null,
    at: (opts && opts.at) || new Date().toISOString(),
    evidence: 'assigned by hand (keyflip sessions assign)',
  });
}

export {
  SOURCE_NAME,
  switchName,
  timeline,
  spans,
  verdict,
  proposals,
  apply,
  sources,
  setSource,
  removeSource,
  isAssigned,
  provenanceFor,
  recordStated,
  sourcePath,
};
