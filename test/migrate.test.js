'use strict';
// Tests for cross-machine migration (src/migrate.js): bundle ALL accounts +
// providers + session transcripts, then MERGE (union) them into another machine
// without clobbering what's already there. Uses the hermetic makeCtx (temp home,
// in-memory store) with claudeDir pinned so transcripts land in a temp projects/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const migrate = require('../src/migrate');
const profiles = require('../src/profiles');
const provider = require('../src/provider');
const { makeCtx } = require('./helpers');

function ctxWithClaude() {
  const ctx = makeCtx();
  ctx.claudeDir = path.join(ctx.home, '.claude');
  fs.mkdirSync(ctx.claudeDir, { recursive: true });
  return ctx;
}
function seedAccount(ctx, name, email, blob) {
  ctx.store.setProfile(name, blob);
  profiles.write(ctx.configDir, { name: name, email: email, oauthAccount: { organizationUuid: 'org-' + name }, userID: 'u' + name, savedAt: ctx.now() });
}
function seedTranscript(ctx, project, id, content) {
  const dir = path.join(ctx.claudeDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, id + '.jsonl');
  fs.writeFileSync(p, content);
  return p;
}
function txPath(ctx, project, id) { return path.join(ctx.claudeDir, 'projects', project, id + '.jsonl'); }

test('buildBundle collects accounts (secrets), providers (keys) and transcripts', function () {
  const ctx = ctxWithClaude();
  seedAccount(ctx, 'work', 'a@x.com', '{"token":"AAA"}');
  provider.add(ctx, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-123' });
  seedTranscript(ctx, '-Users-me-proj', 'sess-1', '{"cwd":"/Users/me/proj"}\n');

  const built = migrate.buildBundle(ctx, {});
  assert.strictEqual(built.counts.accounts, 1);
  assert.strictEqual(built.counts.providers, 1);
  assert.strictEqual(built.counts.transcripts, 1);
  assert.strictEqual(built.bundle.accounts[0].cliCredentials, '{"token":"AAA"}');
  assert.strictEqual(built.bundle.providers[0].key, 'sk-123');
  assert.strictEqual(built.bundle.providers[0].meta.baseUrl, 'https://relay.example');
  assert.strictEqual(built.bundle.transcripts[0].sessionId, 'sess-1');
  assert.ok(built.bundle.transcripts[0].content.indexOf('/Users/me/proj') !== -1);
});

test('--no-sessions / --no-providers trim the bundle', function () {
  const ctx = ctxWithClaude();
  seedAccount(ctx, 'work', 'a@x.com', '{"token":"AAA"}');
  provider.add(ctx, 'relay', { baseUrl: 'https://relay.example', key: 'sk-1' });
  seedTranscript(ctx, '-p', 's1', 'x\n');
  const built = migrate.buildBundle(ctx, { noSessions: true, noProviders: true });
  assert.strictEqual(built.counts.transcripts, 0);
  assert.strictEqual(built.counts.providers, 0);
  assert.strictEqual(built.counts.accounts, 1);
});

test('applyBundle imports accounts+providers+transcripts into a fresh machine', function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  provider.add(src, 'relay', { baseUrl: 'https://relay.example', authScheme: 'api-key', key: 'sk-123' });
  seedTranscript(src, '-Users-me-proj', 'sess-1', 'HELLO\n');
  const bundle = migrate.buildBundle(src, {}).bundle;

  const dst = ctxWithClaude();
  const res = migrate.applyBundle(dst, bundle, {});
  assert.deepStrictEqual(res.accounts.imported, ['work']);
  assert.deepStrictEqual(res.providers.imported, ['relay']);
  assert.strictEqual(res.transcripts.added, 1);
  // account secret + meta landed
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"AAA"}');
  assert.strictEqual((profiles.read(dst.configDir, 'work') || {}).email, 'a@x.com');
  // provider + its key landed
  assert.ok(provider.exists(dst, 'relay'));
  assert.strictEqual(dst.store.getProfile('provider__relay'), 'sk-123');
  // transcript file written verbatim
  assert.strictEqual(fs.readFileSync(txPath(dst, '-Users-me-proj', 'sess-1'), 'utf8'), 'HELLO\n');
});

test('MERGE is a union: existing transcripts/accounts are KEPT, not clobbered', function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"NEW"}');
  seedTranscript(src, '-p', 'shared', 'FROM-SOURCE\n');
  seedTranscript(src, '-p', 'only-source', 'S\n');
  const bundle = migrate.buildBundle(src, {}).bundle;

  const dst = ctxWithClaude();
  seedAccount(dst, 'work', 'a@x.com', '{"token":"OLD"}');   // same name already here
  seedTranscript(dst, '-p', 'shared', 'FROM-TARGET\n');       // same id already here
  seedTranscript(dst, '-p', 'only-target', 'T\n');            // target-only survives

  const res = migrate.applyBundle(dst, bundle, {});
  // account kept (not overwritten without --force)
  assert.deepStrictEqual(res.accounts.imported, []);
  assert.deepStrictEqual(res.accounts.skipped, ['work']);
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"OLD"}');
  // transcripts unioned: shared kept, only-source added, only-target untouched
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(res.transcripts.kept, 1);
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'shared'), 'utf8'), 'FROM-TARGET\n');
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'only-source'), 'utf8'), 'S\n');
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'only-target'), 'utf8'), 'T\n');
});

test('--force overwrites existing accounts and transcripts', function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"NEW"}');
  seedTranscript(src, '-p', 'shared', 'FROM-SOURCE\n');
  const bundle = migrate.buildBundle(src, {}).bundle;

  const dst = ctxWithClaude();
  seedAccount(dst, 'work', 'a@x.com', '{"token":"OLD"}');
  seedTranscript(dst, '-p', 'shared', 'FROM-TARGET\n');

  const res = migrate.applyBundle(dst, bundle, { force: true });
  assert.deepStrictEqual(res.accounts.imported, ['work']);
  assert.strictEqual(dst.store.getProfile('work'), '{"token":"NEW"}');
  assert.strictEqual(res.transcripts.overwritten, 1);
  assert.strictEqual(fs.readFileSync(txPath(dst, '-p', 'shared'), 'utf8'), 'FROM-SOURCE\n');
});

test('applyBundle rejects path traversal in transcript segments', function () {
  const dst = ctxWithClaude();
  const bundle = {
    format: migrate.FORMAT, version: migrate.VERSION, accounts: [], providers: [],
    transcripts: [
      { project: '../../evil', sessionId: 'x', content: 'PWNED\n' },
      { project: '-ok', sessionId: '../escape', content: 'PWNED\n' },
      { project: '-ok', sessionId: 'good', content: 'FINE\n' },
    ],
  };
  const res = migrate.applyBundle(dst, bundle, {});
  assert.strictEqual(res.transcripts.added, 1);
  assert.strictEqual(res.transcripts.skipped, 2);
  assert.ok(!fs.existsSync(path.join(dst.home, 'evil')));
  assert.strictEqual(fs.readFileSync(txPath(dst, '-ok', 'good'), 'utf8'), 'FINE\n');
});

test('a single invalid account does NOT abort the provider + transcript merge', function () {
  const dst = ctxWithClaude();
  const bundle = {
    format: migrate.FORMAT, version: migrate.VERSION,
    accounts: [
      { name: 'good', email: 'g@x.com', oauthAccount: {}, userID: '', cliCredentials: '{"t":1}' },
      { name: 'bad', email: 'not-an-email', oauthAccount: {}, userID: '', cliCredentials: '' }, // invalid: no creds
    ],
    providers: [{ name: 'relay', meta: { baseUrl: 'https://relay.example', authScheme: 'api-key' }, key: 'sk-1' }],
    transcripts: [{ project: '-p', sessionId: 's1', content: 'C\n' }],
  };
  const res = migrate.applyBundle(dst, bundle, {});
  assert.ok(res.accounts.imported.indexOf('good') !== -1, 'the good account still imports');
  assert.ok(res.accounts.skipped.indexOf('bad') !== -1, 'the bad account is skipped, not fatal');
  assert.deepStrictEqual(res.providers.imported, ['relay']);
  assert.strictEqual(res.transcripts.added, 1, 'transcripts still merge despite the bad account');
});

test('applyBundle validates the envelope format and version', function () {
  const dst = ctxWithClaude();
  assert.throws(function () { migrate.applyBundle(dst, { format: 'nope' }, {}); }, /not a keyflip migrate bundle/);
  assert.throws(function () { migrate.applyBundle(dst, { format: migrate.FORMAT, version: 999 }, {}); }, /unsupported migrate bundle version/);
});

test('pushBundle then pullBundle round-trips over a fake WebDAV (encrypted)', async function () {
  const src = ctxWithClaude();
  seedAccount(src, 'work', 'a@x.com', '{"token":"AAA"}');
  seedTranscript(src, '-p', 's1', 'HELLO\n');

  // In-memory WebDAV: PUT stores the encrypted body, GET returns it.
  let stored = null;
  const fakeFetch = async function (url, init) {
    if (init.method === 'PUT') { stored = init.body; return { status: 201 }; }
    if (init.method === 'GET') { return stored == null ? { status: 404 } : { status: 200, text: async function () { return stored; } }; }
    return { status: 405 };
  };
  const o = { url: 'https://dav.example/keyflip.enc', passphrase: 'pw123', fetch: fakeFetch };
  const counts = await migrate.pushBundle(src, o);
  assert.strictEqual(counts.accounts, 1);
  assert.strictEqual(counts.transcripts, 1);
  assert.ok(stored && stored.indexOf('keyflip-sync') !== -1, 'stored body is the encrypted sync envelope');
  assert.ok(stored.indexOf('AAA') === -1, 'plaintext secret is NOT in the stored body');

  const pulled = await migrate.pullBundle(ctxWithClaude(), o);
  assert.strictEqual(pulled.found, true);
  assert.strictEqual(pulled.bundle.accounts[0].cliCredentials, '{"token":"AAA"}');
  assert.strictEqual(pulled.bundle.transcripts[0].content, 'HELLO\n');
});

test('pushBundle requires a passphrase; pullBundle reports not-found on 404', async function () {
  const ctx = ctxWithClaude();
  seedAccount(ctx, 'w', 'a@x.com', '{"t":1}');
  await assert.rejects(function () { return migrate.pushBundle(ctx, { url: 'x', fetch: async function () { return { status: 200 }; } }); }, /passphrase is required/);
  const pulled = await migrate.pullBundle(ctx, { url: 'x', passphrase: 'p', fetch: async function () { return { status: 404 }; } });
  assert.deepStrictEqual(pulled, { found: false });
});

test('E2: buildBundle --sessions filter includes only the named transcripts', function () {
  const ctx = ctxWithClaude();
  seedTranscript(ctx, '-p', 'keepme01', 'A\n');
  seedTranscript(ctx, '-p', 'dropme02', 'B\n');
  seedTranscript(ctx, '-q', 'keepme03', 'C\n');
  const built = migrate.buildBundle(ctx, { sessions: ['keepme01', 'keepme03'], noMemory: true, noProviders: true, noAccounts: true });
  const ids = built.bundle.transcripts.map(function (t) { return t.sessionId; }).sort();
  assert.deepStrictEqual(ids, ['keepme01', 'keepme03']);
  assert.strictEqual(built.counts.accounts, 0, 'noAccounts empties accounts');
});

test('E2: --sessions accepts a prefix', function () {
  const ctx = ctxWithClaude();
  seedTranscript(ctx, '-p', 'abcd1234', 'A\n');
  seedTranscript(ctx, '-p', 'zzzz9999', 'B\n');
  const tx = migrate.collectTranscriptsFiltered(ctx, { sessions: ['abcd'] });
  assert.strictEqual(tx.length, 1);
  assert.strictEqual(tx[0].sessionId, 'abcd1234');
});

test('E2: olderThanDays / newerThanDays filter by transcript mtime', function () {
  const ctx = ctxWithClaude();
  const oldf = seedTranscript(ctx, '-p', 'old00001', 'old\n');
  seedTranscript(ctx, '-p', 'new00002', 'new\n');
  const past = Date.now() / 1000 - 40 * 86400; // 40 days ago
  fs.utimesSync(oldf, past, past);
  const older = migrate.collectTranscriptsFiltered(ctx, { olderThanDays: 30 }).map(function (t) { return t.sessionId; });
  const newer = migrate.collectTranscriptsFiltered(ctx, { newerThanDays: 30 }).map(function (t) { return t.sessionId; });
  assert.deepStrictEqual(older, ['old00001']);
  assert.deepStrictEqual(newer, ['new00002']);
});

test('J2/J3: collectConfig gathers MCP registry + Claude settings; mergeConfig unions', function () {
  const src = ctxWithClaude();
  fs.writeFileSync(path.join(src.configDir, 'mcp-registry.json'), JSON.stringify({ ctx7: { command: 'npx', args: ['ctx7'], env: { K: 'sek' } } }));
  fs.writeFileSync(path.join(src.claudeDir, 'settings.json'), '{"model":"opus"}');
  const cfg = migrate.collectConfig(src);
  assert.ok(cfg.mcpRegistry && cfg.claudeSettings);

  const dst = ctxWithClaude();
  fs.writeFileSync(path.join(dst.configDir, 'mcp-registry.json'), JSON.stringify({ existing: { command: 'node' } }));
  fs.writeFileSync(path.join(dst.claudeDir, 'settings.json'), '{"model":"LOCAL"}'); // already here
  const res = migrate.mergeConfig(dst, cfg, {});
  // mcp-registry merged server-by-server (existing kept, ctx7 added)
  const reg = JSON.parse(fs.readFileSync(path.join(dst.configDir, 'mcp-registry.json'), 'utf8'));
  assert.ok(reg.existing && reg.ctx7, 'both servers present');
  // settings kept (not clobbered without --force)
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'settings.json'), 'utf8'), '{"model":"LOCAL"}');
  assert.ok(res.written.some(function (w) { return w.indexOf('mcp-registry') === 0; }));
  assert.ok(res.kept.indexOf('claude-settings') !== -1);
});

test('J2/J3: mergeConfig --force overwrites settings; buildBundle counts config', function () {
  const src = ctxWithClaude();
  fs.writeFileSync(path.join(src.claudeDir, 'settings.json'), '{"model":"opus"}');
  const built = migrate.buildBundle(src, { noAccounts: true, noMemory: true, noProviders: true, noSessions: true });
  assert.ok(built.counts.config >= 1);
  const dst = ctxWithClaude();
  fs.writeFileSync(path.join(dst.claudeDir, 'settings.json'), '{"model":"OLD"}');
  migrate.mergeConfig(dst, built.bundle.config, { force: true });
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'settings.json'), 'utf8'), '{"model":"opus"}');
});

test('collectMemory gathers ~/.claude/*.md and projects/*/memory files; mergeMemory unions them', function () {
  const src = ctxWithClaude();
  fs.writeFileSync(path.join(src.claudeDir, 'CLAUDE.md'), '# global instructions\n');
  const memDir = path.join(src.claudeDir, 'projects', '-p', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# index\n');
  fs.writeFileSync(path.join(memDir, 'fact.md'), 'a durable fact\n');

  const built = migrate.buildBundle(src, {});
  assert.strictEqual(built.counts.memory, 3);
  const rels = built.bundle.memory.map(function (m) { return m.rel; }).sort();
  assert.ok(rels.indexOf('CLAUDE.md') !== -1);
  assert.ok(rels.indexOf(path.join('projects', '-p', 'memory', 'fact.md')) !== -1);

  const dst = ctxWithClaude();
  fs.writeFileSync(path.join(dst.claudeDir, 'CLAUDE.md'), 'LOCAL — keep me\n'); // already here
  const res = migrate.applyBundle(dst, built.bundle, {});
  assert.strictEqual(res.memory.added, 2);   // MEMORY.md + fact.md
  assert.strictEqual(res.memory.kept, 1);    // existing CLAUDE.md kept (union)
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'CLAUDE.md'), 'utf8'), 'LOCAL — keep me\n');
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'projects', '-p', 'memory', 'fact.md'), 'utf8'), 'a durable fact\n');
});

test('mergeMemory rejects a path that escapes ~/.claude (traversal guard)', function () {
  const dst = ctxWithClaude();
  const bundle = {
    format: migrate.FORMAT, version: migrate.VERSION, accounts: [], providers: [], transcripts: [],
    memory: [
      { rel: '../evil.md', content: 'PWNED\n' },
      { rel: 'ok.md', content: 'FINE\n' },
    ],
  };
  const res = migrate.applyBundle(dst, bundle, {});
  assert.strictEqual(res.memory.added, 1);
  assert.strictEqual(res.memory.skipped, 1);
  assert.ok(!fs.existsSync(path.join(dst.claudeDir, '..', 'evil.md')));
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'ok.md'), 'utf8'), 'FINE\n');
});

test('a sessions-only bundle (no accounts) still merges transcripts', function () {
  const dst = ctxWithClaude();
  const bundle = {
    format: migrate.FORMAT, version: migrate.VERSION, accounts: [], providers: [],
    transcripts: [{ project: '-p', sessionId: 's', content: 'C\n' }],
  };
  const res = migrate.applyBundle(dst, bundle, {});
  assert.deepStrictEqual(res.accounts.imported, []);
  assert.strictEqual(res.transcripts.added, 1);
});

// SECURITY (review P1 #7): the merge writes must not FOLLOW a pre-planted symlink out of root.
const os = require('os');
test('mergeTranscripts refuses a symlinked project directory (no escape via symlinked dir)', function () {
  const dst = ctxWithClaude();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-escape-'));
  fs.mkdirSync(path.join(dst.claudeDir, 'projects'), { recursive: true });
  // attacker pre-plants projects/evil -> /outside
  fs.symlinkSync(outside, path.join(dst.claudeDir, 'projects', 'evil'), 'dir');
  const bundle = { format: migrate.FORMAT, version: migrate.VERSION, accounts: [], providers: [],
    transcripts: [{ project: 'evil', sessionId: 'sess', content: 'PWNED\n' }] };
  const res = migrate.applyBundle(dst, bundle, {});
  assert.strictEqual(res.transcripts.added, 0);
  assert.strictEqual(res.transcripts.skipped, 1);
  assert.ok(!fs.existsSync(path.join(outside, 'sess.jsonl')), 'nothing written through the symlink');
});

test('mergeMemory refuses a symlinked leaf and never clobbers the victim (even with --force)', function () {
  const dst = ctxWithClaude();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-escape-'));
  const victim = path.join(outside, 'victim.md');
  fs.writeFileSync(victim, 'ORIGINAL');
  // attacker pre-plants ~/.claude/CLAUDE.md -> victim
  fs.symlinkSync(victim, path.join(dst.claudeDir, 'CLAUDE.md'), 'file');
  const bundle = { format: migrate.FORMAT, version: migrate.VERSION, accounts: [], providers: [],
    memory: [{ rel: 'CLAUDE.md', content: 'PWNED' }] };
  const res = migrate.applyBundle(dst, bundle, { force: true });
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'victim through the symlink is untouched');
  assert.ok(res.memory.skipped >= 1);
});

test('mergeMemory rejects config-injection and absolute/nested traversal, only real memory locations write', function () {
  const dst = ctxWithClaude();
  const bundle = { format: migrate.FORMAT, version: migrate.VERSION, accounts: [], providers: [],
    memory: [
      { rel: 'settings.json', content: '{"evil":1}' },        // config injection at the ~/.claude root
      { rel: '.claude.json', content: 'x' },                   // dotfile config
      { rel: '/tmp/pwned.md', content: 'x' },                  // absolute escape
      { rel: 'sub/../../escape.md', content: 'x' },            // nested traversal
      { rel: 'CLAUDE.md', content: 'REAL\n' },                 // legitimate top-level memory
      { rel: 'projects/-p/memory/note.md', content: 'OK\n' },  // legitimate project memory
    ] };
  const res = migrate.applyBundle(dst, bundle, { force: true });
  assert.strictEqual(res.memory.added, 2, 'only the 2 legitimate memory files write');
  assert.strictEqual(res.memory.skipped, 4);
  assert.ok(!fs.existsSync(path.join(dst.claudeDir, 'settings.json')), 'no config injection');
  assert.ok(!fs.existsSync(path.join(dst.claudeDir, '.claude.json')));
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'CLAUDE.md'), 'utf8'), 'REAL\n');
  assert.strictEqual(fs.readFileSync(path.join(dst.claudeDir, 'projects', '-p', 'memory', 'note.md'), 'utf8'), 'OK\n');
});
