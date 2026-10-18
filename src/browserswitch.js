// The BROWSER leg of a switch: put each browser's claude.ai session (which the Claude browser
// extension inherits) on the account being switched to, as part of `keyflip <account>` — not as a
// separate opt-in. "Switch to X" means every surface ends up on X; a surface that cannot move is
// skipped AND named, never silently left on the old account.
//
// Two things make this leg different from the CLI/app legs:
//   1. Chromium keeps cookies in memory and rewrites its Cookies DB on exit, so the browser has to be
//      CLOSED for a restore to stick. Closing a browser that does not restore its tabs on relaunch
//      throws the user's tabs away — so an open browser is only closed when it will bring them back
//      (Chromium's "Continue where you left off", `session.restore_on_startup === 1`) or when the user
//      asked for the browser explicitly (`--only browser` / `--browser`).
//   2. A saved session ages: claude.ai rotates it. So before the incoming account's snapshot is
//      written, the OUTGOING account's live session is re-snapshotted under that account — but only
//      when its org identifies a saved profile and it actually carries a sessionKey (a signed-out jar
//      must never overwrite a good capture).
//
// `decide()` is pure (the whole policy, tested without a browser); `align()` executes it with
// injectable deps.
import fs from 'fs';
import path from 'path';
import * as _browser from './browser.js';
import * as profiles from './profiles.js';
import { run as _run } from './exec.js';

// Chromium reopens the previous session after a quit only with restore_on_startup === 1. Anything
// else (unset = the platform default, 4 = specific pages, 5 = new tab) loses the open tabs.
function restoresTabs(b, opts) {
  opts = opts || {};
  const read =
    opts.readFile ||
    function (p) {
      return fs.readFileSync(p, 'utf8');
    };
  try {
    const j = JSON.parse(read(path.join(path.dirname(b.cookies), 'Preferences')));
    return !!(j && j.session && j.session.restore_on_startup === 1);
  } catch (e) {
    return false; // unknown → assume tabs would be lost (the safe answer)
  }
}

function signedIn(ck) {
  return !!(ck && ck.cookie && /(?:^|;\s*)sessionKey=/.test(ck.cookie));
}

// The saved profile that owns a claude.ai org, or '' when none does.
function orgOwner(configDir, org) {
  if (!org) return '';
  let found = '';
  profiles.list(configDir).forEach(function (n) {
    if (found) return;
    const m = profiles.read(configDir, n);
    if (m && m.oauthAccount && m.oauthAccount.organizationUuid === org) found = n;
  });
  return found;
}

// What to do with ONE browser. s = { onTarget, hasSnapshot, running, restoresTabs, explicit }.
//   already — it is signed in as the target right now (nothing to write; its snapshot gets refreshed)
//   skip    — with a reason the caller prints verbatim-ish: no-snapshot | would-lose-tabs
//   sync    — restore the target's snapshot; quit:true when it has to be closed first
function decide(s) {
  s = s || {};
  if (s.onTarget) return { action: 'already' };
  if (!s.hasSnapshot) return { action: 'skip', reason: 'no-snapshot' };
  if (s.running && !s.restoresTabs && !s.explicit) return { action: 'skip', reason: 'would-lose-tabs' };
  return { action: 'sync', quit: !!s.running };
}

// Read ONE browser's state for `name` (read-only) and decide what the leg would do with it.
function inspect(ctx, name, b, wantOrg, br, opts) {
  let ck = null;
  try {
    ck = br.readClaudeCookies(b, {});
  } catch (e) {
    ck = null;
  }
  const sql = br.loadSession(ctx.configDir, name, b);
  const running = !!br.isRunning(b);
  const d = decide({
    onTarget: !!(wantOrg && ck && ck.org === wantOrg && signedIn(ck)),
    hasSnapshot: !!sql,
    running: running,
    restoresTabs: opts.restoresTabs ? opts.restoresTabs(b) : restoresTabs(b),
    explicit: !!opts.explicit,
  });
  return { ck: ck, sql: sql, running: running, d: d };
}

function targetOrg(ctx, name) {
  const meta = profiles.read(ctx.configDir, name) || {};
  return (meta.oauthAccount && meta.oauthAccount.organizationUuid) || null;
}

// The dry-run view of the leg: per browser, what align() WOULD do. Writes nothing, quits nothing.
// Returns [{ browser, action: 'already'|'skip'|'sync', reason?, quit? }].
function preview(ctx, name, opts) {
  opts = opts || {};
  const br = opts.browser || _browser;
  if (ctx.platform !== 'darwin' && !opts.anyPlatform) return [];
  const wantOrg = targetOrg(ctx, name);
  const list = opts.installed || br.installed(ctx.home);
  return list.map(function (b) {
    const s = inspect(ctx, name, b, wantOrg, br, opts);
    return Object.assign({ browser: b.name }, s.d);
  });
}

// Execute the browser leg for `name`. Returns
//   { synced: [browserName], already: [browserName], skipped: [{ browser, reason }], preserved: [{ browser, account }] }
async function align(ctx, name, opts) {
  opts = opts || {};
  const br = opts.browser || _browser;
  const run = opts.run || _run;
  const sleep =
    opts.sleep ||
    function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
  const out = { synced: [], already: [], skipped: [], preserved: [] };
  if (ctx.platform !== 'darwin' && !opts.anyPlatform) return out;
  const wantOrg = targetOrg(ctx, name);
  const list = opts.installed || br.installed(ctx.home);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const s = inspect(ctx, name, b, wantOrg, br, opts);
    const ck = s.ck;
    const sql = s.sql;
    const d = s.d;
    if (d.action === 'already') {
      // It IS this account and signed in: keep its saved snapshot as fresh as the live one.
      try {
        br.saveSession(ctx.configDir, name, b, {});
      } catch (e) {
        /* best-effort */
      }
      out.already.push(b.name);
      continue;
    }
    if (d.action === 'skip') {
      out.skipped.push({ browser: b.name, reason: d.reason });
      continue;
    }
    if (d.quit) {
      br.quit(b, run);
      for (let t = 0; t < 40 && br.isRunning(b); t++) await sleep(250);
      if (br.isRunning(b)) {
        // Never write the Cookies DB of a browser that is still running — it would be overwritten
        // on exit at best and corrupted at worst.
        out.skipped.push({ browser: b.name, reason: 'did-not-quit' });
        continue;
      }
    }
    // Re-snapshot the account this browser is LEAVING (after the quit, so the jar is flushed).
    const outgoing = ck && signedIn(ck) ? orgOwner(ctx.configDir, ck.org) : '';
    if (outgoing && outgoing !== name) {
      try {
        if (br.saveSession(ctx.configDir, outgoing, b, {})) out.preserved.push({ browser: b.name, account: outgoing });
      } catch (e) {
        /* best-effort */
      }
    }
    const r = br.restoreClaudeCookies(b, sql, { force: true });
    if (r && r.ok) out.synced.push(b.name);
    else out.skipped.push({ browser: b.name, reason: 'restore-failed' });
    if (d.quit) run('open', ['-a', b.proc]);
  }
  return out;
}

export { align, preview, decide, restoresTabs, signedIn, orgOwner };
