// BUDGET: per-account usage ceilings + breach/near-breach alerts + Virtual Keys (vk_...).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as budget from '../src/budget.js';
import * as proxy from '../src/proxy.js';
import { makeCtx } from './helpers.js';

function writeCache(ctx, byName) {
  const obj = {};
  Object.keys(byName).forEach(function (name) {
    const u = byName[name];
    const usage = {};
    if (u.fiveHour !== undefined) usage.fiveHour = { pct: u.fiveHour };
    if (u.sevenDay !== undefined) usage.sevenDay = { pct: u.sevenDay };
    obj[name] = { at: 1, status: 'ok', usage: usage };
  });
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), JSON.stringify(obj));
}
function writeBudgetRaw(ctx, raw) {
  fs.writeFileSync(path.join(ctx.configDir, 'budget.json'), raw);
}

// ---- get / setLimit / clear -------------------------------------------------

test('get on a fresh config is empty', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(Object.keys(budget.get(ctx)), []);
});

test('setLimit persists and get reflects it (file is 0600)', function () {
  const ctx = makeCtx();
  const r = budget.setLimit(ctx, 'work', { fiveHourPct: 80, sevenDayPct: 90 });
  assert.deepStrictEqual(
    { fiveHourPct: r.fiveHourPct, sevenDayPct: r.sevenDayPct },
    { fiveHourPct: 80, sevenDayPct: 90 },
  );
  const cfg = budget.get(ctx);
  assert.strictEqual(cfg.work.fiveHourPct, 80);
  assert.strictEqual(cfg.work.sevenDayPct, 90);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(budget.budgetPath(ctx)).mode & 0o777;
    assert.strictEqual(mode, 0o600);
  }
});

test('setLimit MERGES: setting one window leaves the other intact', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  budget.setLimit(ctx, 'work', { sevenDayPct: 70 });
  const cfg = budget.get(ctx);
  assert.strictEqual(cfg.work.fiveHourPct, 80);
  assert.strictEqual(cfg.work.sevenDayPct, 70);
});

test('setLimit with null DELETES a single window', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80, sevenDayPct: 90 });
  const r = budget.setLimit(ctx, 'work', { fiveHourPct: null });
  assert.strictEqual(r.fiveHourPct, undefined);
  assert.strictEqual(r.sevenDayPct, 90);
});

test('setLimit removing the LAST window drops the whole entry', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  const r = budget.setLimit(ctx, 'work', { fiveHourPct: null });
  assert.strictEqual(r, null);
  assert.ok(!('work' in budget.get(ctx)));
});

test('setLimit rejects out-of-range / non-number ceilings', function () {
  const ctx = makeCtx();
  [150, -5, NaN, Infinity, 'x', {}].forEach(function (bad) {
    assert.throws(function () {
      budget.setLimit(ctx, 'work', { fiveHourPct: bad });
    });
  });
  assert.ok(!('work' in budget.get(ctx)));
});

test('setLimit with nothing provided throws', function () {
  const ctx = makeCtx();
  assert.throws(function () {
    budget.setLimit(ctx, 'work', {});
  }, /nothing to set/);
});

test('setLimit accepts the boundary values 0 and 100', function () {
  const ctx = makeCtx();
  const r = budget.setLimit(ctx, 'work', { fiveHourPct: 0, sevenDayPct: 100 });
  assert.strictEqual(r.fiveHourPct, 0);
  assert.strictEqual(r.sevenDayPct, 100);
});

test('setLimit rejects hostile / invalid account names', function () {
  const ctx = makeCtx();
  ['__proto__', 'constructor', 'prototype', 'has space', '-flag', '.dot', '', 'a/b'].forEach(function (bad) {
    assert.throws(function () {
      budget.setLimit(ctx, bad, { fiveHourPct: 50 });
    }, 'expected throw for name: ' + bad);
  });
});

test("setLimit on the '*' defaults works", function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 85 });
  assert.strictEqual(budget.get(ctx)['*'].fiveHourPct, 85);
});

test('clear removes an entry (true), missing entry is false, bad name throws', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  assert.strictEqual(budget.clear(ctx, 'work'), true);
  assert.ok(!('work' in budget.get(ctx)));
  assert.strictEqual(budget.clear(ctx, 'work'), false);
  assert.throws(function () {
    budget.clear(ctx, '__proto__');
  });
});

test('limitsFor merges defaults under per-account overrides', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 50, sevenDayPct: 60 });
  budget.setLimit(ctx, 'work', { fiveHourPct: 90 });
  const eff = budget.limitsFor(ctx, 'work');
  assert.strictEqual(eff.fiveHourPct, 90);
  assert.strictEqual(eff.sevenDayPct, 60);
});

// ---- evaluate ---------------------------------------------------------------

test('evaluate on empty config returns []', function () {
  const ctx = makeCtx();
  writeCache(ctx, { work: { fiveHour: 99, sevenDay: 99 } });
  assert.deepStrictEqual(budget.evaluate(ctx), []);
});

test('evaluate flags a breach when pct >= limit', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  writeCache(ctx, { work: { fiveHour: 85, sevenDay: 10 } });
  const rows = budget.evaluate(ctx);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    name: 'work',
    metric: 'fiveHour',
    pct: 85,
    limit: 80,
    breached: true,
    level: 'breach',
  });
});

test('evaluate flags a warn within WARN_MARGIN, silent below it', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  writeCache(ctx, { work: { fiveHour: 72 } });
  let rows = budget.evaluate(ctx);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].level, 'warn');
  assert.strictEqual(rows[0].breached, false);
  writeCache(ctx, { work: { fiveHour: 69 } });
  assert.deepStrictEqual(budget.evaluate(ctx), []);
});

test('evaluate boundary: pct === limit is breach, pct === limit-margin is warn', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  writeCache(ctx, { work: { fiveHour: 80 } });
  assert.strictEqual(budget.evaluate(ctx)[0].level, 'breach');
  writeCache(ctx, { work: { fiveHour: 70 } });
  assert.strictEqual(budget.evaluate(ctx)[0].level, 'warn');
  writeCache(ctx, { work: { fiveHour: 69.9 } });
  assert.deepStrictEqual(budget.evaluate(ctx), []);
});

test('evaluate skips windows with no cached usage', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80, sevenDayPct: 80 });
  writeCache(ctx, { work: { fiveHour: 95 } });
  const rows = budget.evaluate(ctx);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].metric, 'fiveHour');
});

test('evaluate skips a configured account entirely absent from the cache', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 10 });
  writeCache(ctx, { other: { fiveHour: 99 } });
  assert.deepStrictEqual(budget.evaluate(ctx), []);
});

test("'*' defaults cover every account present in the cache", function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 80 });
  writeCache(ctx, { work: { fiveHour: 90 }, home: { fiveHour: 10 } });
  const rows = budget.evaluate(ctx);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'work');
  assert.strictEqual(rows[0].breached, true);
});

test('per-account ceiling overrides the default for that account', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 50 });
  budget.setLimit(ctx, 'work', { fiveHourPct: 95 });
  writeCache(ctx, { work: { fiveHour: 60 } });
  assert.deepStrictEqual(budget.evaluate(ctx), []);
});

test('evaluate orders breaches before warns, then by pct desc', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 80 });
  writeCache(ctx, {
    a: { fiveHour: 100 },
    b: { fiveHour: 85 },
    c: { fiveHour: 75 },
  });
  const rows = budget.evaluate(ctx);
  assert.deepStrictEqual(
    rows.map(function (r) {
      return r.name;
    }),
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    rows.map(function (r) {
      return r.level;
    }),
    ['breach', 'breach', 'warn'],
  );
});

// ---- status -----------------------------------------------------------------

test('status combines ceilings, current usage, defaults and alerts', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { sevenDayPct: 95 });
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  writeCache(ctx, { work: { fiveHour: 88, sevenDay: 40 } });
  const s = budget.status(ctx);
  assert.deepStrictEqual(s.defaults, { fiveHourPct: null, sevenDayPct: 95 });
  const work = s.accounts.find(function (a) {
    return a.name === 'work';
  });
  assert.strictEqual(work.limits.fiveHourPct, 80);
  assert.strictEqual(work.limits.sevenDayPct, 95);
  assert.strictEqual(work.usage.fiveHour, 88);
  assert.strictEqual(work.usage.sevenDay, 40);
  assert.strictEqual(work.alerts.length, 1);
  assert.strictEqual(work.alerts[0].metric, 'fiveHour');
  assert.strictEqual(s.breached, true);
});

test('status usage is null when a window has no cached sample', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  const s = budget.status(ctx);
  const work = s.accounts.find(function (a) {
    return a.name === 'work';
  });
  assert.strictEqual(work.usage.fiveHour, null);
  assert.strictEqual(work.usage.sevenDay, null);
  assert.deepStrictEqual(s.alerts, []);
  assert.strictEqual(s.breached, false);
});

// ---- hostile / corrupt input ------------------------------------------------

test('get tolerates a corrupt budget.json (reads empty)', function () {
  const ctx = makeCtx();
  writeBudgetRaw(ctx, '{ this is not json');
  assert.deepStrictEqual(Object.keys(budget.get(ctx)), []);
});

test('setLimit REFUSES to clobber a corrupt budget.json', function () {
  const ctx = makeCtx();
  writeBudgetRaw(ctx, '{ not json');
  assert.throws(function () {
    budget.setLimit(ctx, 'work', { fiveHourPct: 50 });
  }, /not valid JSON|JSON/);
  assert.strictEqual(fs.readFileSync(budget.budgetPath(ctx), 'utf8'), '{ not json');
});

test('a tampered budget.json with a real __proto__ key cannot pollute', function () {
  const ctx = makeCtx();
  writeBudgetRaw(ctx, '{"__proto__":{"fiveHourPct":1},"constructor":{"fiveHourPct":2},"work":{"fiveHourPct":80}}');
  const cfg = budget.get(ctx);
  assert.strictEqual(Object.getPrototypeOf(cfg), null, 'config is a null-proto object');
  assert.strictEqual({}.fiveHourPct, undefined, 'no prototype pollution');
  assert.deepStrictEqual(Object.keys(cfg), ['work'], 'unsafe keys dropped');
  assert.strictEqual(cfg.work.fiveHourPct, 80);
});

test('evaluate tolerates a corrupt usage cache (no alerts)', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 1 });
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'garbage{');
  assert.deepStrictEqual(budget.evaluate(ctx), []);
});

test('evaluate ignores junk / hostile cache entries', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, '*', { fiveHourPct: 1 });
  const raw =
    '{"__proto__":{"usage":{"fiveHour":{"pct":99}}},' +
    '"scalar":5,' +
    '"work":{"usage":{"fiveHour":{"pct":"nope"}}},' +
    '"home":{"usage":{"fiveHour":{"pct":50}}}}';
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), raw);
  const rows = budget.evaluate(ctx);
  assert.strictEqual({}.usage, undefined, 'no prototype pollution from cache');
  assert.deepStrictEqual(
    rows.map(function (r) {
      return r.name;
    }),
    ['home'],
  );
});

test('budget.json is written as clean JSON (no prototype leakage on round-trip)', function () {
  const ctx = makeCtx();
  budget.setLimit(ctx, 'work', { fiveHourPct: 80 });
  const parsed = JSON.parse(fs.readFileSync(budget.budgetPath(ctx), 'utf8'));
  assert.deepStrictEqual(parsed, { work: { fiveHourPct: 80 } });
});

// ---- Virtual Keys (vk_...) + USD/TRY Budget + RPM + tempBoost ---------------

test('createVirtualKey, checkVirtualKey, recordVirtualKeySpend, and boostVirtualKeyBudget work end-to-end', function () {
  const ctx = makeCtx({ now: '2026-11-13T10:00:00.000Z' });
  const vk = budget.createVirtualKey(ctx, {
    label: 'ci-agent',
    maxBudgetUsd: 2.0,
    rpmLimit: 2,
    allowedModels: ['claude-sonnet-*'],
    modelBudgets: { 'claude-sonnet-4-6': 1.5 },
  });
  assert.ok(vk.key.startsWith('vk_'));
  assert.strictEqual(vk.label, 'ci-agent');
  assert.strictEqual(vk.maxBudgetUsd, 2.0);
  assert.ok(vk.maxBudgetTry > 60);

  // List hides raw key by default
  const listed = budget.listVirtualKeys(ctx);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].key, undefined);
  assert.ok(listed[0].maskedKey.startsWith('vk_'));

  // Disallowed model -> 403
  const badModel = budget.checkVirtualKey(ctx, vk.key, {
    model: 'claude-opus-4-6',
    nowMs: Date.parse('2026-11-13T10:00:01Z'),
  });
  assert.strictEqual(badModel.allowed, false);
  assert.strictEqual(badModel.status, 403);
  assert.strictEqual(badModel.code, 'model_not_allowed');

  // Allowed model, RPM = 2: first two pass, third in same minute fails with 429
  const c1 = budget.checkVirtualKey(ctx, vk.key, {
    model: 'claude-sonnet-4-6',
    nowMs: Date.parse('2026-11-13T10:00:02Z'),
  });
  assert.strictEqual(c1.allowed, true);
  const c2 = budget.checkVirtualKey(ctx, vk.key, {
    model: 'claude-sonnet-4-6',
    nowMs: Date.parse('2026-11-13T10:00:10Z'),
  });
  assert.strictEqual(c2.allowed, true);
  const c3 = budget.checkVirtualKey(ctx, vk.key, {
    model: 'claude-sonnet-4-6',
    nowMs: Date.parse('2026-11-13T10:00:20Z'),
  });
  assert.strictEqual(c3.allowed, false);
  assert.strictEqual(c3.status, 429);
  assert.strictEqual(c3.code, 'rpm_limit_exceeded');

  // Record spend exceeding total budget ($2.00) -> 429 budget_exceeded
  budget.recordVirtualKeySpend(ctx, vk.key, { model: 'claude-sonnet-4-6', costUsd: 2.1 });
  const overBudget = budget.checkVirtualKey(ctx, vk.key, {
    model: 'claude-sonnet-4-6',
    nowMs: Date.parse('2026-11-13T10:02:00Z'),
  });
  assert.strictEqual(overBudget.allowed, false);
  assert.strictEqual(overBudget.status, 429);
  assert.strictEqual(overBudget.code, 'budget_exceeded');

  // Temporary boost (+$5.00 for 60 min) lifts total ceiling to $7.00
  const boosted = budget.boostVirtualKeyBudget(ctx, 'ci-agent', { amountUsd: 5.0, durationMinutes: 60 });
  assert.strictEqual(boosted.boostActive, true);
  assert.strictEqual(boosted.effectiveBudgetUsd, 7.0);

  // Revoke key -> 403 virtual_key_revoked
  budget.revokeVirtualKey(ctx, vk.id);
  const revCheck = budget.checkVirtualKey(ctx, vk.key, {
    model: 'claude-sonnet-4-6',
    nowMs: Date.parse('2026-11-13T10:03:00Z'),
  });
  assert.strictEqual(revCheck.allowed, false);
  assert.strictEqual(revCheck.status, 403);
  assert.strictEqual(revCheck.code, 'virtual_key_revoked');
});

test('proxy.handleRequest enforces Virtual Key budget before upstream call', async function () {
  const ctx = makeCtx();
  const vk = budget.createVirtualKey(ctx, { label: 'capped-agent', maxBudgetUsd: 0.5 });
  budget.recordVirtualKeySpend(ctx, vk.key, { model: 'claude-sonnet-4-6', costUsd: 0.6 });

  let upstreamCalled = false;
  let statusSent = null;
  let bodySent = '';
  const fakeRes = {
    writeHead(s) {
      statusSent = s;
    },
    end(b) {
      bodySent = String(b || '');
    },
  };
  const r = await proxy.handleRequest(
    ctx,
    {
      method: 'POST',
      path: '/v1/messages',
      headers: { authorization: 'Bearer ' + vk.key },
      body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] })),
    },
    fakeRes,
    {
      forward: async () => {
        upstreamCalled = true;
        return { status: 200, headers: {}, body: Buffer.from('{}') };
      },
    },
  );
  assert.strictEqual(upstreamCalled, false, 'upstream must not be called when virtual key budget is exceeded');
  assert.strictEqual(statusSent, 429);
  assert.strictEqual(r.error, 'budget_exceeded');
  assert.ok(bodySent.includes('budget_exceeded'));
});
