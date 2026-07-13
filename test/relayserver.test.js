'use strict';
// Tests for the self-hostable ZERO-KNOWLEDGE blob relay (src/relayserver.js). Everything
// is exercised over REAL loopback HTTP on an ephemeral port (bind 127.0.0.1, port 0) so we
// cover the actual wire behaviour of the PUT/GET/DELETE/HEAD/OPTIONS subset that keyflip's
// WebDAV client speaks — plus the anti-traversal, size, count, TTL and auth guards.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const relay = require('../src/relayserver');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-relay-')); }

// Minimal raw HTTP client. `rawPath` is sent verbatim (so traversal paths aren't
// normalized by a URL builder). Body may be a Buffer/string.
function req(opts) {
  return new Promise(function (resolve, reject) {
    const headers = Object.assign({}, opts.headers);
    let body = opts.body;
    if (body != null && headers['content-length'] == null) headers['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port: opts.port, method: opts.method, path: opts.path, headers: headers },
      function (res) {
        const chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      });
    r.on('error', function (e) { reject(e); });
    if (body != null) r.write(body);
    r.end();
  });
}

function basic(user, pass) { return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64'); }

async function withServer(opts, fn) {
  const h = await relay.start(opts);
  try { return await fn(h); } finally { await h.close(); }
}

test('PUT then GET round-trips the exact bytes', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    const payload = Buffer.from('ciphertext-\x00\x01\x02-blob');
    const put = await req({ port: h.port, method: 'PUT', path: '/kf/abc123', body: payload });
    assert.strictEqual(put.status, 201);
    const get = await req({ port: h.port, method: 'GET', path: '/kf/abc123' });
    assert.strictEqual(get.status, 200);
    assert.ok(get.body.equals(payload), 'GET returns the identical bytes');
    // stored 0600 and inside the dir
    const st = fs.statSync(path.join(dir, 'abc123'));
    assert.strictEqual(st.mode & 0o777, 0o600);
    // overwrite -> 204
    const put2 = await req({ port: h.port, method: 'PUT', path: '/kf/abc123', body: Buffer.from('again') });
    assert.strictEqual(put2.status, 204);
  });
});

test('HEAD reports presence with no body; 404 when absent', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    await req({ port: h.port, method: 'PUT', path: '/kf/slot1', body: 'hello' });
    const head = await req({ port: h.port, method: 'HEAD', path: '/kf/slot1' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.body.length, 0);
    assert.strictEqual(head.headers['content-length'], '5');
    const miss = await req({ port: h.port, method: 'HEAD', path: '/kf/nope' });
    assert.strictEqual(miss.status, 404);
    assert.strictEqual(miss.body.length, 0);
  });
});

test('GET on a missing slot is 404', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    const get = await req({ port: h.port, method: 'GET', path: '/kf/ghost' });
    assert.strictEqual(get.status, 404);
  });
});

test('DELETE removes the blob and is idempotent (204 even when already gone)', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    await req({ port: h.port, method: 'PUT', path: '/kf/gone', body: 'x' });
    const del = await req({ port: h.port, method: 'DELETE', path: '/kf/gone' });
    assert.strictEqual(del.status, 204);
    assert.strictEqual(fs.existsSync(path.join(dir, 'gone')), false);
    const again = await req({ port: h.port, method: 'DELETE', path: '/kf/gone' });
    assert.strictEqual(again.status, 204); // idempotent
    const get = await req({ port: h.port, method: 'GET', path: '/kf/gone' });
    assert.strictEqual(get.status, 404);
  });
});

test('OPTIONS advertises DAV + Allow so a WebDAV client is satisfied', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    const opt = await req({ port: h.port, method: 'OPTIONS', path: '/kf/anything' });
    assert.strictEqual(opt.status, 200);
    assert.strictEqual(opt.headers['dav'], '1');
    assert.ok(/PUT/.test(opt.headers['allow']) && /DELETE/.test(opt.headers['allow']));
  });
});

test('a disallowed method is 405 with an Allow header', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    const r = await req({ port: h.port, method: 'POST', path: '/kf/x', body: 'y' });
    assert.strictEqual(r.status, 405);
    assert.ok(/GET/.test(r.headers['allow']));
  });
});

// ANTI-TRAVERSAL — the core security property. Every one of these must be REJECTED and must
// NOT create any file outside the storage dir.
test('path-traversal slots are rejected and write nothing outside the dir', async function () {
  const dir = tmpDir();
  const sentinel = path.join(path.dirname(dir), 'ESCAPED-' + path.basename(dir));
  const bigSlot = 'a'.repeat(200);
  const attempts = [
    '/kf/..%2f..%2fetc%2fpasswd',
    '/kf/../x',
    '/kf/../../x',
    '/kf/a/b',
    '/kf/..',
    '/kf/%2e%2e%2fescape',
    '/kf/' + bigSlot,
    '/kf/', // empty slot
    '/kf/sub%2fdir'
  ];
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    for (let i = 0; i < attempts.length; i++) {
      const p = attempts[i];
      const put = await req({ port: h.port, method: 'PUT', path: p, body: 'PWNED' });
      assert.ok(put.status === 400 || put.status === 404, 'traversal PUT ' + p + ' -> ' + put.status);
    }
    // nothing escaped, and the store holds no blobs
    assert.strictEqual(fs.existsSync(sentinel), false, 'no file escaped the storage dir');
    assert.strictEqual(fs.existsSync('/tmp/PWNED'), false);
    const live = fs.readdirSync(dir).filter(function (n) { return n[0] !== '.'; });
    assert.deepStrictEqual(live, [], 'no blob was written for any traversal attempt');
  });
});

test('a valid slot with dot/dash/underscore is accepted (but a bare .. never is)', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    const ok = await req({ port: h.port, method: 'PUT', path: '/kf/a.b-c_d.9', body: 'z' });
    assert.strictEqual(ok.status, 201);
    const bad = await req({ port: h.port, method: 'PUT', path: '/kf/a..b', body: 'z' });
    assert.strictEqual(bad.status, 400, 'a slot containing .. anywhere is rejected');
  });
});

test('a LEADING-dot slot is rejected (else it bypasses the blob-count cap + TTL sweeper)', async function () {
  // Regression (security review): countBlobs skips dotfiles and sweep only reaps '.tmp.*',
  // so a client that could PUT '.x' slots would fill the disk with never-counted,
  // never-expiring blobs. Leading-dot slots must be refused outright.
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0 }, async function (h) {
    for (const p of ['/kf/.x', '/kf/.tmp.forge', '/kf/.hidden.enc']) {
      const put = await req({ port: h.port, method: 'PUT', path: p, body: 'PWNED' });
      assert.strictEqual(put.status, 400, 'leading-dot PUT ' + p + ' -> ' + put.status);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no dotfile (or any file) was written');
  });
});

test('oversized PUT is refused (both declared and streamed)', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0, maxBlobBytes: 16 }, async function (h) {
    // declared content-length over the cap -> 413
    const declared = await req({ port: h.port, method: 'PUT', path: '/kf/big', body: Buffer.alloc(64, 1) });
    assert.strictEqual(declared.status, 413);
    assert.strictEqual(fs.existsSync(path.join(dir, 'big')), false);

    // streamed over the cap with a lying content-length -> socket destroyed, no file
    const err = await new Promise(function (resolve) {
      const r = http.request({ host: '127.0.0.1', port: h.port, method: 'PUT', path: '/kf/big2',
        headers: { 'content-length': '4' } }, function (res) { resolve({ status: res.statusCode }); });
      r.on('error', function (e) { resolve({ error: e.code || e.message }); });
      // write far more than 4 bytes / the cap; the server should kill the socket
      r.write(Buffer.alloc(64, 2));
      // give the server a beat to react, then try to finish
      setTimeout(function () { try { r.end(); } catch (e) { /* ignore */ } }, 30);
    });
    assert.ok(err.status === 413 || err.error, 'streamed overflow is 413 or a killed socket');
    assert.strictEqual(fs.existsSync(path.join(dir, 'big2')), false);
    // no temp files left behind either
    const tmps = fs.readdirSync(dir).filter(function (n) { return n.indexOf('.tmp.') === 0; });
    assert.deepStrictEqual(tmps, []);
  });
});

test('maxBlobs cap returns 507 when the store is full', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0, maxBlobs: 2 }, async function (h) {
    assert.strictEqual((await req({ port: h.port, method: 'PUT', path: '/kf/a', body: '1' })).status, 201);
    assert.strictEqual((await req({ port: h.port, method: 'PUT', path: '/kf/b', body: '2' })).status, 201);
    const full = await req({ port: h.port, method: 'PUT', path: '/kf/c', body: '3' });
    assert.strictEqual(full.status, 507);
    assert.strictEqual(fs.existsSync(path.join(dir, 'c')), false);
    // overwriting an EXISTING slot is still allowed even when full
    const over = await req({ port: h.port, method: 'PUT', path: '/kf/a', body: '11' });
    assert.strictEqual(over.status, 204);
  });
});

// AUTH — HTTP Basic, constant-time, no length oracle / no throw on mismatch.
test('Basic auth: no creds -> 401, wrong creds -> 401, right creds -> 2xx', async function () {
  const dir = tmpDir();
  await withServer({ dir: dir, host: '127.0.0.1', port: 0, auth: { user: 'relay', pass: 's3cret' } }, async function (h) {
    const none = await req({ port: h.port, method: 'PUT', path: '/kf/x', body: 'z' });
    assert.strictEqual(none.status, 401);
    assert.ok(/Basic/.test(none.headers['www-authenticate']));

    // wrong pass AND a different-length credential must both just 401 (no crash/throw)
    const wrong = await req({ port: h.port, method: 'PUT', path: '/kf/x', body: 'z', headers: { authorization: basic('relay', 'nope') } });
    assert.strictEqual(wrong.status, 401);
    const wrongLen = await req({ port: h.port, method: 'PUT', path: '/kf/x', body: 'z', headers: { authorization: basic('a', 'b') } });
    assert.strictEqual(wrongLen.status, 401, 'length mismatch does not throw, just fails');
    const garbage = await req({ port: h.port, method: 'GET', path: '/kf/x', headers: { authorization: 'Basic not-base64!!' } });
    assert.strictEqual(garbage.status, 401);

    const ok = await req({ port: h.port, method: 'PUT', path: '/kf/x', body: 'z', headers: { authorization: basic('relay', 's3cret') } });
    assert.strictEqual(ok.status, 201);
    const okGet = await req({ port: h.port, method: 'GET', path: '/kf/x', headers: { authorization: basic('relay', 's3cret') } });
    assert.strictEqual(okGet.status, 200);
  });
});

// SAFE-BY-DEFAULT: refuse an open, writable store on a non-loopback interface.
test('refuses to bind a non-loopback host with no auth (unless allowUnauthenticated)', async function () {
  const dir = tmpDir();
  await assert.rejects(function () {
    return relay.start({ dir: dir, host: '0.0.0.0', port: 0, auth: null });
  }, /refusing to expose/);

  // with auth it is allowed to construct (we don't actually bind a public port in CI)
  assert.doesNotThrow(function () {
    relay.createRelayServer({ dir: dir, host: '0.0.0.0', port: 0, auth: { user: 'u', pass: 'p' } });
  });
  // or with the explicit opt-in flag
  assert.doesNotThrow(function () {
    relay.createRelayServer({ dir: dir, host: '0.0.0.0', port: 0, auth: null, allowUnauthenticated: true });
  });
});

test('TTL sweep removes blobs older than ttlMs (using the injectable clock)', async function () {
  const dir = tmpDir();
  let clock = 1000000;
  const now = function () { return clock; };
  await withServer({ dir: dir, host: '127.0.0.1', port: 0, ttlMs: 1000, now: now }, async function (h) {
    await req({ port: h.port, method: 'PUT', path: '/kf/fresh', body: 'x' });
    // backdate the file well past the TTL
    const old = new Date(clock - 5000);
    fs.utimesSync(path.join(dir, 'fresh'), old, old);
    // advance the clock and trigger a sweep via a fresh request
    clock += 10000;
    relay._sweep(h.cfg);
    assert.strictEqual(fs.existsSync(path.join(dir, 'fresh')), false, 'expired blob was swept');
  });
});

test('start() reports the actual ephemeral port and binds loopback', async function () {
  const dir = tmpDir();
  const h = await relay.start({ dir: dir, host: '127.0.0.1', port: 0 });
  try {
    assert.ok(h.port > 0 && h.port < 65536, 'a real bound port is reported');
    assert.strictEqual(h.host, '127.0.0.1');
  } finally { await h.close(); }
});

test('createHandler requires a storage dir', function () {
  assert.throws(function () { relay.createHandler({}); }, /dir/);
});
