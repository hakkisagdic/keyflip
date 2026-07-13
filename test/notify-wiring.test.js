'use strict';
// Wave-4/cleanup: the notify system was fully built but NOTHING emitted events — `notify.send`
// was only reachable via `notify test`. These tests prove the real wiring: a configured webhook
// actually receives a 'switch' event when the user switches accounts (and nothing is sent when
// the event isn't subscribed). End-to-end through the spawned CLI + a live loopback HTTP sink.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function setupHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-notif-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"live":"TOKEN-1"}');
  fs.writeFileSync(path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com' }, userID: 'u1' }));
  return home;
}
function loginAs(home, email, userID, token) {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ live: token }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email }, userID: userID }));
}
function childEnv(home) {
  return Object.assign({}, process.env, {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    KEYFLIP_TEST_CLAUDE: 'stopped',
  });
}
function run(home, args) {
  return require('child_process').spawnSync(process.execPath, [BIN].concat(args), { encoding: 'utf8', env: childEnv(home) });
}
// Async spawn — REQUIRED for any CLI call whose webhook posts back to the in-process sink:
// spawnSync would block this process's event loop, so the loopback HTTP server could never
// accept the child's POST (the child's fetch would just time out). spawn keeps the loop free.
function runAsync(home, args) {
  return new Promise(function (resolve) {
    const cp = require('child_process').spawn(process.execPath, [BIN].concat(args), { env: childEnv(home) });
    let out = '', err = '';
    cp.stdout.on('data', function (d) { out += d; });
    cp.stderr.on('data', function (d) { err += d; });
    cp.on('close', function (code) { resolve({ status: code, stdout: out, stderr: err }); });
  });
}
// A loopback sink that records every POSTed webhook body. start() -> {url, hits, close}.
function startSink() {
  const hits = [];
  const server = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () { hits.push({ method: req.method, body: body }); res.writeHead(200); res.end('ok'); });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      resolve({ url: 'http://127.0.0.1:' + port + '/hook', hits: hits, close: function () { return new Promise(function (r) { server.close(r); }); } });
    });
  });
}
function twoAccounts(home) {
  run(home, ['add']);                                 // save alice (current)
  loginAs(home, 'bob@example.com', 'u2', 'TOKEN-2');
  run(home, ['add']);                                 // save bob (current)
}

test('a configured webhook receives a switch event when the account is switched', async function () {
  const home = setupHome();
  const sink = await startSink();
  try {
    twoAccounts(home);
    const set = run(home, ['notify', 'set', '--webhook', sink.url, '--events', 'switch']);
    assert.strictEqual(set.status, 0, set.stderr);

    const sw = await runAsync(home, ['alice', '--force']); // switch bob -> alice (async: sink must stay serveable)
    assert.strictEqual(sw.status, 0, sw.stderr);

    assert.strictEqual(sink.hits.length, 1, 'exactly one webhook POST on switch');
    const msg = JSON.parse(sink.hits[0].body);
    assert.strictEqual(msg.event, 'switch');
    assert.strictEqual(msg.payload.to, 'alice');
  } finally {
    await sink.close();
  }
});

test('no webhook fires when the switch event is NOT subscribed', async function () {
  const home = setupHome();
  const sink = await startSink();
  try {
    twoAccounts(home);
    // subscribe only to 'quota' — a switch must not deliver anything.
    run(home, ['notify', 'set', '--webhook', sink.url, '--events', 'quota']);
    const sw = run(home, ['alice', '--force']);
    assert.strictEqual(sw.status, 0, sw.stderr);
    assert.strictEqual(sink.hits.length, 0, 'switch is not in the subscribed events → no POST');
  } finally {
    await sink.close();
  }
});

test('no webhook configured → a switch still succeeds and sends nothing', async function () {
  const home = setupHome();
  const sink = await startSink();
  try {
    twoAccounts(home);
    const sw = run(home, ['alice', '--force']); // notify never configured
    assert.strictEqual(sw.status, 0, sw.stderr);
    assert.strictEqual(sink.hits.length, 0);
  } finally {
    await sink.close();
  }
});
