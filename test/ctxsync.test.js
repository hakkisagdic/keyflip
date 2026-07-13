'use strict';
// Context-sync privacy modes + conflict detection (src/ctxsync.js). Covers the mode/policy store,
// per-policy filtering, the ALWAYS-ON secret scrub (the security invariant: no token/key ever
// reaches an emitted payload — proven for every syncing mode), export/import round-trips
// (plain + encrypted), prototype-pollution hardening, and the checkpoint conflict model.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const ctxsync = require('../src/ctxsync');
const secretscan = require('../src/secretscan');

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-ctxsync-')); }
const CLOCK = function () { return '2026-07-12T00:00:00.000Z'; };
// Injected runner so exportPackage's git-head annotation never spawns a subprocess.
const NORUN = function () { return { code: 1, stdout: '', stderr: '' }; };

// Real-shaped secrets planted in EVERY text field.
const ANT = 'sk-ant-api03-ABCDEFGHIJKLMNOPqrstuvwx0123456789';
const GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function secretPkg() {
  return {
    project: 'demo',
    rules: [{ tool: 'cursor', rel: '.cursor/mcp.json', content: '{"apiKey":"' + ANT + '"}' }],
    conversations: [
      { id: 'c1', tool: 'cursor', summary: 'set up auth with ' + GH, messages: [{ role: 'user', text: 'my key is ' + ANT }] },
      { id: 'c2', tool: 'gemini', summary: 'notes', messages: [{ role: 'assistant', text: 'all good' }] },
    ],
    snippets: [{ path: 'a.js', lang: 'js', code: 'const k = "' + ANT + '";' }],
    envVars: [{ name: 'ANTHROPIC_API_KEY', description: 'the live key ' + ANT, value: ANT }],
  };
}
function assertNoSecret(s) {
  const str = String(s);
  assert.strictEqual(str.indexOf(ANT), -1, 'anthropic token leaked');
  assert.strictEqual(str.indexOf(GH), -1, 'github token leaked');
  assert.strictEqual(str.indexOf('sk-ant-'), -1, 'anthropic prefix leaked');
  assert.strictEqual(str.indexOf('ghp_'), -1, 'github prefix leaked');
}

// ---- mode + policy store -----------------------------------------------------
test('getMode: unconfigured project defaults to local (fail closed)', function () {
  const p = tmpProject();
  const m = ctxsync.getMode(p);
  assert.strictEqual(m.mode, 'local');
  assert.strictEqual(m.policy.allowCloudSync, false);
  assert.strictEqual(m.contentHash, null);
});

test('setMode: persists to .keyflip/adapters/metadata.json (0600) and round-trips', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'git', { now: CLOCK });
  const file = ctxsync.metaPath(p);
  assert.ok(fs.existsSync(file), 'metadata.json written under .keyflip/adapters/');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'metadata is 0600');
  const m = ctxsync.getMode(p);
  assert.strictEqual(m.mode, 'git');
  assert.strictEqual(m.updatedAt, '2026-07-12T00:00:00.000Z');
});

test('setMode: rejects an unknown mode', function () {
  const p = tmpProject();
  assert.throws(function () { ctxsync.setMode(p, 'public', { now: CLOCK }); }, /unknown context-sync mode/);
});

test('setMode: company preserves an approved provider list across a re-flip', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'company', { now: CLOCK, policy: { allowedProviders: ['cursor'] } });
  ctxsync.setMode(p, 'company', { now: CLOCK }); // no override → keep the list
  assert.deepStrictEqual(ctxsync.getMode(p).policy.allowedProviders, ['cursor']);
});

// ---- filtering + secret scrub ------------------------------------------------
test('filterForSync: company policy strips raw conversations + source snippets', function () {
  const out = ctxsync.filterForSync(secretPkg(), ctxsync.DEFAULT_POLICIES.company);
  assert.deepStrictEqual(out.snippets, [], 'snippets removed when source sharing is off');
  out.conversations.forEach(function (c) { assert.deepStrictEqual(c.messages, [], 'raw messages stripped'); });
  assert.strictEqual(out.conversations.length, 2, 'conversation metadata (id/tool/summary) is kept');
});

test('filterForSync: ALWAYS scrubs secrets even when the policy allows raw content', function () {
  const counter = { n: 0 };
  const out = ctxsync.filterForSync(secretPkg(), ctxsync.DEFAULT_POLICIES.git, counter);
  // raw content is allowed, so messages survive — but every token must be redacted
  assert.strictEqual(out.conversations[0].messages.length, 1);
  assertNoSecret(JSON.stringify(out));
  assert.ok(out.conversations[0].messages[0].text.indexOf(secretscan.REDACTED) !== -1, 'token replaced inline');
  assert.ok(counter.n >= 4, 'redaction count reflects each planted secret');
});

test('normalizeInputPkg: env-var VALUES are dropped — only name + description travel', function () {
  const out = ctxsync.normalizeInputPkg(secretPkg());
  assert.deepStrictEqual(Object.keys(out.envVars[0]).sort(), ['description', 'name']);
  assert.strictEqual(out.envVars[0].name, 'ANTHROPIC_API_KEY', 'the NAME is carried');
});

// ---- export ------------------------------------------------------------------
test('exportPackage: local mode refuses to emit anything', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'local', { now: CLOCK });
  assert.throws(function () { ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN }); }, /local/);
});

test('exportPackage: git mode emits plain, valid, secret-free JSON', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'git', { now: CLOCK });
  const r = ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN });
  assert.strictEqual(r.encrypted, false);
  const env = JSON.parse(r.payload);
  assert.strictEqual(env.magic, 'keyflip-ctxsync');
  assert.strictEqual(env.mode, 'git');
  assert.strictEqual(env.meta.contentHash, r.contentHash);
  assertNoSecret(r.payload);
});

test('exportPackage: encrypted mode requires + uses a passphrase, and never leaks', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'encrypted', { now: CLOCK });
  assert.throws(function () { ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN }); }, /passphrase/);
  const r = ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN, passphrase: 'hunter2' });
  assert.strictEqual(r.encrypted, true);
  assertNoSecret(r.payload); // ciphertext obviously, but assert the plaintext token isn't present
  const back = ctxsync.importPackage(r.payload, { passphrase: 'hunter2' });
  assert.strictEqual(back.mode, 'encrypted');
  assertNoSecret(JSON.stringify(back.pkg)); // decrypted payload is also clean (scrubbed pre-encrypt)
});

test('exportPackage: company mode keeps only approved providers', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'company', { now: CLOCK, policy: { allowedProviders: ['cursor'] } });
  const r = ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN });
  const env = JSON.parse(r.payload);
  const tools = env.pkg.conversations.map(function (c) { return c.tool; });
  assert.deepStrictEqual(tools, ['cursor'], 'gemini conversation dropped (not approved)');
  assert.strictEqual(env.pkg.rules.length, 1, 'only the cursor rule survives');
  assertNoSecret(r.payload);
});

test('exportPackage: NO secret reaches ANY syncing mode (security invariant)', function () {
  ['git', 'encrypted', 'company'].forEach(function (mode) {
    const p = tmpProject();
    ctxsync.setMode(p, mode, { now: CLOCK, policy: { allowRawConversationSync: true, allowSourceCodeSnippets: true, allowedProviders: ['cursor', 'gemini'] } });
    const r = ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN, passphrase: 'pw' });
    if (r.encrypted) {
      assertNoSecret(r.payload);
      const back = ctxsync.importPackage(r.payload, { passphrase: 'pw' });
      assertNoSecret(JSON.stringify(back));
    } else {
      assertNoSecret(r.payload);
    }
  });
});

// ---- import ------------------------------------------------------------------
test('importPackage: rejects garbage and wrong passphrases', function () {
  assert.throws(function () { ctxsync.importPackage('not json at all'); }, /not a keyflip context-sync payload/);
  assert.throws(function () { ctxsync.importPackage('{"magic":"nope"}'); }, /not a keyflip context-sync payload/);
  const p = tmpProject();
  ctxsync.setMode(p, 'encrypted', { now: CLOCK });
  const r = ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN, passphrase: 'right' });
  assert.throws(function () { ctxsync.importPackage(r.payload); }, /encrypted/);
  assert.throws(function () { ctxsync.importPackage(r.payload, { passphrase: 'wrong' }); }, /decryption failed|wrong passphrase/);
});

test('importPackage: neutralizes a prototype-pollution attempt', function () {
  const evil = JSON.stringify({
    magic: 'keyflip-ctxsync', schemaVersion: 1, mode: 'git',
    meta: { contentHash: 'abc' }, policy: {},
    pkg: { project: 'p', rules: [{ tool: 'x', rel: 'y', z: 1 }], conversations: [], snippets: [], envVars: [] },
  }).replace('"project":"p"', '"project":"p","__proto__":{"polluted":true}');
  const out = ctxsync.importPackage(evil);
  assert.strictEqual(({}).polluted, undefined, 'Object.prototype not polluted');
  assert.strictEqual(out.pkg.polluted, undefined);
});

// ---- conflict detection ------------------------------------------------------
test('detectConflict: identical / fast-forward / divergence', function () {
  assert.strictEqual(ctxsync.detectConflict({ contentHash: 'a', parent: 'p' }, { contentHash: 'a', parent: 'p' }).conflict, false);
  const same = ctxsync.detectConflict({ contentHash: 'x', parent: 'base' }, { contentHash: 'y', parent: 'base' });
  assert.strictEqual(same.conflict, true);
  assert.strictEqual(same.reason, 'diverged-from-common-parent');
  // local built on top of the remote's hash → local is ahead, no conflict
  assert.strictEqual(ctxsync.detectConflict({ contentHash: 'b', parent: 'a' }, { contentHash: 'a', parent: 'root' }).conflict, false);
  // remote built on top of the local's hash → remote is ahead, no conflict
  assert.strictEqual(ctxsync.detectConflict({ contentHash: 'a', parent: 'root' }, { contentHash: 'b', parent: 'a' }).conflict, false);
  // unrelated histories → conflict
  assert.strictEqual(ctxsync.detectConflict({ contentHash: 'a', parent: null }, { contentHash: 'b', parent: null }).conflict, true);
  // no checkpoint yet → cannot conflict
  assert.strictEqual(ctxsync.detectConflict({}, { contentHash: 'a' }).conflict, false);
});

test('detectConflict: newer hint from updatedAt', function () {
  const c = ctxsync.detectConflict(
    { contentHash: 'x', parent: 'base', updatedAt: '2026-07-12T10:00:00Z' },
    { contentHash: 'y', parent: 'base', updatedAt: '2026-07-12T09:00:00Z' });
  assert.strictEqual(c.newer, 'local');
});

test('resolutions: offers use-new / use-old / merge / two-branches', function () {
  const ids = ctxsync.resolutions().map(function (r) { return r.id; });
  assert.deepStrictEqual(ids, ['use-new', 'use-old', 'merge', 'two-branches']);
});

test('contentHash: stable + order-independent, changes with content', function () {
  const a = ctxsync.contentHash(secretPkg());
  const b = ctxsync.contentHash(secretPkg());
  assert.strictEqual(a, b, 'deterministic');
  const mutated = secretPkg(); mutated.project = 'other';
  assert.notStrictEqual(a, ctxsync.contentHash(mutated), 'sensitive to content');
});

// ---- roundtrip checkpoint lineage -------------------------------------------
test('recordCheckpoint: advances lineage (old hash becomes the new parent)', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'git', { now: CLOCK });
  ctxsync.recordCheckpoint(p, 'base-hash', { now: CLOCK });     // first checkpoint: parent = null
  let m = ctxsync.getMode(p);
  assert.strictEqual(m.contentHash, 'base-hash');
  assert.strictEqual(m.parent, null);
  ctxsync.recordCheckpoint(p, 'next-hash', { now: CLOCK });     // second: parent = the prior hash
  m = ctxsync.getMode(p);
  assert.strictEqual(m.contentHash, 'next-hash');
  assert.strictEqual(m.parent, 'base-hash');
});

test('export → import → detectConflict flow: same base, both edited = conflict', function () {
  const local = tmpProject();
  ctxsync.setMode(local, 'git', { now: CLOCK });
  const base = 'shared-base-hash';
  // local diverged from the base (parent = base, new hash)
  ctxsync.recordCheckpoint(local, base, { now: CLOCK });
  ctxsync.recordCheckpoint(local, 'local-edit-hash', { now: CLOCK });
  const localMeta = ctxsync.getMode(local); // { contentHash: local-edit-hash, parent: base }
  // remote independently diverged from the SAME base to a different hash
  const remoteMeta = { contentHash: 'remote-edit-hash', parent: base, updatedAt: CLOCK() };
  const c = ctxsync.detectConflict(localMeta, remoteMeta);
  assert.strictEqual(c.conflict, true);
  assert.strictEqual(c.reason, 'diverged-from-common-parent');
});

// ---- buildPackage reuses agents.CONFIG_REGISTRY + secret-scans on the way in --
test('buildPackage: reads a project rule file via CONFIG_REGISTRY and redacts secrets', function () {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(p, '.cursor', 'mcp.json'), '{"apiKey":"' + ANT + '"}');
  const pkg = ctxsync.buildPackage(p, { now: CLOCK });
  const rule = pkg.rules.filter(function (r) { return r.rel.indexOf('mcp.json') !== -1; })[0];
  assert.ok(rule, 'cursor rule discovered under the project');
  assertNoSecret(rule.content);
});

test('buildPackage: normalizes a foreign session file into a conversation', function () {
  const p = tmpProject();
  const jf = path.join(p, 'session.jsonl');
  fs.writeFileSync(jf, [
    '{"type":"user","cwd":"/x","message":{"role":"user","content":"my token ' + GH + '"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"noted"}]}}',
  ].join('\n'));
  const pkg = ctxsync.buildPackage(p, { now: CLOCK, sessionFiles: [jf] });
  const conv = pkg.conversations.filter(function (c) { return c.id === 'session.jsonl'; })[0];
  assert.ok(conv, 'foreign session imported');
  assert.strictEqual(conv.messages.length, 2);
});

// ---- CLI ---------------------------------------------------------------------
test('cli: status, mode set, export, and unknown mode', function () {
  const p = tmpProject();
  let r = ctxsync.cli(['status'], { projectPath: p, now: CLOCK });
  assert.strictEqual(r.code, 0);
  assert.ok(r.lines.join('\n').indexOf('local only') !== -1);

  r = ctxsync.cli(['mode', 'git'], { projectPath: p, now: CLOCK });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(ctxsync.getMode(p).mode, 'git');

  r = ctxsync.cli(['mode', 'nope'], { projectPath: p, now: CLOCK });
  assert.strictEqual(r.code, 1);

  r = ctxsync.cli(['export'], { projectPath: p, now: CLOCK, run: NORUN, pkg: secretPkg() });
  assert.strictEqual(r.code, 0);
  assert.ok(r.stdout, 'export writes a payload to stdout');
  assertNoSecret(r.stdout);
});

test('cli: check reports mode, share counts, scrub count, and a conflict', function () {
  const p = tmpProject();
  ctxsync.setMode(p, 'git', { now: CLOCK });
  // an incoming payload that diverges from our (empty) checkpoint
  const remote = ctxsync.exportPackage(p, { pkg: secretPkg(), now: CLOCK, run: NORUN }).payload;
  // give local a checkpoint that shares no parent with remote → conflict
  ctxsync.recordCheckpoint(p, 'local-only-hash', { now: CLOCK });
  const r = ctxsync.cli(['check'], { projectPath: p, now: CLOCK, run: NORUN, pkg: secretPkg(), against: remote });
  const text = r.lines.join('\n');
  assert.ok(text.indexOf('would share') !== -1);
  assert.ok(text.indexOf('secret(s) would be scrubbed') !== -1);
  assert.ok(text.indexOf('conflict vs incoming') !== -1);
});
