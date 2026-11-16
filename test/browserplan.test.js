// Tests for src/browserplan.js: target resolution, the sync plan, execution and read-back
// verification, with a fake browser. No real Chromium, Keychain or cookie jar is touched.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as bp from '../src/browserplan.js';

const ORG = { alpha: 'org-alpha-0001', beta: 'org-beta-00002' };
const SECRET = 'sk-FIXTURE-SECRET-VALUE';

function configDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bp-'));
  Object.keys(ORG).forEach(function (n) {
    fs.writeFileSync(
      path.join(dir, n + '.json'),
      JSON.stringify({ email: n + '@example.com', oauthAccount: { organizationUuid: ORG[n] } }),
    );
  });
  return dir;
}

function fake(o) {
  const calls = { quit: 0, restored: [], opened: 0 };
  let running = !!o.running;
  const b = { id: 'chrome', name: 'Chrome', cookies: '/nonexistent/Default/Cookies' };
  const br = {
    installed: function () {
      return [b];
    },
    loadSession: function (dir, name) {
      return (o.snapshots || {})[name] || null;
    },
    isRunning: function () {
      return running;
    },
    quit: function () {
      calls.quit++;
      running = false;
    },
    reopen: function () {
      calls.opened++;
      running = true;
    },
    restoreClaudeCookies: function (bb, sql) {
      calls.restored.push(sql);
      return { ok: true };
    },
    readClaudeCookies: function () {
      return o.after || null;
    },
  };
  return { br: br, calls: calls };
}
const noSleep = function () {
  return Promise.resolve();
};
const restores = function (v) {
  return {
    readFile: function () {
      return JSON.stringify({ session: { restore_on_startup: v } });
    },
  };
};

test('resolveTarget(): same account on both surfaces is the target', function () {
  const t = bp.resolveTarget({ cli: 'alpha', desktop: 'alpha' });
  assert.strictEqual(t.name, 'alpha');
  assert.strictEqual(t.ambiguous, false);
});

test('resolveTarget(): different surfaces are ambiguous until --for says which', function () {
  const t = bp.resolveTarget({ cli: 'alpha', desktop: 'beta' });
  assert.strictEqual(t.differ, true);
  assert.strictEqual(t.ambiguous, true);
  assert.strictEqual(t.name, 'alpha', 'status default is the CLI');
  assert.strictEqual(bp.resolveTarget({ cli: 'alpha', desktop: 'beta', surface: 'desktop' }).name, 'beta');
  assert.strictEqual(bp.resolveTarget({ cli: 'alpha', desktop: 'beta', surface: 'cli' }).name, 'alpha');
  const e = bp.resolveTarget({ cli: 'alpha', desktop: 'beta', name: 'beta' });
  assert.strictEqual(e.name, 'beta');
  assert.strictEqual(e.ambiguous, false);
});

test('classify(): ok, signed-out, mismatch, unreadable', function () {
  assert.strictEqual(bp.classify({ cookie: 'sessionKey=x', org: ORG.alpha }, ORG.alpha).state, 'ok');
  assert.strictEqual(bp.classify({ cookie: 'other=1', org: ORG.alpha }, ORG.alpha).state, 'signed-out');
  const m = bp.classify({ cookie: 'sessionKey=x', org: ORG.beta }, ORG.alpha);
  assert.strictEqual(m.state, 'mismatch');
  assert.strictEqual(m.org, ORG.beta.slice(0, 8));
  assert.strictEqual(bp.classify(null, ORG.alpha).state, 'unreadable');
});

test('plan(): an account with no saved session is reported, nothing to restore', function () {
  const dir = configDir();
  const f = fake({ running: true, snapshots: { alpha: 'SQL' } });
  const p = bp.plan({ configDir: dir, home: dir, platform: 'darwin' }, 'beta', { browser: f.br, ...restores(1) });
  assert.strictEqual(p.noSession, true);
  assert.strictEqual(f.calls.quit, 0);
  const steps = bp.noSessionSteps('beta').join('\n');
  assert.match(steps, /sign into claude\.ai as beta/);
  assert.match(steps, /keyflip browser capture --account beta/);
});

test('plan(): a running browser needs a restart; tab loss is warned about', function () {
  const dir = configDir();
  const f = fake({ running: true, snapshots: { alpha: 'SQL' } });
  const ctx = { configDir: dir, home: dir, platform: 'darwin' };
  const keeps = bp.plan(ctx, 'alpha', { browser: f.br, ...restores(1) });
  assert.strictEqual(keeps.restartNeeded, true);
  assert.match(bp.planLines(keeps, 'alpha@example.com')[0], /QUIT and reopened\. It restores the open tabs/);
  const loses = bp.plan(ctx, 'alpha', { browser: f.br, ...restores(5) });
  assert.match(bp.planLines(loses, 'x')[0], /they may be lost/);
  assert.strictEqual(f.calls.quit, 0, 'planning never touches the browser');
});

test('execute(): restores, reopens and verifies the browser is on the target', async function () {
  const dir = configDir();
  const f = fake({
    running: true,
    snapshots: { alpha: 'SQL-ALPHA' },
    after: { cookie: 'sessionKey=' + SECRET, org: ORG.alpha },
  });
  const ctx = { configDir: dir, home: dir, platform: 'darwin' };
  const p = bp.plan(ctx, 'alpha', { browser: f.br, ...restores(1) });
  const r = await bp.execute(ctx, 'alpha', p, { browser: f.br, sleep: noSleep });
  assert.deepStrictEqual(r.synced, ['Chrome']);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(f.calls.quit, 1);
  assert.strictEqual(f.calls.opened, 1);
  assert.deepStrictEqual(f.calls.restored, ['SQL-ALPHA']);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'no cookie value in the result');
});

test('execute(): wrong org or missing cookie after reopen is not verified', async function () {
  const dir = configDir();
  const ctx = { configDir: dir, home: dir, platform: 'darwin' };
  for (const after of [{ cookie: 'sessionKey=' + SECRET, org: ORG.beta }, null, { cookie: 'x=1', org: ORG.alpha }]) {
    const f = fake({ running: false, snapshots: { alpha: 'SQL' }, after: after });
    const p = bp.plan(ctx, 'alpha', { browser: f.br, ...restores(1) });
    const r = await bp.execute(ctx, 'alpha', p, { browser: f.br, sleep: noSleep });
    assert.strictEqual(r.verified, false);
    assert.notStrictEqual(r.verify[0].state, 'ok');
    assert.ok(!JSON.stringify(r).includes(SECRET));
  }
});
