// Tests for metadata backups (src/backup.js) — the same secret set as vcs.js must be skipped.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as backup from '../src/backup.js';
import { makeCtx } from './helpers.js';

function walk(dir, base) {
  base = base || dir;
  let out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out = out.concat(walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

test('a backup carries metadata but NEVER a secret dir or an auth.json', function () {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'accounts.json'), '[]');
  fs.mkdirSync(path.join(ctx.configDir, 'surfaces', 'codex', 'me'), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.configDir, 'surfaces', 'codex', 'me', 'auth.json'),
    '{"tokens":{"refresh_token":"SECRET"}}',
  );
  fs.mkdirSync(path.join(ctx.configDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(ctx.configDir, 'app', 'me.cookies'), 'sessionKey=SECRET');
  fs.writeFileSync(path.join(ctx.configDir, 'auth.json'), '{"tokens":{"access_token":"SECRET"}}');

  const snap = backup.create(ctx, {});
  const files = walk(snap.path);
  assert.ok(files.indexOf('accounts.json') !== -1, 'metadata is backed up');
  assert.strictEqual(files.indexOf('surfaces/codex/me/auth.json'), -1, 'surface captures are NEVER copied');
  assert.strictEqual(files.indexOf('app/me.cookies'), -1, 'app cookies are NEVER copied');
  assert.strictEqual(files.indexOf('auth.json'), -1, 'a loose auth.json is NEVER copied');
});
