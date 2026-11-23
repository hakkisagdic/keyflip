// Stage-2 local offensive-language classifier tests (K1, K2, K4, K6, catalog & installer).
// Uses injectable fake classifiers/hooks; never makes network requests.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { tmpdir } from './helpers.js';
import {
  MASK_TOKEN,
  createFilter,
  profanitySignature,
  splitSentences,
  classifyOffensive,
  normalizeModelId,
} from '../src/profanity.js';
import {
  MODEL_CATALOG,
  DEFAULT_MODEL_ID,
  PERMISSIVE_LICENSES,
  resolveCatalogModel,
  modelsRootDir,
  runtimeDir,
  weightsRootDir,
  modelDir,
  manifestPath,
  isRuntimeInstalled,
  getInstalledModel,
  listInstalledModels,
  scoreFromOutputs,
  loadLocalClassifier,
} from '../src/profanity-model.js';
import { RUNTIME_APPROX_MB, installPlan, installModel, removeModel } from '../src/profanity-model-install.js';

test('K1: with model off, profanitySignature and createFilter output are identical to v1.7.2', async function (t) {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = { configDir: dir };

  assert.strictEqual(normalizeModelId(undefined), 'off');
  assert.strictEqual(normalizeModelId(''), 'off');
  assert.strictEqual(normalizeModelId('OFF'), 'off');
  assert.strictEqual(profanitySignature(ctx, true, { model: 'off' }), profanitySignature(ctx, true));
  assert.strictEqual(profanitySignature(ctx, false, { model: DEFAULT_MODEL_ID }), 'off');

  const goldenInputs = [
    'Bu siktir hata yüzünden sıkıntı yaşadık.',
    'Ankara ve İstanbul toplantısı saat 10.00’da başladı.\nDetaylar index.js içinde.',
    'Sence bu v1.7.2 sürümü 0.8 eşiğiyle iyi mi?',
  ];
  const baseFilter = createFilter({ useUserList: false });
  const stageFilter = createFilter({ useUserList: false, model: 'off', threshold: 0.8 });

  for (const input of goldenInputs) {
    assert.deepStrictEqual(stageFilter.mask(input), baseFilter.mask(input));
    const prepared = await stageFilter.prepare({ title: input, messages: [{ role: 'user', text: input }] });
    assert.strictEqual(prepared.flaggedCount, 0);
    assert.deepStrictEqual(prepared.mask(input), baseFilter.mask(input));
  }
});

test('splitSentences splits sentences cleanly without breaking versions, decimals, or filenames', function () {
  const text = 'Sürüm v1.7.2 çıktı. Eşik 0.8 olarak ayarlandı!\nDosya index.js içinde? Evet… Tamam.';
  const spans = splitSentences(text);
  assert.deepStrictEqual(
    spans.map((s) => s.text),
    ['Sürüm v1.7.2 çıktı.', 'Eşik 0.8 olarak ayarlandı!', 'Dosya index.js içinde?', 'Evet…', 'Tamam.'],
  );
  for (const s of spans) {
    assert.strictEqual(text.slice(s.start, s.end), s.text);
  }
});

test('K2: classifyOffensive and createFilter.prepare mask only sentences at/above threshold', async function () {
  const seen = [];
  const fakeClassifier = async function (texts) {
    seen.push(...texts);
    return texts.map((t) => {
      if (t.includes('sen tam bir beceriksizsin')) return { score: 0.92 };
      if (t.includes('sınırda cümle')) return { score: 0.8 };
      if (t.includes('az kalsın')) return { score: 0.79 };
      return { score: 0.05 };
    });
  };

  const direct = await classifyOffensive(['Temiz cümle.', 'Bence sen tam bir beceriksizsin.'], {
    classifier: fakeClassifier,
  });
  assert.strictEqual(direct.length, 2);
  assert.ok(direct[0].score < 0.8);
  assert.ok(direct[1].score >= 0.8);

  const filter = createFilter({
    useUserList: false,
    model: DEFAULT_MODEL_ID,
    threshold: 0.8,
    classifier: fakeClassifier,
  });

  const conv = {
    title: 'Normal başlık',
    messages: [
      {
        role: 'user',
        text: 'Merhaba, bugün sıkıntı yok. Bu siktir bugı çözelim. Bence sen tam bir beceriksizsin! Ama yine de sınırda cümle.\nAz kalsın gidiyordu.',
      },
      {
        role: 'assistant',
        text: 'Logları kontrol edelim.',
      },
    ],
  };

  const prep = await filter.prepare(conv);
  assert.strictEqual(prep.flaggedCount, 2);
  // Stage-1 word list runs first so the classifier does not see raw "siktir"
  assert.ok(!seen.some((s) => /\bsiktir\b/i.test(s)), 'stage-1 word list must run before classifier');

  const maskedMsg = prep.mask(conv.messages[0].text);
  assert.strictEqual(maskedMsg.text, 'Merhaba, bugün sıkıntı yok. Bu […] bugı çözelim. […] […]\nAz kalsın gidiyordu.');
  assert.strictEqual(maskedMsg.modelCount, 2);
  assert.strictEqual(maskedMsg.count, 3);

  const cleanMsg = prep.mask(conv.messages[1].text);
  assert.strictEqual(cleanMsg.text, 'Logları kontrol edelim.');
  assert.strictEqual(cleanMsg.count, 0);
  assert.strictEqual(cleanMsg.modelCount, 0);
});

test('profanitySignature changes on model id, model hash, and threshold, and stays stable on fallback/off', function (t) {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = { configDir: dir };

  const base = profanitySignature(ctx, true);
  assert.strictEqual(profanitySignature(ctx, true, { model: 'off' }), base);
  assert.strictEqual(profanitySignature(ctx, true, { model: DEFAULT_MODEL_ID, fallback: true }), base);

  const s1 = profanitySignature(ctx, true, { model: DEFAULT_MODEL_ID, modelHash: 'abc1', threshold: 0.8 });
  const s2 = profanitySignature(ctx, true, { model: DEFAULT_MODEL_ID, modelHash: 'abc1', threshold: 0.6 });
  const s3 = profanitySignature(ctx, true, { model: DEFAULT_MODEL_ID, modelHash: 'abc2', threshold: 0.8 });
  const s4 = profanitySignature(ctx, true, {
    model: 'onnx-community/content-safety-guard-small-ONNX',
    modelHash: 'abc1',
    threshold: 0.8,
  });

  assert.notStrictEqual(s1, base);
  assert.notStrictEqual(s1, s2);
  assert.notStrictEqual(s1, s3);
  assert.notStrictEqual(s1, s4);
});

test('K4: inference makes zero network calls and source files contain no URLs or network imports', async function (t) {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = { configDir: dir };

  // Install fake local weights via injectable hooks
  await installModel(ctx, DEFAULT_MODEL_ID, {
    installRuntimeFn: async ({ dir: rtDir }) => {
      fs.mkdirSync(rtDir, { recursive: true });
      fs.writeFileSync(path.join(rtDir, 'package.json'), '{"name":"rt"}\n');
    },
    downloadModelFn: async ({ weightsRoot, entry }) => {
      const mDir = path.join(weightsRoot, ...entry.id.split('/'), entry.subfolder);
      fs.mkdirSync(mDir, { recursive: true });
      fs.writeFileSync(path.join(mDir, entry.modelFile), 'onnx-weights');
    },
  });

  // Monkeypatch http, https, net, and fetch to throw if anything attempts network I/O
  const origHttpReq = http.request;
  const origHttpsReq = https.request;
  const origNetConnect = net.connect;
  const origNetCreate = net.createConnection;
  const origFetch = globalThis.fetch;

  const failNet = () => {
    throw new Error('network access forbidden during inference');
  };
  http.request = failNet;
  https.request = failNet;
  net.connect = failNet;
  net.createConnection = failNet;
  globalThis.fetch = failNet;
  t.after(() => {
    http.request = origHttpReq;
    https.request = origHttpsReq;
    net.connect = origNetConnect;
    net.createConnection = origNetCreate;
    globalThis.fetch = origFetch;
  });

  const clf = await loadLocalClassifier(ctx, DEFAULT_MODEL_ID, {
    runtimeLoader: async ({ manifest }) => {
      assert.strictEqual(manifest.id, DEFAULT_MODEL_ID);
      return async (texts) =>
        texts.map((text) => ({
          score: text.includes('rezil') ? 0.91 : 0.02,
        }));
    },
  });
  const filter = createFilter({
    useUserList: false,
    model: DEFAULT_MODEL_ID,
    threshold: 0.8,
    classifier: clf,
  });
  const prep = await filter.prepare({
    title: 'Konu',
    messages: [{ role: 'user', text: 'Selam. Sen tam bir rezil insansın.' }],
  });
  assert.strictEqual(prep.mask('Selam. Sen tam bir rezil insansın.').text, 'Selam. […]');

  // Static check: src/profanity.js and src/profanity-model.js must contain no URLs or network modules
  for (const rel of ['../src/profanity.js', '../src/profanity-model.js']) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!/https?:\/\//i.test(src), rel + ' must not contain any http(s) URL');
    assert.ok(!/from\s+['"](?:http|https|net)['"]/.test(src), rel + ' must not import http/https/net');
    assert.ok(!/\bfetch\s*\(/.test(src), rel + ' must not call fetch()');
  }
});

test('K6 & catalog: missing weights throw MODEL_NOT_INSTALLED, catalog satisfies license/size rules, install/remove lifecycle works', async function (t) {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = { configDir: dir };

  assert.ok(MODEL_CATALOG.length >= 2);
  for (const entry of MODEL_CATALOG) {
    assert.strictEqual(typeof entry.license, 'string', entry.id + ' must declare license string');
    assert.ok(
      PERMISSIVE_LICENSES.includes(entry.license),
      entry.id + ' must have permissive license (MIT/Apache-2.0/BSD)',
    );
    assert.strictEqual(typeof entry.approxSizeMB, 'number', entry.id + ' must declare numeric approxSizeMB');
    assert.ok(entry.approxSizeMB > 0 && entry.approxSizeMB < 500, entry.id + ' must be under 500 MB');
    assert.strictEqual(typeof entry.source, 'string', entry.id + ' must declare source');
    assert.match(entry.source, /^huggingface\.co\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
    assert.ok(entry.source.endsWith('/' + entry.id), entry.id + ' source must reference its repo id');
    assert.ok(typeof entry.metrics === 'string' && entry.metrics.length > 0, entry.id + ' must declare metrics');
  }

  assert.strictEqual(resolveCatalogModel('multilingual-toxicity-small').id, 'Horizon-Labs/multilingual-toxicity-small');
  assert.strictEqual(resolveCatalogModel(DEFAULT_MODEL_ID).id, DEFAULT_MODEL_ID);
  assert.strictEqual(resolveCatalogModel('unknown/does-not-exist'), null);

  assert.strictEqual(isRuntimeInstalled(ctx), false);
  assert.strictEqual(getInstalledModel(ctx, DEFAULT_MODEL_ID), null);
  assert.deepStrictEqual(listInstalledModels(ctx), []);

  await assert.rejects(
    () => loadLocalClassifier(ctx, DEFAULT_MODEL_ID),
    (err) => err && err.code === 'MODEL_NOT_INSTALLED',
  );

  // scoreFromOutputs handles multi-label arrays and single objects
  assert.strictEqual(
    scoreFromOutputs(
      [
        { label: 'toxicity', score: 0.87 },
        { label: 'insult', score: 0.41 },
      ],
      ['toxicity', 'insult'],
    ).score,
    0.87,
  );
  assert.strictEqual(scoreFromOutputs({ label: 'neutral', score: 0.75 }, ['toxic']).score, 0.25);

  const planBefore = installPlan(ctx, 'multilingual-toxicity-small');
  assert.strictEqual(planBefore.runtimeInstalled, false);
  assert.strictEqual(planBefore.modelInstalled, false);
  assert.strictEqual(planBefore.downloadSizeMB, planBefore.entry.approxSizeMB + RUNTIME_APPROX_MB);
  assert.ok(planBefore.dir.startsWith(weightsRootDir(ctx)));
  assert.ok(modelsRootDir(ctx).startsWith(dir));

  // Without injectable hooks under KEYFLIP_TEST_OFFLINE=1, installModel refuses network download
  const prevOffline = process.env.KEYFLIP_TEST_OFFLINE;
  process.env.KEYFLIP_TEST_OFFLINE = '1';
  try {
    await assert.rejects(() => installModel(ctx, DEFAULT_MODEL_ID), /offline/i);
  } finally {
    if (prevOffline === undefined) delete process.env.KEYFLIP_TEST_OFFLINE;
    else process.env.KEYFLIP_TEST_OFFLINE = prevOffline;
  }

  const res = await installModel(ctx, 'multilingual-toxicity-small', {
    installRuntimeFn: async ({ dir: rt }) => {
      fs.mkdirSync(path.join(rt, 'node_modules', '@huggingface', 'transformers'), { recursive: true });
      fs.writeFileSync(path.join(rt, 'package.json'), '{"name":"rt"}\n');
      fs.writeFileSync(path.join(rt, 'node_modules', '@huggingface', 'transformers', 'package.json'), '{"name":"x"}\n');
    },
    downloadModelFn: async ({ weightsRoot, entry }) => {
      const mDir = path.join(weightsRoot, ...entry.id.split('/'), entry.subfolder);
      fs.mkdirSync(mDir, { recursive: true });
      fs.writeFileSync(path.join(mDir, entry.modelFile), 'fake-onnx-data');
    },
  });
  assert.strictEqual(res.id, DEFAULT_MODEL_ID);
  assert.ok(res.hash && res.hash.length >= 8);
  assert.strictEqual(isRuntimeInstalled(ctx), true);
  assert.ok(fs.existsSync(manifestPath(ctx, DEFAULT_MODEL_ID)));
  assert.ok(fs.existsSync(runtimeDir(ctx)));

  const installed = getInstalledModel(ctx, 'multilingual-toxicity-small');
  assert.ok(installed);
  assert.strictEqual(installed.id, DEFAULT_MODEL_ID);
  assert.strictEqual(listInstalledModels(ctx).length, 1);

  // If the ONNX file is deleted on disk, getInstalledModel returns null
  const onnxPath = path.join(modelDir(ctx, DEFAULT_MODEL_ID), 'onnx', 'model_quantized.onnx');
  fs.rmSync(onnxPath);
  assert.strictEqual(getInstalledModel(ctx, DEFAULT_MODEL_ID), null);

  const removed = removeModel(ctx, DEFAULT_MODEL_ID);
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(fs.existsSync(modelDir(ctx, DEFAULT_MODEL_ID)), false);
  assert.strictEqual(MASK_TOKEN, '[…]');
});
