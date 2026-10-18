// `keyflip verify [account]` — PROVE a login/switch actually landed, instead of trusting that a
// command exited 0.
//
// Why this exists: every painful failure of the last week was a *silent* half-switch. The desktop
// app reopened on its onboarding screen after a "successful" switch because the captured sessionKey
// was 6 days dead. `kiro-cli` reported "Not logged in" with a perfectly valid token stored as
// pretty-printed JSON. In all of those cases every write had succeeded — the state was simply not
// usable, and nothing read it back the way the real tool does.
//
// So verification here means: re-read each surface the way its own application does, and say which
// of these four states it is in.
//   ok    the tool would accept this right now
//   warn  usable today, but will not be (expiring token / expiring / aging capture)
//   fail  present but unusable (expired token, no session cookie, missing file)
//   none  nothing captured for that surface (so a switch to it cannot work)
//
// SECURITY: this module NEVER returns a secret VALUE. Tokens and cookies are inspected for
// existence, size, key names and expiry only; every check result is a fixed-shape object, and the
// CLI renderer prints counts/dates, never content.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from './exec.js';
import * as oauth from './oauth.js';
import * as appauth from './appauth.js';
import * as chatsession from './chatsession.js';
import * as profiles from './profiles.js';
import * as longtoken from './longtoken.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A capture older than this is a coin flip: cloudflare/session lifetimes are measured in days, and
// the failure mode (human re-auth in the middle of work) is the one we cannot automate away.
const CAPTURE_WARN_DAYS = 3;
const CAPTURE_FAIL_DAYS = 7;

function nowMs(opts) {
  return opts && opts.now !== undefined ? opts.now : Date.now();
}
function runner(opts) {
  return (opts && opts.run) || run;
}
function check(name, state, detail, extra) {
  const out = { name: name, state: state, detail: detail || null };
  if (extra)
    Object.keys(extra).forEach(function (k) {
      out[k] = extra[k];
    });
  return out;
}

function ago(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  return min < 2880 ? min + ' min' : Math.round(min / 1440) + ' days';
}

// One credential blob -> a check. `label` distinguishes the STORED capture (what a switch would
// install) from the LIVE credential (what the machine is running right now, which Claude keeps
// fresh — the stored snapshot of the active account is almost always older, and that is fine).
// Values are never read out: only expiry numbers and the presence of a usable refresh token.
function tokenCheck(label, blob, opts) {
  if (!blob) return check(label, 'none', 'no stored credential for this account');
  let d;
  try {
    d = JSON.parse(blob);
  } catch (e) {
    return check(label, 'fail', 'the stored credential is not parseable JSON');
  }
  const o = (d && d.claudeAiOauth) || {};
  const hasRefresh = typeof o.refreshToken === 'string' && o.refreshToken.length > 0;
  // A refresh token can itself expire; then no amount of refreshing revives this account and only a
  // real sign-in will. Say so, because `refresh --all` otherwise appears to "not work".
  const refreshDead =
    hasRefresh && typeof o.refreshTokenExpiresAt === 'number' && o.refreshTokenExpiresAt <= nowMs(opts);
  if (typeof o.expiresAt !== 'number')
    return check(label, 'warn', 'no expiry recorded — treat it as usable but unverifiable', {
      refreshable: hasRefresh && !refreshDead,
    });
  const ageMin = Math.round((o.expiresAt - nowMs(opts)) / 60000);
  const iso = new Date(o.expiresAt).toISOString().slice(0, 16).replace('T', ' ');
  if (ageMin < 0) {
    if (!hasRefresh)
      return check(
        label,
        'fail',
        'expired ' +
          ago(o.expiresAt - nowMs(opts)) +
          ' ago and NO refresh token is stored (Claude does store an empty one) — needs a real login',
        {
          expiresAt: iso,
          refreshable: false,
        },
      );
    if (refreshDead)
      return check(
        label,
        'fail',
        'expired ' + ago(o.expiresAt - nowMs(opts)) + ' ago and its refresh token expired too — needs a real login',
        {
          expiresAt: iso,
          refreshable: false,
        },
      );
    return check(
      label,
      'warn',
      'access token expired ' +
        ago(o.expiresAt - nowMs(opts)) +
        ' ago — a refresh token is stored, so `keyflip refresh` can revive it',
      { expiresAt: iso, refreshable: true },
    );
  }
  if (oauth.isExpiring(blob, nowMs(opts)))
    return check(label, 'warn', 'expiring in ' + ageMin + ' min (' + iso + ')', {
      expiresAt: iso,
      refreshable: hasRefresh && !refreshDead,
    });
  return check(label, 'ok', 'valid for ~' + ago(o.expiresAt - nowMs(opts)) + ' (until ' + iso + ' UTC)', {
    expiresAt: iso,
    refreshable: hasRefresh && !refreshDead,
  });
}

// ---- 1. the CLI credential (the portable, refreshable half) ------------------------------------
function checkCliToken(ctx, name, opts) {
  const store = opts.store || ctx.store;
  let blob;
  try {
    blob = store.getProfile(name);
  } catch (e) {
    blob = null;
  }
  const c = tokenCheck('cli token (stored)', blob, opts);
  if (c.state !== 'fail' && c.state !== 'none') return c;
  // The normal login is dead — but a `keyflip login <name> --long-lived` token is what a switch
  // would hand the CLI instead (longtoken.pick). Report THAT, plus its one limitation.
  const ll = longtoken.info(store, name, nowMs(opts));
  if (!ll || !ll.usable) return c;
  return check(
    'cli token (stored)',
    ll.daysLeft !== null && ll.daysLeft < 14 ? 'warn' : 'ok',
    'one-year --long-lived token, valid ' +
      (ll.daysLeft === null ? 'with no recorded expiry' : '~' + ll.daysLeft + ' more days') +
      ' (inference-only: Remote Control / Claude in Chrome still need a full login)',
    {
      expiresAt: ll.expiresAt ? ll.expiresAt.slice(0, 16).replace('T', ' ') : null,
      refreshable: false,
      longLived: true,
    },
  );
}

// The live credential, when this account is the one the machine is on.
function checkLiveCliToken(ctx, opts) {
  let blob;
  try {
    blob = (opts.store || ctx.store).getLive();
  } catch (e) {
    blob = null;
  }
  return tokenCheck('cli token (live)', blob, opts);
}

// ---- 2. the desktop-app token cache (config.json keys, encrypted) --------------------------------
function checkAppTokenCache(ctx, name) {
  const p = appauth.profilePath(ctx, name);
  if (!p || !fs.existsSync(p))
    return check('app token cache', 'none', 'no app/<name> capture (run: keyflip add <name> --app)');
  const keys = [];
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    appauth.KEYS.forEach(function (k) {
      if (typeof o[k] === 'string' && o[k]) keys.push(k);
    });
  } catch (e) {
    return check('app token cache', 'fail', 'app/' + name + '.json is not readable JSON');
  }
  if (!keys.length) return check('app token cache', 'fail', 'capture exists but holds no token key');
  return check('app token cache', 'ok', keys.length + ' encrypted key(s) captured (' + keys.join(', ') + ')');
}

// Chromium stamps cookie expiries in microseconds since 1601-01-01. 0 / non-persistent means a
// session cookie that dies with the app.
function chromiumTimeUsToMs(us) {
  const n = Number(us);
  if (!isFinite(n) || n <= 0) return null;
  const secs = Math.floor(n / 1000000) - 11644473600;
  return secs > 0 ? secs * 1000 : null;
}

// Read WHICH claude.ai session cookies exist in a Cookies DB, and the furthest expiry. NAMES and
// expiries are plaintext in the DB, so this proves "is there a session" without ever decrypting a
// value. Returns null when sqlite cannot read the file at all.
function sessionCookieInfo(dbPath, opts) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  const tmp = path.join(os.tmpdir(), 'keyflip-verify-' + process.pid + '-' + Date.now() + '.db');
  try {
    fs.copyFileSync(dbPath, tmp);
  } catch (e) {
    return null;
  }
  try {
    const r = runner(opts)('sqlite3', [
      '-separator',
      '\t',
      'file:' + tmp + '?mode=ro',
      "SELECT name, expires_utc FROM cookies WHERE host_key LIKE '%claude.ai' AND name IN (" +
        appauth.SESSION_COOKIE_NAMES.map(function (n) {
          return "'" + n + "'";
        }).join(',') +
        ');',
    ]);
    if (!r || r.code !== 0 || !String(r.stdout || '').trim())
      return r && r.code === 0 ? { rows: [], best: null } : null;
    const rows = String(r.stdout).trim().split('\n');
    let best = null;
    rows.forEach(function (line) {
      const ms = chromiumTimeUsToMs(line.split('\t')[1]);
      if (ms && (best === null || ms > best)) best = ms;
    });
    return { rows: rows, best: best };
  } catch (e) {
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

// ---- 3. the desktop-app cookie capture (the half that needs a human when it dies) ----------------
function checkAppCookies(ctx, name, opts) {
  const p = appauth.profileCookiesPath(ctx, name);
  if (!p || !fs.existsSync(p))
    return check(
      'app session cookie',
      'none',
      'no cookie capture — `keyflip add ' + name + ' --app` with the app signed in',
    );
  const ageDays = Math.floor((nowMs(opts) - fs.statSync(p).mtimeMs) / DAY_MS);
  const info = sessionCookieInfo(p, opts);
  if (info === null) {
    // sqlite could not read it (encrypted DB we cannot open, or no sqlite3) — presence-only fallback
    return check(
      'app session cookie',
      ageDays > CAPTURE_FAIL_DAYS ? 'fail' : 'warn',
      'capture is ' + ageDays + ' day(s) old; its cookie could not be read to confirm a session',
    );
  }
  if (!info.rows.length)
    return check(
      'app session cookie',
      'fail',
      'capture is ' +
        ageDays +
        ' day(s) old and holds NO claude.ai session cookie (it was captured before the app flushed one)',
      { ageDays: ageDays },
    );
  const base = 'session cookie present, capture is ' + ageDays + ' day(s) old';
  if (info.best) {
    const left = Math.round((info.best - nowMs(opts)) / DAY_MS);
    const iso = new Date(info.best).toISOString().slice(0, 10);
    if (left < 0)
      return check(
        'app session cookie',
        'fail',
        base + ' — but it expired ' + iso + ', so switching to this account will need a manual sign-in',
        { ageDays: ageDays, expiresAt: new Date(info.best).toISOString() },
      );
    if (left <= 3)
      return check('app session cookie', 'warn', base + ' — expires ' + iso + ' (' + left + ' day(s) left)', {
        ageDays: ageDays,
        expiresAt: new Date(info.best).toISOString(),
      });
    return check('app session cookie', 'ok', base + ' — valid to ' + iso, {
      ageDays: ageDays,
      expiresAt: new Date(info.best).toISOString(),
    });
  }
  // A session cookie with no expiry dies with the app, not on a clock: fresh is fine, old is a gamble.
  if (ageDays > CAPTURE_FAIL_DAYS)
    return check(
      'app session cookie',
      'fail',
      base + ' — past the ' + CAPTURE_FAIL_DAYS + '-day mark, treat it as dead until re-captured',
      { ageDays: ageDays },
    );
  if (ageDays > CAPTURE_WARN_DAYS)
    return check('app session cookie', 'warn', base + ' — re-capture soon (a clean app quit flushes a fresh one)', {
      ageDays: ageDays,
    });
  return check('app session cookie', 'ok', base, { ageDays: ageDays });
}

// ---- 4. browser captures (the only container a web session can stay alive in) --------------------
function checkBrowserCapture(ctx, name, opts) {
  const snaps = chatsession.snapshotsFor(ctx, name);
  if (!snaps.length)
    return check(
      'browser session',
      'none',
      'no browser capture for this account (`keyflip browser capture ' + name + '`)',
    );
  const newest = snaps[0];
  // snapshotsFor() carries st.mtime (a Date), not mtimeMs.
  const mtimeMs = newest.mtime ? new Date(newest.mtime).getTime() : 0;
  const ageDays = Math.floor((nowMs(opts) - mtimeMs) / DAY_MS);
  const label = 'saved ' + newest.browserId + ' session, ' + ageDays + ' day(s) old';
  if (ageDays > CAPTURE_FAIL_DAYS)
    return check('browser session', 'warn', label + ' — old enough that the server may have rotated it', {
      ageDays: ageDays,
    });
  if (ageDays > CAPTURE_WARN_DAYS) return check('browser session', 'warn', label, { ageDays: ageDays });
  return check('browser session', 'ok', label, { ageDays: ageDays });
}

// ---- 5. live state: what the machine is ON right now, and does it match --------------------------
// `active` here means keyflip's notion (the CLI credential on disk) plus the desktop app's own
// cookie jar. A mismatch between them is exactly the "switched but the app says sign in" class.
function checkLive(ctx, name, opts) {
  const out = [];
  let liveEmail;
  try {
    liveEmail = (
      opts.currentEmail ||
      function () {
        return null;
      }
    )(ctx);
  } catch (e) {
    liveEmail = null;
  }
  const want = profiles.email(ctx.configDir, name);
  if (liveEmail && want)
    out.push(
      liveEmail.toLowerCase() === want.toLowerCase()
        ? check('live identity (CLI)', 'ok', 'this machine is on ' + liveEmail)
        : check('live identity (CLI)', 'fail', 'the CLI credential on disk is ' + liveEmail + ', not ' + want, {
            live: liveEmail,
            expected: want,
          }),
    );
  else out.push(check('live identity (CLI)', 'warn', 'the active CLI credential could not be read to compare'));
  if (ctx.platform === 'darwin') {
    const s = appauth.liveAppSession(ctx, { run: opts.run });
    if (s.checked === 'query')
      out.push(
        s.signedIn
          ? check(
              'live app session',
              'ok',
              'the desktop app is signed in' +
                (s.expiresAt ? ' (cookie valid to ' + s.expiresAt.slice(0, 10) + ')' : ' (session cookie)'),
            )
          : check(
              'live app session',
              'fail',
              'the desktop app holds NO claude.ai session cookie — it will show its sign-in screen',
            ),
      );
    else
      out.push(
        check(
          'live app session',
          'warn',
          'app cookie DB unreadable (' +
            s.reason +
            '); fell back to a byte scan: ' +
            (s.signedIn ? 'looks signed in' : 'looks signed out'),
        ),
      );
  }
  return out;
}

// ---- account sweep -------------------------------------------------------------------------------
// Everything above is per-account and offline. `--live` adds the ONE check that can only come from
// the server: what quota the stored credential can still see.
async function verifyAccount(ctx, name, opts) {
  opts = opts || {};
  const checks = [
    checkCliToken(ctx, name, opts),
    checkAppTokenCache(ctx, name),
    checkAppCookies(ctx, name, opts),
    checkBrowserCapture(ctx, name, opts),
  ];
  if (opts.usage) {
    try {
      const _usage = opts.usageModule || (await import('./usage.js'));
      const infos = await _usage.usageForProfiles(ctx, [name], {
        nowMs: nowMs(opts),
        fetch: opts.fetch,
        liveFor: opts.liveAccount || null,
      });
      const info = infos && infos[name];
      const status = info && info.status;
      if (status === 'ok')
        checks.push(
          check(
            'server says (usage)',
            'ok',
            'the stored credential can still read quota' + (info.usage ? ' — ' + _usage.fmt(info.usage) : ''),
          ),
        );
      else if (status === 'throttled')
        checks.push(
          check('server says (usage)', 'warn', 'rate-limited right now — the credential is valid, the window is full'),
        );
      else if (status === 'no-creds' || status === 'no-token')
        checks.push(check('server says (usage)', 'none', 'nothing stored to probe with'));
      else
        checks.push(
          check('server says (usage)', 'fail', 'the credential was rejected (status: ' + (status || 'unknown') + ')'),
        );
    } catch (e) {
      checks.push(
        check('server says (usage)', 'warn', 'usage probe failed: ' + String((e && e.message) || e).slice(0, 120)),
      );
    }
  }
  // The live credential belongs to exactly one account; reading it for that account is how we avoid
  // reporting the machine's working login as "expired" because its stored snapshot is older.
  if (opts.liveAccount === name) checks.splice(1, 0, checkLiveCliToken(ctx, opts));
  // Live checks describe the machine, not the capture: only meaningful for the account the machine
  // is actually on, otherwise every account would report the same live state.
  if (opts.live && opts.liveAccount && opts.liveAccount === name)
    checkLive(ctx, name, opts).forEach(function (c) {
      checks.push(c);
    });
  return { account: name, checks: checks, state: rollup(checks) };
}

// The worst state wins: an account you cannot switch to is not "ok with a warning". 'none' on a
// secondary surface (no browser capture, other account live) is normal and must not become the
// headline — only an account that holds NOTHING anywhere rolls up to 'none'.
function rollup(checks) {
  const rank = { ok: 0, warn: 2, fail: 3 };
  let worst = 'ok';
  let anything = false;
  checks.forEach(function (c) {
    if (c.state === 'none') return;
    anything = true;
    if (rank[c.state] > rank[worst]) worst = c.state;
  });
  return anything ? worst : 'none';
}

// The four verdicts, in the words the whole tool uses. `keyflip verify`, the switch preflight and
// the post-switch read-back all render through these so an account is described identically in all
// three places.
const HEADLINE = { ok: 'usable now', warn: 'usable, decaying', fail: 'NOT usable', none: 'nothing captured' };

// One-line summary of a verdict: the worst matching check's own text. Returns { state, headline,
// detail } — detail is null when everything is fine. Like every other function here it can only
// ever return a check NAME and a structural explanation, never a credential value.
function brief(result) {
  const checks = (result && result.checks) || [];
  const state = (result && result.state) || 'none';
  const headline = HEADLINE[state] || state;
  if (state === 'ok') return { state: 'ok', headline: headline, detail: null };
  const hit =
    checks.filter(function (c) {
      return c.state === state;
    })[0] ||
    checks.filter(function (c) {
      return c.state === 'fail' || c.state === 'warn';
    })[0];
  return { state: state, headline: headline, detail: hit ? hit.name + (hit.detail ? ': ' + hit.detail : '') : null };
}

async function verifyAll(ctx, opts) {
  opts = opts || {};
  const names = opts.accounts || profiles.list(ctx.configDir);
  const out = [];
  for (let i = 0; i < names.length; i++) out.push(await verifyAccount(ctx, names[i], opts));
  return out;
}

export {
  verifyAccount,
  verifyAll,
  brief,
  HEADLINE,
  tokenCheck,
  checkCliToken,
  checkLiveCliToken,
  checkAppTokenCache,
  checkAppCookies,
  checkBrowserCapture,
  checkLive,
  sessionCookieInfo,
  chromiumTimeUsToMs,
  rollup,
  CAPTURE_WARN_DAYS,
  CAPTURE_FAIL_DAYS,
};
