import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as cowork from '../src/cowork.js';
import * as chat from '../src/chat.js';
import { makeCtx } from './helpers.js';
import * as _appsessions from '../src/appsessions.js';

function ctxApp() { const ctx = makeCtx(); ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude'); return ctx; }

function seedCowork(ctx, acctUuid, orgUuid, id, obj) {
  const dir = path.join(ctx.appDataDir, 'local-agent-mode-sessions', acctUuid, orgUuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_' + id + '.json'), JSON.stringify(Object.assign({ sessionId: id }, obj)));
}

// ---- Cowork ----
test('cowork lists sessions across accounts, newest first, with title/account/cliSessionId', function () {
  const ctx = ctxApp();
  seedCowork(ctx, 'acct-gmail', 'org-1', 's1', { title: 'Exam builder', emailAddress: 'a@gmail.com', cliSessionId: 'cli-1', cwd: '/w', initialMessage: 'make an exam', lastActivityAt: 1778848443085 });
  seedCowork(ctx, 'acct-yahoo', 'org-2', 's2', { title: 'Ledger', emailAddress: 'b@yahoo.com', cliSessionId: 'cli-2', lastActivityAt: 1782080820761 });
  const rows = cowork.list(ctx, {});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].sessionId, 's2');           // newest activity first
  assert.strictEqual(rows[0].account, 'b@yahoo.com');
  assert.match(rows[1].lastActivityAt, /^2026-/);         // epoch-ms normalized to ISO
});

test('cowork --search matches title/message/account; archived hidden by default', function () {
  const ctx = ctxApp();
  seedCowork(ctx, 'a', 'o', 'x', { title: 'OAuth flow', emailAddress: 'a@x.com' });
  seedCowork(ctx, 'a', 'o', 'y', { title: 'archived one', emailAddress: 'a@x.com', isArchived: true });
  assert.strictEqual(cowork.list(ctx, { search: 'oauth' }).length, 1);
  assert.strictEqual(cowork.list(ctx, {}).length, 1);                     // archived hidden
  assert.strictEqual(cowork.list(ctx, { includeArchived: true }).length, 2);
});

test('cowork resume uses the underlying cliSessionId', function () {
  const ctx = ctxApp();
  seedCowork(ctx, 'a', 'o', 'sess', { title: 't', cliSessionId: 'cli-abc', cwd: '/my/dir' });
  const rc = cowork.resumeCommand(cowork.find(ctx, 'sess'));
  assert.deepStrictEqual(rc, { cwd: '/my/dir', command: 'claude', args: ['--resume', 'cli-abc'] });
});

// ---- Chat ----
test('decryptCookie round-trips the Chromium v10 scheme (domain-hash prefix stripped)', function () {
  const pw = 'test-pass';
  const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([crypto.randomBytes(32), Buffer.from('sk-ant-sid-XYZ')]); // 32B domain hash + value
  const enc = Buffer.concat([Buffer.from('v10'), c.update(plaintext), c.final()]);
  assert.strictEqual(chat.decryptCookie(enc, pw), 'sk-ant-sid-XYZ');
  assert.strictEqual(chat.decryptCookie(Buffer.from('not-v10'), pw), null);
});

test('chat.list resolves the org and normalizes conversations (injected cookie + fetch)', async function () {
  const ctx = ctxApp();
  const fetchMock = async function (url) {
    if (/\/api\/organizations$/.test(url)) return { ok: true, status: 200, json: async function () { return [{ uuid: 'org-9', name: "me's Organization" }]; } };
    if (/chat_conversations/.test(url)) return { ok: true, status: 200, json: async function () { return [{ uuid: 'c1', name: 'First chat', updated_at: '2026-07-01T00:00:00Z' }]; } };
    return { ok: false, status: 404 };
  };
  const r = await chat.list(ctx, { fetch: fetchMock, cookieHeaderOverride: { cookie: 'sessionKey=x', org: null } });
  assert.strictEqual(r.org, 'org-9');
  assert.strictEqual(r.conversations[0].name, 'First chat');
});

test('chat surfaces a clear 403 (stale Cloudflare cookie) message', async function () {
  const ctx = ctxApp();
  const fetchMock = async function () { return { ok: false, status: 403, json: async function () { return {}; } }; };
  await assert.rejects(function () { return chat.list(ctx, { fetch: fetchMock, cookieHeaderOverride: { cookie: 'x', org: 'o' } }); }, /Cloudflare|403/);
});

test('consolidate merges Cowork sessions across accounts too', function () {
  const appsessions = _appsessions;
  const ctx = ctxApp();
  // account A has a cowork session; B has none -> after consolidate B should gain it
  seedCowork(ctx, 'A', 'OA', 'cw1', { sessionId: 'cw1', cliSessionId: 'cli-1', title: 't' });
  fs.mkdirSync(path.join(ctx.appDataDir, 'local-agent-mode-sessions', 'B', 'OB'), { recursive: true });
  ctx.now = function () { return '2026-07-02T00:00:00.000Z'; };
  const r = appsessions.consolidate(ctx);
  assert.ok(r.cowork >= 1);
  assert.ok(fs.existsSync(path.join(ctx.appDataDir, 'local-agent-mode-sessions', 'B', 'OB', 'local_cw1.json')));
});
