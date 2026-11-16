// Plan, execution and verification of `keyflip browser sync`, shared by the CLI and the MCP tool.
//
// The point: restoring a browser's claude.ai session means closing and reopening the browser, which
// the user must be told about BEFORE it happens, never after. `plan()` is read-only and prints what
// would happen; `execute()` does it (only called once the caller holds a confirmation) and then reads
// the cookie jar back to say whether the browser really ended up on the target account.
//
// No function here returns or logs a cookie value: only browser names, account names and the first
// 8 characters of an org id.
import * as _browser from './browser.js';
import * as _bs from './browserswitch.js';
import * as profiles from './profiles.js';
import { run as _run } from './exec.js';

const SURFACES = ['cli', 'desktop'];

// The saved account the Desktop app is on. det.account is the app's claude-code-sessions folder
// (an account UUID), NOT a keyflip profile name, so map by organization id, like `keyflip list`.
// guess is true when detection fell back (det.reason set), so callers can say it is not certain.
export function desktopProfile(ctx, det) {
  det = det || {};
  const name = det.org ? _bs.orgOwner(ctx.configDir, det.org) || null : null;
  return { name: name, guess: !!(name && det.reason) };
}

// Which saved account the browser should follow.
//   o = { name, surface, cli, desktop } — name: an explicit account; surface: 'cli'|'desktop' (--for);
//   cli/desktop: the saved account each surface is signed into right now (or null).
// Returns { name, surface, differ, ambiguous }. When both surfaces are on different accounts and the
// caller named neither, `ambiguous` is true and name is the CLI's (a status default only: sync must
// not guess, because a wrong guess is exactly the bug this module exists to prevent).
function resolveTarget(o) {
  o = o || {};
  const cli = o.cli || null;
  const desktop = o.desktop || null;
  const differ = !!(cli && desktop && cli !== desktop);
  if (o.name) return { name: o.name, surface: 'account', differ: differ, ambiguous: false };
  if (o.surface === 'cli') return { name: cli, surface: 'cli', differ: differ, ambiguous: false };
  if (o.surface === 'desktop') return { name: desktop, surface: 'desktop', differ: differ, ambiguous: false };
  if (differ) return { name: cli, surface: 'cli', differ: true, ambiguous: true };
  return { name: cli || desktop, surface: cli ? 'cli' : 'desktop', differ: false, ambiguous: false };
}

function isSurface(s) {
  return SURFACES.indexOf(s) !== -1;
}

function orgShort(org) {
  return org ? String(org).slice(0, 8) : '';
}

function targetOrg(ctx, name) {
  const m = profiles.read(ctx.configDir, name) || {};
  return (m.oauthAccount && m.oauthAccount.organizationUuid) || null;
}

// Classify a cookie read taken after the browser reopened.
//   ok | signed-out (no sessionKey) | mismatch (another org) | unreadable
function classify(ck, wantOrg) {
  if (!ck) return { state: 'unreadable' };
  if (!/(?:^|;\s*)sessionKey=/.test(ck.cookie || '')) return { state: 'signed-out' };
  if (wantOrg && ck.org && ck.org !== wantOrg) return { state: 'mismatch', org: orgShort(ck.org) };
  if (wantOrg && !ck.org) return { state: 'unreadable' };
  return { state: 'ok' };
}

// Read-only plan for syncing `name`. Returns
//   { account, browsers: [{ browser, id, running, hasSnapshot, restoresTabs }], restartNeeded, noSession }
// browsers lists only those that have a saved session for the account; noSession is true when none does.
function plan(ctx, name, opts) {
  opts = opts || {};
  const br = opts.browser || _browser;
  const list = opts.installed || br.installed(ctx.home, { platform: ctx.platform });
  const rows = [];
  list.forEach(function (b) {
    const has = !!br.loadSession(ctx.configDir, name, b);
    rows.push({
      browser: b.name,
      id: b.id,
      running: !!br.isRunning(b, opts.run),
      hasSnapshot: has,
      restoresTabs: _bs.restoresTabs(b, opts),
      _b: b,
    });
  });
  const usable = rows.filter(function (r) {
    return r.hasSnapshot;
  });
  return {
    account: name,
    browsers: usable,
    all: rows,
    restartNeeded: usable.some(function (r) {
      return r.running;
    }),
    noSession: usable.length === 0,
  };
}

// The one-line-per-browser text of a plan (no values, no paths).
function planLines(p, label) {
  const out = [];
  p.browsers.forEach(function (r) {
    if (!r.running) {
      out.push(
        r.browser + ' is closed: its claude.ai session will be written, then it stays closed. Account: ' + label,
      );
      return;
    }
    out.push(
      r.browser +
        ' will be QUIT and reopened. ' +
        (r.restoresTabs
          ? 'It restores the open tabs itself.'
          : 'WARNING: it does not restore open tabs on relaunch, so they may be lost.') +
        ' Account: ' +
        label,
    );
  });
  return out;
}

// The two steps that finish an account with no saved browser session.
function noSessionSteps(name) {
  return [
    'no saved browser session for ' + name + ': nothing was restored.',
    '1. In the browser, sign into claude.ai as ' + name + '.',
    '2. Run: keyflip browser capture --account ' + name,
  ];
}

// Run the plan. deps: { browser, run, sleep, verifyWaitMs }. Never restores another account's session
// (the snapshot store is keyed by account). Returns
//   { synced: [name], skipped: [{browser, reason}], verified: bool, verify: [{browser, state, org?}] }
async function execute(ctx, name, p, deps) {
  deps = deps || {};
  const br = deps.browser || _browser;
  const run = deps.run || _run;
  const sleep =
    deps.sleep ||
    function (ms) {
      return new Promise(function (r) {
        setTimeout(r, ms);
      });
    };
  const out = { synced: [], skipped: [], verified: false, verify: [] };
  const wantOrg = targetOrg(ctx, name);
  for (let i = 0; i < p.browsers.length; i++) {
    const row = p.browsers[i];
    const b = row._b;
    const sql = br.loadSession(ctx.configDir, name, b);
    if (!sql) {
      out.skipped.push({ browser: row.browser, reason: 'no-snapshot' });
      continue;
    }
    const was = !!br.isRunning(b, run);
    if (was) {
      br.quit(b, run);
      for (let t = 0; t < 24 && br.isRunning(b, run); t++) await sleep(250);
    }
    // Never write into a live Cookies DB: it corrupts it.
    if (br.isRunning(b, run)) {
      out.skipped.push({ browser: row.browser, reason: 'did-not-quit' });
      continue;
    }
    const r = br.restoreClaudeCookies(b, sql, { force: true });
    if (!r || !r.ok) {
      out.skipped.push({ browser: row.browser, reason: 'restore-failed' });
      if (was) br.reopen(b, run);
      continue;
    }
    out.synced.push(row.browser);
    if (was) br.reopen(b, run);
  }
  if (out.synced.length) {
    await sleep(deps.verifyWaitMs == null ? 3000 : deps.verifyWaitMs);
    out.synced.forEach(function (n) {
      const row = p.browsers.filter(function (r) {
        return r.browser === n;
      })[0];
      const ck = (function () {
        try {
          return br.readClaudeCookies(row._b, { run: run });
        } catch {
          return null;
        }
      })();
      out.verify.push(Object.assign({ browser: n }, classify(ck, wantOrg)));
    });
    out.verified =
      out.verify.length > 0 &&
      out.verify.every(function (v) {
        return v.state === 'ok';
      });
  }
  return out;
}

// Strip the internal handle before a plan goes into JSON.
function publicPlan(p) {
  return {
    account: p.account,
    restartNeeded: p.restartNeeded,
    noSession: p.noSession,
    browsers: p.browsers.map(function (r) {
      return { browser: r.browser, running: r.running, restoresTabs: r.restoresTabs };
    }),
  };
}

export {
  targetOrg as orgOf,
  resolveTarget,
  isSurface,
  classify,
  plan,
  planLines,
  noSessionSteps,
  execute,
  publicPlan,
  orgShort,
};
