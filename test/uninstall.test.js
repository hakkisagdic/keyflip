'use strict';
// Tests for `keyflip reset` / `keyflip uninstall` and the profiles.list fix that
// stops keyflip's own state files (breakers.json, proxy.json, …) being counted as
// accounts. Unit tests exercise the pure planner; integration tests spawn the CLI
// against a temp HOME (mirrors cli.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uninstall = require('../src/uninstall');
const profiles = require('../src/profiles');

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-uninst-')); }

function run(home, args, extraEnv) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      KEYFLIP_TEST_CLAUDE: 'stopped',
    }, extraEnv || {}),
  });
}

// ---- profiles.list: reserved state files are not accounts --------------------

test('profiles.list excludes keyflip state files, keeps real profiles', function () {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'work.json'), '{"name":"work","email":"a@x.com"}');
  fs.writeFileSync(path.join(dir, 'home.json'), '{"name":"home","email":"b@x.com"}');
  ['breakers', 'proxy', 'mcp-registry', 'links', 'installed-skills'].forEach(function (n) {
    fs.writeFileSync(path.join(dir, n + '.json'), '{}');
  });
  const got = profiles.list(dir);
  assert.deepStrictEqual(got, ['home', 'work']); // sorted, no reserved names
});

// ---- classifyInstall ---------------------------------------------------------

test('classifyInstall detects installer / npm / dev', function () {
  assert.strictEqual(uninstall.classifyInstall(path.join('/Users/x', '.local', 'share', 'keyflip', 'bin', 'keyflip.js')), 'installer');
  assert.strictEqual(uninstall.classifyInstall(path.join('/usr', 'lib', 'node_modules', 'keyflip', 'bin', 'keyflip.js')), 'npm');
  assert.strictEqual(uninstall.classifyInstall(path.join('/Users/x', 'Documents', 'keyflip', 'bin', 'keyflip.js')), 'dev');
});

// ---- planUninstall -----------------------------------------------------------

test('planUninstall (installer) lists symlink, program dir; app only on macOS', function () {
  const mac = uninstall.planUninstall({ method: 'installer', home: '/h', platform: 'darwin' });
  const labels = mac.files.map(function (f) { return f.label; });
  assert.ok(labels.indexOf('CLI symlink') !== -1);
  assert.ok(labels.indexOf('program files') !== -1);
  assert.ok(labels.indexOf('launcher app') !== -1);
  // program dir removed last (holds the running JS)
  assert.ok(mac.files[mac.files.length - 1].self === true);

  const lin = uninstall.planUninstall({ method: 'installer', home: '/h', platform: 'linux' });
  assert.ok(lin.files.map(function (f) { return f.label; }).indexOf('launcher app') === -1);
  assert.ok(lin.pathNote && /keyflip PATH/.test(lin.pathNote));
});

test('planUninstall (npm) yields an npm uninstall spawn; dev yields a no-op', function () {
  const npm = uninstall.planUninstall({ method: 'npm', home: '/h', platform: 'linux' });
  assert.deepStrictEqual(npm.npm, { cmd: 'npm', args: ['uninstall', '-g', 'keyflip'] });
  const win = uninstall.planUninstall({ method: 'npm', home: '/h', platform: 'win32' });
  assert.strictEqual(win.npm.cmd, 'npm.cmd');

  const dev = uninstall.planUninstall({ method: 'dev', home: '/h', platform: 'linux' });
  assert.deepStrictEqual(dev.files, []);
  assert.strictEqual(dev.npm, null);
});

test('installerArtifacts honors KEYFLIP_* env overrides and the removal loop clears them', function () {
  const base = tmp();
  const shareDir = path.join(base, 'share', 'keyflip');
  const binDir = path.join(base, 'bin');
  const appDir = path.join(base, 'Applications');
  fs.mkdirSync(shareDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(appDir, 'Keyflip.app'), { recursive: true });
  fs.writeFileSync(path.join(binDir, 'keyflip'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(shareDir, 'marker'), 'x');

  const items = uninstall.installerArtifacts({ home: base, platform: 'darwin', shareDir: shareDir, binDir: binDir, appDir: appDir });
  items.forEach(function (f) { fs.rmSync(f.path, { recursive: true, force: true }); });
  assert.ok(!fs.existsSync(path.join(binDir, 'keyflip')));
  assert.ok(!fs.existsSync(shareDir));
  assert.ok(!fs.existsSync(path.join(appDir, 'Keyflip.app')));
});

test('derivedStatePaths are all under configDir and name the runtime files', function () {
  const paths = uninstall.derivedStatePaths({ configDir: '/cfg' });
  const names = paths.map(function (p) { return p.name; });
  ['usage-history.jsonl', 'proxy.json', 'breakers.json', 'events.jsonl', 'logs'].forEach(function (n) {
    assert.ok(names.indexOf(n) !== -1, 'expected ' + n);
  });
  paths.forEach(function (p) { assert.ok(p.path.indexOf('/cfg') === 0); });
  // never touches account/provider/backup data
  assert.ok(names.indexOf('providers') === -1);
  assert.ok(names.indexOf('backups') === -1);
});

// ---- integration: reset keeps accounts, clears runtime state -----------------

function seed(home) {
  const cfg = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(path.join(cfg, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'providers'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'work.json'), '{"name":"work","email":"a@x.com"}');
  fs.writeFileSync(path.join(cfg, 'home.json'), '{"name":"home","email":"b@x.com"}');
  fs.writeFileSync(path.join(cfg, 'providers', 'relay.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'backups', 'b1.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'usage-history.jsonl'), 'x\n');
  fs.writeFileSync(path.join(cfg, 'breakers.json'), '{}');
  fs.writeFileSync(path.join(cfg, 'logs', 'x.log'), 'l\n');
  return cfg;
}

test('reset --force keeps accounts + providers + backups, clears runtime state', function () {
  const home = tmp();
  const cfg = seed(home);
  const r = run(home, ['reset', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  // kept
  assert.ok(fs.existsSync(path.join(cfg, 'work.json')));
  assert.ok(fs.existsSync(path.join(cfg, 'home.json')));
  assert.ok(fs.existsSync(path.join(cfg, 'providers')));
  assert.ok(fs.existsSync(path.join(cfg, 'backups')));
  // cleared
  assert.ok(!fs.existsSync(path.join(cfg, 'usage-history.jsonl')));
  assert.ok(!fs.existsSync(path.join(cfg, 'breakers.json')));
  assert.ok(!fs.existsSync(path.join(cfg, 'logs')));
  // no phantom profile written by the schema migration
  assert.ok(!fs.existsSync(path.join(cfg, 'undefined.json')));
  assert.match(r.stdout, /2 saved account\(s\)/);
});

test('reset --json without --force on a non-TTY refuses (does not delete)', function () {
  const home = tmp();
  const cfg = seed(home);
  const r = run(home, ['reset']);
  assert.notStrictEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(cfg, 'usage-history.jsonl')), 'must not clear without confirmation');
});

// ---- integration: uninstall from a dev checkout never deletes the repo -------

test('uninstall --purge --force from a source checkout leaves the repo, purges data', function () {
  const home = tmp();
  const cfg = seed(home);
  const r = run(home, ['uninstall', '--purge', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /source checkout/);
  assert.match(r.stdout, /left untouched/);
  // data purged (whole config dir gone)
  assert.ok(!fs.existsSync(cfg));
  // the repo bin is obviously still here (we just ran it)
  assert.ok(fs.existsSync(BIN));
});

test('uninstall (no --purge) from a source checkout is a no-op that keeps data', function () {
  const home = tmp();
  const cfg = seed(home);
  const r = run(home, ['uninstall', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cfg, 'work.json')), 'data kept without --purge');
});
