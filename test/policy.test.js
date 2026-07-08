'use strict';
// POLICY ENGINE: constrain which account a directory/repo may use. A hermetic makeCtx()
// gives each test a fresh temp configDir; policy.json is the only state. Group membership,
// repo resolution and subprocess are all INJECTED, so tests need no network/git/real time.
// Covers the happy path plus hostile input (prototype pollution, corrupt file, bad names,
// path-segment escapes) and the deny-beats-allow / longest-cwdPrefix decision model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('../src/policy');
const groups = require('../src/groups');
const { makeCtx } = require('./helpers');

test('evaluate resolves symlinks — a deny rule on the real path applies to a symlinked cwd (no fail-open)', function () {
  const ctx = makeCtx();
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-real-'));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pol-link-')), 'ln');
  fs.symlinkSync(real, link);
  policy.addRule(ctx, { match: { cwdPrefix: real }, deny: { accounts: ['personal'] } });
  // Enter via the SYMLINK: lexical path.resolve(link) != real, but physical realpath resolves both to
  // `real`, so the deny rule must still fire. (macOS /tmp->/private/tmp is exactly this class of bug.)
  const res = policy.evaluate(ctx, { cwd: link, account: 'personal' });
  assert.strictEqual(res.allowed, false, 'symlinked cwd resolves to the real path and hits the deny rule');
});

function ppath(ctx) { return path.join(ctx.configDir, 'policy.json'); }
// membersOf fake: a fixed group->members map, injected so no groups.json is needed.
function membersOf(map) { return function (g) { return (map && map[g]) || []; }; }

// ---- state + CRUD ----------------------------------------------------------------

test('get: no file -> empty state, default allow', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(policy.get(ctx), { rules: [], default: 'allow' });
});

test('addRule persists, assigns an id, and stores cwdPrefix absolute', function () {
  const ctx = makeCtx();
  const r = policy.addRule(ctx, { match: { cwdPrefix: '/srv/clients' }, allow: { accounts: ['work'] }, note: 'clients' });
  assert.ok(policy.isValidId(r.id), 'an id is assigned');
  assert.strictEqual(r.match.cwdPrefix, path.resolve('/srv/clients'));
  assert.strictEqual(r.createdAt, ctx.now());
  const got = policy.get(ctx);
  assert.strictEqual(got.rules.length, 1);
  assert.deepStrictEqual(got.rules[0].allow, { accounts: ['work'] });
  assert.ok(fs.existsSync(ppath(ctx)), 'policy.json written');
});

test('addRule: explicit id honored; duplicate id rejected', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'clients', match: { cwdPrefix: '/c' }, allow: { accounts: ['work'] } });
  assert.throws(function () { policy.addRule(ctx, { id: 'clients', match: { cwdPrefix: '/d' }, deny: { accounts: ['x'] } }); }, /already exists/);
});

test('addRule: rejects an empty rule and invalid names/ids', function () {
  const ctx = makeCtx();
  assert.throws(function () { policy.addRule(ctx, { match: {}, allow: {}, deny: {} }); }, /needs at least/);
  assert.throws(function () { policy.addRule(ctx, { match: { cwdPrefix: '/c' }, allow: { accounts: ['__proto__'] } }); }, /invalid account name/);
  assert.throws(function () { policy.addRule(ctx, { match: { cwdPrefix: '/c' }, allow: { groups: ['bad group'] } }); }, /invalid group name/);
  assert.throws(function () { policy.addRule(ctx, { id: '__proto__', match: { cwdPrefix: '/c' }, allow: { accounts: ['work'] } }); }, /invalid rule id/);
  assert.strictEqual(fs.existsSync(ppath(ctx)), false, 'nothing written on rejection');
});

test('removeRule returns true/false and persists', function () {
  const ctx = makeCtx();
  const r = policy.addRule(ctx, { id: 'r1', match: { cwdPrefix: '/c' }, deny: { accounts: ['personal'] } });
  assert.strictEqual(policy.removeRule(ctx, 'nope'), false);
  assert.strictEqual(policy.removeRule(ctx, r.id), true);
  assert.deepStrictEqual(policy.get(ctx).rules, []);
});

test('setDefault flips the fallback and validates', function () {
  const ctx = makeCtx();
  assert.strictEqual(policy.setDefault(ctx, 'deny'), 'deny');
  assert.strictEqual(policy.get(ctx).default, 'deny');
  assert.throws(function () { policy.setDefault(ctx, 'maybe'); }, /must be 'allow' or 'deny'/);
});

// ---- evaluate: the decision model -----------------------------------------------

test('no rules: falls back to default (allow, then deny)', function () {
  const ctx = makeCtx();
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x', account: 'work' }).allowed, true);
  policy.setDefault(ctx, 'deny');
  const d = policy.evaluate(ctx, { cwd: '/x', account: 'work' });
  assert.strictEqual(d.allowed, false);
  assert.match(d.reason, /default is 'deny'/);
});

test('allowlist is EXCLUSIVE: listed account passes, others are denied where the rule matches', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'clients', match: { cwdPrefix: '/srv/clients' }, allow: { accounts: ['work'] }, note: 'client code = work only' });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/srv/clients/acme', account: 'work' }).allowed, true);
  const denied = policy.evaluate(ctx, { cwd: '/srv/clients/acme', account: 'personal' });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.ruleId, 'clients');
  assert.match(denied.reason, /not in the allowlist.*client code = work only/);
  // Outside the matched subtree, the rule does not apply -> default allow.
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/home/me', account: 'personal' }).allowed, true);
});

test('deny beats allow WITHIN a rule', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'r', match: { cwdPrefix: '/c' }, allow: { accounts: ['work', 'personal'] }, deny: { accounts: ['personal'] } });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/c', account: 'work' }).allowed, true);
  const d = policy.evaluate(ctx, { cwd: '/c', account: 'personal' });
  assert.strictEqual(d.allowed, false);
  assert.match(d.reason, /explicitly denied/);
});

test('longest cwdPrefix governs the allow decision', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'broad', match: { cwdPrefix: '/x' }, allow: { accounts: ['alpha'] } });
  policy.addRule(ctx, { id: 'narrow', match: { cwdPrefix: '/x/y' }, allow: { accounts: ['beta'] } });
  // Under /x/y the more specific rule wins: beta allowed, alpha denied.
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x/y/z', account: 'beta' }).ruleId, 'narrow');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x/y/z', account: 'beta' }).allowed, true);
  const alpha = policy.evaluate(ctx, { cwd: '/x/y/z', account: 'alpha' });
  assert.strictEqual(alpha.allowed, false);
  assert.strictEqual(alpha.ruleId, 'narrow');
  // Under /x only the broad rule matches: alpha allowed.
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x/w', account: 'alpha' }).allowed, true);
});

test('explicit deny is a HARD block even against a more specific allow (deny beats allow globally)', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'broad-deny', match: { cwdPrefix: '/x' }, deny: { accounts: ['secret'] } });
  policy.addRule(ctx, { id: 'narrow-allow', match: { cwdPrefix: '/x/y' }, allow: { accounts: ['secret'] } });
  const d = policy.evaluate(ctx, { cwd: '/x/y/z', account: 'secret' });
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.ruleId, 'broad-deny');
});

test('blocklist rule: account not on the list passes, overriding a deny default', function () {
  const ctx = makeCtx();
  policy.setDefault(ctx, 'deny');
  policy.addRule(ctx, { id: 'block', match: { cwdPrefix: '/x' }, deny: { accounts: ['personal'] } });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x', account: 'work' }).allowed, true, 'passed the blocklist');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x', account: 'personal' }).allowed, false);
});

test('group membership is resolved (injected membersOf)', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'g', match: { cwdPrefix: '/c' }, allow: { groups: ['workpool'] } });
  const opts = { membersOf: membersOf({ workpool: ['acme', 'globex'] }) };
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/c', account: 'acme' }, opts).allowed, true);
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/c', account: 'stranger' }, opts).allowed, false);
});

test('group membership resolves via real groups.membersOf by default', function () {
  const ctx = makeCtx();
  groups.setTags(ctx, 'acme', ['workpool']);
  policy.addRule(ctx, { id: 'g', match: { cwdPrefix: '/c' }, deny: { groups: ['workpool'] } });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/c', account: 'acme' }).allowed, false, 'acme is denied via its group');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/c', account: 'other' }).allowed, true);
});

test('global rule (empty match) applies everywhere and is least specific', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'global', match: {}, allow: { accounts: ['work'] } });
  policy.addRule(ctx, { id: 'local', match: { cwdPrefix: '/open' }, allow: { accounts: ['work', 'personal'] } });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/anywhere', account: 'personal' }).allowed, false, 'global allowlist excludes personal');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/open/x', account: 'personal' }).allowed, true, 'more specific local rule permits personal');
});

// ---- repo matching ---------------------------------------------------------------

test('repo match: rule keyed on repo; repo passed in the context', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'client-repo', match: { repo: 'acme/client' }, allow: { accounts: ['work'] } });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/tmp/w', account: 'personal', repo: 'git@github.com:acme/client.git' }).allowed, false);
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/tmp/w', account: 'work', repo: 'https://github.com/acme/client' }).allowed, true);
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/tmp/w', account: 'personal', repo: 'acme/other' }).allowed, true, 'a different repo does not match -> default allow');
});

test('repo resolved from cwd via injected run (no real git)', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'r', match: { repo: 'acme/client' }, allow: { accounts: ['work'] } });
  const run = function (cmd, args) {
    if (args.indexOf('remote.origin.url') !== -1) return { code: 0, stdout: 'git@github.com:acme/client.git\n', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/tmp/w', account: 'personal' }, { run: run }).allowed, false);
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/tmp/w', account: 'work' }, { run: run }).allowed, true);
});

test('normalizeRepo canonicalizes url forms to owner/repo', function () {
  assert.strictEqual(policy.normalizeRepo('git@github.com:Acme/Client.git'), 'acme/client');
  assert.strictEqual(policy.normalizeRepo('https://github.com/acme/client/'), 'acme/client');
  assert.strictEqual(policy.normalizeRepo('ssh://git@host.xz/acme/client.git'), 'acme/client');
  assert.strictEqual(policy.normalizeRepo('acme/client'), 'acme/client');
  assert.strictEqual(policy.normalizeRepo('client'), 'client');
  assert.strictEqual(policy.normalizeRepo(''), null);
});

// ---- path-segment safety ---------------------------------------------------------

test('cwdPrefix is path-segment aware: /a/b does not match /a/bc', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'r', match: { cwdPrefix: '/a/b' }, allow: { accounts: ['work'] } });
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/a/bc', account: 'personal' }).allowed, true, 'sibling prefix does not match');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/a/b', account: 'personal' }).allowed, false, 'exact prefix matches');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/a/b/c', account: 'personal' }).allowed, false, 'descendant matches');
});

// ---- enforce ---------------------------------------------------------------------

test('enforce: returns the result when allowed, throws POLICY_DENIED when not', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'clients', match: { cwdPrefix: '/c' }, allow: { accounts: ['work'] } });
  assert.strictEqual(policy.enforce(ctx, { cwd: '/c', account: 'work' }).allowed, true);
  let err;
  try { policy.enforce(ctx, { cwd: '/c', account: 'personal' }); } catch (e) { err = e; }
  assert.ok(err && err.code === 'POLICY_DENIED', 'throws a tagged error');
  assert.match(err.message, /policy denied.*personal.*rule clients/);
  assert.strictEqual(err.policy.allowed, false);
});

// ---- hostile / robustness --------------------------------------------------------

test('hostile: a tampered policy.json cannot pollute prototypes and is sanitized', function () {
  const ctx = makeCtx();
  fs.writeFileSync(ppath(ctx), JSON.stringify({
    __proto__: { polluted: true },
    default: 'deny',
    rules: [
      { id: '__proto__', match: { cwdPrefix: '/c' }, deny: { accounts: ['x'] } }, // bad id -> dropped
      { id: 'ok', match: { cwdPrefix: '/c' }, allow: { accounts: ['work', '__proto__', 5], groups: ['bad group', 'good'] } },
      'not-an-object',
      { id: 'ok', match: {}, allow: { accounts: ['dup'] } }, // duplicate id -> dropped
    ],
  }));
  const st = policy.get(ctx);
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype not polluted');
  assert.strictEqual(st.default, 'deny');
  assert.deepStrictEqual(st.rules.map(function (r) { return r.id; }), ['ok'], 'only the first valid rule survives');
  assert.deepStrictEqual(st.rules[0].allow, { accounts: ['work'], groups: ['good'] }, 'junk accounts/groups stripped, sorted');
});

test('corrupt policy.json: reads degrade to empty, writes REFUSE to clobber', function () {
  const ctx = makeCtx();
  fs.writeFileSync(ppath(ctx), '{ not json');
  assert.deepStrictEqual(policy.get(ctx), { rules: [], default: 'allow' }, 'read degrades to empty');
  assert.strictEqual(policy.evaluate(ctx, { cwd: '/x', account: 'work' }).allowed, true, 'evaluate is safe on a corrupt file');
  assert.throws(function () { policy.addRule(ctx, { match: { cwdPrefix: '/c' }, allow: { accounts: ['work'] } }); }, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(ppath(ctx), 'utf8'), '{ not json', 'corrupt file left untouched');
});

test('policy.json is written 0600', function () {
  const ctx = makeCtx();
  policy.addRule(ctx, { id: 'r', match: { cwdPrefix: '/c' }, allow: { accounts: ['work'] } });
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(ppath(ctx)).mode & 0o777, 0o600);
});

// ---- MCP tools -------------------------------------------------------------------

test('mcp: list + check are read-only and work end to end', async function () {
  const ctx = makeCtx();
  const list = policy.mcpTools.find(function (t) { return t.name === 'keyflip_policy_list'; });
  const check = policy.mcpTools.find(function (t) { return t.name === 'keyflip_policy_check'; });
  assert.strictEqual(list.annotations.readOnlyHint, true);
  assert.strictEqual(check.annotations.readOnlyHint, true);
  policy.addRule(ctx, { id: 'clients', match: { cwdPrefix: '/c' }, allow: { accounts: ['work'] } });
  assert.strictEqual((await list.run(ctx, {})).rules.length, 1);
  assert.strictEqual((await check.run(ctx, { account: 'personal', cwd: '/c' })).allowed, false);
  assert.strictEqual((await check.run(ctx, { account: 'work', cwd: '/c' })).allowed, true);
});

test('mcp: add + remove require confirm and are declared mutating', async function () {
  const ctx = makeCtx();
  const add = policy.mcpTools.find(function (t) { return t.name === 'keyflip_policy_add'; });
  const remove = policy.mcpTools.find(function (t) { return t.name === 'keyflip_policy_remove'; });
  assert.strictEqual(add.annotations.readOnlyHint, false);
  assert.ok(add.inputSchema.required.indexOf('confirm') !== -1, 'confirm is required in the schema');
  assert.ok(remove.inputSchema.required.indexOf('confirm') !== -1);
  await assert.rejects(add.run(ctx, { effect: 'allow', cwd_prefix: '/c', accounts: ['work'] }), /confirmation required/);
  const res = await add.run(ctx, { effect: 'allow', cwd_prefix: '/c', accounts: ['work'], confirm: true });
  assert.ok(res.added && res.added.id);
  assert.strictEqual(policy.get(ctx).rules.length, 1);
  await assert.rejects(remove.run(ctx, { id: res.added.id }), /confirmation required/);
  assert.strictEqual((await remove.run(ctx, { id: res.added.id, confirm: true })).removed, res.added.id);
  assert.strictEqual(policy.get(ctx).rules.length, 0);
});
