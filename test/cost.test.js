// COST intelligence tests. Fully hermetic: makeCtx gives a temp home + fixed
// clock; we write .usage-cache.json / usage-history.jsonl / fake transcripts
// directly (cost.js only READS them). No network, no subprocess, no real time.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as cost from '../src/cost.js';
import * as history from '../src/history.js';
import { makeCtx } from './helpers.js';

function writeCache(ctx, obj) {
  fs.writeFileSync(path.join(ctx.configDir, '.usage-cache.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function writeSession(ctx, project, id, lines) {
  const dir = path.join(ctx.home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map(function (l) { return typeof l === 'string' ? l : JSON.stringify(l); }).join('\n') + '\n');
  return file;
}
function asstLine(cwd, model, u, text) {
  return { type: 'assistant', cwd: cwd, message: { role: 'assistant', model: model, content: [{ type: 'text', text: text || 'ok' }], usage: u } };
}
function userLine(cwd, text) {
  return { type: 'user', cwd: cwd, message: { role: 'user', content: text || 'hi' } };
}
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }

// ---- priceFor ---------------------------------------------------------------

test('priceFor resolves known models exactly', function () {
  assert.deepStrictEqual(cost.priceFor('claude-opus-4-8'), { id: 'claude-opus-4-8', inputPerMTok: 5, outputPerMTok: 25, fallback: false });
  assert.deepStrictEqual(cost.priceFor('claude-sonnet-5'), { id: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15, fallback: false });
  assert.strictEqual(cost.priceFor('claude-haiku-4-5').inputPerMTok, 1);
});

test('priceFor normalizes provider/region prefixes, @version, dated + -fast suffixes, case', function () {
  assert.strictEqual(cost.priceFor('anthropic.claude-opus-4-8').id, 'claude-opus-4-8');
  assert.strictEqual(cost.priceFor('us.anthropic.claude-sonnet-4-6').id, 'claude-sonnet-4-6');
  assert.strictEqual(cost.priceFor('claude-opus-4-5@20251101').id, 'claude-opus-4-5');
  assert.strictEqual(cost.priceFor('claude-haiku-4-5-20251001').id, 'claude-haiku-4-5');
  assert.strictEqual(cost.priceFor('claude-opus-4-8-fast').id, 'claude-opus-4-8');
  assert.strictEqual(cost.priceFor('CLAUDE-OPUS-4-8').id, 'claude-opus-4-8');
});

test('priceFor falls back (flagged) for unknown / empty / null models', function () {
  ['gpt-4', 'llama-3', '', null, undefined, 12345, {}].forEach(function (bad) {
    const p = cost.priceFor(bad);
    assert.strictEqual(p.fallback, true, 'expected fallback for ' + String(bad));
    assert.strictEqual(p.inputPerMTok, cost.FALLBACK_PRICE.inputPerMTok);
    assert.strictEqual(p.outputPerMTok, cost.FALLBACK_PRICE.outputPerMTok);
  });
});

test('priceFor does not strip hyphens (regression: model id stays intact)', function () {
  // A control-char strip that ate hyphens would turn this into "claudeopus48".
  assert.strictEqual(cost.priceFor('claude-opus-4-8').fallback, false);
});

// ---- estimateCost -----------------------------------------------------------

test('estimateCost prices input + output at per-MTok rates', function () {
  assert.strictEqual(cost.estimateCost({ model: 'claude-opus-4-8', inputTokens: 1e6, outputTokens: 1e6 }), 30);
  assert.ok(close(cost.estimateCost({ model: 'claude-haiku-4-5', inputTokens: 100, outputTokens: 50 }), 0.0001 + 0.00025));
});

test('estimateCost adds cache tokens at input-relative multipliers', function () {
  // opus input rate 5: read 1e6 -> 5*0.1=0.5 ; write 1e6 -> 5*1.25=6.25
  const c = cost.estimateCost({ model: 'claude-opus-4-8', inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheCreationTokens: 1e6 });
  assert.ok(close(c, 0.5 + 6.25), 'got ' + c);
});

test('estimateCost treats missing/negative/NaN tokens as zero and returns a number', function () {
  assert.strictEqual(cost.estimateCost({ model: 'claude-opus-4-8' }), 0);
  assert.strictEqual(cost.estimateCost({ model: 'claude-opus-4-8', inputTokens: -5, outputTokens: NaN }), 0);
  assert.strictEqual(typeof cost.estimateCost({ model: 'claude-opus-4-8', inputTokens: 10, outputTokens: 20 }), 'number');
});

test('estimateCost uses fallback pricing for an unknown model', function () {
  // fallback = opus-tier 5/25 -> 1e6 in + 1e6 out = 30
  assert.strictEqual(cost.estimateCost({ model: 'mystery-model', inputTokens: 1e6, outputTokens: 1e6 }), 30);
});

// ---- unified ----------------------------------------------------------------

test('unified on an empty/missing cache reports no accounts and null totals', function () {
  const ctx = makeCtx();
  const u = cost.unified(ctx);
  assert.deepStrictEqual(u.accounts, []);
  assert.strictEqual(u.totals.accounts, 0);
  assert.strictEqual(u.totals.fiveHourPctMax, null);
  assert.strictEqual(u.totals.costUSD, null);
  assert.strictEqual(u.totals.tokens, null);
  assert.strictEqual(u.at, ctx.now());
});

test('unified reports pct utilization but NEVER fabricates cost from percentages', function () {
  const ctx = makeCtx();
  writeCache(ctx, {
    work: { at: 1, status: 'ok', usage: { fiveHour: { pct: 80 }, sevenDay: { pct: 40 } } },
    home: { at: 1, status: 'ok', usage: { fiveHour: { pct: 20 } } },
  });
  const u = cost.unified(ctx);
  const work = u.accounts.find(function (a) { return a.name === 'work'; });
  assert.strictEqual(work.fiveHourPct, 80);
  assert.strictEqual(work.sevenDayPct, 40);
  assert.strictEqual(work.costUSD, null, 'cost must be null — pct is not spend');
  assert.strictEqual(work.measured, false);
  assert.strictEqual(work.tokens, null);
  assert.strictEqual(u.totals.fiveHourPctMax, 80);
  assert.strictEqual(u.totals.fiveHourPctAvg, 50);
  assert.strictEqual(u.totals.costUSD, null);
  assert.strictEqual(u.totals.tokens, null);
});

test('unified DOES cost accounts whose cache entry carries measured token totals', function () {
  const ctx = makeCtx();
  writeCache(ctx, {
    work: { at: 1, status: 'ok', usage: { fiveHour: { pct: 50 }, model: 'claude-opus-4-8', tokens: { input: 1e6, output: 1e6 } } },
  });
  const u = cost.unified(ctx);
  const work = u.accounts[0];
  assert.strictEqual(work.measured, true);
  assert.strictEqual(work.tokens.input, 1e6);
  assert.strictEqual(work.costUSD, 30);
  assert.strictEqual(u.totals.costUSD, 30);
  assert.strictEqual(u.totals.tokens.output, 1e6);
});

test('unified tolerates a corrupt cache (reads empty)', function () {
  const ctx = makeCtx();
  writeCache(ctx, 'not json {');
  assert.deepStrictEqual(cost.unified(ctx).accounts, []);
});

test('unified is prototype-pollution safe against a hostile __proto__ cache key', function () {
  const ctx = makeCtx();
  writeCache(ctx, '{"__proto__":{"usage":{"fiveHour":{"pct":99}}},"work":{"usage":{"fiveHour":{"pct":10}}}}');
  const u = cost.unified(ctx);
  assert.strictEqual(({}).usage, undefined, 'no prototype pollution');
  // both keys are surfaced as plain rows; neither pollutes a prototype
  assert.ok(u.accounts.some(function (a) { return a.name === 'work' && a.fiveHourPct === 10; }));
});

// ---- predict ----------------------------------------------------------------

test('predict projects a positive rate and finite ETA from a rising trend', function () {
  const ctx = makeCtx();
  const samples = [
    { at: '2025-12-31T22:00:00.000Z', account: 'work', fiveHour: 40, sevenDay: 5 },
    { at: '2025-12-31T23:00:00.000Z', account: 'work', fiveHour: 60, sevenDay: 10 },
  ];
  const p = cost.predict(ctx, 'work', { samples: samples });
  const five = p.windows.find(function (w) { return w.metric === 'fiveHour'; });
  assert.strictEqual(five.pct, 60);
  assert.ok(close(five.ratePerHour, 20));
  assert.ok(close(five.etaMinutes, 120), 'eta ' + five.etaMinutes); // (100-60)/20*60
  assert.strictEqual(five.samples, 2);
});

test('predict ignores samples before a window reset (uses the trailing run only)', function () {
  const ctx = makeCtx();
  const samples = [
    { at: '2025-12-31T20:00:00.000Z', account: 'work', fiveHour: 80 },
    { at: '2025-12-31T21:00:00.000Z', account: 'work', fiveHour: 90 },
    { at: '2025-12-31T22:00:00.000Z', account: 'work', fiveHour: 10 }, // reset
    { at: '2025-12-31T23:00:00.000Z', account: 'work', fiveHour: 30 },
  ];
  const five = cost.predict(ctx, 'work', { samples: samples }).windows[0];
  assert.strictEqual(five.pct, 30);
  assert.ok(close(five.ratePerHour, 20)); // only the 10->30 run
  assert.strictEqual(five.samples, 2);
  assert.ok(close(five.etaMinutes, 210));
});

test('predict returns null rate/eta for a flat trend (never faked)', function () {
  const ctx = makeCtx();
  const samples = [
    { at: '2025-12-31T22:00:00.000Z', account: 'work', fiveHour: 50 },
    { at: '2025-12-31T23:00:00.000Z', account: 'work', fiveHour: 50 },
  ];
  const five = cost.predict(ctx, 'work', { samples: samples }).windows[0];
  assert.strictEqual(five.pct, 50);
  assert.strictEqual(five.ratePerHour, null);
  assert.strictEqual(five.etaMinutes, null);
});

test('predict returns eta 0 when already at/over the limit', function () {
  const ctx = makeCtx();
  const p = cost.predict(ctx, 'work', {
    cache: { work: { usage: { fiveHour: { pct: 100 } } } },
    samples: [
      { at: '2025-12-31T22:00:00.000Z', account: 'work', fiveHour: 90 },
      { at: '2025-12-31T23:00:00.000Z', account: 'work', fiveHour: 100 },
    ],
  });
  assert.strictEqual(p.windows[0].etaMinutes, 0);
});

test('predict with no data yields null pct/rate/eta and 0 samples', function () {
  const ctx = makeCtx();
  const p = cost.predict(ctx, 'ghost', { samples: [], cache: {} });
  p.windows.forEach(function (w) {
    assert.strictEqual(w.pct, null);
    assert.strictEqual(w.ratePerHour, null);
    assert.strictEqual(w.etaMinutes, null);
    assert.strictEqual(w.samples, 0);
  });
});

test('predict reads the default history log + usage cache when opts omitted', function () {
  const ctx = makeCtx();
  fs.writeFileSync(history.usageFile(ctx),
    JSON.stringify({ at: '2025-12-31T22:00:00.000Z', account: 'work', status: 'ok', fiveHour: 40, sevenDay: 1 }) + '\n' +
    JSON.stringify({ at: '2025-12-31T23:00:00.000Z', account: 'work', status: 'ok', fiveHour: 60, sevenDay: 2 }) + '\n' +
    JSON.stringify({ at: '2025-12-31T23:30:00.000Z', account: 'other', status: 'ok', fiveHour: 99, sevenDay: 99 }) + '\n');
  const five = cost.predict(ctx, 'work').windows[0];
  assert.strictEqual(five.pct, 60); // 'other' account samples are filtered out
  assert.ok(close(five.ratePerHour, 20));
});

test('predict honors an injected clock for the "at" stamp', function () {
  const ctx = makeCtx();
  const p = cost.predict(ctx, 'work', { samples: [], cache: {}, clock: function () { return '2099-01-01T00:00:00.000Z'; } });
  assert.strictEqual(p.at, '2099-01-01T00:00:00.000Z');
});

// ---- attribute --------------------------------------------------------------

test('attribute measures per-cwd tokens/messages/cost, sorted by cost desc', function () {
  const ctx = makeCtx();
  writeSession(ctx, '-repo-a', 'sessA', [
    userLine('/repo/a'),
    asstLine('/repo/a', 'claude-opus-4-8', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }),
  ]);
  writeSession(ctx, '-repo-b', 'sessB', [
    userLine('/repo/b'),
    asstLine('/repo/b', 'claude-haiku-4-5', { input_tokens: 100, output_tokens: 50 }),
  ]);
  const r = cost.attribute(ctx);
  assert.strictEqual(r.byCwd.length, 2);
  assert.strictEqual(r.byCwd[0].cwd, '/repo/a', 'a costs more -> first');
  assert.strictEqual(r.byCwd[0].repo, 'a');
  assert.strictEqual(r.byCwd[0].tokens.total, 3600);
  assert.strictEqual(r.byCwd[0].messages, 2);
  assert.ok(close(r.byCwd[0].costUSD, 0.005 + 0.0125 + 0.001 + 0.000625), 'cost ' + r.byCwd[0].costUSD);
  assert.strictEqual(r.byCwd[0].models['claude-opus-4-8'].tokens.total, 3600);
  assert.strictEqual(r.totals.cwds, 2);
  assert.strictEqual(r.totals.sessions, 2);
  assert.ok(r.totals.costUSD > r.byCwd[1].costUSD);
  assert.match(r.note, /MEASURED/);
});

test('attribute caps work at maxSessions', function () {
  const ctx = makeCtx();
  writeSession(ctx, '-r1', 'sess1', [userLine('/r1'), asstLine('/r1', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 5 })]);
  writeSession(ctx, '-r2', 'sess2', [userLine('/r2'), asstLine('/r2', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 5 })]);
  const r = cost.attribute(ctx, { maxSessions: 1 });
  assert.strictEqual(r.scanned.sessions, 1);
  assert.ok(r.scanned.filesRead <= 1);
  assert.strictEqual(r.capped, true);
});

test('attribute flags truncated transcripts (bounded read) without throwing', function () {
  const ctx = makeCtx();
  const dir = path.join(ctx.home, '.claude', 'projects', '-big');
  fs.mkdirSync(dir, { recursive: true });
  const head = JSON.stringify(userLine('/big')) + '\n' +
    JSON.stringify(asstLine('/big', 'claude-opus-4-8', { input_tokens: 100, output_tokens: 100 })) + '\n';
  const padding = ('x'.repeat(200) + '\n').repeat(1000); // ~200KB of junk lines
  fs.writeFileSync(path.join(dir, 'sessBig.jsonl'), head + padding);
  const r = cost.attribute(ctx, { maxBytesPerFile: 70000 }); // floor-clamped; file is far bigger
  assert.strictEqual(r.scanned.truncatedFiles, 1);
  assert.strictEqual(r.byCwd.length, 1);
  assert.strictEqual(r.byCwd[0].tokens.input, 100); // head line still counted
});

test('attribute is prototype-pollution safe against a hostile cwd', function () {
  const ctx = makeCtx();
  writeSession(ctx, '-evil', 'sessE', [
    userLine('__proto__'),
    asstLine('__proto__', 'claude-opus-4-8', { input_tokens: 10, output_tokens: 10 }),
  ]);
  const r = cost.attribute(ctx);
  assert.strictEqual(({}).sessions, undefined, 'no prototype pollution');
  assert.ok(r.byCwd.some(function (b) { return b.cwd === '__proto__'; }));
});

test('attribute on an empty projects tree returns an empty result', function () {
  const ctx = makeCtx();
  const r = cost.attribute(ctx);
  assert.deepStrictEqual(r.byCwd, []);
  assert.strictEqual(r.totals.costUSD, 0);
  assert.strictEqual(r.scanned.sessions, 0);
});

test('attribute uses fallback pricing for an unknown model and says so', function () {
  const ctx = makeCtx();
  writeSession(ctx, '-mystery', 'sessM', [
    userLine('/mystery'),
    asstLine('/mystery', 'some-future-model', { input_tokens: 1e6, output_tokens: 1e6 }),
  ]);
  const r = cost.attribute(ctx);
  assert.strictEqual(r.byCwd[0].estimate, true);
  assert.strictEqual(r.byCwd[0].models['some-future-model'].fallbackPrice, true);
  assert.strictEqual(r.byCwd[0].costUSD, 30); // fallback opus-tier
  assert.match(r.note, /fallback pricing/);
});

// ---- fmt helpers ------------------------------------------------------------

test('fmtUsd formats across magnitudes', function () {
  assert.strictEqual(cost.fmtUsd(0), '$0.00');
  assert.strictEqual(cost.fmtUsd(0.0001), '$0.0001');
  assert.strictEqual(cost.fmtUsd(12.5), '$12.50');
  assert.strictEqual(cost.fmtUsd(1234), '$1,234');
  assert.strictEqual(cost.fmtUsd(NaN), '$?');
});

test('fmtEta formats minutes and handles null/now', function () {
  assert.strictEqual(cost.fmtEta(null), '-');
  assert.strictEqual(cost.fmtEta(0), 'now');
  assert.strictEqual(cost.fmtEta(30), '30m');
  assert.strictEqual(cost.fmtEta(90), '1h 30m');
  assert.strictEqual(cost.fmtEta(1500), '1d 1h');
});
