// fleet push: processInbox() is the single inbox gate shared by the CLI (`fleet push`) and the MCP
// `keyflip_fleet_push` tool. These tests exercise the MCP surface end-to-end on two real on-disk
// machines, including the consent gate and the encrypted-at-rest guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { makeCtx, tmpdir, assertPrivateMode } from './helpers.js';
import * as _fleet from '../src/fleet.js';
import * as _mcp from '../src/mcp.js';
import * as _profiles from '../src/profiles.js';

const PASS = 'fleet-test-passphrase';

// Real clock: inbox freshness is measured against ctx.now(), and makeCtx's fixed clock would make
// every freshly queued command look stale.
function ctxFor() {
  return makeCtx({
    now: function () {
      return new Date().toISOString();
    },
  });
}
function writeProfile(ctx, name, email) {
  _profiles.write(ctx.configDir, { name: name, email: email, schemaVersion: 1 });
}
function pushTool() {
  const t = _mcp.TOOLS.find(function (x) {
    return x.name === 'keyflip_fleet_push';
  });
  assert.ok(t, 'keyflip_fleet_push must be registered');
  return t;
}
function passFile(ctx) {
  const p = path.join(ctx.home, 'fleet-pass.txt');
  fs.writeFileSync(p, PASS);
  return p;
}

test('fleet push tool publishes an encrypted status and is confirm-gated', async function () {
  const ctx = ctxFor();
  const shared = tmpdir();
  _fleet.setConfig(ctx, { dir: shared, name: 'machine-a' });
  writeProfile(ctx, 'work', 'work@example.test');
  const pf = passFile(ctx);

  await assert.rejects(function () {
    return pushTool().run(ctx, { passphrase_file: pf });
  }, /confirmation required/);

  const out = await pushTool().run(ctx, { passphrase_file: pf, confirm: true });
  assert.equal(out.published.machine, 'machine-a');
  assert.equal(out.published.accounts, 1);
  assert.equal(out.published.withSecrets, false);
  assert.equal(out.applied.length, 0);
  assert.equal(out.conflicts.length, 0);

  const files = fs.readdirSync(shared).filter(function (n) {
    return n.slice(-'.status.enc'.length) === '.status.enc';
  });
  assert.equal(files.length, 1, 'one status file per machine');
  const statusPath = path.join(shared, files[0]);
  assertPrivateMode(statusPath);
  const raw = fs.readFileSync(statusPath, 'utf8');
  assert.ok(!raw.includes('work@example.test'), 'the account e-mail must not appear in plaintext');
  assert.ok(!raw.includes('"accounts"'), 'the status JSON must not appear in plaintext');
});

test('queued switch is skipped without apply and applied with apply', async function () {
  const a = ctxFor();
  const b = ctxFor();
  const shared = tmpdir();
  _fleet.setConfig(a, { dir: shared, name: 'machine-a' });
  _fleet.setConfig(b, { dir: shared, name: 'machine-b' });
  writeProfile(a, 'work', 'work@example.test');
  writeProfile(b, 'personal', 'personal@example.test');

  const busA = _fleet.bus(a, { passphrase: PASS });
  const busB = _fleet.bus(b, { passphrase: PASS });
  _fleet.publish(a, busA, {});
  _fleet.publish(b, busB, {});
  // B is pinned on A (the invite/join or `fleet trust` step). Without this, origin auth rejects it.
  _fleet.trustKey(a, _fleet.identity(b).machineId, _fleet.publicKey(b));

  const target = _fleet.identity(a).machineId;
  const pf = passFile(a);

  _fleet.queue(b, busB, target, { type: 'switch', payload: { account: 'work' } });
  const skipped = await pushTool().run(a, { passphrase_file: pf, confirm: true });
  assert.equal(skipped.applied.length, 1);
  assert.equal(skipped.applied[0].applied, 'switch');
  assert.match(skipped.applied[0].detail, /needs consent/);
  assert.equal(_fleet.readInbox(a, busA).length, 0, 'a consumed inbox is cleared even when skipped');

  _fleet.queue(b, busB, target, { type: 'switch', payload: { account: 'work' } });
  const applied = await pushTool().run(a, { passphrase_file: pf, confirm: true, apply: true });
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].ok, true);
  assert.match(applied.applied[0].detail, /switched to work/);

  const replay = await pushTool().run(a, { passphrase_file: pf, confirm: true, apply: true });
  assert.equal(replay.applied.length, 0, 'nothing is replayed after the inbox is consumed');
});

test('a command from an unpinned machine is rejected', async function () {
  const a = ctxFor();
  const c = ctxFor();
  const shared = tmpdir();
  _fleet.setConfig(a, { dir: shared, name: 'machine-a' });
  _fleet.setConfig(c, { dir: shared, name: 'machine-c' });
  writeProfile(a, 'work', 'work@example.test');
  writeProfile(c, 'ci', 'ci@example.test');

  const busA = _fleet.bus(a, { passphrase: PASS });
  const busC = _fleet.bus(c, { passphrase: PASS });
  _fleet.publish(a, busA, {});
  _fleet.publish(c, busC, {}); // publishing does NOT pin
  _fleet.queue(c, busC, _fleet.identity(a).machineId, { type: 'switch', payload: { account: 'work' } });

  const out = await pushTool().run(a, { passphrase_file: passFile(a), confirm: true, apply: true });
  assert.equal(out.applied.length, 1);
  assert.equal(out.applied[0].ok, false);
  assert.match(out.applied[0].detail, /no pinned key for sender/);
  assert.equal(out.pending.length, 1, 'the stranger is reported as pending, never auto-pinned');
});
