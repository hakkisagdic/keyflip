// provusage — a ZERO-DEPENDENCY multi-provider usage / limit reader for keyflip.
//
// Approach adapted from CodexBar (github.com/steipete/CodexBar), MIT License —
// reimplemented in zero-dependency JS. No CodexBar Swift source was
// transliterated; only the CAPABILITY (a normalized, per-provider registry that
// reads usage windows + reset times from each tool's own local surfaces) was
// ported. See CREDITS.md.
//
// Design goals
//  - Node built-ins ONLY (fs, path, os, child_process, crypto). No npm, no TS.
//  - Every provider normalizes to the SAME shape as keyflip's src/usage.js does
//    for Claude, so the TUI / menubar can render all providers uniformly:
//        read(ctx, deps) -> {
//          status: 'ok' | 'throttled' | 'unknown' | 'unauthenticated',
//          windows: [ { name, usedPct, resetsAt } ],   // name: '5h'|'weekly'|...
//          raw?: <non-secret source object>
//        }
//  - Fully INJECTABLE so tests never touch a real network / CLI / account:
//        deps = { runner, fetch, now, env, requireUsage }
//    A missing tool, offline state, malformed file, or thrown fetch/CLI ALWAYS
//    degrades to { status: 'unknown' } and NEVER throws.
//  - We never read, store, decrypt, or return any secret/token VALUE. API
//    providers reference their key by ENV VAR NAME only (deps.env[NAME]); the
//    value is used to build one Authorization header and is never logged/raw'd.

import fs from 'fs';
import path from 'path';
import os from 'os';
import child_process from 'child_process';
import * as _usage from './usage.js';

// ---------------------------------------------------------------------------
// Injectable dependency defaults. Tests override any of these.
// ---------------------------------------------------------------------------
function defaultRunner(cmd, args, opts) {
  // Synchronous CLI runner. Wrapped so a missing binary (ENOENT) or any spawn
  // failure returns a shaped result instead of throwing.
  try {
    const r = child_process.spawnSync(cmd, args || [], {
      encoding: 'utf8',
      timeout: (opts && opts.timeoutMs) || 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message || r.error), error: true };
    return { code: typeof r.status === 'number' ? r.status : -1, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch (e) {
    return { code: -1, stdout: '', stderr: String((e && e.message) || e), error: true };
  }
}

function resolveDeps(deps) {
  deps = deps || {};
  return {
    runner: deps.runner || defaultRunner,
    // fetch defaults to NULL (fail-closed), NOT the global fetch: an 'api' provider reads a
    // real token from env into an Authorization header, so implicitly defaulting to the global
    // fetch would send the user's live provider tokens over the network from any caller (incl.
    // `node --test`) that merely forgot to inject one. A null fetch makes api reads 'unknown'.
    // Production callers (the CLI) pass fetch explicitly; tests pass a controlled stub.
    fetch: deps.fetch || null,
    now:
      deps.now ||
      function () {
        return Date.now();
      },
    env: deps.env || process.env,
    // Lets the claude provider delegate to keyflip's existing usage.js without
    // duplicating Claude logic — and lets tests inject a stub.
    requireUsage:
      deps.requireUsage ||
      function () {
        return _usage;
      },
  };
}

// ---------------------------------------------------------------------------
// Small, safe utilities (never throw).
// ---------------------------------------------------------------------------
function safe(fn, d) {
  try {
    return fn();
  } catch (e) {
    return d;
  }
}
function existsAbs(p) {
  return safe(function () {
    return fs.existsSync(p);
  }, false);
}
function homePath(ctx, rel) {
  return path.join(ctx.home, rel);
}
function existsHome(ctx, rel) {
  return existsAbs(homePath(ctx, rel));
}
function readJson(abs) {
  return safe(function () {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  }, null);
}
function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}
function clampPct(v) {
  const n = num(v);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

// Read only the tail of a (possibly huge) file, so scanning a long JSONL session
// log stays cheap. Returns a string (best-effort); '' on any error.
function readTail(abs, maxBytes) {
  maxBytes = maxBytes || 512 * 1024;
  let fd = null;
  try {
    const st = fs.statSync(abs);
    const size = st.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let s = buf.toString('utf8');
    // If we cut into the middle of a line, drop the first partial line.
    if (start > 0) {
      const nl = s.indexOf('\n');
      if (nl !== -1) s = s.slice(nl + 1);
    }
    return s;
  } catch (e) {
    return '';
  } finally {
    if (fd !== null)
      safe(function () {
        fs.closeSync(fd);
      });
  }
}

// Recursively collect files under `dir` whose basename matches `re`. Bounded and
// non-throwing; returns [] if the dir is missing.
function findFiles(dir, re, cap) {
  cap = cap || 5000;
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < cap) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (re.test(e.name)) out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Window naming + reset normalization (the "resetWindow" helper the spec asks
// for): turn a provider's raw reset info into a uniform { resetsAt, human }.
// ---------------------------------------------------------------------------
function windowNameForMinutes(minutes) {
  const m = num(minutes);
  if (m === null) return 'window';
  // tolerant buckets (providers report slightly-off durations)
  if (m <= 90) return '1h';
  if (m <= 360) return '5h';
  if (m <= 1500) return 'daily'; // ~1440
  if (m <= 12000) return 'weekly'; // ~10080
  if (m <= 50000) return 'monthly'; // ~43200
  return m + 'm';
}

function humanizeUntil(deltaMs) {
  if (deltaMs === null || deltaMs === undefined) return null;
  if (deltaMs <= 0) return 'resets now';
  const totalMin = Math.floor(deltaMs / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return 'resets in ' + days + 'd' + (hours ? ' ' + hours + 'h' : '');
  if (hours > 0) return 'resets in ' + hours + 'h' + (mins ? ' ' + mins + 'm' : '');
  if (mins > 0) return 'resets in ' + mins + 'm';
  return 'resets in <1m';
}

// Accepts a flexible description of a reset time and returns a uniform ISO +
// human string. Recognized inputs:
//   number          -> unix SECONDS if < 1e12, else epoch MS (heuristic)
//   ISO string      -> parsed
//   { unixSeconds } -> epoch seconds
//   { ms }          -> epoch ms
//   { iso }         -> ISO string
//   { inSeconds }   -> relative to deps.now()
//   null/undefined  -> { resetsAt: null, human: null }
function resetWindow(input, deps) {
  deps = deps || {};
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  let ms = null;
  if (input === null || input === undefined) {
    ms = null;
  } else if (typeof input === 'number' && isFinite(input)) {
    ms = input >= 1e12 ? input : input * 1000;
  } else if (typeof input === 'string') {
    const t = Date.parse(input);
    ms = isNaN(t) ? null : t;
  } else if (isObj(input)) {
    if (typeof input.ms === 'number' && isFinite(input.ms)) ms = input.ms;
    else if (typeof input.unixSeconds === 'number' && isFinite(input.unixSeconds)) ms = input.unixSeconds * 1000;
    else if (typeof input.inSeconds === 'number' && isFinite(input.inSeconds)) ms = nowMs + input.inSeconds * 1000;
    else if (typeof input.iso === 'string') {
      const t = Date.parse(input.iso);
      ms = isNaN(t) ? null : t;
    }
  }
  if (ms === null) return { resetsAt: null, human: null };
  let iso = null;
  try {
    iso = new Date(ms).toISOString();
  } catch (e) {
    return { resetsAt: null, human: null };
  }
  return { resetsAt: iso, human: humanizeUntil(ms - nowMs) };
}

function makeWindow(name, usedPct, resetInput, deps) {
  const rw = resetWindow(resetInput, deps);
  return { name: name, usedPct: clampPct(usedPct), resetsAt: rw.resetsAt, human: rw.human };
}

// ---------------------------------------------------------------------------
// Injectable network helper. Returns { ok, status, data } | { ok:false }.
// Any missing fetch / thrown error / non-JSON body degrades to { ok:false }.
// ---------------------------------------------------------------------------
async function httpGetJson(url, headers, deps) {
  if (!deps.fetch) return { ok: false, status: null };
  try {
    const res = await deps.fetch(url, {
      headers: headers || {},
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
    });
    if (!res) return { ok: false, status: null };
    if (!res.ok) return { ok: false, status: res.status || null };
    const data = await res.json();
    return { ok: true, status: res.status || 200, data: data };
  } catch (e) {
    return { ok: false, status: null };
  }
}

// A provider that needs an env key but has none -> unauthenticated, never a throw
// and never a leak of the (absent) value.
function keyFromEnv(deps, envName) {
  const v = deps.env ? deps.env[envName] : undefined;
  return typeof v === 'string' && v.length ? v : null;
}

// ===========================================================================
// PROVIDER: codex / openai (Codex CLI) — FILE. Real & verified.
// ---------------------------------------------------------------------------
// Codex CLI writes rollout session logs as JSONL under
//   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
// (CODEX_HOME defaults to ~/.codex). Each token_count event carries the current
// rate-limit snapshot (openai/codex protocol.rs: TokenCountEvent.rate_limits ->
// RateLimitSnapshot { primary, secondary } of RateLimitWindow { used_percent,
// window_minutes, resets_at }). We read the newest session's last snapshot.
// ===========================================================================
function codexHome(ctx, deps) {
  const env = keyFromEnv(deps, 'CODEX_HOME');
  return env ? env : homePath(ctx, '.codex');
}

function codexReadWindow(w, deps) {
  if (!isObj(w) || num(w.used_percent) === null) return null;
  let reset = null;
  if (num(w.resets_at) !== null) reset = { unixSeconds: w.resets_at };
  else if (num(w.resets_in_seconds) !== null) reset = { inSeconds: w.resets_in_seconds }; // older codex
  return makeWindow(windowNameForMinutes(w.window_minutes), w.used_percent, reset, deps);
}

function codexParseSnapshot(rl, deps) {
  if (!isObj(rl)) return null;
  const windows = [];
  const p = codexReadWindow(rl.primary, deps);
  if (p) windows.push(p);
  const s = codexReadWindow(rl.secondary, deps);
  if (s) windows.push(s);
  if (!windows.length) return null;
  return windows;
}

function codexLatestSnapshot(ctx, deps) {
  const home = codexHome(ctx, deps);
  let files = findFiles(path.join(home, 'sessions'), /^rollout-.*\.jsonl$/);
  if (!files.length) files = findFiles(path.join(home, 'archived_sessions'), /^rollout-.*\.jsonl$/);
  if (!files.length) return null;
  // File names embed an ISO timestamp, so lexicographic order == chronological.
  files.sort();
  // Scan newest files first; within a file, newest line first.
  for (let fi = files.length - 1; fi >= 0; fi--) {
    const text = readTail(files[fi]);
    if (!text) continue;
    const lines = text.split('\n');
    for (let li = lines.length - 1; li >= 0; li--) {
      const line = lines[li].trim();
      if (!line) continue;
      const obj = safe(function () {
        return JSON.parse(line);
      }, null);
      if (!obj) continue;
      const payload = isObj(obj.payload) ? obj.payload : obj;
      const rl = isObj(payload.rate_limits) ? payload.rate_limits : isObj(obj.rate_limits) ? obj.rate_limits : null;
      if (rl) return rl;
    }
  }
  return null;
}

const codexProvider = {
  id: 'codex',
  label: 'Codex CLI (OpenAI)',
  kind: 'file',
  detect: function (ctx, deps) {
    return { present: existsAbs(codexHome(ctx, deps)) };
  },
  read: function (ctx, deps) {
    const rl = codexLatestSnapshot(ctx, deps);
    if (!rl) return { status: 'unknown', windows: [] };
    const windows = codexParseSnapshot(rl, deps);
    if (!windows) return { status: 'unknown', windows: [] };
    return { status: 'ok', windows: windows, raw: rl };
  },
};

// ===========================================================================
// PROVIDER: gemini (Gemini CLI) — CLI (injected runner).
// ---------------------------------------------------------------------------
// Presence: ~/.gemini exists. The Gemini CLI's quota is OAuth-backed; there is
// no *documented* stable local usage file, so we read it by invoking the CLI via
// the injectable runner and parsing a JSON usage payload. The exact command /
// output shape is NEEDS-VERIFICATION (see StructuredOutput). Tests inject a fake
// runner returning canned JSON to prove the parse + normalization.
// Expected JSON (tolerant): { windows:[{name|window_minutes, used_percent|usedPct, resets_at|resetsAt}] }
//   or a flat { used_percent, window_minutes, resets_at }.
// ===========================================================================
function geminiParse(payload, deps) {
  if (typeof payload === 'string')
    payload = safe(function () {
      return JSON.parse(payload);
    }, null);
  if (!isObj(payload)) return null;
  const rows = Array.isArray(payload.windows)
    ? payload.windows
    : Array.isArray(payload.quotas)
      ? payload.quotas
      : num(payload.used_percent) !== null || num(payload.usedPct) !== null
        ? [payload]
        : null;
  if (!rows) return null;
  const windows = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isObj(r)) continue;
    const pct = num(r.used_percent) !== null ? r.used_percent : r.usedPct;
    if (num(pct) === null) continue;
    const name = typeof r.name === 'string' ? r.name : windowNameForMinutes(r.window_minutes);
    let reset = null;
    if (num(r.resets_at) !== null) reset = { unixSeconds: r.resets_at };
    else if (typeof r.resetsAt === 'string') reset = { iso: r.resetsAt };
    else if (typeof r.resets_at === 'string') reset = { iso: r.resets_at };
    else if (num(r.resets_in_seconds) !== null) reset = { inSeconds: r.resets_in_seconds };
    windows.push(makeWindow(name, pct, reset, deps));
  }
  return windows.length ? windows : null;
}

const geminiProvider = {
  id: 'gemini',
  label: 'Gemini CLI',
  kind: 'cli',
  detect: function (ctx, deps) {
    return { present: existsHome(ctx, '.gemini') };
  },
  read: function (ctx, deps) {
    const r = deps.runner('gemini', ['usage', '--json'], { timeoutMs: 5000 });
    if (!r || r.code !== 0 || !r.stdout) return { status: 'unknown', windows: [] };
    const windows = geminiParse(r.stdout, deps);
    if (!windows) return { status: 'unknown', windows: [] };
    return {
      status: 'ok',
      windows: windows,
      raw: safe(function () {
        return JSON.parse(r.stdout);
      }, null),
    };
  },
};

// ===========================================================================
// PROVIDER: opencode — FILE (injected).
// ---------------------------------------------------------------------------
// Presence: ~/.local/share/opencode or ~/.config/opencode. opencode stores auth
// per provider (auth.json) but no standardized usage percentages; if a usage
// cache exists we parse it, else present+unknown. Usage-file shape is
// NEEDS-VERIFICATION. Shape (tolerant): { windows:[{name,usedPct,resetsAt}] }.
// ===========================================================================
function opencodeUsagePath(ctx) {
  const a = homePath(ctx, path.join('.local', 'share', 'opencode', 'usage.json'));
  if (existsAbs(a)) return a;
  const b = homePath(ctx, path.join('.config', 'opencode', 'usage.json'));
  if (existsAbs(b)) return b;
  return null;
}
const opencodeProvider = {
  id: 'opencode',
  label: 'opencode',
  kind: 'file',
  detect: function (ctx, deps) {
    return {
      present:
        existsHome(ctx, path.join('.local', 'share', 'opencode')) || existsHome(ctx, path.join('.config', 'opencode')),
    };
  },
  read: function (ctx, deps) {
    const up = opencodeUsagePath(ctx);
    if (!up) return { status: 'unknown', windows: [] };
    const obj = readJson(up);
    const windows = geminiParse(obj, deps); // same tolerant windows shape
    if (!windows) return { status: 'unknown', windows: [] };
    return { status: 'ok', windows: windows, raw: obj };
  },
};

// ===========================================================================
// API providers (openrouter, cursor, copilot) — network via injected fetch.
// Key referenced by ENV VAR NAME only; value only ever becomes an Auth header.
// ---------------------------------------------------------------------------
// mapStatusFromHttp: shared degradation. 401/403 -> unauthenticated, 429 ->
// throttled, anything else / no-fetch / throw -> unknown.
// ===========================================================================
function apiUnknownForStatus(status) {
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status === 429) return 'throttled';
  return 'unknown';
}

// openrouter: GET https://openrouter.ai/api/v1/key
//   -> { data: { label, limit, usage, limit_remaining, is_free_tier, rate_limit } }
// usedPct = usage/limit*100 when limit is a positive number (null limit = no cap).
// Real, documented endpoint; live correctness is NEEDS-VERIFICATION (no key here).
const openrouterProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  kind: 'api',
  envVar: 'OPENROUTER_API_KEY',
  detect: function (ctx, deps) {
    return { present: !!keyFromEnv(deps, 'OPENROUTER_API_KEY') };
  },
  read: async function (ctx, deps) {
    const key = keyFromEnv(deps, 'OPENROUTER_API_KEY');
    if (!key) return { status: 'unauthenticated', windows: [] };
    const r = await httpGetJson('https://openrouter.ai/api/v1/key', { Authorization: 'Bearer ' + key }, deps);
    if (!r.ok) return { status: apiUnknownForStatus(r.status), windows: [] };
    const d = isObj(r.data) && isObj(r.data.data) ? r.data.data : null;
    if (!d) return { status: 'unknown', windows: [] };
    const limit = num(d.limit);
    const used = num(d.usage);
    let pct = null;
    if (limit !== null && limit > 0 && used !== null) pct = (used / limit) * 100;
    const safeRaw = {
      limit: limit,
      usage: used,
      limit_remaining: num(d.limit_remaining),
      is_free_tier: !!d.is_free_tier,
    };
    return { status: 'ok', windows: [makeWindow('credits', pct, null, deps)], raw: safeRaw };
  },
};

// cursor: usage endpoint is session/cookie-backed; we model an API-key path via
// injected fetch. Endpoint + shape are NEEDS-VERIFICATION. Tolerant parse of a
// per-model map { "<model>": { numRequests, maxRequestUsage } } or { used_percent }.
const cursorProvider = {
  id: 'cursor',
  label: 'Cursor',
  kind: 'api',
  envVar: 'CURSOR_API_KEY',
  detect: function (ctx, deps) {
    return { present: existsHome(ctx, '.cursor') || !!keyFromEnv(deps, 'CURSOR_API_KEY') };
  },
  read: async function (ctx, deps) {
    const key = keyFromEnv(deps, 'CURSOR_API_KEY');
    if (!key) return { status: 'unknown', windows: [] }; // present-but-no-key: usage lives behind a browser session
    const r = await httpGetJson('https://cursor.com/api/usage', { Authorization: 'Bearer ' + key }, deps);
    if (!r.ok) return { status: apiUnknownForStatus(r.status), windows: [] };
    const d = r.data;
    if (num(d && d.used_percent) !== null) {
      return {
        status: 'ok',
        windows: [
          makeWindow('monthly', d.used_percent, d.resets_at != null ? { unixSeconds: d.resets_at } : null, deps),
        ],
        raw: d,
      };
    }
    if (isObj(d) && isObj(d['gpt-4'])) {
      const g = d['gpt-4'];
      const used = num(g.numRequests);
      const max = num(g.maxRequestUsage);
      const pct = used !== null && max !== null && max > 0 ? (used / max) * 100 : null;
      return {
        status: 'ok',
        windows: [makeWindow('monthly', pct, null, deps)],
        raw: { numRequests: used, maxRequestUsage: max },
      };
    }
    return { status: 'unknown', windows: [] };
  },
};

// copilot: GitHub Copilot per-user quota (no clean public endpoint) — modeled via
// injected fetch, NEEDS-VERIFICATION. Tolerant parse of { quota_snapshots } or
// { used_percent }.
const copilotProvider = {
  id: 'copilot',
  label: 'GitHub Copilot',
  kind: 'api',
  envVar: 'GITHUB_COPILOT_TOKEN',
  detect: function (ctx, deps) {
    return {
      present:
        existsHome(ctx, path.join('.config', 'github-copilot')) ||
        existsHome(ctx, '.copilot') ||
        !!keyFromEnv(deps, 'GITHUB_COPILOT_TOKEN'),
    };
  },
  read: async function (ctx, deps) {
    const key = keyFromEnv(deps, 'GITHUB_COPILOT_TOKEN');
    if (!key) return { status: 'unknown', windows: [] };
    const r = await httpGetJson(
      'https://api.github.com/copilot_internal/user',
      { Authorization: 'Bearer ' + key },
      deps,
    );
    if (!r.ok) return { status: apiUnknownForStatus(r.status), windows: [] };
    const d = r.data;
    if (num(d && d.used_percent) !== null) {
      return {
        status: 'ok',
        windows: [
          makeWindow('monthly', d.used_percent, d.resets_at != null ? { unixSeconds: d.resets_at } : null, deps),
        ],
        raw: d,
      };
    }
    return { status: 'unknown', windows: [] };
  },
};

// ===========================================================================
// PROVIDER: claude — DELEGATES to keyflip's existing src/usage.js. No Claude
// logic is duplicated here. deps.requireUsage() is injectable so tests can stub
// the delegate and prove the wiring.
// ===========================================================================
function mapClaudeStatus(s) {
  if (s === 'ok') return 'ok';
  // usage.js returns 'throttled' when the OAuth USAGE endpoint 429s — which it documents does
  // NOT mean the account is rate-limited (a 429-usage account keeps serving inference). Map it
  // to 'unknown', never 'throttled', so a TUI/auto-switch consumer does not skip a usable account.
  if (s === 'throttled') return 'unknown';
  if (s === 'expired' || s === 'no-token' || s === 'no-creds') return 'unauthenticated';
  return 'unknown';
}
const claudeProvider = {
  id: 'claude',
  label: 'Claude (Anthropic)',
  kind: 'delegate',
  detect: function (ctx, deps) {
    // Present if keyflip has any Claude credential surface for the active account.
    const hasLive = safe(function () {
      return !!(ctx.store && ctx.store.getLive && ctx.store.getLive());
    }, false);
    const hasCfg = !!(ctx.claudeConfigPath && existsAbs(ctx.claudeConfigPath));
    return { present: hasLive || hasCfg };
  },
  read: async function (ctx, deps) {
    const usageMod = deps.requireUsage();
    const account = ctx.account || 'default';
    const res = await usageMod.usageForProfiles(ctx, [account], {
      fetch: deps.fetch,
      nowMs: deps.now(),
      liveFor: account,
    });
    const info = res && res[account];
    if (!info) return { status: 'unknown', windows: [] };
    const status = mapClaudeStatus(info.status);
    const windows = [];
    const u = info.usage;
    if (isObj(u)) {
      if (isObj(u.fiveHour) && num(u.fiveHour.pct) !== null) {
        windows.push(makeWindow('5h', u.fiveHour.pct, u.fiveHour.resetsAt ? { iso: u.fiveHour.resetsAt } : null, deps));
      }
      if (isObj(u.sevenDay) && num(u.sevenDay.pct) !== null) {
        windows.push(
          makeWindow('weekly', u.sevenDay.pct, u.sevenDay.resetsAt ? { iso: u.sevenDay.resetsAt } : null, deps),
        );
      }
    }
    return { status: status === 'ok' && !windows.length ? 'unknown' : status, windows: windows, raw: null };
  },
};

// ---------------------------------------------------------------------------
// REGISTRY
// ---------------------------------------------------------------------------
const PROVIDERS = [
  codexProvider,
  geminiProvider,
  opencodeProvider,
  openrouterProvider,
  cursorProvider,
  copilotProvider,
  claudeProvider,
];

const BY_ID = Object.create(null);
PROVIDERS.forEach(function (p) {
  BY_ID[p.id] = p;
});
function get(id) {
  return typeof id === 'string' && BY_ID[id] ? BY_ID[id] : null;
}

// Normalize the OUTPUT of a provider.read so the shape is IDENTICAL across every
// provider even if a provider returns something partial. Never throws.
function normalizeRead(res) {
  const ok = isObj(res) ? res : {};
  const validStatus = { ok: 1, throttled: 1, unknown: 1, unauthenticated: 1 };
  const status = validStatus[ok.status] ? ok.status : 'unknown';
  const windows = Array.isArray(ok.windows)
    ? ok.windows.map(function (w) {
        return {
          name: w && typeof w.name === 'string' ? w.name : 'window',
          usedPct: w && num(w.usedPct) !== null ? w.usedPct : null,
          resetsAt: w && typeof w.resetsAt === 'string' ? w.resetsAt : null,
          human: w && typeof w.human === 'string' ? w.human : null,
        };
      })
    : [];
  const out = { status: status, windows: windows };
  if (ok.raw !== undefined) out.raw = ok.raw;
  return out;
}

// detect one provider, never throwing.
async function detectOne(ctx, id, deps) {
  const d = resolveDeps(deps);
  const p = get(id);
  if (!p) return null;
  let det;
  try {
    det = await p.detect(ctx, d);
  } catch (e) {
    det = { present: false };
  }
  return { id: p.id, label: p.label, kind: p.kind, present: !!(det && det.present) };
}

// read one provider (detect first). Always returns the normalized shape; a
// missing tool / offline / malformed source degrades to status 'unknown'.
async function readOne(ctx, id, deps) {
  const d = resolveDeps(deps);
  const p = get(id);
  if (!p) return null;
  let present = false;
  try {
    const det = await p.detect(ctx, d);
    present = !!(det && det.present);
  } catch (e) {
    present = false;
  }
  const base = { id: p.id, label: p.label, kind: p.kind, present: present };
  if (!present) return Object.assign(base, { status: 'unknown', windows: [] });
  let res;
  try {
    res = await p.read(ctx, d);
  } catch (e) {
    res = { status: 'unknown', windows: [] };
  }
  return Object.assign(base, normalizeRead(res));
}

// readAll: read every PRESENT provider (absent ones are skipped). Returns an
// array of { id, label, kind, present:true, status, windows, raw? }.
async function readAll(ctx, deps) {
  const d = resolveDeps(deps);
  const out = [];
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    let present = false;
    try {
      const det = await p.detect(ctx, d);
      present = !!(det && det.present);
    } catch (e) {
      present = false;
    }
    if (!present) continue;
    let res;
    try {
      res = await p.read(ctx, d);
    } catch (e) {
      res = { status: 'unknown', windows: [] };
    }
    out.push(Object.assign({ id: p.id, label: p.label, kind: p.kind, present: true }, normalizeRead(res)));
  }
  return out;
}

export {
  PROVIDERS,
  get,
  detectOne,
  readOne,
  readAll,
  resetWindow,
  windowNameForMinutes,
  humanizeUntil,
  makeWindow,
  normalizeRead,
  codexParseSnapshot,
  geminiParse,
};
