import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as cowork from '../src/cowork.js';
import * as chat from '../src/chat.js';
import { makeCtx } from './helpers.js';
import * as _appsessions from '../src/appsessions.js';

// Account/org folders are UUID-named in the real store; anything else is not an account.
const A1 = 'aaaaaaaa-0000-4000-8000-000000000001',
  O1 = 'aaaaaaaa-0000-4000-8000-0000000000a1',
  A2 = 'bbbbbbbb-0000-4000-8000-000000000002',
  O2 = 'bbbbbbbb-0000-4000-8000-0000000000b2';

function ctxApp() {
  const ctx = makeCtx();
  ctx.appDataDir = path.join(ctx.home, 'Library', 'Application Support', 'Claude');
  return ctx;
}

function seedCowork(ctx, acctUuid, orgUuid, id, obj) {
  const dir = path.join(ctx.appDataDir, 'local-agent-mode-sessions', acctUuid, orgUuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local_' + id + '.json'), JSON.stringify(Object.assign({ sessionId: id }, obj)));
}

// ---- Cowork ----
test('cowork lists sessions across accounts, newest first, with title/account/cliSessionId', function () {
  const ctx = ctxApp();
  seedCowork(ctx, A1, O1, 's1', {
    title: 'Exam builder',
    emailAddress: 'a@gmail.com',
    cliSessionId: 'cli-1',
    cwd: '/w',
    initialMessage: 'make an exam',
    lastActivityAt: 1778848443085,
  });
  seedCowork(ctx, A2, O2, 's2', {
    title: 'Ledger',
    emailAddress: 'b@yahoo.com',
    cliSessionId: 'cli-2',
    lastActivityAt: 1782080820761,
  });
  const rows = cowork.list(ctx, {});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].sessionId, 's2'); // newest activity first
  assert.strictEqual(rows[0].account, 'b@yahoo.com');
  assert.match(rows[1].lastActivityAt, /^2026-/); // epoch-ms normalized to ISO
});

test('cowork --search matches title/message/account; archived hidden by default', function () {
  const ctx = ctxApp();
  seedCowork(ctx, A1, O1, 'x', { title: 'OAuth flow', emailAddress: 'a@x.com' });
  seedCowork(ctx, A1, O1, 'y', { title: 'archived one', emailAddress: 'a@x.com', isArchived: true });
  assert.strictEqual(cowork.list(ctx, { search: 'oauth' }).length, 1);
  assert.strictEqual(cowork.list(ctx, {}).length, 1); // archived hidden
  assert.strictEqual(cowork.list(ctx, { includeArchived: true }).length, 2);
});

test('cowork lists a consolidated session once, from its home account', function () {
  const ctx = ctxApp();
  const store = path.join(ctx.appDataDir, 'local-agent-mode-sessions');
  // Home copy in A1 (the session's data dir sits beside it); consolidate copied the pointer to A2.
  seedCowork(ctx, A1, O1, 's1', { title: 'Exam builder', cliSessionId: 'cli-1', lastActivityAt: 1778848443085 });
  fs.mkdirSync(path.join(store, A1, O1, 'local_s1'));
  seedCowork(ctx, A2, O2, 's1', { title: 'Exam builder', cliSessionId: 'cli-1', lastActivityAt: 1778848443085 });
  // App bookkeeping laid out like an account folder is not an account.
  seedCowork(ctx, 'skills-plugin', O1, 's1', { title: 'Exam builder', cliSessionId: 'cli-1' });
  seedCowork(ctx, 'skills-plugin', O1, 'stray', { title: 'never a session' });
  const rows = cowork.list(ctx, {});
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sessionId, 's1');
  assert.strictEqual(rows[0].accountUuid, A1);
  assert.strictEqual(cowork.find(ctx, 's1').accountUuid, A1);
});

test('cowork resume uses the underlying cliSessionId', function () {
  const ctx = ctxApp();
  seedCowork(ctx, A1, O1, 'sess', { title: 't', cliSessionId: 'cli-abc', cwd: '/my/dir' });
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
    if (/\/api\/organizations$/.test(url))
      return {
        ok: true,
        status: 200,
        json: async function () {
          return [{ uuid: 'org-9', name: "me's Organization" }];
        },
      };
    if (/chat_conversations/.test(url))
      return {
        ok: true,
        status: 200,
        json: async function () {
          return [{ uuid: 'c1', name: 'First chat', updated_at: '2026-07-01T00:00:00Z' }];
        },
      };
    return { ok: false, status: 404 };
  };
  const r = await chat.list(ctx, { fetch: fetchMock, cookieHeaderOverride: { cookie: 'sessionKey=x', org: null } });
  assert.strictEqual(r.org, 'org-9');
  assert.strictEqual(r.conversations[0].name, 'First chat');
});

test('chat surfaces a clear 403 (stale Cloudflare cookie) message', async function () {
  const ctx = ctxApp();
  const fetchMock = async function () {
    return {
      ok: false,
      status: 403,
      json: async function () {
        return {};
      },
    };
  };
  await assert.rejects(function () {
    return chat.list(ctx, { fetch: fetchMock, cookieHeaderOverride: { cookie: 'x', org: 'o' } });
  }, /Cloudflare|403/);
});

test('consolidate merges Cowork sessions across accounts too', function () {
  const appsessions = _appsessions;
  const ctx = ctxApp();
  // account A has a cowork session; B has none -> after consolidate B should gain it
  seedCowork(ctx, A1, O1, 'cw1', { sessionId: 'cw1', cliSessionId: 'cli-1', title: 't' });
  fs.mkdirSync(path.join(ctx.appDataDir, 'local-agent-mode-sessions', A2, O2), { recursive: true });
  ctx.now = function () {
    return '2026-07-02T00:00:00.000Z';
  };
  const r = appsessions.consolidate(ctx);
  assert.ok(r.cowork >= 1);
  assert.ok(fs.existsSync(path.join(ctx.appDataDir, 'local-agent-mode-sessions', A2, O2, 'local_cw1.json')));
});
