// `keyflip fleet discover` at the CLI level — the half the module tests cannot prove.
//
// test/lanfleet.test.js covers the beacon bytes and one in-process listener. These tests spawn
// REAL `bin/keyflip.js` processes with separate HOMEs, so the thing being tested is the command a
// user runs: identity minting, announcement, JSON output, and the Tailscale fallback ordering.
//
// Two processes on one host are not two physical machines, but they do exercise the actual
// multicast wire and two independent machine identities. If a host blocks multicast the LAN test
// skips (like the module test) instead of failing a machine that simply has no LAN discovery.
//
// Tailscale is exercised with a fake `tailscale` executable on PATH: the CLI shells out to
// `tailscale status --json`, so a script that prints a canned status tests the exact production
// code path without a tailnet, an install, or a login.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-discover-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN"}'); // forces FileStore
  return home;
}

function envFor(home, extra) {
  return Object.assign(
    {},
    process.env,
    {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      KEYFLIP_CONFIG_DIR: path.join(home, '.config', 'keyflip'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped', // never touch a real desktop app
      KEYFLIP_APP_BUNDLE: path.join(home, 'no-such-Claude.app'),
    },
    extra || {},
  );
}

function run(home, args, extraEnv) {
  return _child_process.spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: envFor(home, extraEnv),
  });
}

function discoverJson(r, label) {
  assert.strictEqual(r.status, 0, label + ' exited ' + r.status + ': ' + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.fleetDiscover, label + ' printed a fleetDiscover object');
  return out.fleetDiscover;
}

// Spawn a discover process now and resolve when it exits. Used to run two at once: each announces
// while it listens, which is the only way two zero-configuration machines ever meet.
function discoverAsync(home, args) {
  return new Promise(function (resolve, reject) {
    const child = _child_process.spawn(process.execPath, [BIN].concat(args), {
      env: envFor(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', function (d) {
      stdout += d;
    });
    child.stderr.on('data', function (d) {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', function (status) {
      resolve({ status: status, stdout: stdout, stderr: stderr });
    });
  });
}

test('two live CLI processes discover each other over multicast and each excludes itself', async function (t) {
  const homeA = setupHome();
  const homeB = setupHome();
  const args = ['--json', 'fleet', 'discover', '--timeout', '2500'];
  const both = await Promise.all([discoverAsync(homeA, args), discoverAsync(homeB, args)]);
  const a = discoverJson(both[0], 'A');
  const b = discoverJson(both[1], 'B');

  assert.notStrictEqual(a.self.machineId, b.self.machineId, 'separate homes mint separate identities');
  assert.strictEqual(a.announced, true, 'announce is ON by default: two listeners must be able to meet');
  assert.strictEqual(b.announced, true);

  const seenByA = a.peers.map(function (p) {
    return p.machineId;
  });
  const seenByB = b.peers.map(function (p) {
    return p.machineId;
  });
  if (!seenByA.length && !seenByB.length) {
    return t.skip('multicast was not delivered on this host (locked-down network)');
  }
  assert.ok(seenByA.indexOf(b.self.machineId) !== -1, 'A saw B');
  assert.ok(seenByB.indexOf(a.self.machineId) !== -1, 'B saw A');
  assert.strictEqual(seenByA.indexOf(a.self.machineId), -1, 'A never lists itself as a peer');
  assert.strictEqual(seenByB.indexOf(b.self.machineId), -1, 'B never lists itself as a peer');

  const peerA = a.peers.filter(function (p) {
    return p.machineId === b.self.machineId;
  })[0];
  assert.strictEqual(peerA.fp, b.self.fp, 'the advertised fingerprint is the peer identity fingerprint');
  assert.ok(peerA.host, 'a LAN peer carries the address it answered from');
  assert.strictEqual(a.lan, a.peers.length, 'these peers came from the LAN');
  assert.strictEqual(a.transport, 'lan');
});

test('--no-announce stays silent but still hears an announcing peer', async function (t) {
  const quietHome = setupHome();
  const loudHome = setupHome();
  // The loud side announces; the quiet side must not (and must still discover the loud one).
  const [quiet, loud] = await Promise.all([
    discoverAsync(quietHome, ['--json', 'fleet', 'discover', '--timeout', '2500', '--no-announce']),
    discoverAsync(loudHome, ['--json', 'fleet', 'discover', '--timeout', '2500']),
  ]);
  const q = discoverJson(quiet, 'quiet');
  const l = discoverJson(loud, 'loud');
  assert.strictEqual(q.announced, false);
  assert.strictEqual(l.announced, true);
  const quietSeesLoud = q.peers.some(function (p) {
    return p.machineId === l.self.machineId;
  });
  if (!quietSeesLoud && q.lan === 0) return t.skip('multicast was not delivered on this host (locked-down network)');
  assert.ok(quietSeesLoud, 'a silent listener still sees an announcer');
  assert.strictEqual(
    l.peers.some(function (p) {
      return p.machineId === q.self.machineId;
    }),
    false,
    'the announcing side never hears the silent machine — --no-announce really is silent',
  );
});

// A fake `tailscale` on PATH. The real CLI runs `tailscale status --json`; this answers it exactly
// once with the canned payload, so the fallback path is tested without Tailscale installed.
function fakeTailscale(t, body, opts) {
  if (process.platform === 'win32') {
    t.skip('the fake tailscale executable is a POSIX shell script');
    return null;
  }
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-fake-ts-'));
  const statusFile = path.join(dir, 'status.json');
  fs.writeFileSync(statusFile, typeof body === 'string' ? body : JSON.stringify(body));
  const script = path.join(dir, 'tailscale');
  fs.writeFileSync(
    script,
    '#!/bin/sh\n' +
      'if [ "$1" = "status" ] && [ "$2" = "--json" ]; then\n' +
      (opts.fail ? '  exit 1\n' : "  cat '" + statusFile + "'\n  exit 0\n") +
      'fi\n' +
      'exit 1\n',
  );
  fs.chmodSync(script, 0o755);
  return dir;
}

function withoutLanPeers(r) {
  // Accepts a spawnSync result or an already-parsed fleetDiscover object. A real keyflip machine
  // on the same network would win before Tailscale is consulted; that is correct behaviour, so
  // only the no-LAN case can assert the fallback.
  const d = r.fleetDiscover || r;
  return d.lan === 0;
}

test('Tailscale fallback: online peers appear when multicast finds nobody', async function (t) {
  const binDir = fakeTailscale(t, {
    Peer: {
      p1: { Hostname: 'Office Mac', Online: true, TailscaleIPs: ['100.101.102.103', 'fd7a::1'], PublicKey: 'nope' },
      p2: { Hostname: 'offline-box', Online: false, TailscaleIPs: ['100.101.102.104'] },
    },
  });
  if (!binDir) return;
  const home = setupHome();
  const r = run(home, ['--json', 'fleet', 'discover', '--timeout', '250', '--no-announce'], {
    PATH: binDir + path.delimiter + process.env.PATH,
  });
  const d = discoverJson(r, 'fleet discover');
  if (!withoutLanPeers(d)) return t.skip('a real LAN peer exists on this network; it correctly won over Tailscale');
  assert.strictEqual(d.tailscale, 1);
  assert.strictEqual(d.transport, 'tailscale');
  assert.deepStrictEqual(d.peers, [
    { machineId: 'OfficeMac', name: 'Office Mac', host: '100.101.102.103', transport: 'tailscale', online: true },
  ]);
});

test('Tailscale fallback: a failing or malformed tailscale degrades to zero peers, not a crash', async function (t) {
  const failDir = fakeTailscale(t, {}, { fail: true });
  if (!failDir) return;
  const home = setupHome();
  let r = run(home, ['--json', 'fleet', 'discover', '--timeout', '250', '--no-announce'], {
    PATH: failDir + path.delimiter + process.env.PATH,
  });
  let d = discoverJson(r, 'failing tailscale');
  if (!withoutLanPeers(d)) return t.skip('a real LAN peer exists on this network; it correctly won over Tailscale');
  assert.strictEqual(d.tailscale, 0);
  assert.strictEqual(d.transport, 'lan');

  const badDir = fakeTailscale(t, 'this is not json');
  const r2 = run(home, ['--json', 'fleet', 'discover', '--timeout', '250', '--no-announce'], {
    PATH: badDir + path.delimiter + process.env.PATH,
  });
  const d2 = discoverJson(r2, 'malformed tailscale');
  if (!withoutLanPeers(d2)) return t.skip('a real LAN peer exists on this network; it correctly won over Tailscale');
  assert.strictEqual(d2.tailscale, 0);
  assert.deepStrictEqual(d2.peers, []);
});
