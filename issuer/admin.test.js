'use strict';
// ISSUER / admin.test.js — zero-dep (node:test + node:assert) coverage for the
// admin panel: the bearer-token gate, the issue / reissue / revoke paths, the
// lookup + list filters, and the event log view.
//
// What it proves:
//   * With NO token configured the panel is DISABLED (503) — it fails closed.
//   * A wrong/missing token is 401; the right token is accepted.
//   * Issuing returns a token ONCE and the token is NEVER persisted (the store
//     file and the event log contain no token-shaped string).
//   * The minted token verifies GREEN in src/license.js when that module's
//     public key is set to our throwaway keypair — a real cross-check of the
//     crypto contract, not a self-test.
//   * Revoke marks the record; a second revoke is 409; reissue mints a NEW
//     license and supersedes the old one.
//   * Bad input (tier / email / months) is rejected with 400 and mints nothing.
//
// Isolation: a throwaway Ed25519 keypair, an injected signer, and a temp dir.
// No real issuer key on disk, no network.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createAdmin } = require('./admin');
const { LicenseStore, EventLog } = require('./store');
const license = require('../src/license');

// ---- helpers ------------------------------------------------------------------
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-admin-'));
}

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { publicKey, privateKey, spkiB64 };
}

// Drive a request through the admin handler without opening a port.
function request(handler, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const req = http.request(
        { host: '127.0.0.1', port, method, path: urlPath, headers: opts.headers || {} },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
            srv.close(() => resolve({ status: res.statusCode, json, text, headers: res.headers }));
          });
        },
      );
      req.on('error', (e) => {
        srv.close(() => reject(e));
      });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  });
}

function bearer(token) {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
}

// Build an admin with a throwaway signer + temp storage.
function makeAdmin(opts) {
  opts = opts || {};
  const dir = tmpDir();
  const kp = makeKeypair();
  const store = new LicenseStore({ file: path.join(dir, 'licenses.json') });
  const events = new EventLog({ file: path.join(dir, 'events.jsonl') });
  const sign = require('./sign');
  const admin = createAdmin({
    token: opts.token === undefined ? 'test-token' : opts.token,
    store,
    events,
    signLicense: (payload) => sign.signLicense(payload, kp.privateKey),
    log: () => {},
  });
  return { admin, dir, kp, store, events };
}

// ---- tests --------------------------------------------------------------------

test('the panel PAGE boots: its script has no undefined globals', () => {
  // The panel is one inline <script>. If it references a name that does not
  // exist in the browser, the whole IIFE dies at that line and the page renders
  // but does NOTHING (no tier list, no Connect button, no issue button). That
  // is invisible to an HTTP-level test, so we actually BOOT the script in a
  // node:vm sandbox with a tiny DOM stub and assert it runs clean.
  const html = require('./admin').PANEL_HTML;
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the panel must contain exactly one inline script');
  assert.ok(!/__TIERS_JSON__/.test(html), 'the tier placeholder must be resolved');

  function makeEl(tag) {
    return {
      tagName: tag,
      value: '',
      textContent: '',
      className: '',
      style: {},
      colSpan: 1,
      children: [],
      appendChild(c) {
        this.children.push(c);
        return c;
      },
    };
  }
  const byId = {};
  const getEl = (id) => {
    if (!byId[id]) byId[id] = makeEl('input');
    return byId[id];
  };
  const sandbox = {
    document: {
      getElementById: getEl,
      createElement: (tag) => makeEl(tag),
    },
    fetch: () => Promise.reject(new Error('no network in this test')),
    encodeURIComponent,
    console,
  };
  vm.createContext(sandbox);
  // A ReferenceError here means the page would be dead in a real browser.
  vm.runInContext(m[1], sandbox, { filename: 'panel.js' });

  // The tier dropdown is filled from the server's own tier table.
  const options = getEl('tier').children.map((o) => o.value);
  assert.deepStrictEqual(options, ['pro', 'team', 'enterprise']);
  // The buttons are wired (the page would be inert otherwise).
  assert.strictEqual(typeof getEl('connect').onclick, 'function');
  assert.strictEqual(typeof getEl('issue').onclick, 'function');
  assert.strictEqual(typeof getEl('refresh').onclick, 'function');
});

test('with no configured token the panel is disabled (503)', async () => {
  const { admin } = makeAdmin({ token: '' });
  const r = await request(admin.handler, 'GET', '/admin/api/licenses', { headers: bearer('anything') });
  assert.strictEqual(r.status, 503);
  assert.ok(/disabled/i.test(r.json.error));
});

test('a wrong or missing token is 401', async () => {
  const { admin } = makeAdmin();
  const wrong = await request(admin.handler, 'GET', '/admin/api/licenses', { headers: bearer('nope') });
  assert.strictEqual(wrong.status, 401);
  const missing = await request(admin.handler, 'GET', '/admin/api/licenses');
  assert.strictEqual(missing.status, 401);
});

test('the panel page itself is served without a token (it holds no data)', async () => {
  const { admin } = makeAdmin();
  const r = await request(admin.handler, 'GET', '/admin');
  assert.strictEqual(r.status, 200);
  assert.ok(/text\/html/.test(r.headers['content-type']));
  assert.ok(r.text.includes('keyflip issuer'));
});

test('issuing returns a token once and never persists it', async () => {
  const { admin, dir } = makeAdmin();
  const r = await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 'Buyer@Example.com', tier: 'pro', months: 12 }),
  });
  assert.strictEqual(r.status, 201);
  assert.ok(r.json.token);
  assert.strictEqual(r.json.tier, 'pro');
  assert.strictEqual(r.json.email, 'buyer@example.com');
  assert.ok(r.json.expiry);

  // The token must not be on disk anywhere the issuer writes.
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(raw.indexOf(r.json.token) === -1, 'token must not be persisted in ' + f);
    assert.ok(!/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}/.test(raw), 'no token-shaped string in ' + f);
  }
  assert.ok(files.indexOf('events.jsonl') !== -1);
});

test('the minted token verifies green in src/license.js', async () => {
  const { admin, kp } = makeAdmin();
  const r = await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 'a@b.co', tier: 'team', months: 3 }),
  });
  assert.strictEqual(r.status, 201);
  license.setPublicKey(kp.spkiB64);
  try {
    const v = license.verify(r.json.token);
    assert.strictEqual(v.valid, true, 'license.js must accept the minted token: ' + v.reason);
    assert.strictEqual(v.tier, 'team');
    assert.strictEqual(v.email, 'a@b.co');
  } finally {
    license.setPublicKey(license.PUBKEY_B64); // restore the shipped release key
  }
});

test('bad input is rejected and mints nothing', async () => {
  const { admin, store } = makeAdmin();
  const cases = [
    { body: { email: 'a@b.co', tier: 'gold', months: 12 }, why: 'unknown tier' },
    { body: { email: 'not-an-email', tier: 'pro', months: 12 }, why: 'bad email' },
    { body: { email: 'a@b.co', tier: 'pro', months: 0 }, why: 'months below 1' },
    { body: { email: 'a@b.co', tier: 'pro', months: 999 }, why: 'months above 120' },
  ];
  for (const c of cases) {
    const r = await request(admin.handler, 'POST', '/admin/api/licenses', {
      headers: bearer('test-token'),
      body: JSON.stringify(c.body),
    });
    assert.strictEqual(r.status, 400, c.why);
  }
  assert.strictEqual(store.list({}).length, 0);
});

test('list, lookup and filters work', async () => {
  const { admin } = makeAdmin();
  const a = await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 'one@x.co', tier: 'pro', months: 1 }),
  });
  await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 'two@x.co', tier: 'team', months: 1 }),
  });
  const all = await request(admin.handler, 'GET', '/admin/api/licenses', { headers: bearer('test-token') });
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.json.licenses.length, 2);
  const byEmail = await request(admin.handler, 'GET', '/admin/api/licenses?email=one@x.co', {
    headers: bearer('test-token'),
  });
  assert.strictEqual(byEmail.json.licenses.length, 1);
  const one = await request(admin.handler, 'GET', '/admin/api/licenses/' + a.json.licenseId, {
    headers: bearer('test-token'),
  });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.json.email, 'one@x.co');
  const missing = await request(admin.handler, 'GET', '/admin/api/licenses/lic_nope', {
    headers: bearer('test-token'),
  });
  assert.strictEqual(missing.status, 404);
});

test('revoke marks the record and a second revoke is 409', async () => {
  const { admin, store } = makeAdmin();
  const a = await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 'r@x.co', tier: 'pro', months: 12 }),
  });
  const id = a.json.licenseId;
  const rev = await request(admin.handler, 'POST', '/admin/api/licenses/' + id + '/revoke', {
    headers: bearer('test-token'),
    body: JSON.stringify({ reason: 'chargeback' }),
  });
  assert.strictEqual(rev.status, 200);
  assert.strictEqual(rev.json.status, 'revoked');
  assert.strictEqual(rev.json.revokeReason, 'chargeback');
  const again = await request(admin.handler, 'POST', '/admin/api/licenses/' + id + '/revoke', {
    headers: bearer('test-token'),
    body: JSON.stringify({ reason: 'again' }),
  });
  assert.strictEqual(again.status, 409);
  assert.strictEqual(store.get(id).status, 'revoked');
});

test('reissue mints a new license and supersedes the old one', async () => {
  const { admin, store, kp } = makeAdmin();
  const a = await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 's@x.co', tier: 'pro', months: 12 }),
  });
  const oldId = a.json.licenseId;
  const re = await request(admin.handler, 'POST', '/admin/api/licenses/' + oldId + '/reissue', {
    headers: bearer('test-token'),
    body: JSON.stringify({ months: 1 }),
  });
  assert.strictEqual(re.status, 201);
  assert.notStrictEqual(re.json.licenseId, oldId);
  assert.strictEqual(re.json.supersedes, oldId);
  assert.ok(re.json.token);
  assert.strictEqual(store.get(oldId).status, 'superseded');
  assert.strictEqual(store.get(oldId).supersededBy, re.json.licenseId);
  // The reissued token is a genuine license too.
  license.setPublicKey(kp.spkiB64);
  try {
    assert.strictEqual(license.verify(re.json.token).valid, true);
  } finally {
    license.setPublicKey(license.PUBKEY_B64);
  }
});

test('the event log view shows what happened', async () => {
  const { admin } = makeAdmin();
  const a = await request(admin.handler, 'POST', '/admin/api/licenses', {
    headers: bearer('test-token'),
    body: JSON.stringify({ email: 'e@x.co', tier: 'pro', months: 1 }),
  });
  await request(admin.handler, 'POST', '/admin/api/licenses/' + a.json.licenseId + '/revoke', {
    headers: bearer('test-token'),
    body: JSON.stringify({ reason: 'test' }),
  });
  const r = await request(admin.handler, 'GET', '/admin/api/events', { headers: bearer('test-token') });
  assert.strictEqual(r.status, 200);
  const kinds = r.json.events.map((e) => e.event);
  assert.ok(kinds.indexOf('license.issued') !== -1);
  assert.ok(kinds.indexOf('license.revoked') !== -1);
});

test('an unknown admin path is 404, not a stack trace', async () => {
  const { admin } = makeAdmin();
  const r = await request(admin.handler, 'GET', '/admin/api/nope', { headers: bearer('test-token') });
  assert.strictEqual(r.status, 404);
});

test('a token in the query string is not accepted', async () => {
  const { admin } = makeAdmin();
  const r = await request(admin.handler, 'GET', '/admin/api/licenses?token=test-token');
  assert.strictEqual(r.status, 401);
});
