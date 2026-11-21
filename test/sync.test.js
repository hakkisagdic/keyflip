// sync push must not replace the remote backup when buildExport skipped an account.
import test from 'node:test';
import assert from 'node:assert';
import * as sync from '../src/sync.js';
import * as profiles from '../src/profiles.js';
import { makeCtx } from './helpers.js';

const NAMES = ['alpha', 'beta', 'gamma'];
const PASSPHRASE = 'sync-test-passphrase';

// The thrown store error deliberately does not contain the profile name, so a
// refusal that mentions the name got it from buildExport's skipped list.
function ctxWith(unreadable) {
  const ctx = makeCtx();
  const bad = Object.create(null);
  (unreadable || []).forEach(function (name) {
    bad[name] = true;
  });
  NAMES.forEach(function (name) {
    profiles.write(ctx.configDir, { name: name, email: name + '@example.com', savedAt: ctx.now() });
    ctx.store.setProfile(name, '{"claudeAiOauth":{"accessToken":"CRED-' + name.toUpperCase() + '"}}');
  });
  const inner = ctx.store.getProfile.bind(ctx.store);
  ctx.store.getProfile = function (name) {
    if (bad[name]) throw new Error('EKEYCHAIN');
    return inner(name);
  };
  return ctx;
}

async function collectBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  const chunks = [];
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      chunks.push(Buffer.from(step.value));
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function tracker() {
  const state = { calls: 0, bodies: [] };
  const fetchImpl = async function (_url, opt) {
    state.calls += 1;
    state.bodies.push(await collectBody(opt && opt.body));
    return { status: 201 };
  };
  return { fetch: fetchImpl, state: state };
}

function pushOpts(fetchImpl, extra) {
  return Object.assign(
    {
      url: 'https://dav.example/keyflip.enc',
      passphrase: PASSPHRASE,
      fetch: fetchImpl,
      device: 'sync-test-device',
    },
    extra || {},
  );
}

function namesIn(body) {
  const parsed = JSON.parse(sync.decrypt(body, PASSPHRASE));
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : parsed.bundle.accounts;
  return accounts.map(function (a) {
    return a.name;
  });
}

['push', 'pushStream'].forEach(function (which) {
  test(which + ': one unreadable profile refuses and never calls fetch', async function () {
    const ctx = ctxWith(['beta']);
    const tracked = tracker();
    await assert.rejects(
      function () {
        return sync[which](ctx, pushOpts(tracked.fetch));
      },
      function (err) {
        assert.match(err.message, /\bbeta\b/);
        assert.doesNotMatch(err.message, /CRED-/);
        assert.doesNotMatch(err.message, /EKEYCHAIN/);
        return true;
      },
    );
    assert.strictEqual(tracked.state.calls, 0);
  });

  test(which + ': allowPartial pushes the readable accounts and reports the skipped name', async function () {
    const ctx = ctxWith(['beta']);
    const tracked = tracker();
    const result = await sync[which](ctx, pushOpts(tracked.fetch, { allowPartial: true }));
    assert.strictEqual(result.pushed, 2);
    assert.deepStrictEqual(result.skipped, ['beta']);
    assert.strictEqual(tracked.state.calls, 1);
    const plain = sync.decrypt(tracked.state.bodies[0], PASSPHRASE);
    assert.doesNotMatch(plain, /CRED-BETA/);
    assert.deepStrictEqual(namesIn(tracked.state.bodies[0]).sort(), ['alpha', 'gamma']);
  });

  test(which + ': nothing readable refuses even with allowPartial, fetch not called', async function () {
    const ctx = ctxWith(NAMES);
    const tracked = tracker();
    await assert.rejects(
      function () {
        return sync[which](ctx, pushOpts(tracked.fetch, { allowPartial: true }));
      },
      function (err) {
        assert.strictEqual(err.message, 'nothing to push');
        assert.doesNotMatch(err.message, /CRED-/);
        return true;
      },
    );
    assert.strictEqual(tracked.state.calls, 0);
  });

  test(which + ': a healthy store pushes every account', async function () {
    const ctx = ctxWith([]);
    const tracked = tracker();
    const result = await sync[which](ctx, pushOpts(tracked.fetch));
    assert.deepStrictEqual(result, { pushed: 3, skipped: [] });
    assert.strictEqual(tracked.state.calls, 1);
    assert.deepStrictEqual(namesIn(tracked.state.bodies[0]).sort(), NAMES);
  });
});
