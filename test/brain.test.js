// brain.test.js — the OPT-IN suggest+approve planner. Everything runs OFFLINE:
// fetch is injected, and the env gate is toggled around each test. The brain must
// PROPOSE ONLY (never execute), NEVER leak the API key, and defensively validate
// UNTRUSTED model output against the real command CATALOG.

import { test } from 'node:test';
import assert from 'node:assert';
import * as brain from '../src/brain.js';
import * as secretscan from '../src/secretscan.js';
import _fs from 'fs';
import _path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = _path.dirname(__filename);

const API_KEY = 'AIzaSyTEST_gemini_key_000000000000000000000';

// Toggle process.env.KEYFLIP_BRAIN around a synchronous or async body, always
// restoring the prior value.
async function withBrainEnv(value, fn) {
  const prev = process.env.KEYFLIP_BRAIN;
  if (value === undefined) delete process.env.KEYFLIP_BRAIN;
  else process.env.KEYFLIP_BRAIN = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.KEYFLIP_BRAIN;
    else process.env.KEYFLIP_BRAIN = prev;
  }
}

// Build a fake fetch that returns a Gemini-shaped 200 whose model text is `text`.
function fakeFetchReturning(text, opts) {
  opts = opts || {};
  const calls = [];
  const fetchFn = async function (url, init) {
    calls.push({ url: url, init: init });
    if (opts.throw) throw new Error('network down');
    const status = opts.status || 200;
    return {
      status: status,
      json: async function () {
        if (opts.rawBody !== undefined) return opts.rawBody;
        return { candidates: [{ content: { parts: [{ text: text }] } }] };
      },
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

function validPlanText() {
  return JSON.stringify({
    plan: [
      { command: 'status', rationale: 'see current account' },
      { command: 'rm-rf-everything', rationale: 'malicious fabricated command' },
      { command: 'switch', args: 'work', rationale: 'move to the work account' },
      { command: 'reset', rationale: 'factory reset' },
    ],
  });
}

// ---- enabled() ---------------------------------------------------------------

test('enabled() is false when KEYFLIP_BRAIN is unset, even with a key', async function () {
  await withBrainEnv(undefined, function () {
    assert.strictEqual(brain.enabled({}, { apiKey: API_KEY }), false);
  });
});

test('enabled() is false when the env gate is on but no key is present', async function () {
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await withBrainEnv('1', function () {
      assert.strictEqual(brain.enabled({}, {}), false);
    });
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('enabled() is true only when BOTH the env gate and a key are present', async function () {
  await withBrainEnv('1', function () {
    assert.strictEqual(brain.enabled({}, { apiKey: API_KEY }), true);
  });
  await withBrainEnv('true', function () {
    assert.strictEqual(brain.enabled({}, { apiKey: API_KEY }), true);
  });
  await withBrainEnv('on', function () {
    assert.strictEqual(brain.enabled({}, { apiKey: API_KEY }), true);
  });
  await withBrainEnv('0', function () {
    assert.strictEqual(brain.enabled({}, { apiKey: API_KEY }), false);
  });
});

test('enabled() reads the key from the environment when no dep is injected', async function () {
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = API_KEY;
  try {
    await withBrainEnv('1', function () {
      assert.strictEqual(brain.enabled({}, {}), true);
    });
    await withBrainEnv(undefined, function () {
      assert.strictEqual(brain.enabled({}, {}), false);
    });
  } finally {
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

// ---- propose(): disabled = no-op --------------------------------------------

test('propose() returns enabled:false and does NOTHING when the brain is off', async function () {
  await withBrainEnv(undefined, async function () {
    let fetchCalled = false;
    const fetchFn = async function () {
      fetchCalled = true;
      return {
        status: 200,
        json: async function () {
          return {};
        },
      };
    };
    const r = await brain.propose({}, 'switch me to work', { apiKey: API_KEY, fetch: fetchFn });
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.plan, []);
    assert.strictEqual(fetchCalled, false, 'no network call when disabled');
  });
});

// ---- propose(): validation of UNTRUSTED model output ------------------------

test('propose() validates the plan: fabricated commands dropped, real ones kept & tagged', async function () {
  await withBrainEnv('1', async function () {
    const fetchFn = fakeFetchReturning(validPlanText());
    const r = await brain.propose({}, 'switch me to work and reset', { apiKey: API_KEY, fetch: fetchFn });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.enabled, true);

    const names = r.plan.map(function (s) {
      return s.command;
    });
    assert.deepStrictEqual(names, ['status', 'switch', 'reset'], 'fabricated command removed, order preserved');
    assert.ok(
      Array.isArray(r.dropped) && r.dropped.indexOf('rm-rf-everything') !== -1,
      'fabricated command recorded as dropped',
    );

    const byName = {};
    r.plan.forEach(function (s) {
      byName[s.command] = s;
    });
    assert.strictEqual(byName.status.safe, true);
    assert.strictEqual(byName.status.mutating, false, 'status is read-only');
    assert.strictEqual(byName.switch.mutating, true, 'switch is mutating');
    assert.strictEqual(byName.switch.safe, false);
    assert.strictEqual(byName.reset.mutating, true, 'reset is mutating');
    assert.strictEqual(byName.switch.args, 'work', 'string args preserved');
  });
});

test('propose(): a catalog-safe command carrying ARGS is downgraded to mutating (regression)', async function () {
  // `cache`/`config` are catalog-`safe` in their bare form, but `cache purge` / `config set` mutate.
  // A model that attaches args to a safe command must NOT yield a step tagged safe.
  await withBrainEnv('1', async function () {
    const plan = JSON.stringify({
      plan: [
        { command: 'cache', args: 'purge', rationale: 'x' },
        { command: 'status', rationale: 'read' },
      ],
    });
    const r = await brain.propose({}, 'clean the cache', { apiKey: API_KEY, fetch: fakeFetchReturning(plan) });
    const byName = {};
    r.plan.forEach(function (s) {
      byName[s.command] = s;
    });
    assert.strictEqual(byName.cache.safe, false, 'cache purge is NOT safe (it has args)');
    assert.strictEqual(byName.cache.mutating, true);
    assert.strictEqual(byName.status.safe, true, 'a no-arg safe command stays safe');
  });
});

test('redactOutbound(): a non-shape secret under a credential KEY in a JSON string is scrubbed (regression)', function () {
  // A password that matches no token shape, passed as a serialized-JSON string, must still be
  // redacted by key-name (redactJson) — the shape-only path would have leaked it to Gemini.
  const out = brain.redactOutbound(JSON.stringify({ sync: { password: 'corr-horse-batt-8f2a1c9d' } }));
  assert.strictEqual(String(out).indexOf('corr-horse-batt-8f2a1c9d'), -1, 'the password must not survive');
  assert.ok(String(out).indexOf('sync') !== -1, 'non-secret structure is kept');
});

test('propose() marks mutating/safe from the CATALOG, not from what the model claims', async function () {
  await withBrainEnv('1', async function () {
    // Model lies: claims status is mutating and switch is safe. We ignore that.
    const text = JSON.stringify({
      plan: [
        { command: 'status', safe: false, mutating: true, rationale: 'x' },
        { command: 'switch', safe: true, mutating: false, rationale: 'y' },
      ],
    });
    const r = await brain.propose({}, 'do stuff', { apiKey: API_KEY, fetch: fakeFetchReturning(text) });
    const byName = {};
    r.plan.forEach(function (s) {
      byName[s.command] = s;
    });
    assert.strictEqual(byName.status.mutating, false);
    assert.strictEqual(byName.switch.mutating, true);
  });
});

test('propose() drops a hostile inherited-key command name (__proto__)', async function () {
  await withBrainEnv('1', async function () {
    const text = JSON.stringify({
      plan: [
        { command: '__proto__', rationale: 'prototype pollution attempt' },
        { command: 'constructor', rationale: 'nope' },
        { command: 'status', rationale: 'ok' },
      ],
    });
    const r = await brain.propose({}, 'x', { apiKey: API_KEY, fetch: fakeFetchReturning(text) });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(
      r.plan.map(function (s) {
        return s.command;
      }),
      ['status'],
    );
  });
});

// ---- propose(): junk / errors never throw -----------------------------------

test('propose() returns ok:false (never throws) on prose with no JSON', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'x', {
      apiKey: API_KEY,
      fetch: fakeFetchReturning('I cannot help with that, sorry!'),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.enabled, true);
    assert.deepStrictEqual(r.plan, []);
    assert.ok(typeof r.reason === 'string');
  });
});

test('propose() returns ok:false on a 500 error', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'x', { apiKey: API_KEY, fetch: fakeFetchReturning('', { status: 500 }) });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.plan, []);
  });
});

test('propose() returns ok:false when fetch throws (timeout/network)', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'x', { apiKey: API_KEY, fetch: fakeFetchReturning('', { throw: true }) });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.plan, []);
  });
});

test('propose() returns ok:false on a malformed body (no candidates)', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'x', {
      apiKey: API_KEY,
      fetch: fakeFetchReturning('', { rawBody: { nope: true } }),
    });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.plan, []);
  });
});

test('propose() returns ok:false when the JSON has no plan array', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'x', { apiKey: API_KEY, fetch: fakeFetchReturning('{"result":"nope"}') });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-plan-in-output');
  });
});

test('propose() returns ok:false when every step is invalid', async function () {
  await withBrainEnv('1', async function () {
    const text = JSON.stringify({ plan: [{ command: 'fake-a' }, { command: 'fake-b' }] });
    const r = await brain.propose({}, 'x', { apiKey: API_KEY, fetch: fakeFetchReturning(text) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-valid-steps');
    assert.ok(r.dropped.indexOf('fake-a') !== -1);
  });
});

test('propose() extracts JSON embedded in surrounding prose / code fences', async function () {
  await withBrainEnv('1', async function () {
    const embedded =
      'Sure! Here is your plan:\n```json\n' +
      JSON.stringify({ plan: [{ command: 'list' }] }) +
      '\n```\nHope that helps.';
    const r = await brain.propose({}, 'x', { apiKey: API_KEY, fetch: fakeFetchReturning(embedded) });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(
      r.plan.map(function (s) {
        return s.command;
      }),
      ['list'],
    );
  });
});

// ---- plan length cap ---------------------------------------------------------

test('propose() caps the plan length at MAX_STEPS', async function () {
  await withBrainEnv('1', async function () {
    const steps = [];
    for (let i = 0; i < 40; i++) steps.push({ command: 'status', rationale: 'r' + i });
    const r = await brain.propose({}, 'x', {
      apiKey: API_KEY,
      fetch: fakeFetchReturning(JSON.stringify({ plan: steps })),
    });
    assert.strictEqual(r.ok, true);
    assert.ok(r.plan.length <= brain.MAX_STEPS, 'plan capped at MAX_STEPS');
    assert.strictEqual(r.plan.length, brain.MAX_STEPS);
  });
});

// ---- API KEY never leaks -----------------------------------------------------

test('the API key never appears in the returned plan object', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'switch to work', {
      apiKey: API_KEY,
      fetch: fakeFetchReturning(validPlanText()),
    });
    const serialized = JSON.stringify(r);
    assert.strictEqual(serialized.indexOf(API_KEY), -1, 'key absent from the whole result');
  });
});

test('the API key never appears in formatPlan output', async function () {
  await withBrainEnv('1', async function () {
    const r = await brain.propose({}, 'switch to work', {
      apiKey: API_KEY,
      fetch: fakeFetchReturning(validPlanText()),
    });
    const rendered = brain.formatPlan(r.plan);
    assert.strictEqual(rendered.indexOf(API_KEY), -1, 'key absent from formatPlan');
    assert.ok(rendered.indexOf('keyflip status') !== -1, 'renders the safe step');
    assert.ok(/\[mutating\]/.test(rendered), 'flags mutating steps');
  });
});

test('the API key rides only the request URL, never a returned/logged field', async function () {
  await withBrainEnv('1', async function () {
    const fetchFn = fakeFetchReturning(validPlanText());
    const r = await brain.propose({}, 'switch', { apiKey: API_KEY, fetch: fetchFn });
    assert.strictEqual(fetchFn.calls.length, 1);
    // Present in the request URL (that is the ONLY allowed place)...
    assert.ok(fetchFn.calls[0].url.indexOf(encodeURIComponent(API_KEY)) !== -1, 'key is in the request URL');
    // ...but not in the plan we hand back to the CLI.
    assert.strictEqual(JSON.stringify(r).indexOf(API_KEY), -1);
  });
});

// ---- outbound scrubbing ------------------------------------------------------

test('redactOutbound scrubs a token embedded in caller state (object)', function () {
  const state = {
    account: 'work',
    creds: { api_key: 'sk-ant-abcdef....', note: 'my token is sk-ant-1234567890ABCDEFGH' },
  };
  const scrubbed = brain.redactOutbound(state);
  const s = JSON.stringify(scrubbed);
  assert.strictEqual(s.indexOf('sk-ant-1234567890ABCDEFGH'), -1, 'anthropic token gone');
  assert.ok(s.indexOf(secretscan.REDACTED) !== -1, 'replaced with the redaction marker');
  assert.ok(s.indexOf('work') !== -1, 'non-secret structure preserved');
});

test('redactOutbound scrubs a secret-shaped token from a free-text string', function () {
  const scrubbed = brain.redactOutbound('please use gh token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 now');
  assert.strictEqual(scrubbed.indexOf('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), -1);
  assert.ok(scrubbed.indexOf(secretscan.REDACTED) !== -1);
});

test('propose() scrubs the outbound intent before sending it to Gemini', async function () {
  await withBrainEnv('1', async function () {
    const fetchFn = fakeFetchReturning(JSON.stringify({ plan: [{ command: 'status' }] }));
    const secret = 'sk-ant-SECRETLEAK1234567890ABCDEF';
    await brain.propose({}, 'set my key to ' + secret, { apiKey: API_KEY, fetch: fetchFn, state: { token: secret } });
    const bodySent = fetchFn.calls[0].init.body;
    assert.strictEqual(bodySent.indexOf(secret), -1, 'the secret never reaches the request body');
    assert.ok(bodySent.indexOf(secretscan.REDACTED) !== -1, 'the secret was redacted in the outbound payload');
  });
});

// ---- callGemini direct fail-closed behavior ---------------------------------

test('callGemini returns null (never throws) on non-200 / throw / bad body', async function () {
  const a = await brain.callGemini(API_KEY, 'p', { fetch: fakeFetchReturning('', { status: 404 }) });
  assert.strictEqual(a, null);
  const b = await brain.callGemini(API_KEY, 'p', { fetch: fakeFetchReturning('', { throw: true }) });
  assert.strictEqual(b, null);
  const c = await brain.callGemini(API_KEY, 'p', { fetch: fakeFetchReturning('', { rawBody: null }) });
  assert.strictEqual(c, null);
  const d = await brain.callGemini(API_KEY, 'p', { fetch: fakeFetchReturning('not json prose') });
  assert.strictEqual(d, null, 'non-JSON model text -> null');
});

test('callGemini uses the default model in the URL, overridable via deps.model', async function () {
  const f1 = fakeFetchReturning(JSON.stringify({ plan: [] }));
  await brain.callGemini(API_KEY, 'p', { fetch: f1 });
  assert.ok(f1.calls[0].url.indexOf(brain.DEFAULT_MODEL) !== -1, 'default model present');

  const f2 = fakeFetchReturning(JSON.stringify({ plan: [] }));
  await brain.callGemini(API_KEY, 'p', { fetch: f2, model: 'gemini-1.5-pro' });
  assert.ok(f2.calls[0].url.indexOf('gemini-1.5-pro') !== -1, 'model override present');
});

// ---- propose() empty intent --------------------------------------------------

test('propose() rejects an empty intent without a network call', async function () {
  await withBrainEnv('1', async function () {
    let called = false;
    const fetchFn = async function () {
      called = true;
      return {
        status: 200,
        json: async function () {
          return {};
        },
      };
    };
    const r = await brain.propose({}, '   ', { apiKey: API_KEY, fetch: fetchFn });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.reason, 'empty-intent');
    assert.strictEqual(called, false);
  });
});

// ---- extractFirstJsonObject: brace matching is string/escape aware ----------

test('extractFirstJsonObject ignores braces inside JSON strings', function () {
  const parsed = brain.extractFirstJsonObject(
    'noise {"plan":[{"command":"status","rationale":"a } b \\" c"}]} trailing',
  );
  assert.ok(parsed && Array.isArray(parsed.plan));
  assert.strictEqual(parsed.plan[0].rationale, 'a } b " c');
});

test('extractFirstJsonObject returns null when there is no object', function () {
  assert.strictEqual(brain.extractFirstJsonObject('just prose, no json here'), null);
  assert.strictEqual(brain.extractFirstJsonObject(''), null);
});

// ---- module surface: no execution seam --------------------------------------

test('brain.js does not import or expose any execution path', function () {
  const src = _fs.readFileSync(_path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
  assert.strictEqual(/require\(['"]\.\/cli['"]\)/.test(src), false, 'does not require cli.js');
  assert.strictEqual(/require\(['"]\.\/mcp['"]\)/.test(src), false, 'does not require mcp.js');
  assert.strictEqual(/child_process/.test(src), false, 'does not require child_process');
  assert.strictEqual(/\.run\s*\(/.test(src), false, 'no tool.run(...) call');
});
