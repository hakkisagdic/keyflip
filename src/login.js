'use strict';
// Helpers for `keyflip login` — capture the credential minted by an isolated,
// OFFICIAL `claude auth login` (run with CLAUDE_CONFIG_DIR=<temp>). Claude writes
// the token to <temp>/.credentials.json; on macOS it may migrate to a Keychain
// item named "Claude Code-credentials-<sha256(dir)[:8]>". We read whichever
// exists, so the user's real login is never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// macOS Keychain service name Claude derives for a non-default CLAUDE_CONFIG_DIR.
function isoKeychainService(dir) {
  return 'Claude Code-credentials-' + crypto.createHash('sha256').update(String(dir)).digest('hex').slice(0, 8);
}

// Return the blob unchanged if it's a well-formed OAuth credential, else null.
function validBlob(s) {
  try {
    const d = JSON.parse(s);
    return d && d.claudeAiOauth && typeof d.claudeAiOauth.accessToken === 'string' && d.claudeAiOauth.accessToken.trim() ? s : null;
  } catch (e) { return null; }
}

// Read the credential an isolated `claude auth login` produced. Order: the
// plaintext file first (Linux/Windows always, macOS before migration), then the
// hashed macOS Keychain item. `opts.run` is exec.run; `opts.platform` selects OS.
function readIsolatedCredential(dir, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  try {
    const s = fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8');
    const v = validBlob(s);
    if (v) return v;
  } catch (e) { /* not a file — try keychain */ }
  if (platform === 'darwin' && opts.run) {
    const svc = isoKeychainService(dir);
    const r = opts.run('/usr/bin/security', ['find-generic-password', '-s', svc, '-w'], undefined, { timeoutMs: 8000 });
    if (r && r.code === 0 && r.stdout) {
      const v = validBlob(String(r.stdout).trim());
      if (v) return v;
    }
  }
  return null;
}

// Parse `claude auth status` JSON output → { email, orgId, orgName, plan } | null.
function parseAuthStatus(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    if (!j || typeof j !== 'object') return null;
    return { email: j.email || null, orgId: j.orgId || null, orgName: j.orgName || null, plan: j.subscriptionType || null, loggedIn: !!j.loggedIn };
  } catch (e) { return null; }
}

// Best-effort removal of the hashed Keychain item Claude may have created.
function cleanIsolatedKeychain(dir, opts) {
  opts = opts || {};
  if ((opts.platform || process.platform) !== 'darwin' || !opts.run) return;
  try { opts.run('/usr/bin/security', ['delete-generic-password', '-s', isoKeychainService(dir)], undefined, { timeoutMs: 8000 }); } catch (e) { /* ignore */ }
}

// Build the `claude auth login` argv from options. Pure — one place both the auto and
// manual login paths use, so `--sso`/`--console`/`--email` can't silently drift apart.
function buildLoginArgs(opts) {
  opts = opts || {};
  const args = ['auth', 'login', opts.useConsole ? '--console' : '--claudeai'];
  if (opts.sso) args.push('--sso');
  if (opts.email) args.push('--email', opts.email);
  return args;
}

// Run the OFFICIAL `claude auth login` in an isolated CLAUDE_CONFIG_DIR and save
// the minted token as a keyflip profile. Pure mechanics (no printing) so both the
// CLI and the MCP server can use it. opts: { email, name, useConsole, sso, stdio }.
// Returns { status:'captured'|'refreshed', name, email }. Throws Error with a
// `.code` ('claude-missing'|'login-failed'|'no-cred'|'mismatch'|'name-taken').
function performLogin(ctx, opts) {
  opts = opts || {};
  const fs = require('fs'); const path = require('path'); const os = require('os');
  const cp = require('child_process');
  const exec = require('./exec');
  const claude = require('./claude');
  const profiles = require('./profiles');
  const core = require('./core');

  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-login-'));
  const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: isoDir });
  try {
    try { claude.writeConfig(path.join(isoDir, '.claude.json'), { hasCompletedOnboarding: true }); } catch (e) { /* best-effort */ }
    const args = buildLoginArgs(opts);
    const r = cp.spawnSync('claude', args, { stdio: opts.stdio || 'inherit', env: env });
    if (r.error) { const e = new Error('could not run `claude auth login` (is Claude Code installed and on PATH?): ' + r.error.message); e.code = 'claude-missing'; throw e; }
    if (typeof r.status === 'number' && r.status !== 0) { const e = new Error('the login did not complete (exit ' + r.status + ')'); e.code = 'login-failed'; throw e; }
    return captureFromIso(ctx, isoDir, env, opts);
  } finally {
    cleanIsolatedKeychain(isoDir, { platform: ctx.platform, run: exec.run });
    try { fs.rmSync(isoDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

// Read the credential an isolated `claude auth login` just wrote, resolve the real
// identity (guard against the browser-session mismatch), and save it as a profile.
// Throws Error with `.code` on failure. Shared by the auto and manual login paths.
function captureFromIso(ctx, isoDir, env, opts) {
  opts = opts || {};
  const exec = require('./exec');
  const profiles = require('./profiles');
  const core = require('./core');
  const blob = readIsolatedCredential(isoDir, { platform: ctx.platform, run: exec.run });
  if (!blob) { const e = new Error('login completed but the new credential could not be read from the isolated store'); e.code = 'no-cred'; throw e; }
  let em = null, org = null;
  const st = parseAuthStatus(exec.run('claude', ['auth', 'status'], undefined, { timeoutMs: 8000, env: env }).stdout);
  if (st) { em = st.email || null; org = st.orgId || null; }
  if (opts.email && em && em.toLowerCase() !== opts.email.toLowerCase()) {
    const e = new Error('signed in as ' + em + ', not ' + opts.email + ' — the browser was already logged into claude.com as ' + em); e.code = 'mismatch'; e.actual = em; throw e;
  }
  let existing = null;
  if (em) profiles.list(ctx.configDir).forEach(function (n) { if (!existing && (profiles.email(ctx.configDir, n) || '').toLowerCase() === em.toLowerCase()) existing = n; });
  const finalName = existing || opts.name || core.autoName(ctx, em || '');
  if (!existing && profiles.exists(ctx.configDir, finalName) && profiles.email(ctx.configDir, finalName) !== (em || '')) {
    const e = new Error("profile '" + finalName + "' already exists for a different account — pass a name"); e.code = 'name-taken'; throw e;
  }
  ctx.store.setProfile(finalName, blob);
  const oa = {}; if (org) oa.organizationUuid = org; if (em) oa.emailAddress = em;
  profiles.write(ctx.configDir, { name: finalName, email: em || '', oauthAccount: oa, userID: '', savedAt: ctx.now(), viaLogin: true });
  return { status: existing ? 'refreshed' : 'captured', name: finalName, email: em || null };
}

// Pull the OAuth `code` out of whatever the user pastes — a bare code, or the full
// redirect URL (…/callback?code=XXX&state=…). Returns the trimmed input otherwise.
function extractCode(line) {
  const s = String(line || '').trim();
  const m = s.match(/[?&]code=([^&\s]+)/);
  return m ? decodeURIComponent(m[1]) : s;
}

// Manual/paste login: run the isolated `claude auth login` interactively; the user
// completes the sign-in however they like (email code, magic link, …) and pastes
// the resulting code OR the whole redirect URL, which we feed to claude. Resolves
// like performLogin. Interactive — for a real terminal, not the MCP server.
function performLoginManual(ctx, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    const fs = require('fs'); const path = require('path'); const os = require('os');
    const cp = require('child_process'); const readline = require('readline');
    const exec = require('./exec');
    const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-login-'));
    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: isoDir });
    try { require('./claude').writeConfig(path.join(isoDir, '.claude.json'), { hasCompletedOnboarding: true }); } catch (e) { /* best-effort */ }
    const args = buildLoginArgs(opts);

    let settled = false, rl = null;
    function cleanup() { cleanIsolatedKeychain(isoDir, { platform: ctx.platform, run: exec.run }); try { fs.rmSync(isoDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    function done(fn, arg) { if (settled) return; settled = true; try { if (rl) rl.close(); } catch (e) { /* */ } fn(arg); }

    const child = cp.spawn('claude', args, { stdio: ['pipe', 'inherit', 'inherit'], env: env });
    child.on('error', function (e) { const err = new Error('could not run `claude auth login`: ' + e.message); err.code = 'claude-missing'; cleanup(); done(reject, err); });
    child.on('exit', function () {
      // The child finished — either the browser callback completed it, or it accepted
      // the code we fed. Capture whatever credential it wrote.
      try { const res = captureFromIso(ctx, isoDir, env, opts); cleanup(); done(resolve, res); }
      catch (e) { cleanup(); done(reject, e); }
    });

    rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('\nSign in in the browser (email code, magic link, whatever). When you see a code — or land on the redirect URL — paste it here and press Enter\n(or just wait if the browser finishes on its own): ', function (line) {
      try { child.stdin.write(extractCode(line) + '\n'); } catch (e) { /* child may already be gone */ }
    });
  });
}

// Sign the Claude Code CLI out (official logout + clear the live credential +
// strip the account from ~/.claude.json). Never touches saved keyflip profiles.
function cliLogout(ctx) {
  const exec = require('./exec');
  const claude = require('./claude');
  try { exec.run('claude', ['auth', 'logout'], undefined, { timeoutMs: 8000 }); } catch (e) { /* best-effort */ }
  try { ctx.store.delLive(); } catch (e) { /* already gone */ }
  try {
    const c = claude.readConfig(ctx.claudeConfigPath);
    if (c && (c.oauthAccount || c.userID)) { delete c.oauthAccount; delete c.userID; claude.writeConfig(ctx.claudeConfigPath, c); }
  } catch (e) { /* ignore */ }
  return true;
}

module.exports = {
  buildLoginArgs: buildLoginArgs,
  isoKeychainService: isoKeychainService,
  validBlob: validBlob,
  readIsolatedCredential: readIsolatedCredential,
  parseAuthStatus: parseAuthStatus,
  cleanIsolatedKeychain: cleanIsolatedKeychain,
  performLogin: performLogin,
  performLoginManual: performLoginManual,
  captureFromIso: captureFromIso,
  extractCode: extractCode,
  cliLogout: cliLogout,
};
