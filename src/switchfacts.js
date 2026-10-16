// #38: the live FACTS a switch plan is built from. Split out of the CLI (and separate from
// switchplan.js, which stays dependency-free and pure) so that BOTH `keyflip <account> --dry-run` and
// the MCP `keyflip_switch` tool plan from exactly the same reading of the machine — an agent must not
// get a different story than the terminal.
//
// READ-ONLY BY CONSTRUCTION: every call below is a stat/read/decrypt-check; nothing here writes a
// file, a store entry or a Keychain item, and no network call is made (usage is deliberately NOT
// probed — a preflight must not spend quota). That is what makes a dry run safe with Claude open.
import * as core from './core.js';
import * as profiles from './profiles.js';
import * as appauth from './appauth.js';
import * as appctl from './platform.js';
import * as chatsession from './chatsession.js';
import * as oauth from './oauth.js';
import * as policy from './policy.js';
import * as verifymod from './verify.js';

function safe(fn, d) {
  try {
    return fn();
  } catch (e) {
    return d;
  }
}

// The saved profile the desktop app's OWN login currently matches, identified by the org uuid in its
// token. '' means "the app is signed into an account keyflip has never saved" (a real answer); null
// means "there is no app login to read" — callers must not act on null.
function appActiveProfile(ctx) {
  if (!ctx.appDataDir) return null;
  const det = safe(function () {
    return appauth.detectAppAccount(ctx);
  }, null);
  if (!det || !det.org) return null;
  let found = '';
  profiles.list(ctx.configDir).forEach(function (n) {
    if (found) return;
    const m = profiles.read(ctx.configDir, n);
    if (m && m.oauthAccount && m.oauthAccount.organizationUuid === det.org) found = n;
  });
  return found;
}

async function collect(ctx, name, opts) {
  opts = opts || {};
  const f = {
    target: name,
    email: safe(function () {
      return profiles.email(ctx.configDir, name);
    }, null),
    activeCliEmail: null,
    activeCliProfile: null,
    appActiveProfile: null,
    appCaptured: false,
    cliCaptured: false,
    appRunning: false,
    canManageApp: false,
    browserCaptured: false,
    needsRefresh: false,
    tokenDead: false,
    policyDenied: null,
    targetState: null,
    targetDetail: null,
    targetChecks: [],
  };
  f.activeCliEmail = safe(function () {
    return core.currentEmail(ctx);
  }, null);
  if (f.activeCliEmail)
    profiles.list(ctx.configDir).forEach(function (n) {
      if (!f.activeCliProfile && profiles.email(ctx.configDir, n) === f.activeCliEmail) f.activeCliProfile = n;
    });
  f.appActiveProfile = appActiveProfile(ctx);
  const blob = safe(function () {
    return ctx.store.getProfile(name);
  }, null);
  f.cliCaptured = !!blob;
  f.appCaptured = safe(function () {
    return appauth.hasProfile(ctx, name);
  }, false);
  f.appRunning = safe(function () {
    return appctl.isClaudeRunning(ctx.platform);
  }, false);
  f.canManageApp = safe(function () {
    return appctl.canManageApp(ctx.platform);
  }, false);
  f.browserCaptured = safe(function () {
    return chatsession.snapshotsFor(ctx, name).length > 0;
  }, false);
  // Report a policy block as a plan line instead of throwing — the real switch still enforces it.
  if (!opts.force)
    f.policyDenied = safe(function () {
      try {
        policy.enforce(ctx, { cwd: opts.cwd || process.cwd(), account: name });
        return null;
      } catch (e) {
        return e && e.code === 'POLICY_DENIED' ? e.message : null;
      }
    }, null);
  const r = await verifymod.verifyAccount(ctx, name, {
    // The live credential only describes the machine when the machine is ALREADY on this account.
    liveAccount: f.activeCliProfile === name ? name : null,
    currentEmail: function (c) {
      return core.currentEmail(c);
    },
  });
  const b = verifymod.brief(r);
  f.targetState = b.state;
  f.targetDetail = b.detail;
  f.targetChecks = r.checks;
  // "Refresh it during the switch" is only true of an expiring token that still holds a refresh
  // token. A dead one with an empty refreshToken (how Claude stores a revoked grant) needs a human, so
  // the plan must not promise a refresh that cannot happen.
  const stored = (r.checks || []).filter(function (c) {
    return c.name === 'cli token (stored)';
  })[0];
  f.needsRefresh = !!(oauth.isExpiring(blob) && stored && stored.refreshable && stored.state !== 'fail');
  f.tokenDead = !!(stored && stored.state === 'fail');
  return f;
}

export { collect, appActiveProfile };
