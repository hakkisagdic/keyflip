// SWITCH PREFLIGHT (E-#38): describe what `keyflip <account>` WOULD do BEFORE it does it.
//
// A switch writes to up to four places (CLI credential store, desktop-app login, browser session,
// consolidated chat pointers) and the outcome depends on live state: is the app running, can we
// close it, is the target's capture still valid, does a policy allow this directory. Users learn
// that by running a switch and watching — which is not a dry run. This module turns those facts into
// a PLAN: what gets written, what gets skipped, what blocks it.
//
// PURE BY CONSTRUCTION: `build()` receives already-collected facts and returns plain data. It never
// reads a credential, never touches a store, and has no side effects — which is what lets
// `--dry-run` be safe to run at any time (app open, another account active, no confirmations) and
// lets this whole branch be tested without a machine to switch.
//
// `shouldRollback()` is the matching decision function: given the post-switch read-back (see
// verify.js) it says whether to put the previous account back. Also pure — the caller decides how
// loudly to warn, because a rollback RE-WRITES credential stores.
//
// build() returns { mode, writes[], skips[], warns[], blockers[], wouldQuit, needsConfirm } — data
// only; the CLI owns the rendering, so a plan can be printed, diffed or asserted on identically.

// A switch can end up in one of these shapes. Mirrors cmdSwitch's real branches so the plan cannot
// drift from the code it describes.
//   'already-active' — nothing to do (both surfaces are already on the target)
//   'app-only'       — the CLI is already the target; only the desktop app's login lags
//   'restart'        — full switch; Claude gets quit and reopened
//   'in-place'       — full switch with --force; Claude keeps running and may fight the swap
//   'plain'          — full switch; Claude is closed (or cannot be managed on this OS)
//   'refuse'         — nothing runs: a blocker stops the switch before it starts
function build(facts, opts) {
  facts = facts || {};
  opts = opts || {};
  const autoYes = !!opts.autoYes;
  const force = !!opts.force;
  const plan = { mode: 'plain', writes: [], skips: [], warns: [], blockers: [], wouldQuit: false, needsConfirm: false };

  const push = function (arr, msg) {
    if (msg) arr.push(msg);
  };
  // A refused switch promises NOTHING — an empty write list is the guarantee behind `--dry-run`'s
  // "nothing was changed", so every refusal path funnels through here instead of leaving half a plan.
  const refuse = function (msg) {
    plan.mode = 'refuse';
    plan.writes = [];
    plan.wouldQuit = false;
    plan.needsConfirm = false;
    if (msg) plan.blockers.push(msg);
    return plan;
  };

  // What the TARGET can actually authenticate with, from the read-back verifier (may be absent when
  // the caller skipped verification). A switch that "succeeds" onto a dead capture is the failure
  // this whole feature exists to surface BEFORE the machine moves.
  const state = facts.targetState || null;
  if (state === 'fail')
    push(
      plan.warns,
      "'" +
        facts.target +
        "' is NOT usable right now (" +
        (facts.targetDetail || 'its credentials are dead') +
        ') — the switch would land on a surface that cannot authenticate.',
    );
  else if (state === 'none')
    push(plan.warns, "nothing captured for '" + facts.target + "' — there is no credential to switch to.");
  else if (state === 'warn')
    push(
      plan.warns,
      "'" + facts.target + "' is usable but decaying (run `keyflip verify " + facts.target + ' --usage`).',
    );
  // A revoked grant has no refresh token at all: no command can revive it, and a plan that buried
  // that behind "refreshes during the switch" would send the user into a dead session.
  if (facts.tokenDead)
    push(
      plan.warns,
      'its stored CLI token cannot be refreshed (Claude stores no refresh token) — only a real sign-in fixes that surface.',
    );

  // --- already-active / app-only branch --------------------------------------------------------
  if (facts.email && facts.email === facts.activeCliEmail) {
    const appNow = facts.appActiveProfile; // null = can't tell, '' = app on an unsaved account
    if (appNow === null || appNow === facts.target || !facts.appCaptured) {
      plan.mode = 'already-active';
      push(plan.skips, 'the CLI is already on this account');
      if (appNow === facts.target) push(plan.skips, 'the desktop app is already on it too');
      if (!facts.appCaptured && appNow !== null && appNow !== facts.target)
        push(plan.skips, "the app is on another account, but no app login is saved for '" + facts.target + "'");
      return plan;
    }
    plan.mode = 'app-only';
    plan.writes.push("the Claude desktop app's login → " + facts.target);
    plan.writes.push('consolidated chat pointers');
    if (appNow) push(plan.warns, 'the CLI already reads as this account; only the desktop app is on ' + appNow + '.');
    else
      push(
        plan.warns,
        'the CLI already reads as this account; the desktop app is on an account keyflip has not saved.',
      );
    if (facts.appRunning) {
      if (!facts.canManageApp)
        return refuse('Claude is open and cannot be auto-closed on this OS — quit it first, or --force.');
      plan.wouldQuit = true;
      // A prompt is not a blocker — it is just the next thing that will happen. Callers set --restart
      // (or answer it), and the plan says so instead of looking like a refusal.
      if (!autoYes) plan.needsConfirm = true;
    }
    return plan;
  }

  // --- full switch -----------------------------------------------------------------------------
  if (facts.policyDenied) return refuse(facts.policyDenied + '  (override with --force)');

  if (facts.cliCaptured) plan.writes.push('the CLI login (OAuth blob) → ' + facts.target);
  else
    push(
      plan.skips,
      "no CLI login captured for '" + facts.target + "' — the desktop app would move, the CLI would not",
    );

  if (facts.appCaptured) plan.writes.push("the Claude desktop app's login → " + facts.target);
  else push(plan.skips, 'no saved desktop-app login for this account — the app stays where it is');

  if (opts.browser) {
    if (facts.browserCaptured) plan.writes.push('the browser claude.ai session → ' + facts.target);
    else
      push(
        plan.skips,
        '--browser was given but no saved browser session exists for this account (capture one with `keyflip browser capture`)',
      );
  }
  if (facts.cliCaptured || facts.appCaptured) plan.writes.push('consolidated chat pointers');

  if (facts.appRunning) {
    if (force) {
      plan.mode = 'in-place';
      push(
        plan.warns,
        '--force swaps while Claude keeps running: the app can rewrite the shared login back to its own account, and its cookies stay locked until you restart it.',
      );
    } else if (facts.canManageApp) {
      plan.mode = 'restart';
      plan.wouldQuit = true;
      push(plan.warns, 'Claude will be QUIT and REOPENED as part of this switch.');
      if (!autoYes) plan.needsConfirm = true;
    } else if (autoYes) {
      plan.mode = 'plain';
      push(
        plan.warns,
        'Claude cannot be auto-closed on this OS; --yes swaps the CLI only and you restart it yourself.',
      );
    } else return refuse('Claude is open and cannot be auto-closed on this OS — quit it first, or --force.');
  }

  // Saved-session decay: the token gets refreshed at switch time when possible, so a stale-but-
  // refreshable capture is not a blocker; say what will happen.
  if (facts.needsRefresh && plan.mode !== 'refuse')
    push(
      plan.skips,
      'its stored OAuth token is expiring — `keyflip` refreshes it during the switch when no session is live',
    );

  return plan;
}

// What a rollback can HONESTLY restore. A switch moves up to three things (CLI blob, app login,
// browser session); a rollback can only put back something that was itself a saved profile AND was
// actually moved by this switch, so the caller never claims more recovery than it performed.
// prev = { cli, app, target } (account names before the switch), moved = { cli:bool, app:bool }.
function rollbackScope(prev, moved) {
  prev = prev || {};
  moved = moved || {};
  const out = { cli: null, app: null, notes: [] };
  if (moved.cli) {
    if (prev.cli && prev.cli !== prev.target) out.cli = prev.cli;
    else
      out.notes.push(
        prev.cli
          ? 'the CLI was already on the target — nothing to restore there'
          : "the previous CLI account isn't a saved profile, so keyflip cannot put it back",
      );
  }
  if (moved.app) {
    if (prev.app && prev.app !== prev.target && prev.appCaptured) out.app = prev.app;
    else if (prev.app && prev.app !== prev.target)
      out.notes.push("no saved app login for '" + prev.app + "' — the desktop app cannot be moved back");
  }
  return out;
}

// Should the previous account be put back? Pure so the policy is testable; the caller owns the
// (credential-writing) action. Only ever answers `do:true` when the user opted in, because a
// rollback re-writes the very stores a switch just wrote — and if the user has already begun fixing
// the new account by hand, silently undoing the switch would clobber that.
// readback = the post-switch read-back: { scope, state, detail, appSignedIn, cliMismatch }.
function shouldRollback(readback, opts) {
  opts = opts || {};
  const no = { do: false, reason: null };
  if (!opts.rollbackOnFail) return no;
  const res = readback || {};
  // The app reopened on its sign-in screen: the saved cookie was refused. That is the single most
  // confusing half-switch, and it is directly observable, so it stands alone.
  if (res.appSignedIn === false) {
    const why = { do: true, reason: 'the desktop app reopened on its SIGN-IN screen — the saved session was refused' };
    return guard(why, res);
  }
  // The credential on disk is still the previous account: the write never landed, so nothing else
  // about this switch can be trusted.
  if (res.cliMismatch)
    return guard({ do: true, reason: 'the CLI credential on disk is still ' + res.cliMismatch }, res);
  if (res.state === 'fail' || res.state === 'none')
    return guard(
      {
        do: true,
        reason: 'the account we switched to cannot authenticate (' + (res.detail || 'no usable credential') + ')',
      },
      res,
    );
  return no;
}

// A rollback is only offered when there is something to roll INTO — half-restoring a machine would
// leave the user worse off than an honest warning.
function guard(decision, res) {
  const scope = (res && res.scope) || {};
  if (scope.cli || scope.app) return decision;
  return {
    do: false,
    reason:
      decision.reason +
      '; and nothing can be rolled back' +
      (scope.notes && scope.notes.length ? ' (' + scope.notes.join('; ') + ')' : ''),
  };
}

export { build, rollbackScope, shouldRollback };
