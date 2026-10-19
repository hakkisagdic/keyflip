// Tests for the browser leg of a switch (src/browserswitch.js): the policy (decide) and its
// execution (align/preview) with a fake browser — no real Chromium, Keychain or Cookies DB.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as bs from '../src/browserswitch.js';

const ORG = { gmail: 'org-gmail', yahoo: 'org-yahoo' };

function configDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bs-'));
  Object.keys(ORG).forEach(function (n) {
    fs.writeFileSync(
      path.join(dir, n + '.json'),
      JSON.stringify({ email: n + '@example.com', oauthAccount: { organizationUuid: ORG[n] } }),
    );
  });
  return dir;
}

// A fake browser module. `jar` is what the live Cookies DB says now; `snapshots` the saved sessions.
function fakeBrowser(o) {
  const calls = { quit: 0, saved: [], restored: [], opened: 0 };
  let running = !!o.running;
  const b = { id: 'chrome', name: 'Chrome', proc: 'Google Chrome', cookies: '/nonexistent/Default/Cookies' };
  const br = {
    installed: function () {
      return [b];
    },
    readClaudeCookies: function () {
      return o.jar || null;
    },
    loadSession: function (dir, name) {
      return (o.snapshots || {})[name] || null;
    },
    isRunning: function () {
      return running;
    },
    quit: function () {
      calls.quit++;
      if (!o.refusesToQuit) running = false;
    },
    saveSession: function (dir, name) {
      calls.saved.push(name);
      return true;
    },
    restoreClaudeCookies: function (bb, sql) {
      calls.restored.push(sql);
      return { ok: !o.restoreFails };
    },
  };
  const run = function (cmd) {
    if (cmd === 'open') calls.opened++;
    return { code: 0, stdout: '' };
  };
  return { br: br, run: run, calls: calls };
}

const signedInAs = function (who) {
  return { cookie: 'sessionKey=sk-redacted; lastActiveOrg=' + ORG[who], org: ORG[who] };
};
const noSleep = function () {
  return Promise.resolve();
};

test('decide(): the whole policy, one browser at a time', function () {
  assert.deepStrictEqual(bs.decide({ onTarget: true, hasSnapshot: false }), { action: 'already' });
  assert.deepStrictEqual(bs.decide({ hasSnapshot: false }), { action: 'skip', reason: 'no-snapshot' });
  assert.deepStrictEqual(bs.decide({ hasSnapshot: true, running: false }), { action: 'sync', quit: false });
  // An open browser that would NOT bring its tabs back is left alone unless the user asked for it.
  assert.deepStrictEqual(bs.decide({ hasSnapshot: true, running: true }), {
    action: 'skip',
    reason: 'would-lose-tabs',
  });
  assert.deepStrictEqual(bs.decide({ hasSnapshot: true, running: true, restoresTabs: true }), {
    action: 'sync',
    quit: true,
  });
  assert.deepStrictEqual(bs.decide({ hasSnapshot: true, running: true, explicit: true }), {
    action: 'sync',
    quit: true,
  });
});

test('restoresTabs() only trusts "Continue where you left off" (restore_on_startup === 1)', function () {
  const b = { cookies: '/x/Default/Cookies' };
  const pref = function (v) {
    return {
      readFile: function () {
        return JSON.stringify({ session: v === undefined ? {} : { restore_on_startup: v } });
      },
    };
  };
  assert.strictEqual(bs.restoresTabs(b, pref(1)), true);
  assert.strictEqual(bs.restoresTabs(b, pref(5)), false);
  assert.strictEqual(bs.restoresTabs(b, pref(undefined)), false);
  assert.strictEqual(
    bs.restoresTabs(b, {
      readFile: function () {
        throw new Error('ENOENT');
      },
    }),
    false,
    'unknown means "tabs would be lost" — the safe answer',
  );
});

test('align(): a closed browser on the other account is restored, and the outgoing session is kept', async function () {
  const dir = configDir();
  const f = fakeBrowser({ running: false, jar: signedInAs('yahoo'), snapshots: { gmail: 'SQL-GMAIL' } });
  const res = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: f.br,
    run: f.run,
    sleep: noSleep,
    restoresTabs: function () {
      return false;
    },
  });
  assert.deepStrictEqual(res.synced, ['Chrome']);
  assert.deepStrictEqual(res.preserved, [{ browser: 'Chrome', account: 'yahoo' }]);
  assert.deepStrictEqual(f.calls.saved, ['yahoo'], "yahoo's live session is re-snapshotted before it is replaced");
  assert.deepStrictEqual(f.calls.restored, ['SQL-GMAIL']);
  assert.strictEqual(f.calls.quit, 0);
  assert.strictEqual(f.calls.opened, 0, 'a browser keyflip did not close is not opened either');
});

test('align(): an open browser that would lose its tabs is skipped, untouched', async function () {
  const dir = configDir();
  const f = fakeBrowser({ running: true, jar: signedInAs('yahoo'), snapshots: { gmail: 'SQL-GMAIL' } });
  const res = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: f.br,
    run: f.run,
    sleep: noSleep,
    restoresTabs: function () {
      return false;
    },
  });
  assert.deepStrictEqual(res.skipped, [{ browser: 'Chrome', reason: 'would-lose-tabs' }]);
  assert.strictEqual(f.calls.quit, 0);
  assert.deepStrictEqual(f.calls.restored, []);
  assert.deepStrictEqual(f.calls.saved, []);
});

test('align(): explicit consent closes, restores and reopens; a browser that will not close is never written', async function () {
  const dir = configDir();
  const f = fakeBrowser({ running: true, jar: signedInAs('yahoo'), snapshots: { gmail: 'SQL-GMAIL' } });
  const res = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: f.br,
    run: f.run,
    sleep: noSleep,
    explicit: true,
    restoresTabs: function () {
      return false;
    },
  });
  assert.deepStrictEqual(res.synced, ['Chrome']);
  assert.strictEqual(f.calls.quit, 1);
  assert.strictEqual(f.calls.opened, 1);

  const stuck = fakeBrowser({
    running: true,
    refusesToQuit: true,
    jar: signedInAs('yahoo'),
    snapshots: { gmail: 'SQL-GMAIL' },
  });
  const r2 = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: stuck.br,
    run: stuck.run,
    sleep: noSleep,
    explicit: true,
  });
  assert.deepStrictEqual(r2.skipped, [{ browser: 'Chrome', reason: 'did-not-quit' }]);
  assert.deepStrictEqual(stuck.calls.restored, [], 'never write the Cookies DB of a running browser');
});

test('align(): already on the target refreshes its snapshot; a signed-out jar never overwrites a capture', async function () {
  const dir = configDir();
  const on = fakeBrowser({ running: true, jar: signedInAs('gmail'), snapshots: {} });
  const r1 = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: on.br,
    run: on.run,
    sleep: noSleep,
  });
  assert.deepStrictEqual(r1.already, ['Chrome']);
  assert.deepStrictEqual(on.calls.saved, ['gmail']);

  // Signed out (lastActiveOrg survives a logout, sessionKey does not): restore, but preserve nobody.
  const out = fakeBrowser({
    running: false,
    jar: { cookie: 'lastActiveOrg=' + ORG.yahoo, org: ORG.yahoo },
    snapshots: { gmail: 'SQL-GMAIL' },
  });
  const r2 = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: out.br,
    run: out.run,
    sleep: noSleep,
  });
  assert.deepStrictEqual(r2.synced, ['Chrome']);
  assert.deepStrictEqual(out.calls.saved, [], "a signed-out jar must not replace yahoo's good capture");
});

test('align(): no snapshot → named skip; restore failure → named skip; non-macOS → no-op', async function () {
  const dir = configDir();
  const none = fakeBrowser({ running: false, jar: signedInAs('yahoo'), snapshots: {} });
  const r1 = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: none.br,
    run: none.run,
  });
  assert.deepStrictEqual(r1.skipped, [{ browser: 'Chrome', reason: 'no-snapshot' }]);

  const bad = fakeBrowser({ running: false, restoreFails: true, jar: null, snapshots: { gmail: 'SQL' } });
  const r2 = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: bad.br,
    run: bad.run,
  });
  assert.deepStrictEqual(r2.skipped, [{ browser: 'Chrome', reason: 'restore-failed' }]);

  const lin = fakeBrowser({ running: false, snapshots: { gmail: 'SQL' } });
  const r3 = await bs.align({ platform: 'linux', configDir: dir, home: dir }, 'gmail', {
    browser: lin.br,
    run: lin.run,
  });
  assert.deepStrictEqual(r3, { synced: [], already: [], skipped: [], preserved: [] });
});

test('preview() reports what align() would do and touches nothing', function () {
  const dir = configDir();
  const f = fakeBrowser({ running: true, jar: signedInAs('yahoo'), snapshots: { gmail: 'SQL-GMAIL' } });
  const p = bs.preview({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: f.br,
    restoresTabs: function () {
      return true;
    },
  });
  assert.deepStrictEqual(p, [{ browser: 'Chrome', action: 'sync', quit: true }]);
  assert.strictEqual(f.calls.quit, 0);
  assert.deepStrictEqual(f.calls.saved, []);
  assert.deepStrictEqual(f.calls.restored, []);
});

test('orgOwner() maps a claude.ai org back to the saved profile, or to nobody', function () {
  const dir = configDir();
  assert.strictEqual(bs.orgOwner(dir, ORG.yahoo), 'yahoo');
  assert.strictEqual(bs.orgOwner(dir, 'org-unknown'), '');
  assert.strictEqual(bs.orgOwner(dir, null), '');
});

// #37: several profiles of ONE browser share a single process. Quitting it per profile would
// kill the browser the previous profile just reopened, so the leg quits once and reopens once.
test('two profiles of one browser: quit once, restore both, reopen once', async function () {
  const dir = configDir();
  const calls = { quit: 0, opened: 0, restored: [] };
  let running = true;
  const profiles = [
    { id: 'chrome', name: 'Chrome', proc: 'Google Chrome', cookies: '/x/Default/Cookies' },
    { id: 'chrome-Profile-2', name: 'Chrome (Work)', proc: 'Google Chrome', cookies: '/x/Profile 2/Cookies' },
  ];
  const br = {
    installed: function () {
      return profiles;
    },
    readClaudeCookies: function () {
      return signedInAs('yahoo');
    },
    loadSession: function () {
      return 'SQL-GMAIL';
    },
    isRunning: function () {
      return running;
    },
    quit: function () {
      calls.quit++;
      running = false;
    },
    saveSession: function () {
      return true;
    },
    restoreClaudeCookies: function (b) {
      calls.restored.push(b.id);
      return { ok: true };
    },
  };
  const run = function (cmd) {
    if (cmd === 'open') calls.opened++;
    return { code: 0, stdout: '' };
  };
  const out = await bs.align({ platform: 'darwin', configDir: dir, home: dir }, 'gmail', {
    browser: br,
    run: run,
    sleep: noSleep,
    restoresTabs: function () {
      return true;
    },
  });
  assert.strictEqual(calls.restored.length, 2, 'both profiles get their snapshot');
  assert.deepStrictEqual(calls.restored, ['chrome', 'chrome-Profile-2']);
  assert.strictEqual(calls.quit, 1, 'one process, one quit');
  assert.strictEqual(calls.opened, 1, 'and one reopen after BOTH restores');
  assert.deepStrictEqual(out.synced, ['Chrome', 'Chrome (Work)']);
});
