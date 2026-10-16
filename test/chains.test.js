// Tests for #39 — the credential-chain map (src/chains.js).
//
// These are hermetic: a temp $HOME, a temp state repo, and hand-made stores. Nothing here talks to
// the Keychain (and the module under test must not either — several tests exist to prove that).
//
// The invariants the whole module rests on, each pinned by a test below:
//   - a node's UPSTREAM is what decides its lifetime (the app token cache bottoms out in a human);
//   - Keychain locations are reported UNPROBED, never fetched;
//   - staleness, sharing and loose modes are found from PATHS + STATS only;
//   - no secret VALUE ever leaves the module, and it WRITES NOTHING into the state repo.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as chains from '../src/chains.js';
import * as profiles from '../src/profiles.js';
import * as provider from '../src/provider.js';
import { makeCtx, assertPrivateMode } from './helpers.js';

// A string shaped like a real credential, used ONLY to prove it never appears in the output.
const SECRET_TEXT = 'sk-ant-api03-' + 'NoTReAlKeYfOrTeStsOnLyAbCdEfGhIjKlMnOpQrStUvWx';
const HOUR = 3600000;

// A context with every store location keyflip knows about pointed into the temp home.
function mkctx(overrides) {
  const ctx = makeCtx(overrides);
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  ctx.claudeSettingsPath = path.join(ctx.home, '.claude', 'settings.json');
  fs.mkdirSync(ctx.appDataDir, { recursive: true });
  fs.mkdirSync(path.join(ctx.home, '.claude'), { recursive: true });
  return ctx;
}

// Write a file (relative to the state repo, or to $HOME for `abs`) with a chosen mode and mtime.
function inRepo(ctx, rel, opts) {
  return writeFile(path.join(ctx.configDir, rel), opts);
}
function inHome(ctx, rel, opts) {
  return writeFile(path.join(ctx.home, rel), opts);
}
function writeFile(p, opts) {
  opts = opts || {};
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, opts.content === undefined ? 'ZZZ-not-a-real-secret-zzz' : opts.content);
  if (opts.mode) fs.chmodSync(p, opts.mode);
  if (opts.hoursAgo !== undefined) setAge(p, opts.hoursAgo);
  return p;
}
function setAge(p, hours) {
  const t = new Date(Date.now() - hours * HOUR);
  fs.utimesSync(p, t, t);
}

function node(c, id) {
  const n = c.nodes.filter(function (x) {
    return x.id === id;
  })[0];
  assert.ok(n, 'expected a node with id "' + id + '"');
  return n;
}
function has(c, id) {
  return c.nodes.some(function (x) {
    return x.id === id;
  });
}
function risksOf(c, kind) {
  return c.risks.filter(function (r) {
    return r.kind === kind;
  });
}
function account(c, name) {
  return c.accounts.filter(function (a) {
    return a.account === name;
  })[0];
}

// ---------------------------------------------------------------- the graph itself

test('the desktop app token cache bottoms out in a human login, not in itself', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  // The live app stores exist; the per-account copies exist; the CLI credential exists.
  inHome(ctx, 'Library/Application Support/Claude/Cookies', { content: 'cookie db' });
  inHome(ctx, 'Library/Application Support/Claude/config.json', { content: '{}' });
  inHome(ctx, '.claude/.credentials.json', { content: '{"claudeAiOauth":{"accessToken":"' + SECRET_TEXT + '"}}' });
  inRepo(ctx, 'app/work.cookies', { mode: 0o600, content: 'cookie snapshot' });
  inRepo(ctx, 'app/work.json', { content: '{"oauth:tokenCache":{"accessToken":"' + SECRET_TEXT + '"}}' });
  inRepo(ctx, 'creds/work.cred', { mode: 0o600, content: '{"accessToken":"' + SECRET_TEXT + '"}' });

  const c = chains.chains(ctx, {});
  const map = chains.index(c.nodes);

  // The derivation the whole module exists to encode: config.json is a COPY of the cookie's effect.
  assert.strictEqual(node(c, 'app-token:work').source, 'live:app-config');
  assert.deepStrictEqual(node(c, 'app-token:work').dependsOn, ['app-cookies:work']);
  assert.strictEqual(node(c, 'app-cookies:work').source, 'live:app-cookies');
  assert.deepStrictEqual(node(c, 'app-cookies:work').dependsOn, ['login:claude-app']);

  // So the snapshot's real expiry is the human login's expiry — walking up must land there.
  assert.strictEqual(chains.rootOf(node(c, 'app-token:work'), map).id, 'login:claude-app');
  assert.strictEqual(chains.rootOf(node(c, 'app-cookies:work'), map).id, 'login:claude-app');
  // The CLI profile, by contrast, is renewed by the CLI itself off the web OAuth login.
  assert.strictEqual(chains.rootOf(node(c, 'profile:work'), map).id, 'login:claude-web');
  // And the two human roots are synthetic: they are events, not files.
  assert.strictEqual(node(c, 'login:claude-app').kind, 'interactive-login');
  assert.strictEqual(node(c, 'login:claude-app').abs, null);

  // Per-account rollup: what keyflip holds, who renews it, and where it bottoms out. Note that
  // `renewableBy` only ever names the holders of files that EXIST — the human is not a renewer of
  // anything, the human is the ROOT, which is exactly why `roots` exists as its own field.
  const w = account(c, 'work');
  assert.strictEqual(w.present, 3, 'the CLI profile plus the two app stores');
  assert.deepStrictEqual(w.renewableBy.sort(), ['a fresh capture only', 'keyflip, on switch']);
  assert.deepStrictEqual(w.roots.sort(), ['login:claude-app', 'login:claude-web']);
});

test('identity metadata is never a chain root, and an opaque capture has no root at all', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  // A third-party capture keyflip copied but cannot interpret, under an account with nothing else:
  // no recorded upstream on purpose, so it must not be given a fabricated chain.
  inRepo(ctx, 'surfaces/codex/mystery/auth.json', { content: '{"opaque":true}' });
  const c = chains.chains(ctx, {});
  const s = node(c, 'surface:codex/mystery/auth.json');
  assert.strictEqual(s.source, null);
  assert.strictEqual(s.dependsOn.length, 0);
  assert.strictEqual(s.renew, 'recapture');
  assert.deepStrictEqual(account(c, 'mystery').roots, [], 'no traceable origin, so no claimed root');
  // The profile metadata is present but is not a credential...
  assert.strictEqual(node(c, 'meta:work').secret, false);
  assert.strictEqual(node(c, 'meta:work').renew, 'metadata');
  // It has no upstream, so a walk from it stops on itself — which is precisely why it is excluded
  // from `roots` rather than being reported as the origin of its own account's chain.
  assert.strictEqual(chains.rootOf(node(c, 'meta:work'), chains.index(c.nodes)).id, 'meta:work');
  // ...so neither it nor anything else may appear as a "root" it is not upstream of. Note that
  // `roots` describes the SHAPE of the chain, not what is currently on disk: work's stores are all
  // absent here, yet the chain they would form still bottoms out in the two human logins — which is
  // the honest answer to "what would have to happen for this account to be alive again".
  assert.deepStrictEqual(account(c, 'work').roots.sort(), ['login:claude-app', 'login:claude-web']);
  assert.strictEqual(account(c, 'work').present, 0);
  assert.ok(
    c.accounts.every(function (a) {
      return a.roots.indexOf('meta:work') === -1;
    }),
  );
});

test('Keychain items are reported unprobed — existence would take `security … -w`, which prints the secret', function () {
  const ctx = mkctx({ platform: 'darwin' });
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  const c = chains.chains(ctx, {});
  const live = node(c, 'live:claude');
  const prof = node(c, 'profile:work');
  assert.strictEqual(live.exists, null, 'not "false" — keyflip does not KNOW either way');
  assert.strictEqual(live.probed, false);
  assert.strictEqual(live.mode, null, 'no mode can be claimed for something never opened');
  assert.match(live.file, /^keychain:/);
  assert.match(live.note, /unprobed/);
  assert.match(prof.file, /^keychain:keyflip:work$/);
  // A tree of unprobed nodes is still a map: the account summary separates held from unprobed.
  const w = account(c, 'work');
  assert.strictEqual(w.present, 0, 'nothing keyflip can point at in the Keychain counts as held');
  assert.ok(w.unprobed >= 1);
  assert.ok(c.summary.unprobed >= 2);
});

test('the credential store name for a provider is derived from provider.js, not guessed', function () {
  const ctx = mkctx();
  provider.add(ctx, 'relay', { baseUrl: 'https://relay.example/v1', key: SECRET_TEXT, authScheme: 'bearer' });
  provider.use(ctx, 'relay');
  const c = chains.chains(ctx, {});
  // The key's location uses the SAME name provider.add wrote it under.
  assert.ok(has(c, 'provider-key:' + 'relay'), 'the provider key node exists');
  const key = node(c, 'provider-key:relay');
  assert.strictEqual(path.basename(String(key.abs)), provider.keyStoreName('relay') + '.cred');
  // ...and settings.json is the plaintext copy of it, which is a second place the secret lives.
  const mirror = node(c, 'env-mirror');
  assert.strictEqual(mirror.kind, 'env-mirror');
  assert.strictEqual(mirror.secret, true);
  assert.strictEqual(mirror.abs, ctx.claudeSettingsPath);
  assert.deepStrictEqual(mirror.dependsOn, ['provider-key:relay']);
  assert.strictEqual(
    chains.rootOf(mirror, chains.index(c.nodes)).id,
    'login:provider:relay',
    'only the vendor console renews an API key',
  );
  assert.strictEqual(node(c, 'provider-meta:relay').secret, false, 'endpoint config is not a credential');
});

// ---------------------------------------------------------------- risk: loose file mode

test('a world-readable secret inside the state repo is a high risk; the same mode OUTSIDE it is not', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  // keyflip's own capture, left at 644 by a plain copy: the whole machine can read a session cookie.
  const loose = inRepo(ctx, 'browser-sessions/work__chrome.sql', { mode: 0o644, content: 'cookie db' });
  // keyflip's own capture, written privately: fine.
  const tight = inRepo(ctx, 'app/work.cookies', { mode: 0o600, content: 'cookie snapshot' });
  // Chrome's OWN cookie DB is 644 on every Mac (macOS protects it above the filesystem layer).
  // Flagging it would put a permanent warning over a normal fact and train the user to ignore it.
  const theirs = inHome(ctx, 'Library/Application Support/Google/Chrome/Default/Cookies', {
    mode: 0o644,
    content: 'live cookie db',
  });

  const c = chains.chains(ctx, {});
  const r = risksOf(c, 'loose-mode');
  assert.strictEqual(r.length, 1, 'exactly the repo file at 644');
  assert.strictEqual(r[0].severity, 'high');
  assert.strictEqual(r[0].file, 'browser-sessions/work__chrome.sql', 'displayed relative to the state repo');
  assert.strictEqual(r[0].abs, loose, 'and carries the real path so the fix never re-derives it');
  assert.strictEqual(r[0].mode, '644');
  assert.match(r[0].detail, /readable beyond your user/);
  assert.strictEqual(node(c, 'browser:work__chrome.sql').mode, '644');
  // The other two are NOT risks — prove it by absence at the source, not just by count.
  assert.strictEqual(node(c, 'live:chrome-cookies').abs, theirs);
  assert.strictEqual(node(c, 'app-cookies:work').mode, '600');
  assert.strictEqual(
    risksOf(c, 'loose-mode').filter(function (x) {
      return x.abs === theirs || x.abs === tight;
    }).length,
    0,
  );
});

test('a directory at 755 is not flagged: only the secret CONTENT of a file is exposure', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  inRepo(ctx, 'app/work.json', { mode: 0o600, content: '{}' });
  fs.chmodSync(path.join(ctx.configDir, 'app'), 0o755);
  const c = chains.chains(ctx, {});
  assert.strictEqual(risksOf(c, 'loose-mode').length, 0);
  assert.strictEqual(node(c, 'app-token:work').dir, false);
  // A directory node (a whole opaque store copied out) is marked as one so the render never
  // implies a single blob — and it is still not a mode risk.
  fs.mkdirSync(path.join(ctx.configDir, 'surfaces', 'codex', 'work', 'leveldb'), { recursive: true });
  fs.chmodSync(path.join(ctx.configDir, 'surfaces', 'codex', 'work', 'leveldb'), 0o755);
  const d = chains.chains(ctx, {});
  assert.strictEqual(node(d, 'surface:codex/work/leveldb/').dir, true);
  assert.match(node(d, 'surface:codex/work/leveldb/').file, /\/$/);
  assert.strictEqual(risksOf(d, 'loose-mode').length, 0);
});

test('tighten: dry run by default, chmod 600 on apply, and never outside the secret set', function () {
  const ctx = mkctx();
  const loose = inRepo(ctx, 'browser-sessions/work__chrome.sql', { mode: 0o644, content: 'cookie db' });
  inRepo(ctx, 'app/work.cookies', { mode: 0o644, content: 'cookie snapshot' });
  // A loose NON-secret inside the repo (profile metadata is written 0600, but imagine 644):
  // tighten must leave it alone — it is not what the risk engine reports.
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  const meta = profiles.metaPath(ctx.configDir, 'work');
  fs.chmodSync(meta, 0o644);

  const dry = chains.tighten(ctx, {});
  assert.strictEqual(dry.applied, false);
  assert.strictEqual(dry.changed.length, 2);
  assert.ok(
    dry.changed.every(function (x) {
      return x.applied === false && x.to === '600' && x.from === '644';
    }),
    'dry run promises the mode it would set',
  );
  assert.strictEqual(dry.remaining, 2, 'and reports what is still loose, which is everything');
  assert.strictEqual(fs.statSync(loose).mode & 0o777, 0o644, 'nothing changed on disk');

  const real = chains.tighten(ctx, { apply: true });
  assert.strictEqual(real.applied, true);
  assert.strictEqual(real.changed.length, 2);
  assert.ok(
    real.changed.every(function (x) {
      return x.applied === true;
    }),
  );
  assert.strictEqual(real.remaining, 0, 'it re-scans and PROVES the fix landed');
  assertPrivateMode(loose, 'the captured cookie DB');
  assert.strictEqual(fs.statSync(meta).mode & 0o777, 0o644, 'a non-secret file was never touched');
  // The map agrees with the filesystem now.
  assert.strictEqual(risksOf(chains.chains(ctx, {}), 'loose-mode').length, 0);
});

// ---------------------------------------------------------------- risk: staleness / sharing / coverage

test('a capture older than the store it came from is stale, and says by how much', function () {
  const ctx = mkctx();
  const live = inHome(ctx, 'Library/Application Support/Google/Chrome/Default/Cookies', { content: 'db' });
  inRepo(ctx, 'browser-sessions/work__chrome.sql', { content: 'db', hoursAgo: 48 });
  // Chrome logged in as someone else 2h after the capture — the snapshot is now the past.
  setAge(live, 2);
  const c = chains.chains(ctx, {});
  const r = risksOf(c, 'stale-snapshot');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].severity, 'warn');
  assert.match(r[0].detail, /4[56]h before/, 'the gap is stated in hours, rounded up');
  assert.match(r[0].detail, /restores the past/);
  assert.deepStrictEqual(r[0].nodes, ['browser:work__chrome.sql', 'live:chrome-cookies']);
  assert.match(r[0].fix, /re-capture/);

  // Re-capture it and the risk is gone — the same shape of proof as the tighten re-scan.
  inRepo(ctx, 'browser-sessions/work__chrome.sql', { content: 'db' });
  assert.strictEqual(risksOf(chains.chains(ctx, {}), 'stale-snapshot').length, 0);
});

test('a source that no longer exists turns a capture into the only copy', function () {
  const ctx = mkctx();
  const live = inHome(ctx, 'Library/Application Support/Google/Chrome/Default/Cookies', { content: 'db' });
  inRepo(ctx, 'browser-sessions/work__chrome.sql', { content: 'db' });
  fs.rmSync(live);
  const r = risksOf(chains.chains(ctx, {}), 'lost-source');
  assert.strictEqual(r.length, 1);
  assert.match(r[0].detail, /no longer exists/);
  assert.match(r[0].detail, /only copy/);
  assert.strictEqual(r[0].nodes[0], 'browser:work__chrome.sql');
});

test('two accounts captured from one single-tenant store: only one of them can be signed in', function () {
  const ctx = mkctx();
  const live = inHome(ctx, 'Library/Application Support/Google/Chrome/Default/Cookies', { content: 'db' });
  inRepo(ctx, 'browser-sessions/alpha__chrome.sql', { content: 'db' });
  inRepo(ctx, 'browser-sessions/beta__chrome.sql', { content: 'db' });
  const c = chains.chains(ctx, {});
  const r = risksOf(c, 'shared-source');
  assert.strictEqual(r.length, 1, 'one risk naming the crowd, not one per pair');
  assert.strictEqual(r[0].severity, 'high');
  assert.match(r[0].detail, /2 captures \(alpha, beta\)/);
  assert.match(r[0].detail, /holds a single account/);
  assert.strictEqual(r[0].file, '~/' + path.relative(ctx.home, live), 'the shared store, ~-relative');
  assert.deepStrictEqual(
    r[0].nodes,
    ['browser:alpha__chrome.sql', 'browser:beta__chrome.sql'],
    'and it lists every claimant',
  );
  // One account is not a conflict — it is just a capture.
  fs.rmSync(path.join(ctx.configDir, 'browser-sessions', 'beta__chrome.sql'));
  assert.strictEqual(risksOf(chains.chains(ctx, {}), 'shared-source').length, 0);
});

test('the desktop app cookie jar is single-tenant too, so two app captures compete', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'alpha', email: 'a@example.com' });
  profiles.write(ctx.configDir, { name: 'beta', email: 'b@example.com' });
  inHome(ctx, 'Library/Application Support/Claude/Cookies', { content: 'db' });
  inRepo(ctx, 'app/alpha.cookies', { mode: 0o600, content: 'db' });
  inRepo(ctx, 'app/beta.cookies', { mode: 0o600, content: 'db' });
  const c = chains.chains(ctx, {});
  const r = risksOf(c, 'shared-source');
  assert.strictEqual(r.length, 1);
  assert.match(r[0].file, /Application Support\/Claude\/Cookies$/);
  // The token-cache copies hang off the app CONFIG (a token cache the app re-mints), which is NOT
  // single-tenant — so they must not generate a second, misleading conflict. The single-tenant mark
  // belongs on the LIVE store, because that is the thing only one account can occupy.
  assert.strictEqual(node(c, 'live:app-cookies').tenant, 'single');
  assert.strictEqual(node(c, 'app-cookies:alpha').tenant, null);
  assert.strictEqual(node(c, 'app-token:alpha').tenant, null);
});

test('a capture with no profile is invisible to `list`, and a profile with no capture restores nothing', function () {
  const ctx = mkctx();
  inRepo(ctx, 'surfaces/codex/ghost/auth.json', { content: '{}' });
  profiles.write(ctx.configDir, { name: 'empty', email: 'e@example.com' });
  const c = chains.chains(ctx, {});
  const orphan = risksOf(c, 'orphan-capture');
  assert.strictEqual(orphan.length, 1);
  assert.strictEqual(orphan[0].file, 'ghost');
  assert.match(orphan[0].detail, /no <configDir>\/ghost\.json profile/);
  assert.match(orphan[0].fix, /keyflip add ghost/);
  const un = risksOf(c, 'uncaptured-account');
  assert.strictEqual(un.length, 1);
  assert.strictEqual(un[0].file, 'empty');
  assert.match(un[0].detail, /nothing to restore/);
  assert.match(un[0].fix, /log in as empty/);
  // Give the account a credential and the second warning disappears.
  inRepo(ctx, 'creds/empty.cred', { mode: 0o600, content: '{}' });
  const after = chains.chains(ctx, {});
  assert.strictEqual(risksOf(after, 'uncaptured-account').length, 0);
  assert.ok(account(after, 'empty').present >= 1);
});

// ---------------------------------------------------------------- the report's own honesty

test('a scoped report counts only what it actually looked at', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'alpha', email: 'a@example.com' });
  profiles.write(ctx.configDir, { name: 'beta', email: 'b@example.com' });
  inRepo(ctx, 'app/alpha.cookies', { mode: 0o600, content: 'x' });
  inRepo(ctx, 'browser-sessions/alpha__chrome.sql', { mode: 0o600, content: 'x' });
  inRepo(ctx, 'browser-sessions/beta__chrome.sql', { mode: 0o644, content: 'x' });
  const live = inHome(ctx, 'Library/Application Support/Google/Chrome/Default/Cookies', { content: 'x' });
  setAge(path.join(ctx.configDir, 'browser-sessions', 'beta__chrome.sql'), 40);
  setAge(path.join(ctx.configDir, 'browser-sessions', 'alpha__chrome.sql'), 10);

  const all = chains.chains(ctx, {});
  const scoped = chains.chains(ctx, { account: 'alpha' });
  assert.strictEqual(scoped.scoped, 'alpha');
  assert.strictEqual(scoped.accounts.length, 1);
  assert.strictEqual(scoped.summary.nodes, scoped.nodes.length, 'summary matches scope, never the whole store');
  assert.ok(scoped.summary.nodes < all.summary.nodes);
  assert.strictEqual(scoped.summary.high + scoped.summary.warn, scoped.risks.length);
  // The stores alpha hangs off stay visible (they are the explanation) — machine-wide and human roots.
  assert.ok(has(scoped, 'login:claude-app'));
  assert.ok(has(scoped, 'live:app-cookies'));
  assert.ok(has(scoped, 'live:chrome-cookies'), 'its source is how a stale capture is interpretable');
  assert.strictEqual(risksOf(scoped, 'loose-mode').length, 0, "beta's 644 is not alpha's finding");
  // Beta's private finding must not leak into alpha's report…
  const betaStale = risksOf(all, 'stale-snapshot').filter(function (r) {
    return r.accounts.indexOf('beta') !== -1;
  });
  assert.strictEqual(betaStale.length, 1, 'beta has a finding of its own to be excluded for');
  assert.ok(
    scoped.risks.every(function (r) {
      return r.accounts.length === 0 || r.accounts.indexOf('alpha') !== -1;
    }),
    'every finding in alpha’s scope is alpha’s own or one alpha shares',
  );
  // …while a conflict they BOTH cause stays, and alpha's own staleness stays.
  assert.strictEqual(risksOf(scoped, 'shared-source').length, 1);
  assert.deepStrictEqual(risksOf(scoped, 'shared-source')[0].accounts.sort(), ['alpha', 'beta']);
  assert.strictEqual(risksOf(scoped, 'stale-snapshot').length, 1);
  assert.deepStrictEqual(risksOf(scoped, 'stale-snapshot')[0].accounts, ['alpha']);
  assert.ok(
    scoped.nodes.every(function (n) {
      return n.account === 'alpha' || n.account === null || n.synthetic;
    }),
  );
  assert.strictEqual(path.basename(String(live)), 'Cookies');
  // An unknown account scopes to nothing but the shared background, and says so via empty accounts.
  const none = chains.chains(ctx, { account: 'nope' });
  assert.strictEqual(none.accounts.length, 0);
  assert.deepStrictEqual(none.risks, []);
});

test('the map never emits a secret VALUE, never an absolute path out of the repo, and writes nothing', function () {
  const ctx = mkctx();
  profiles.write(ctx.configDir, { name: 'work', email: 'w@example.com' });
  inHome(ctx, '.claude/.credentials.json', { content: '{"claudeAiOauth":{"accessToken":"' + SECRET_TEXT + '"}}' });
  inHome(ctx, 'Library/Application Support/Claude/Cookies', { content: SECRET_TEXT });
  inHome(ctx, 'Library/Application Support/Claude/config.json', { content: SECRET_TEXT });
  inRepo(ctx, 'app/work.json', { content: SECRET_TEXT });
  inRepo(ctx, 'app/work.cookies', { content: SECRET_TEXT });
  inRepo(ctx, 'surfaces/codex/work/auth.json', { content: SECRET_TEXT });
  const before = snapshot(ctx.configDir);

  const c = chains.chains(ctx, {});
  assert.strictEqual(JSON.stringify(c).indexOf(SECRET_TEXT), -1, 'no content of any probed file leaves here');
  assert.ok(JSON.stringify(c).indexOf('sk-ant-api03-') === -1);
  // publicNode is the outward shape: relative paths only.
  const pub = c.nodes.map(chains.publicNode);
  assert.strictEqual(JSON.stringify(pub).indexOf('abs'), -1, 'publicNode drops the abs field entirely');
  const ppub = c.risks.map(chains.publicRisk);
  assert.strictEqual(JSON.stringify(ppub).indexOf(ctx.configDir), -1, 'publicRisk drops the absolute path too');
  assert.ok(
    ppub.every(function (r, i) {
      return r.detail === c.risks[i].detail && r.fix === c.risks[i].fix && r.kind === c.risks[i].kind;
    }),
    'but nothing a human needs to act on is lost',
  );
  assert.ok(
    pub.every(function (n) {
      return !n.file || n.file.slice(0, 1) !== '/' || n.file.indexOf(ctx.home) !== 0;
    }),
    'display paths are repo-relative or ~-relative, never raw $HOME paths',
  );
  // Size/mtime/mode are the whole payload — a shape, not a value.
  assert.strictEqual(node(c, 'app-token:work').bytes, SECRET_TEXT.length);
  assert.ok(node(c, 'app-token:work').mtime);
  // And the paths are HOME-relative even when the store lives in a dot-directory — the CLI
  // credential does (`~/.claude/.credentials.json`), and a leading-dot test would print it absolute.
  assert.strictEqual(node(c, 'live:claude').file, '~/.claude/.credentials.json');
  assert.strictEqual(c.configDir, '~/.config/keyflip');
  // And the read-only promise, proven by the filesystem rather than by the comment claiming it.
  assert.deepStrictEqual(snapshot(ctx.configDir), before, 'collect() created/changed no file in the state repo');
});

function snapshot(dir) {
  const out = [];
  const walk = function (d) {
    fs.readdirSync(d)
      .sort()
      .forEach(function (f) {
        const p = path.join(d, f);
        const st = fs.lstatSync(p);
        out.push(path.relative(dir, p) + '|' + st.mode + '|' + Math.round(st.mtimeMs) + '|' + st.size);
        if (st.isDirectory()) walk(p);
      });
  };
  walk(dir);
  return out;
}

test('risks are sorted with the actionable ones first, and every risk names a fix', function () {
  const ctx = mkctx();
  inRepo(ctx, 'browser-sessions/work__chrome.sql', { mode: 0o644, content: 'x' });
  inRepo(ctx, 'browser-sessions/other__chrome.sql', { mode: 0o644, content: 'x' });
  inHome(ctx, 'Library/Application Support/Google/Chrome/Default/Cookies', { content: 'x', hoursAgo: 0 });
  setAge(path.join(ctx.configDir, 'browser-sessions', 'other__chrome.sql'), 30);
  const c = chains.chains(ctx, {});
  assert.ok(c.risks.length >= 3);
  const sev = c.risks.map(function (r) {
    return r.severity;
  });
  assert.deepStrictEqual(
    sev,
    sev.slice().sort(function (a, b) {
      return (a === 'high' ? 0 : 1) - (b === 'high' ? 0 : 1);
    }),
    'high before warn, so the CLI prints what matters first',
  );
  assert.ok(
    c.risks.every(function (r) {
      return typeof r.fix === 'string' && r.fix.length > 5;
    }),
    'no finding is left as a complaint without a way out',
  );
  assert.ok(c.renewLegend.human === 'a human login/rotation');
});

test('a cycle in the graph walks to a stop instead of spinning', function () {
  const ctx = mkctx();
  const c = chains.chains(ctx, {});
  const map = chains.index(c.nodes);
  map['app-token:loop'] = Object.assign({}, node(c, 'live:app-config'), {
    id: 'app-token:loop',
    dependsOn: ['app-cookies:loop'],
  });
  map['app-cookies:loop'] = Object.assign({}, node(c, 'live:app-cookies'), {
    id: 'app-cookies:loop',
    dependsOn: ['app-token:loop'],
  });
  const r = chains.rootOf(map['app-token:loop'], map);
  assert.ok(r && r.id, 'it terminates at one of the two, not forever');
  assert.ok(['app-token:loop', 'app-cookies:loop'].indexOf(r.id) !== -1);
});

test('an empty state repo still maps: two human roots and nothing claimed', function () {
  const ctx = mkctx();
  const c = chains.chains(ctx, {});
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.accounts.length, 0);
  assert.ok(has(c, 'login:claude-web') && has(c, 'login:claude-app'));
  // Nothing present, nothing captured: the absence is reported as absence, not as a broken chain.
  assert.strictEqual(risksOf(c, 'loose-mode').length, 0);
  assert.strictEqual(risksOf(c, 'shared-source').length, 0);
  assert.ok(c.summary.missing > 0);
  assert.strictEqual(chains.tighten(ctx, { apply: true }).changed.length, 0);
});

test('the MCP surface exposes the map read-only and the chmod only behind confirm', async function () {
  const ctx = mkctx();
  inRepo(ctx, 'browser-sessions/work__chrome.sql', { mode: 0o644, content: 'x' });
  const names = chains.mcpTools.map(function (t) {
    return t.name;
  });
  assert.deepStrictEqual(names, ['keyflip_chains', 'keyflip_chains_tighten']);
  const ro = chains.mcpTools[0];
  assert.strictEqual(ro.annotations.readOnlyHint, true);
  const out = await ro.run(ctx, {});
  assert.ok(out.nodes.length > 0);
  assert.strictEqual(JSON.stringify(out).indexOf(ctx.configDir), -1, 'no absolute state-repo path in the payload');
  const mut = chains.mcpTools[1];
  assert.strictEqual(mut.annotations.readOnlyHint, false);
  assert.deepStrictEqual(mut.inputSchema.required, ['confirm']);
  await assert.rejects(function () {
    return mut.run(ctx, {});
  }, /confirmation required/);
  assert.strictEqual(fs.statSync(path.join(ctx.configDir, 'browser-sessions', 'work__chrome.sql')).mode & 0o777, 0o644);
  const fixed = await mut.run(ctx, { confirm: true });
  assert.strictEqual(fixed.remaining, 0);
  assert.strictEqual(fs.statSync(path.join(ctx.configDir, 'browser-sessions', 'work__chrome.sql')).mode & 0o777, 0o600);
});
