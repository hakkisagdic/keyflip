'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const update = require('../src/update');
const { tmpdir } = require('./helpers');

function ctxAt(dir) { return { configDir: dir }; }
const NOW = 1800000000000;

test('cmpVersions orders semver-ish versions', function () {
  assert.strictEqual(update.cmpVersions('1.2.0', '1.1.9'), 1);
  assert.strictEqual(update.cmpVersions('1.1.0', '1.1.0'), 0);
  assert.strictEqual(update.cmpVersions('0.9.9', '1.0.0'), -1);
});

test('latestVersion fetches once and then serves the 24h cache', async function () {
  const dir = tmpdir();
  let calls = 0;
  const f = async function () { calls++; return { ok: true, json: async function () { return { version: '9.9.9' }; } }; };
  assert.strictEqual(await update.latestVersion(ctxAt(dir), { fetch: f, nowMs: NOW }), '9.9.9');
  assert.strictEqual(await update.latestVersion(ctxAt(dir), { fetch: f, nowMs: NOW + 1000 }), '9.9.9');
  assert.strictEqual(calls, 1); // second hit came from cache
  // cache expiry re-fetches
  await update.latestVersion(ctxAt(dir), { fetch: f, nowMs: NOW + 25 * 3600 * 1000 });
  assert.strictEqual(calls, 2);
});

test('maybeNotify prints only when newer, and never throws on network failure', async function () {
  const dir = tmpdir();
  let out = '';
  const stderr = { write: function (s) { out += s; } };
  const newer = async function () { return { ok: true, json: async function () { return { version: '99.0.0' }; } }; };
  const latest = await update.maybeNotify(ctxAt(dir), '1.0.0', { fetch: newer, nowMs: NOW, stderr: stderr });
  assert.strictEqual(latest, '99.0.0');
  assert.match(out, /99\.0\.0 is available/);

  const dir2 = tmpdir();
  out = '';
  const boom = async function () { throw new Error('offline'); };
  const r = await update.maybeNotify(ctxAt(dir2), '1.0.0', { fetch: boom, nowMs: NOW, stderr: stderr });
  assert.strictEqual(r, null);
  assert.strictEqual(out, '');
});

test('detectInstallMethod recognizes installer copies and npm globals', function () {
  const home = tmpdir();
  const inst = path.join(home, '.local', 'share', 'ccswitch', 'bin', 'ccswitch.js');
  fs.mkdirSync(path.dirname(inst), { recursive: true });
  fs.writeFileSync(inst, '');
  assert.strictEqual(update.detectInstallMethod(inst), 'installer');
  assert.strictEqual(update.detectInstallMethod('/usr/local/lib/node_modules/ccswitch/bin/ccswitch.js'), 'npm');
  assert.strictEqual(update.detectInstallMethod('/some/random/place/ccswitch.js'), 'unknown');
  // Platform-explicit so the assertion holds on the Windows CI runner too.
  assert.ok(update.upgradeCommand('installer', 'linux').indexOf('install.sh') !== -1);
  assert.ok(update.upgradeCommand('installer', 'win32').indexOf('install.ps1') !== -1);
  assert.ok(update.upgradeCommand('npm', 'linux').indexOf('npm install -g') !== -1);
  // upgradeSpawn never uses bash on Windows.
  assert.strictEqual(update.upgradeSpawn('npm', 'win32').cmd, 'npm.cmd');
  assert.strictEqual(update.upgradeSpawn('installer', 'win32').cmd, 'powershell');
  assert.strictEqual(update.upgradeSpawn('installer', 'linux').cmd, 'bash');
});
