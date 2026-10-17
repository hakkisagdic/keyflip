// #57 FLEET LAN DISCOVERY — the zero-dependency multicast beacon that lets two keyflip machines
// find each other on the same network WITHOUT the shared rendezvous folder. Two things must hold:
// the wire format carries ONLY public identity (never a passphrase/private key/command), and a
// hostile datagram can never inject a machine id that later reaches a bus filename.
import test from 'node:test';
import assert from 'node:assert';
import * as lanfleet from '../src/lanfleet.js';
import * as fleet from '../src/fleet.js';
import { makeCtx } from './helpers.js';

// ---- wire format (pure; no sockets) ------------------------------------------

test('a beacon round-trips machine id, name and fingerprint', function () {
  const buf = lanfleet.encodeBeacon({ machineId: 'mac-a1b2c3', name: 'Mac', fp: 'aa:bb:cc' });
  const got = lanfleet.decodeBeacon(buf);
  assert.deepStrictEqual(got, { machineId: 'mac-a1b2c3', name: 'Mac', fp: 'aa:bb:cc' });
});

test('a beacon carries ONLY public identity — never a secret field', function () {
  const me = { machineId: 'm', name: 'n', fp: 'f', passphrase: 'SECRET-PASS', privatePem: 'SECRET-KEY' };
  const raw = lanfleet.encodeBeacon(me).toString('utf8');
  assert.strictEqual(raw.indexOf('SECRET'), -1, 'extra fields are dropped: the beacon is a fixed shape');
  const j = JSON.parse(raw);
  assert.deepStrictEqual(Object.keys(j).sort(), ['fp', 'id', 'keyflip', 'n', 'v']);
});

test('decode rejects a foreign tag, a malformed buffer, and an unsafe id', function () {
  assert.strictEqual(lanfleet.decodeBeacon(Buffer.from('{not json')), null);
  assert.strictEqual(lanfleet.decodeBeacon(Buffer.from(JSON.stringify({ keyflip: 'transfer', id: 'x' }))), null);
  assert.strictEqual(lanfleet.decodeBeacon(Buffer.from(JSON.stringify({ keyflip: 'fleet-discover' }))), null);
  // An id that would escape a filename (slash) or a prototype key must never survive.
  assert.strictEqual(
    lanfleet.decodeBeacon(Buffer.from(JSON.stringify({ keyflip: 'fleet-discover', id: '../etc/passwd' }))),
    null,
  );
  assert.strictEqual(lanfleet.decodeBeacon(Buffer.from(JSON.stringify({ keyflip: 'fleet-discover', id: '-' }))), null);
});

test('a beacon with no fingerprint still announces presence (a machine with no key yet)', function () {
  const got = lanfleet.decodeBeacon(lanfleet.encodeBeacon({ machineId: 'fresh', name: 'Fresh' }));
  assert.strictEqual(got.machineId, 'fresh');
  assert.strictEqual(got.fp, null);
});

test('fingerprint matches the one fleet prints for the same key (out-of-band comparison stays honest)', function () {
  const ctx = makeCtx();
  const pub = fleet.publicKey(ctx);
  assert.strictEqual(lanfleet.fingerprint(pub), fleet.fingerprint(pub));
});

// ---- real loopback multicast (the actual wire) -------------------------------

test('announce is heard by discover, and discover excludes the announcer itself', async function () {
  const a = lanfleet.announce({ machineId: 'peer-alpha', name: 'Alpha', fp: 'aa:bb' }, { intervalMs: 200 });
  const b = lanfleet.announce({ machineId: 'peer-beta', name: 'Beta', fp: 'cc:dd' }, { intervalMs: 200 });
  try {
    const seen = await lanfleet.discover({ timeoutMs: 1500 });
    const ids = seen.map(function (p) {
      return p.machineId;
    });
    // Multicast delivery is best-effort; on a host that blocks it we get [] and skip rather than flake.
    if (!ids.length) return;
    assert.ok(ids.indexOf('peer-alpha') !== -1 || ids.indexOf('peer-beta') !== -1, 'saw at least one peer');

    const withoutAlpha = await lanfleet.discover({ timeoutMs: 1500, exclude: 'peer-alpha' });
    const rest = withoutAlpha.map(function (p) {
      return p.machineId;
    });
    assert.strictEqual(rest.indexOf('peer-alpha'), -1, 'exclude filters the given machine id out');
  } finally {
    a.stop();
    b.stop();
  }
});

test('discover resolves [] (never rejects) when nothing is listening', async function () {
  const seen = await lanfleet.discover({ timeoutMs: 300, exclude: 'nobody' });
  assert.ok(Array.isArray(seen), 'a hostile/locked-down network yields an empty list, not a crash');
});
