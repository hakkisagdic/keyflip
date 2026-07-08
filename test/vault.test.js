'use strict';
// EXTERNAL SECRET BACKEND: drive 1Password/Bitwarden/HashiCorp Vault through an
// INJECTED CLI runner, so every path is exercised with zero real subprocesses,
// no network and a fixed clock. Each provider gets a tiny in-memory emulator so
// happy-path round-trips (set -> get -> list -> del) are real; hostile paths
// (locked, absent, missing item, bad names, prototype pollution, confirm gates)
// use hand-programmed runners. The security-critical assertion throughout: a
// secret only ever travels on stdin (call.input), NEVER on argv (call.args).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vault = require('../src/vault');
const { makeCtx } = require('./helpers');

const TOKEN = 'SUPER-SECRET-TOKEN-123'; // quote-free marker: survives JSON.stringify + base64 verbatim
const SECRET = '{"claudeAiOauth":{"accessToken":"' + TOKEN + '"}}';

// A recording runner. `handler(call)` returns a partial spawn result (merged
// over sane defaults). run.calls captures every invocation for assertions.
function makeRun(handler) {
  const calls = [];
  const run = function (cmd, args, input, opts) {
    const call = { cmd: cmd, args: args || [], input: input, opts: opts || {} };
    calls.push(call);
    const res = handler(call) || {};
    return Object.assign({ code: 0, stdout: '', stderr: '', error: null, timedOut: false }, res);
  };
  run.calls = calls;
  return run;
}
// No argv element of any recorded call may contain the secret marker — neither
// raw nor base64-wrapped.
function assertSecretNeverOnArgv(run) {
  const b64 = Buffer.from(TOKEN).toString('base64');
  run.calls.forEach(function (c) {
    const argv = JSON.stringify(c.args);
    assert.strictEqual(argv.indexOf(TOKEN), -1, 'secret leaked onto argv of `' + c.cmd + ' ' + c.args.join(' ') + '`');
    assert.strictEqual(argv.indexOf(b64), -1, 'base64 secret leaked onto argv of `' + c.cmd + '`');
  });
}
// The marker must have reached the child ONLY on stdin (raw for op/vault, or
// base64-wrapped for bw).
function assertSecretReachedStdin(run) {
  const found = run.calls.some(function (c) {
    if (typeof c.input !== 'string' || !c.input) return false;
    if (c.input.indexOf(TOKEN) !== -1) return true;
    try { return Buffer.from(c.input, 'base64').toString('utf8').indexOf(TOKEN) !== -1; } catch (e) { return false; }
  });
  assert.ok(found, 'the secret was delivered on stdin');
}

// ---- per-provider emulators ------------------------------------------------
// 1Password: `read`, `item create|delete|list`. Store keyed by name.
function opEmu() {
  const store = Object.create(null);
  return makeRun(function (call) {
    const a = call.args;
    if (a[0] === '--version') return { stdout: '2.30.0\n' };
    // Real op resolves an item by its LITERAL title (slash and all) — emulate `op item get <title>
    // --fields …`, NOT an op:// path parse (that mis-parses the slash; see the vault opGet fix).
    if (a[0] === 'item' && a[1] === 'get') {
      const title = a[2]; // 'keyflip/<name>' verbatim
      const name = title.indexOf('keyflip/') === 0 ? title.slice('keyflip/'.length) : null;
      if (name && Object.prototype.hasOwnProperty.call(store, name)) return { stdout: store[name] };
      return { code: 1, stderr: '[ERROR] "' + title + '" isn\'t an item.' };
    }
    if (a[0] === 'item' && a[1] === 'create') {
      const tmpl = JSON.parse(call.input); // secret arrives here, on stdin
      const name = tmpl.title.slice('keyflip/'.length);
      store[name] = tmpl.fields[0].value;
      return { stdout: '{"id":"x"}' };
    }
    if (a[0] === 'item' && a[1] === 'delete') {
      const name = a[2].slice('keyflip/'.length);
      if (!Object.prototype.hasOwnProperty.call(store, name)) return { code: 1, stderr: 'not found' };
      delete store[name]; return {};
    }
    if (a[0] === 'item' && a[1] === 'list') {
      return { stdout: JSON.stringify(Object.keys(store).map(function (n) { return { title: 'keyflip/' + n }; })) };
    }
    return { code: 1, stderr: 'unexpected op call' };
  });
}
// Bitwarden: `--version`, `get item|notes`, `create|edit|delete item`, `list items`.
function bwEmu() {
  const store = Object.create(null); // name -> {id, notes}
  let seq = 0;
  return makeRun(function (call) {
    const a = call.args;
    if (a[0] === '--version') return { stdout: '2024.1.0\n' };
    if (a[0] === 'get' && a[1] === 'item') {
      const name = a[2].slice('keyflip/'.length);
      if (!store[name]) return { code: 1, stderr: 'Not found.' };
      return { stdout: JSON.stringify({ id: store[name].id, name: a[2], notes: store[name].notes }) };
    }
    if (a[0] === 'get' && a[1] === 'notes') {
      const name = a[2].slice('keyflip/'.length);
      if (!store[name]) return { code: 1, stderr: 'Not found.' };
      return { stdout: store[name].notes + '\n' };
    }
    if (a[0] === 'create' && a[1] === 'item') {
      const tmpl = JSON.parse(Buffer.from(call.input, 'base64').toString('utf8')); // secret on stdin (base64)
      const name = tmpl.name.slice('keyflip/'.length);
      store[name] = { id: 'id-' + (++seq), notes: tmpl.notes };
      return {};
    }
    if (a[0] === 'edit' && a[1] === 'item') {
      const tmpl = JSON.parse(Buffer.from(call.input, 'base64').toString('utf8'));
      const name = tmpl.name.slice('keyflip/'.length);
      store[name] = { id: a[2], notes: tmpl.notes };
      return {};
    }
    if (a[0] === 'delete' && a[1] === 'item') {
      const name = Object.keys(store).filter(function (n) { return store[n].id === a[2]; })[0];
      if (name) delete store[name];
      return {};
    }
    if (a[0] === 'list' && a[1] === 'items') {
      return { stdout: JSON.stringify(Object.keys(store).map(function (n) { return { name: 'keyflip/' + n }; })) };
    }
    return { code: 1, stderr: 'unexpected bw call' };
  });
}
// HashiCorp Vault: `version`, `kv get|put|delete|list`.
function vaultEmu() {
  const store = Object.create(null);
  return makeRun(function (call) {
    const a = call.args;
    if (a[0] === 'version') return { stdout: 'Vault v1.15.0\n' };
    if (a[0] === 'kv' && a[1] === 'get') {
      const name = a[3].slice('secret/keyflip/'.length);
      if (!Object.prototype.hasOwnProperty.call(store, name)) return { code: 2, stderr: 'No value found at secret/keyflip/' + name };
      return { stdout: store[name] + '\n' };
    }
    if (a[0] === 'kv' && a[1] === 'put') {
      const name = a[2].slice('secret/keyflip/'.length);
      assert.strictEqual(a[3], 'credential=-', 'value must be read from stdin, not argv');
      store[name] = call.input; // secret on stdin
      return { stdout: 'Success!' };
    }
    if (a[0] === 'kv' && a[1] === 'delete') {
      const name = a[2].slice('secret/keyflip/'.length);
      delete store[name]; return {};
    }
    if (a[0] === 'kv' && a[1] === 'list') {
      const names = Object.keys(store);
      if (!names.length) return { code: 2, stderr: 'No value found at secret/keyflip' };
      return { stdout: JSON.stringify(names) };
    }
    return { code: 1, stderr: 'unexpected vault call' };
  });
}

const EMUS = { op: opEmu, bw: bwEmu, vault: vaultEmu };

// ---- detection -------------------------------------------------------------
test('detect returns the available backends, in canonical order', function () {
  // op + vault installed (exit 0), bw missing (ENOENT).
  const run = makeRun(function (call) {
    if (call.cmd === 'bw') return { code: 1, error: { code: 'ENOENT' } };
    return { code: 0, stdout: 'v\n' };
  });
  assert.deepStrictEqual(vault.detect({ run: run }), ['op', 'vault']);
});

test('probe reports absent vs available with a reason', function () {
  const run = makeRun(function (call) { return call.cmd === 'op' ? { code: 0, stdout: '2.30.0' } : { code: 1, error: { code: 'ENOENT' } }; });
  assert.deepStrictEqual(vault.probe('op', { run: run }), { ok: true, version: '2.30.0' });
  const bad = vault.probe('bw', { run: run });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /not installed/);
  assert.strictEqual(vault.probe('nope', {}).ok, false);
});

// ---- round-trips per provider (happy path + secret-safety) ------------------
PROV_TESTS();
function PROV_TESTS() {
  ['op', 'bw', 'vault'].forEach(function (prov) {
    test(prov + ': set/get/list/del round-trip keeps the secret off argv', function () {
      const run = EMUS[prov]();
      const store = vault.makeStore(makeCtx(), { provider: prov, run: run });
      assert.strictEqual(store.get('work'), null, 'missing item reads as null, not an error');
      store.set('work', SECRET);
      assert.strictEqual(store.get('work'), SECRET, 'reads back exactly what was written');
      store.set('home', '{"t":"OTHER"}');
      assert.deepStrictEqual(store.list().sort(), ['home', 'work']);
      assert.strictEqual(store.del('work'), true);
      assert.strictEqual(store.get('work'), null);
      assert.deepStrictEqual(store.list(), ['home']);
      // The load-bearing invariants.
      assertSecretNeverOnArgv(run);
      assertSecretReachedStdin(run);
    });

    test(prov + ': set is an idempotent upsert (second set overwrites)', function () {
      const run = EMUS[prov]();
      const store = vault.makeStore(makeCtx(), { provider: prov, run: run });
      store.set('work', 'AAA');
      store.set('work', 'BBB');
      assert.strictEqual(store.get('work'), 'BBB');
      assert.deepStrictEqual(store.list(), ['work'], 'no duplicate item after re-set');
    });

    test(prov + ': getProfile/setProfile/delProfile alias the primary interface', function () {
      const run = EMUS[prov]();
      const store = vault.makeStore(makeCtx(), { provider: prov, run: run });
      store.setProfile('acct', SECRET);
      assert.strictEqual(store.getProfile('acct'), SECRET);
      assert.strictEqual(store.delProfile('acct'), true);
      assert.strictEqual(store.getProfile('acct'), null);
      assertSecretNeverOnArgv(run);
    });
  });
}

// ---- hostile paths ---------------------------------------------------------
test('locked/unauthenticated vault throws a clear EVAULT error (never a silent miss)', function () {
  const locked = {
    op: { code: 1, stderr: "[ERROR] you are not currently signed in. Please run 'op signin'." },
    bw: { code: 1, stderr: 'Vault is locked.' },
    vault: { code: 2, stderr: 'Error making API request. Code: 503. Errors: * Vault is sealed' },
  };
  ['op', 'bw', 'vault'].forEach(function (prov) {
    const run = makeRun(function () { return locked[prov]; });
    const store = vault.makeStore(makeCtx(), { provider: prov, run: run });
    assert.throws(function () { store.get('work'); }, function (e) {
      return e.code === 'EVAULT' && /locked or not authenticated/i.test(e.message);
    }, prov + ' get on a locked vault must throw');
  });
});

test('absent CLI throws an install hint (not ENOENT)', function () {
  const run = makeRun(function () { return { code: 1, error: { code: 'ENOENT' } }; });
  const store = vault.makeStore(makeCtx(), { provider: 'op', run: run });
  assert.throws(function () { store.get('work'); }, function (e) {
    return e.code === 'EVAULT' && /not found/.test(e.message) && /install/.test(e.message);
  });
});

test('missing item is null on get, false on del, [] on list — not an error', function () {
  const run = EMUS.vault();
  const store = vault.makeStore(makeCtx(), { provider: 'vault', run: run });
  assert.strictEqual(store.get('ghost'), null);
  assert.strictEqual(store.del('ghost'), true, 'vault delete of a missing path is a no-op success');
  assert.deepStrictEqual(store.list(), []);
});

test('bw delete of a missing item is a no-op (returns false)', function () {
  const run = bwEmu();
  const store = vault.makeStore(makeCtx(), { provider: 'bw', run: run });
  assert.strictEqual(store.del('ghost'), false);
});

test('invalid / prototype-polluting names are rejected before any spawn', function () {
  const run = EMUS.op();
  const store = vault.makeStore(makeCtx(), { provider: 'op', run: run });
  ['__proto__', 'constructor', '../escape', 'has space', '-flag', '', 'a/b'].forEach(function (bad) {
    assert.throws(function () { store.get(bad); }, /invalid credential name/, 'get rejects ' + JSON.stringify(bad));
    assert.throws(function () { store.set(bad, SECRET); }, /invalid credential name/);
  });
  assert.strictEqual(run.calls.length, 0, 'no CLI was ever spawned for a bad name');
});

test('a hostile item title cannot pollute list() output', function () {
  const run = makeRun(function (call) {
    if (call.args[0] === 'item' && call.args[1] === 'list') {
      return { stdout: JSON.stringify([{ title: 'keyflip/__proto__' }, { title: 'keyflip/good' }, { title: 'unrelated' }]) };
    }
    return {};
  });
  const store = vault.makeStore(makeCtx(), { provider: 'op', run: run });
  assert.deepStrictEqual(store.list(), ['good'], 'reserved/invalid names filtered out');
});

test('makeStore rejects an unknown provider and empty blobs', function () {
  assert.throws(function () { vault.makeStore(makeCtx(), { provider: 'lastpass' }); }, /unknown vault backend/);
  assert.throws(function () { vault.makeStore(makeCtx(), { provider: '__proto__' }); }, /unknown vault backend/);
  const store = vault.makeStore(makeCtx(), { provider: 'op', run: EMUS.op() });
  assert.throws(function () { store.set('work', null); }, /empty credential blob/);
});

test('live-credential ops are unsupported on the vault backend', function () {
  const store = vault.makeStore(makeCtx(), { provider: 'vault', run: EMUS.vault() });
  assert.throws(function () { store.getLive(); }, /stores saved profiles only/);
  assert.throws(function () { store.setLive('x'); }, /stores saved profiles only/);
  assert.throws(function () { store.delLive(); }, /stores saved profiles only/);
});

// ---- state file (use / off / status) ---------------------------------------
test('use records the backend to <configDir>/vault.json; status reflects it', function () {
  const ctx = makeCtx();
  const run = makeRun(function () { return { code: 0, stdout: 'v' }; }); // everything available
  const r = vault.use(ctx, 'op', { run: run });
  assert.strictEqual(r.backend, 'op');
  assert.strictEqual(r.updatedAt, '2026-01-01T00:00:00.000Z', 'uses injected ctx.now()');
  const onDisk = JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'vault.json'), 'utf8'));
  assert.strictEqual(onDisk.backend, 'op');
  const s = vault.status(ctx, { run: run });
  assert.strictEqual(s.backend, 'op');
  assert.strictEqual(s.configured, true);
  assert.strictEqual(s.backendAvailable, true);
});

test('use refuses an unavailable backend unless forced', function () {
  const ctx = makeCtx();
  const run = makeRun(function () { return { code: 1, error: { code: 'ENOENT' } }; });
  assert.throws(function () { vault.use(ctx, 'bw', { run: run }); }, function (e) {
    return e.code === 'EVAULT' && /not available/.test(e.message);
  });
  assert.strictEqual(vault.readState(ctx).backend, null, 'nothing recorded on failure');
  const r = vault.use(ctx, 'bw', { run: run, force: true });
  assert.strictEqual(r.backend, 'bw', 'force records it anyway');
});

test('use rejects an unknown provider', function () {
  assert.throws(function () { vault.use(makeCtx(), 'keychain', { force: true }); }, /unknown vault backend/);
});

test('off clears the backend but leaves stored secrets untouched', function () {
  const ctx = makeCtx();
  const run = makeRun(function () { return { code: 0, stdout: 'v' }; });
  vault.use(ctx, 'vault', { run: run });
  const r = vault.off(ctx);
  assert.strictEqual(r.backend, null);
  assert.strictEqual(r.previous, 'vault');
  assert.match(r.note, /left untouched/);
  assert.strictEqual(vault.readState(ctx).backend, null);
});

test('readState survives a missing and a corrupt state file', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(vault.readState(ctx).backend, null, 'missing => defaults');
  fs.writeFileSync(path.join(ctx.configDir, 'vault.json'), '{ this is not json');
  assert.strictEqual(vault.readState(ctx).backend, null, 'corrupt => defaults, never throws');
  // a tampered backend value is ignored
  fs.writeFileSync(path.join(ctx.configDir, 'vault.json'), JSON.stringify({ backend: '__proto__' }));
  assert.strictEqual(vault.readState(ctx).backend, null);
});

// ---- CLI dispatch ----------------------------------------------------------
test('cli status / use / off return printable lines with no secrets', function () {
  const ctx = makeCtx();
  const run = makeRun(function () { return { code: 0, stdout: 'v' }; });
  let out = vault.cli(ctx, ['status'], { run: run });
  assert.strictEqual(out.action, 'status');
  assert.match(out.lines.join('\n'), /OFF/);
  out = vault.cli(ctx, ['use', 'bw'], { run: run });
  assert.strictEqual(out.data.backend, 'bw');
  assert.match(out.lines.join('\n'), /Bitwarden/);
  out = vault.cli(ctx, ['off'], { run: run });
  assert.strictEqual(out.data.backend, null);
  out = vault.cli(ctx, [], { run: run });
  assert.strictEqual(out.action, 'status', 'default subcommand is status');
  assert.throws(function () { vault.cli(ctx, ['use'], { run: run }); }, /usage: keyflip vault use/);
  assert.throws(function () { vault.cli(ctx, ['bogus'], { run: run }); }, /unknown: keyflip vault/);
});

// ---- MCP tools -------------------------------------------------------------
test('MCP tools: status is RO; use/off are MUT and gated on confirm', function () {
  const byName = Object.create(null);
  vault.tools.forEach(function (t) { byName[t.name] = t; });
  assert.ok(byName.keyflip_vault_status && byName.keyflip_vault_use && byName.keyflip_vault_off);
  assert.strictEqual(byName.keyflip_vault_status.annotations.readOnlyHint, true);
  assert.strictEqual(byName.keyflip_vault_use.annotations.readOnlyHint, false);
  assert.ok(byName.keyflip_vault_use.inputSchema.required.indexOf('confirm') !== -1);
  assert.ok(byName.keyflip_vault_off.inputSchema.required.indexOf('confirm') !== -1);
});

test('MCP keyflip_vault_use requires confirm=true, then records the backend (ctx.run injected)', async function () {
  const ctx = makeCtx();
  ctx.run = makeRun(function () { return { code: 0, stdout: 'v' }; }); // op looks installed
  const useTool = vault.tools.filter(function (t) { return t.name === 'keyflip_vault_use'; })[0];
  await assert.rejects(function () { return useTool.run(ctx, { provider: 'op' }); }, /confirmation required/);
  assert.strictEqual(vault.readState(ctx).backend, null, 'nothing recorded without confirm');
  const r = await useTool.run(ctx, { provider: 'op', confirm: true });
  assert.strictEqual(r.backend, 'op');
  assert.strictEqual(vault.readState(ctx).backend, 'op');
});

test('MCP keyflip_vault_off requires confirm=true', async function () {
  const ctx = makeCtx();
  ctx.run = makeRun(function () { return { code: 0, stdout: 'v' }; });
  const offTool = vault.tools.filter(function (t) { return t.name === 'keyflip_vault_off'; })[0];
  await assert.rejects(function () { return offTool.run(ctx, {}); }, /confirmation required/);
  const r = await offTool.run(ctx, { confirm: true });
  assert.strictEqual(r.backend, null);
});

test('MCP keyflip_vault_status returns the recorded backend (ctx.run injected — no real spawn)', async function () {
  const ctx = makeCtx();
  ctx.run = makeRun(function (call) { return call.cmd === 'vault' ? { code: 0, stdout: 'Vault v1' } : { code: 1, error: { code: 'ENOENT' } }; });
  vault.writeState(ctx, { backend: 'vault', settings: { vault: 'Private', mount: 'secret' }, updatedAt: ctx.now() });
  const statusTool = vault.tools.filter(function (t) { return t.name === 'keyflip_vault_status'; })[0];
  const s = await statusTool.run(ctx, {});
  assert.strictEqual(s.backend, 'vault');
  assert.strictEqual(s.configured, true);
  assert.deepStrictEqual(s.available, ['vault']);
  assert.strictEqual(s.backendAvailable, true);
});
