// Tests for the switch PREFLIGHT (src/switchplan.js): the plan a switch would produce, and the
// decision whether to roll it back. Both are pure functions of facts, so the whole branch is
// testable without a machine to switch — and that is exactly the point: a user can trust `--dry-run`
// because the code behind it provably cannot write.
import test from 'node:test';
import assert from 'node:assert';
import * as plan from '../src/switchplan.js';

// A neutral, fully-captured target on a different account, Claude closed. Individual tests bend one
// fact at a time so each assertion names the reason for the mode.
function facts(overrides) {
  return Object.assign(
    {
      target: 'gmail',
      email: 'me@gmail.com',
      activeCliEmail: 'me@yahoo.com',
      activeCliProfile: 'yahoo',
      appActiveProfile: 'yahoo',
      appCaptured: true,
      cliCaptured: true,
      appRunning: false,
      canManageApp: true,
      browserCaptured: true,
      needsRefresh: false,
      tokenDead: false,
      policyDenied: null,
      targetState: 'ok',
      targetDetail: null,
    },
    overrides || {},
  );
}

test('a normal switch plans every surface it can move', function () {
  const p = plan.build(facts(), {});
  assert.strictEqual(p.mode, 'plain');
  assert.strictEqual(p.writes.length, 4, JSON.stringify(p.writes)); // CLI blob, app login, browser, chats
  assert.match(p.writes.join(' '), /CLI login/);
  assert.match(p.writes.join(' '), /desktop app/);
  assert.match(p.writes.join(' '), /browser claude.ai session/, 'the browser moves by default now');
  assert.match(p.writes.join(' '), /chat/);
  assert.strictEqual(p.wouldQuit, false);
  assert.strictEqual(p.blockers.length, 0);
});

test('--dry-run of an already-active account writes nothing at all', function () {
  const p = plan.build(
    facts({
      activeCliEmail: 'me@gmail.com',
      appActiveProfile: 'gmail',
      browsers: [{ browser: 'Chrome', action: 'already' }],
    }),
    {},
  );
  assert.strictEqual(p.mode, 'already-active');
  assert.deepStrictEqual(p.writes, []);
  assert.match(p.skips.join(' '), /already on this account/);
});

test('the CLI being active but the app lagging is an app-only switch, not a no-op', function () {
  const p = plan.build(
    facts({
      activeCliEmail: 'me@gmail.com',
      appActiveProfile: 'yahoo',
      browsers: [{ browser: 'Chrome', action: 'already' }],
    }),
    {},
  );
  assert.strictEqual(p.mode, 'app-only');
  assert.strictEqual(p.writes.length, 2, JSON.stringify(p.writes));
  assert.doesNotMatch(p.writes.join(' '), /CLI login/, 'must not claim to move a CLI that is already there');
  assert.match(p.warns.join(' '), /only the desktop app is on yahoo/);
});

test('--force keeps Claude up and says the app can fight the swap', function () {
  const p = plan.build(facts({ appRunning: true }), { force: true });
  assert.strictEqual(p.mode, 'in-place');
  assert.strictEqual(p.wouldQuit, false);
  assert.match(p.warns.join(' '), /rewrite the shared login|can rewrite/);
});

test('a managed, running Claude means quit + reopen, and no --restart means a prompt first', function () {
  const p = plan.build(facts({ appRunning: true }), {});
  assert.strictEqual(p.mode, 'restart');
  assert.strictEqual(p.wouldQuit, true);
  assert.strictEqual(p.needsConfirm, true, 'the plan must tell the user it will ask');
  assert.match(p.warns.join(' '), /QUIT and REOPENED/);
  assert.strictEqual(plan.build(facts({ appRunning: true }), { autoYes: true }).needsConfirm, false);
});

test('an app that cannot be auto-closed blocks the switch unless --force or --yes', function () {
  const p = plan.build(facts({ appRunning: true, canManageApp: false }), {});
  assert.strictEqual(p.mode, 'refuse');
  assert.strictEqual(p.writes.length, 0, 'a refused switch plans no writes');
  assert.match(p.blockers.join(' '), /cannot be auto-closed/);
  // --yes on such a platform swaps the CLI only, which is what actually happens.
  assert.strictEqual(plan.build(facts({ appRunning: true, canManageApp: false }), { autoYes: true }).mode, 'plain');
});

test('a policy block is reported as a blocker, with the override', function () {
  const p = plan.build(facts({ policyDenied: "policy denied: account 'gmail' may not be used here — work dir" }), {});
  assert.strictEqual(p.mode, 'refuse');
  assert.deepStrictEqual(p.writes, []);
  assert.match(p.blockers.join(' '), /override with --force/);
});

test('a dead capture is warned about BEFORE the machine moves', function () {
  const dead = plan.build(facts({ targetState: 'fail', targetDetail: 'cli token (stored): expired' }), {});
  assert.match(dead.warns.join(' '), /NOT usable right now/);
  assert.match(dead.warns.join(' '), /cannot authenticate/);
  const none = plan.build(facts({ targetState: 'none' }), {});
  assert.match(none.warns.join(' '), /nothing captured/);
  assert.strictEqual(plan.build(facts({ targetState: 'ok' }), {}).warns.length, 0);
});

test('missing captures degrade to skips instead of promising a surface it cannot move', function () {
  const p = plan.build(facts({ cliCaptured: false, appCaptured: false, browserCaptured: false }), {});
  assert.match(p.skips.join(' '), /no CLI login/);
  assert.match(p.skips.join(' '), /no saved desktop-app login/);
  assert.deepStrictEqual(p.writes, [], 'nothing captured -> nothing promised');
});

test('the browser is only promised when a browser session is actually saved', function () {
  assert.match(plan.build(facts(), {}).writes.join(' '), /browser claude.ai session/);
  const none = plan.build(facts({ browserCaptured: false }), {});
  assert.match(none.skips.join(' '), /no saved browser session/);
  // Left out on purpose (legacy browser:false, or --only without it): never written.
  assert.doesNotMatch(plan.build(facts(), { browser: false }).writes.join(' '), /browser/);
});

test('per-browser facts become one honest line each: restore, already there, or why not', function () {
  const p = plan.build(
    facts({
      browsers: [
        { browser: 'Chrome', action: 'skip', reason: 'would-lose-tabs' },
        { browser: 'Brave', action: 'sync', quit: true },
        { browser: 'Arc', action: 'skip', reason: 'no-snapshot' },
        { browser: 'Edge', action: 'already' },
      ],
    }),
    {},
  );
  const w = p.writes.join(' | ');
  const s = p.skips.join(' | ');
  assert.match(w, /Brave claude.ai session → gmail \(Brave is closed and reopened/);
  assert.doesNotMatch(w, /Chrome|Arc|Edge/, 'only the browser that will actually move is a write');
  assert.match(s, /Chrome is open and would lose its tabs.*--only browser/);
  assert.match(s, /Arc: no saved claude.ai session.*keyflip browser capture gmail/);
  assert.match(s, /Edge claude.ai is already on this account/);
  // A skipped browser never blocks the other surfaces.
  assert.strictEqual(p.mode, 'plain');
  assert.match(w, /CLI login/);
});

test('CLI + app already there but the browser lags: a browser-only switch, not a no-op', function () {
  const p = plan.build(
    facts({
      activeCliEmail: 'me@gmail.com',
      appActiveProfile: 'gmail',
      browsers: [{ browser: 'Chrome', action: 'sync' }],
    }),
    {},
  );
  assert.strictEqual(p.mode, 'browser-only');
  assert.deepStrictEqual(p.writes, ['the Chrome claude.ai session → gmail']);
});

test('--only narrows the plan to the chosen surfaces and names what it left out', function () {
  const b = plan.build(facts(), { surfaces: { cli: false, app: false, browser: true, only: true } });
  assert.strictEqual(b.mode, 'browser-only');
  assert.deepStrictEqual(b.writes, ['the browser claude.ai session → gmail']);
  assert.match(b.skips.join(' '), /CLI and the desktop app — left out by --only/);

  const c = plan.build(facts({ appRunning: true }), {
    surfaces: { cli: true, app: false, browser: false, only: true },
  });
  assert.strictEqual(c.mode, 'in-place');
  assert.strictEqual(c.wouldQuit, false, '--only cli never closes Claude');
  assert.deepStrictEqual(c.writes, ['the CLI login (OAuth blob) → gmail']);
  assert.match(c.skips.join(' '), /desktop app login — left out/);
  assert.match(c.skips.join(' '), /browser claude.ai session — left out/);
  assert.match(c.warns.join(' '), /may rewrite the shared CLI login/);
  assert.strictEqual(
    plan.build(facts({ cliCaptured: false }), { surfaces: { cli: true, app: false, browser: false, only: true } }).mode,
    'refuse',
  );

  const a = plan.build(facts({ appRunning: true }), {
    surfaces: { cli: false, app: true, browser: false, only: true },
  });
  assert.strictEqual(a.mode, 'app-only');
  assert.strictEqual(a.wouldQuit, true);
  assert.doesNotMatch(a.writes.join(' '), /CLI login/);
  const aDone = plan.build(facts({ appActiveProfile: 'gmail' }), {
    surfaces: { cli: false, app: true, browser: false, only: true },
  });
  assert.strictEqual(aDone.mode, 'already-active');
  assert.deepStrictEqual(aDone.writes, []);
});

test('an expiring-but-refreshable token is a note, not a blocker', function () {
  const p = plan.build(facts({ needsRefresh: true }), {});
  assert.match(p.skips.join(' '), /refreshes it during the switch/);
  assert.strictEqual(p.mode, 'plain');
  assert.strictEqual(p.blockers.length, 0);
});

test('rollbackScope only offers to restore what this switch actually moved', function () {
  const prev = { cli: 'yahoo', app: 'yahoo', target: 'gmail', appCaptured: true };
  const full = plan.rollbackScope(prev, { cli: true, app: true });
  assert.strictEqual(full.cli, 'yahoo');
  assert.strictEqual(full.app, 'yahoo');
  assert.deepStrictEqual(full.notes, []);

  // App-only path: the CLI never moved, so a rollback must not claim to restore it.
  const appOnly = plan.rollbackScope(prev, { cli: false, app: true });
  assert.strictEqual(appOnly.cli, null);
  assert.strictEqual(appOnly.app, 'yahoo');

  // Switched away from an account keyflip never saved -> nothing to go back to.
  const unknown = plan.rollbackScope({ cli: null, app: '', target: 'gmail' }, { cli: true, app: true });
  assert.strictEqual(unknown.cli, null);
  assert.strictEqual(unknown.app, null);
  assert.match(unknown.notes.join(' '), /isn't a saved profile/);

  // A previous app login that has no capture cannot be re-applied.
  const uncached = plan.rollbackScope(
    { cli: 'yahoo', app: 'yahoo', target: 'gmail', appCaptured: false },
    { app: true },
  );
  assert.strictEqual(uncached.app, null);
  assert.match(uncached.notes.join(' '), /no saved app login/);

  // Rolling back onto the same account the machine is already on is a no-op, not a "restore".
  const same = plan.rollbackScope({ cli: 'gmail', app: 'gmail', target: 'gmail' }, { cli: true, app: true });
  assert.strictEqual(same.cli, null);
  assert.match(same.notes.join(' '), /already on the target/);
});

test('shouldRollback only fires when the user opted in AND the read-back is bad', function () {
  const scope = { cli: 'yahoo', app: 'yahoo', notes: [] };
  const good = { scope: scope, state: 'ok', appSignedIn: true, cliMismatch: null };
  assert.deepStrictEqual(plan.shouldRollback(good, { rollbackOnFail: true }), { do: false, reason: null });
  // Without the flag: never, even on a dead machine (a rollback rewrites credentials by itself).
  assert.deepStrictEqual(plan.shouldRollback({ scope: scope, state: 'fail', detail: 'expired' }, {}), {
    do: false,
    reason: null,
  });

  const dead = plan.shouldRollback(
    { scope: scope, state: 'fail', detail: 'cli token: expired' },
    { rollbackOnFail: true },
  );
  assert.strictEqual(dead.do, true);
  assert.match(dead.reason, /cannot authenticate/);
  assert.match(dead.reason, /cli token: expired/);
  assert.strictEqual(plan.shouldRollback({ scope: scope, state: 'none' }, { rollbackOnFail: true }).do, true);
  // A decaying-but-usable account is NOT a rollback trigger: rolling back would just move the problem.
  assert.deepStrictEqual(plan.shouldRollback({ scope: scope, state: 'warn' }, { rollbackOnFail: true }), {
    do: false,
    reason: null,
  });

  const refused = plan.shouldRollback({ scope: scope, state: 'ok', appSignedIn: false }, { rollbackOnFail: true });
  assert.strictEqual(refused.do, true, 'an app that reopened on its sign-in screen is a failed switch');
  assert.match(refused.reason, /SIGN-IN screen/);
  // null = nothing to check (app never reopened) — must not be read as a refusal.
  assert.deepStrictEqual(
    plan.shouldRollback({ scope: scope, state: 'ok', appSignedIn: null }, { rollbackOnFail: true }),
    {
      do: false,
      reason: null,
    },
  );

  const stuck = plan.shouldRollback(
    { scope: scope, state: 'ok', cliMismatch: 'me@yahoo.com' },
    { rollbackOnFail: true },
  );
  assert.strictEqual(stuck.do, true);
  assert.match(stuck.reason, /did not land|still me@yahoo.com/);

  // Nothing to roll INTO -> refuse to half-restore.
  const nowhere = plan.shouldRollback(
    { scope: { cli: null, app: null, notes: ["it isn't a saved profile"] }, state: 'fail' },
    { rollbackOnFail: true },
  );
  assert.strictEqual(nowhere.do, false);
  assert.match(nowhere.reason, /nothing can be rolled back/);
  assert.match(nowhere.reason, /isn't a saved profile/);
});

test('a dead-with-no-refresh-token capture says only a sign-in fixes it', function () {
  const p = plan.build(
    facts({ targetState: 'fail', targetDetail: 'cli token (stored): expired', tokenDead: true, needsRefresh: false }),
    {},
  );
  assert.match(p.warns.join(' '), /cannot be refreshed/, p.warns.join(' | '));
  // The refresh note is for decaying tokens ONLY — a plan must not promise a refresh that cannot run.
  assert.doesNotMatch(p.skips.join(' '), /refreshes it during the switch/);
  const decaying = plan.build(facts({ targetState: 'warn', needsRefresh: true }), {});
  assert.match(decaying.skips.join(' '), /refreshes it during the switch/);
  assert.doesNotMatch(decaying.warns.join(' '), /cannot be refreshed/);
});

test('build() is pure: the same facts render the same plan, twice', function () {
  const f = facts({ appRunning: true });
  const a = plan.build(f, { force: true });
  const b = plan.build(f, { force: true });
  assert.deepStrictEqual(a, b);
  assert.notStrictEqual(a.writes, b.writes, 'a fresh object every call — no shared state to leak');
});
