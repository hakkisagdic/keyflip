// claude.ai Chat reader: cookie sources (live app DB vs another account's saved
// snapshot), the "app hasn't flushed its cookies yet" guard, and id resolution
// (listings print an 8-char prefix, the API needs the full uuid). No Keychain and no
// network here: the safeStorage password is injected and fetch is stubbed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as chat from '../src/chat.js';

const PW = 'unit-test-password';
const KEY = crypto.pbkdf2Sync(PW, 'saltysalt', 1003, 16, 'sha1');

// One Chromium cookie value: "v10" + AES-128-CBC(plaintext), IV = 16 spaces.
function encryptCookie(plaintext) {
  const d = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), d.update(plaintext), d.final()]);
}

// A real SQLite Cookies DB, shaped like the app's, holding the given claude.ai cookies.
function cookieDb(rows) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-chat-')), 'Cookies');
  const sql = Object.keys(rows)
    .map(function (name) {
      const hex = encryptCookie(rows[name]).toString('hex');
      return (
        "INSERT INTO cookies(name,host_key,encrypted_value) VALUES('" +
        name +
        "','.claude.ai',cast(X'" +
        hex +
        "' as BLOB));"
      );
    })
    .join(' ');
  execFileSync('sqlite3', [file, 'CREATE TABLE cookies(name TEXT,host_key TEXT,encrypted_value BLOB);' + sql]);
  return file;
}

function ctxWith(rows, extra) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-chat-')), 'Claude');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = Object.assign(
    {
      appDataDir: dir,
      configDir: path.join(dir, '..', 'config'),
      safeStoragePassword: PW,
    },
    extra || {},
  );
  fs.mkdirSync(ctx.configDir, { recursive: true });
  fs.copyFileSync(cookieDb(rows), path.join(dir, 'Cookies'));
  return ctx;
}

const LIVE = { sessionKey: 'SESSION-1', lastActiveOrg: 'org-live' };

test('cookieHeader decrypts the live app cookie DB and reports the org', function () {
  const ctx = ctxWith(LIVE);
  const ch = chat.cookieHeader(ctx);
  assert.match(ch.cookie, /sessionKey=SESSION-1/);
  assert.strictEqual(ch.org, 'org-live');
});

test('a RUNNING app whose cookies were never written out is named, not 403-debugged', function () {
  // Chromium flushes session cookies only on a clean quit, so this is the common case
  // while the app is open: readable cookies, but no sessionKey at all.
  const ctx = ctxWith({ lastActiveOrg: 'org-live', __cf_bm: 'noise' });
  assert.throws(
    function () {
      chat.cookieHeader(ctx);
    },
    function (e) {
      assert.strictEqual(e.code, 'cookies-not-flushed');
      assert.match(e.message, /Cmd\+Q/);
      return true;
    },
  );
});

test('cookieHeader can read ANOTHER account from its saved snapshot (no switching)', function () {
  const ctx = ctxWith(LIVE);
  const snap = path.join(ctx.configDir, 'app');
  fs.mkdirSync(snap, { recursive: true });
  fs.copyFileSync(cookieDb({ sessionKey: 'SESSION-Y', lastActiveOrg: 'org-yahoo' }), path.join(snap, 'yahoo.cookies'));
  const mine = chat.cookieHeader(ctx);
  const theirs = chat.cookieHeader(ctx, { account: 'yahoo' });
  assert.match(mine.cookie, /sessionKey=SESSION-1/);
  assert.match(theirs.cookie, /sessionKey=SESSION-Y/);
  assert.strictEqual(theirs.org, 'org-yahoo', 'the org follows the snapshot, not the live app');
});

test('an account with no saved snapshot says how to get one', function () {
  const ctx = ctxWith(LIVE);
  assert.throws(function () {
    chat.cookieHeader(ctx, { account: 'nevercaptured' });
  }, /no saved desktop-app cookie for 'nevercaptured'[\s\S]*keyflip add nevercaptured --app/);
});

// ---- network-shaped tests: everything below only talks to a stubbed fetch ----

const UUID_A = '404a507c-1111-2222-3333-444444444444';
const UUID_B = 'beef0000-1111-2222-3333-444444444444';
const UUID_C = '404a507d-1111-2222-3333-444444444444'; // shares a 6-char prefix with A
const CONV = [
  { uuid: UUID_A, name: 'Memory export and account questions', updated_at: '2026-10-07T10:47:00Z' },
  { uuid: UUID_B, name: 'Rocket league odds', updated_at: '2026-10-01T09:00:00Z' },
  { uuid: UUID_C, name: 'Rebuild the palace index', updated_at: '2026-10-02T09:00:00Z' },
];

function stubFetch(log) {
  return async function (url) {
    if (log) log.push(url);
    const one = /chat_conversations\/([0-9a-f-]{36})/.exec(url);
    if (one) return { ok: true, status: 200, json: async () => ({ uuid: one[1], name: 'x', chat_messages: [] }) };
    if (/chat_conversations\?/.test(url)) return { ok: true, status: 200, json: async () => CONV };
    if (/organizations$/.test(url)) return { ok: true, status: 200, json: async () => [{ uuid: 'org-x', name: 'x' }] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
function netOpts(extra) {
  // A header override keeps these tests off the Keychain and off disk.
  return Object.assign({ cookieHeaderOverride: { cookie: 'sessionKey=S', org: 'org-x' }, fetch: stubFetch() }, extra);
}

test('a full uuid is used as-is, so no listing round-trip is needed', async function () {
  const seen = [];
  const conv = await chat.get({}, UUID_A, netOpts({ fetch: stubFetch(seen) }));
  assert.strictEqual(conv.uuid, UUID_A);
  assert.deepStrictEqual(seen, [
    'https://claude.ai/api/organizations/org-x/chat_conversations/' + UUID_A + '?tree=True&rendering_mode=messages',
  ]);
});

test('the 8-char id a listing prints resolves to its conversation', async function () {
  const conv = await chat.get({}, '404a507c', netOpts());
  assert.strictEqual(conv.uuid, UUID_A);
});

test('a unique chat title resolves too', async function () {
  const conv = await chat.get({}, 'Rocket league odds', netOpts());
  assert.strictEqual(conv.uuid, UUID_B);
});

test('an ambiguous prefix lists the candidates instead of guessing', async function () {
  await assert.rejects(
    function () {
      return chat.get({}, '404a50', netOpts({ resolveLimit: 3 }));
    },
    function (e) {
      assert.match(e.message, /matches several chats/);
      assert.match(e.message, /404a507c, 404a507d/);
      return true;
    },
  );
});

test('an unknown id points at search rather than a bare 404', async function () {
  await assert.rejects(function () {
    return chat.get({}, 'nonexistent-thing', netOpts());
  }, /no chat found for 'nonexistent-thing'[\s\S]*keyflip chat search/);
});

test('search filters titles case-insensitively and reports what it scanned', async function () {
  const r = await chat.search({}, 'memory', netOpts());
  assert.strictEqual(r.scanned, 3);
  assert.deepStrictEqual(
    r.matches.map(function (c) {
      return c.uuid;
    }),
    [UUID_A],
  );
});

test('get/list/search accept an account and pass it to the cookie source', async function () {
  const ctx = ctxWith(LIVE);
  const snap = path.join(ctx.configDir, 'app');
  fs.mkdirSync(snap, { recursive: true });
  fs.copyFileSync(
    cookieDb({ sessionKey: 'FROM-SNAPSHOT', lastActiveOrg: 'org-snap' }),
    path.join(snap, 'yahoo.cookies'),
  );
  let asked = null;
  const opts = {
    account: 'yahoo',
    fetch: async function (url) {
      asked = url;
      return { ok: true, status: 200, json: async () => CONV };
    },
  };
  const r = await chat.list(ctx, opts);
  assert.strictEqual(r.org, 'org-snap', 'the snapshot account is the one queried');
  assert.match(asked, /organizations\/org-snap\/chat_conversations/);
});
