// SESSION FRESHNESS (#65): how old is each claude.ai sign-in keyflip holds, and has the server
// already called one too old?
//
// Two families of credential live behind an account, and they age differently:
//   - the CLI's OAuth grant carries a refresh token, so keyflip can renew it on a schedule
//     (`keyflip refresh --schedule`) — no human needed;
//   - the claude.ai `sessionKey` cookie (the desktop app's real login, and the browser's) has NO
//     refresh path. Measured on this machine: its `expires_utc` is exactly sign-in + 28 days and does
//     not move when the session is used, and its `creation_utc` is the moment of the human sign-in
//     (Chromium keeps it across server rotations of the value). On top of that hard cap the server
//     refuses an OAuth scope expansion with `session_stale_relogin` ("sessionKey is valid but too old
//     for the requested scope expansion") well before expiry — the "Sign in again" banner.
//
// So the honest mechanism for the cookie family is MEASURE + WARN, not refresh: show the sign-in age
// of every saved and live jar, detect the server's stale verdict in Claude's own log, and remember the
// age at which it happened so the next warning comes before the banner does.
//
// NEVER reads a cookie value: only creation/expiry timestamps and cookie NAMES.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run as _run } from './exec.js';
import * as appauth from './appauth.js';
import * as browser from './browser.js';
import * as profiles from './profiles.js';

const SESSION_NAMES = ['sessionKey', 'sessionKeyV3'];
const DAY = 86400000;
// Chromium stores times as microseconds since 1601-01-01.
const EPOCH_DELTA_SECS = 11644473600;
// Warn this many days before the hard expiry (a sign-in takes a minute; a dead session mid-task costs more).
const EXPIRY_WARN_DAYS = 5;

function chromeToMs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  const ms = Math.floor(n / 1000) - EPOCH_DELTA_SECS * 1000;
  return ms > 0 ? ms : null;
}

// Pick the newest session cookie among rows [{ created, expires }] (Chromium µs values).
function newest(rows) {
  let best = null;
  rows.forEach(function (r) {
    const c = chromeToMs(r.created);
    if (c == null) return;
    if (!best || c > best.signedInAt) best = { signedInAt: c, expiresAt: chromeToMs(r.expires) };
  });
  return best;
}

// Sign-in times of a Chromium Cookies DB (live jar or a saved capture). Returns
//   { signedInAt, expiresAt } (epoch ms) | null when the jar holds no claude.ai session cookie |
//   undefined when the file is missing or unreadable (callers must not read "unreadable" as "signed out").
function jarTimes(file, opts) {
  opts = opts || {};
  const runner = opts.run || _run;
  if (!file || !fs.existsSync(file)) return undefined;
  // Query a COPY: the live jar is held open (and rewritten) by the app.
  const tmp = path.join(os.tmpdir(), 'keyflip-age-' + process.pid + '-' + Date.now() + '.db');
  try {
    try {
      const b = runner('sqlite3', [file, '.backup "' + tmp.replace(/"/g, '""') + '"']);
      if (!b || b.code !== 0) fs.copyFileSync(file, tmp);
    } catch (e) {
      fs.copyFileSync(file, tmp);
    }
    try {
      fs.chmodSync(tmp, 0o600);
    } catch (e) {
      /* best effort */
    }
    const r = runner('sqlite3', [
      '-separator',
      '\t',
      'file:' + tmp + '?mode=ro',
      "SELECT creation_utc, expires_utc FROM cookies WHERE host_key LIKE '%claude.ai' AND name IN ('" +
        SESSION_NAMES.join("','") +
        "');",
    ]);
    if (!r || r.code !== 0) return undefined;
    const rows = String(r.stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(function (l) {
        const p = l.split('\t');
        return { created: p[0], expires: p[1] };
      });
    return newest(rows);
  } catch (e) {
    return undefined;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

// Split one `VALUES(...)` list into raw tokens: numbers, 'quoted strings' ('' escapes), X'hex', NULL.
function splitValues(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ',' || ch === ' ') {
      i++;
      continue;
    }
    if (ch === "'" || ((ch === 'X' || ch === 'x') && s[i + 1] === "'")) {
      let j = ch === "'" ? i + 1 : i + 2;
      let v = '';
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          v += "'";
          j += 2;
        } else if (s[j] === "'") break;
        else v += s[j++];
      }
      out.push(ch === "'" ? v : '<blob>'); // a blob's bytes are never kept
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== ',') j++;
    out.push(s.slice(i, j).trim());
    i = j;
  }
  return out;
}

// Sign-in times inside a saved BROWSER session (browser.js snapshotClaudeCookies: `INSERT INTO cookies
// VALUES(...)` rows in Chromium's column order — creation_utc first, name 4th, expires_utc 8th).
function sqlTimes(sql) {
  if (!sql) return undefined;
  const rows = [];
  String(sql)
    .split('\n')
    .forEach(function (line) {
      const m = /^INSERT INTO\s+"?cookies"?\s+VALUES\s*\((.*)\);?\s*$/i.exec(line.trim());
      if (!m) return;
      const v = splitValues(m[1]);
      if (v.length < 8 || SESSION_NAMES.indexOf(v[3]) === -1 || !/claude\.ai$/.test(v[1])) return;
      rows.push({ created: v[0], expires: v[7] });
    });
  return newest(rows);
}

// Turn times into a verdict. staleAfterDays = the age at which the server has been seen to refuse
// this kind of session (learned, see below); null = not learned yet.
//   fresh | aging (older than a stale verdict seen before) | expiring (≤5 days left) | expired
function describe(t, opts) {
  opts = opts || {};
  if (!t || !t.signedInAt) return null;
  const now = opts.now || Date.now();
  const ageDays = Math.max(0, (now - t.signedInAt) / DAY);
  const daysLeft = t.expiresAt ? (t.expiresAt - now) / DAY : null;
  let state = 'fresh';
  if (daysLeft != null && daysLeft <= 0) state = 'expired';
  else if (daysLeft != null && daysLeft <= EXPIRY_WARN_DAYS) state = 'expiring';
  else if (opts.staleAfterDays != null && ageDays >= opts.staleAfterDays) state = 'aging';
  return {
    signedInAt: new Date(t.signedInAt).toISOString(),
    expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    ageDays: Math.round(ageDays * 10) / 10,
    daysLeft: daysLeft == null ? null : Math.round(daysLeft * 10) / 10,
    state: state,
  };
}

// Short human form: "signed in 3d ago, 25d left". Measured from signedInAt (ageDays is rounded to
// a tenth of a day, too coarse for "signed in 20 minutes ago").
function fmt(d, now) {
  if (!d) return 'no claude.ai session';
  const ms = d.signedInAt ? (now || Date.now()) - Date.parse(d.signedInAt) : d.ageDays * DAY;
  const hours = Math.max(0, ms) / 3600000;
  const age =
    hours < 1
      ? Math.max(1, Math.round(hours * 60)) + 'm'
      : hours < 24
        ? Math.round(hours) + 'h'
        : Math.round(hours / 24) + 'd';
  let s = 'signed in ' + age + ' ago';
  if (d.daysLeft != null) s += d.daysLeft > 0 ? ', ' + Math.round(d.daysLeft) + 'd left' : ', EXPIRED';
  return s;
}

// ---- the server's own verdict, from Claude Desktop's log ---------------------------------------
function claudeLogPath(ctx) {
  if (ctx && ctx.claudeLogPath) return ctx.claudeLogPath;
  if (process.env.KEYFLIP_CLAUDE_LOG) return process.env.KEYFLIP_CLAUDE_LOG;
  if (!ctx || ctx.platform !== 'darwin') return null;
  return path.join(ctx.home, 'Library', 'Logs', 'Claude', 'main.log');
}

// Read the tail of a (possibly large) log without loading all of it.
function tail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  } finally {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
  }
}

// Parse the log's local "YYYY-MM-DD HH:MM:SS" stamp.
function stampMs(line) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(line);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

// Is the app latched on `session_stale_relogin` RIGHT NOW? The app logs every refusal and logs
// "clearing latched session_stale_relogin" / "sessionKey rotated" when the cookie changes, so the LAST
// of the two in LOG ORDER wins. (Not by timestamp: the log has 1-second stamps, and a clear followed
// by a fresh refusal in the same second — seen here — means the new cookie was refused too.)
// Returns { stale, at, org } — at/org from the last refusal — or { stale:false } (also when there is no
// log to read). opts.since (epoch ms) ignores anything older (e.g. before a switch reopened the app).
function staleRelogin(ctx, opts) {
  opts = opts || {};
  const file = claudeLogPath(ctx);
  if (!file) return { stale: false, at: null, org: null, checked: false };
  const text = opts.text != null ? opts.text : tail(file, opts.bytes || 2 * 1024 * 1024);
  if (!text) return { stale: false, at: null, org: null, checked: false };
  let last = null;
  text.split('\n').forEach(function (line) {
    if (line.indexOf('session_stale_relogin') === -1) return;
    const at = stampMs(line);
    if (opts.since && (at == null || at < opts.since)) return;
    if (/clearing latched session_stale_relogin|sessionKey rotated/.test(line)) last = null;
    else if (/rejected with session_stale_relogin|failed for orgId=|code=session_stale_relogin/.test(line)) {
      const om = /orgId=([0-9a-f-]{36})/.exec(line);
      // One refusal is logged as several lines; only some carry the org — keep it across the burst.
      last = { at: at, org: om ? om[1] : last ? last.org : null };
    }
  });
  if (!last) return { stale: false, at: null, org: null, checked: true };
  return { stale: true, at: last.at ? new Date(last.at).toISOString() : null, org: last.org, checked: true };
}

// ---- learning the threshold ----------------------------------------------------------------------
// The server does not publish how old is "too old for scope expansion", so keyflip remembers the
// sign-in age at which it was refused and warns from the youngest such age on. Ages only — no
// account secret — kept in a SUBDIRECTORY so it can never be mistaken for a saved account
// (every <configDir>/*.json is one unless reserved).
function freshnessFile(configDir) {
  return path.join(configDir, 'freshness', 'stale-relogin.json');
}

function readObservations(configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(freshnessFile(configDir), 'utf8'));
    return Array.isArray(j.observations) ? j.observations : [];
  } catch (e) {
    return [];
  }
}

// Record one refusal (idempotent per profile + log timestamp). Returns the observation list.
function recordStale(configDir, obs) {
  const list = readObservations(configDir);
  if (!obs || typeof obs.ageDays !== 'number' || !isFinite(obs.ageDays)) return list;
  const dup = list.some(function (o) {
    return o.profile === obs.profile && o.at === obs.at;
  });
  if (dup) return list;
  list.push({ at: obs.at || new Date().toISOString(), profile: obs.profile || null, ageDays: obs.ageDays });
  const f = freshnessFile(configDir);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ observations: list.slice(-50) }, null, 2) + '\n');
  } catch (e) {
    /* best effort — a missed observation only delays the warning */
  }
  return list;
}

// The youngest sign-in age the server has refused, or null when never seen.
function staleAfterDays(configDir) {
  let min = null;
  readObservations(configDir).forEach(function (o) {
    if (typeof o.ageDays === 'number' && (min === null || o.ageDays < min)) min = o.ageDays;
  });
  return min;
}

// ---- the whole picture ---------------------------------------------------------------------------
// The saved profile that owns a claude.ai org uuid, or '' when none does.
function profileForOrg(configDir, org) {
  if (!org) return '';
  let found = '';
  profiles.list(configDir).forEach(function (n) {
    if (found) return;
    const m = profiles.read(configDir, n);
    if (m && m.oauthAccount && m.oauthAccount.organizationUuid === org) found = n;
  });
  return found;
}

// One jar reading -> a report entry. undefined (unreadable) and null (no session) are kept apart:
// "could not read it" must never be shown as "signed out".
function entry(t, opts) {
  if (t === undefined) return { state: 'unreadable' };
  if (t === null) return { state: 'signed-out' };
  return describe(t, opts);
}

const RANK = { 'signed-out': 4, expired: 4, expiring: 3, aging: 2, unreadable: 1, fresh: 0 };
// The worst state among entries (what a one-line summary should lead with).
function worst(entries) {
  let w = null;
  (entries || []).forEach(function (e) {
    if (e && e.state && (w === null || (RANK[e.state] || 0) > (RANK[w] || 0))) w = e.state;
  });
  return w;
}

// Sign-in ages of every claude.ai session keyflip can see, live and saved:
//   { staleAfterDays, stale: {stale, at, org, profile},
//     live: { app: {profile, ...entry} | null, browsers: [{browser, ...entry}] },
//     accounts: [{ name, app: entry|null, browsers: [{browser, ...entry}] }] }
// READ-ONLY: copies jars to a 0600 temp file to query them, reads Claude's log tail, writes nothing.
function report(ctx, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const learned = staleAfterDays(ctx.configDir);
  const dopts = { now: now, staleAfterDays: learned };
  const out = { staleAfterDays: learned, stale: null, live: { app: null, browsers: [] }, accounts: [] };

  const liveFile = ctx.appDataDir ? appauth.cookiesPath(ctx) : null;
  if (liveFile && fs.existsSync(liveFile)) {
    let org = null;
    try {
      const det = appauth.detectAppAccount(ctx);
      org = det && det.org;
    } catch (e) {
      org = null;
    }
    out.live.app = Object.assign(
      { profile: profileForOrg(ctx.configDir, org) || null },
      entry(jarTimes(liveFile, opts), dopts),
    );
  }
  const cat = ctx.platform === 'darwin' || opts.anyPlatform ? browser.catalog(ctx.home) : {};
  const browsers = Object.keys(cat).map(function (k) {
    return cat[k];
  });
  browsers.forEach(function (b) {
    if (!fs.existsSync(b.cookies)) return;
    out.live.browsers.push(Object.assign({ browser: b.name }, entry(jarTimes(b.cookies, opts), dopts)));
  });

  profiles.list(ctx.configDir).forEach(function (name) {
    const acct = { name: name, app: null, browsers: [] };
    const cap = appauth.profileCookiesPath(ctx, name);
    if (cap && fs.existsSync(cap)) acct.app = entry(jarTimes(cap, opts), dopts);
    browsers.forEach(function (b) {
      const sql = browser.loadSession(ctx.configDir, name, b);
      if (sql) acct.browsers.push(Object.assign({ browser: b.name }, entry(sqlTimes(sql), dopts)));
    });
    out.accounts.push(acct);
  });

  const st = opts.stale !== undefined ? opts.stale : staleRelogin(ctx, opts.log || {});
  out.stale = Object.assign({}, st, { profile: st && st.stale ? profileForOrg(ctx.configDir, st.org) || null : null });
  return out;
}

// Turn a live stale verdict into a learned observation: the sign-in age of the session the server
// refused. The refused session is the live app jar (a switch restores the target's capture into it),
// so its creation time is the sign-in being judged. Returns the observation recorded, or null.
function noteStale(ctx, stale, opts) {
  opts = opts || {};
  if (!stale || !stale.stale || !stale.at) return null;
  const t = opts.times !== undefined ? opts.times : jarTimes(appauth.cookiesPath(ctx), opts);
  if (!t || !t.signedInAt) return null;
  const ageDays = (Date.parse(stale.at) - t.signedInAt) / DAY;
  // A refusal that predates this sign-in is about a previous session, not this one.
  if (!isFinite(ageDays) || ageDays < 0) return null;
  const obs = {
    at: stale.at,
    profile: stale.profile || profileForOrg(ctx.configDir, stale.org) || null,
    ageDays: Math.round(ageDays * 10) / 10,
  };
  recordStale(ctx.configDir, obs);
  return obs;
}

export {
  report,
  noteStale,
  worst,
  profileForOrg,
  chromeToMs,
  jarTimes,
  sqlTimes,
  splitValues,
  describe,
  fmt,
  claudeLogPath,
  staleRelogin,
  recordStale,
  staleAfterDays,
  readObservations,
  freshnessFile,
  EXPIRY_WARN_DAYS,
};
