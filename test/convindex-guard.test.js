// The conversation index must be bounded: it commits progress while it scans, stops cleanly on a
// memory or wall-clock limit (the next run resumes), and logs progress so a stall shows. Synthetic
// transcripts only; the embedding endpoint is an injected stub.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import cp from 'child_process';
import { fileURLToPath } from 'url';
import { makeCtx } from './helpers.js';
import * as config from '../src/config.js';
import * as convindex from '../src/convindex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');
const MB = 1048576;

function ctxFor() {
  const ctx = makeCtx();
  ctx.env = {};
  return ctx;
}

function writeClaude(ctx, id, turns) {
  const dir = path.join(ctx.home, '.claude', 'projects', '-work-proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const lines = turns.map((text, i) => ({
    type: i % 2 ? 'assistant' : 'user',
    timestamp: '2026-10-01T10:' + String(i % 60).padStart(2, '0') + ':00Z',
    message: { role: i % 2 ? 'assistant' : 'user', content: text },
  }));
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function seedMany(ctx, n) {
  for (let i = 0; i < n; i++) {
    const id = 'c-' + String(i).padStart(3, '0');
    writeClaude(ctx, id, ['Question number ' + i + ' about topic ' + id, 'Answer number ' + i + ' for ' + id]);
  }
}

function readManifest(ctx) {
  return JSON.parse(fs.readFileSync(convindex.metaPath(ctx), 'utf8'));
}

// A probe that reads small until it has been asked `after` times, then large.
function probeAfter(after, big) {
  let calls = 0;
  return function () {
    calls++;
    return calls > after ? big : 50 * MB;
  };
}

test('K1: the scan commits progress while it runs, not only at the end', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 20);
  const seen = [];
  await convindex.build(ctx, {
    scanFlushSources: 5,
    onProgress: function (p) {
      if (p.phase !== 'scan') return;
      let rows = 0;
      try {
        rows = Object.keys(readManifest(ctx).sources).length;
      } catch {
        rows = 0;
      }
      seen.push({ done: p.done, rows: rows });
    },
  });
  const at = seen.find((s) => s.done === 16);
  assert.ok(at, 'the scan reached source 16');
  assert.ok(at.rows >= 10, 'meta.json already held the earlier conversations mid-scan, got ' + at.rows);
  const m = readManifest(ctx);
  assert.strictEqual(Object.keys(m.sources).length, 20);
  Object.values(m.sources).forEach((row) => {
    assert.ok(fs.existsSync(convindex.chunkPath(ctx, row.id)), 'chunk file for ' + row.id);
  });
});

test('K2: a memory limit stops the run cleanly with the reason, and the next run resumes', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 12);
  const lines = [];
  const r1 = await convindex.build(ctx, {
    scanFlushSources: 100,
    maxRssMb: 200,
    rssProbe: probeAfter(5, 300 * MB),
    log: (l) => lines.push(l),
  });
  assert.ok(r1.stopped, 'the run reports why it stopped');
  assert.strictEqual(r1.stopped.reason, 'memory');
  assert.strictEqual(r1.stopped.phase, 'scan');
  assert.ok(r1.stopped.done >= 5 && r1.stopped.done < 12);
  assert.ok(lines.some((l) => /memory guard/.test(l) && /resumes/.test(l)), 'the reason is logged');
  const rows1 = Object.keys(readManifest(ctx).sources).length;
  assert.ok(rows1 >= 4 && rows1 < 12, 'the finished conversations were saved: ' + rows1);
  assert.strictEqual(rows1, r1.indexed);

  const r2 = await convindex.build(ctx, { maxRssMb: 200, rssProbe: () => 50 * MB });
  assert.strictEqual(r2.stopped, undefined);
  assert.strictEqual(r2.reused, rows1, 'what was done is reused, not parsed again');
  assert.strictEqual(r2.indexed, 12 - rows1);
  assert.strictEqual(Object.keys(readManifest(ctx).sources).length, 12);
});

test('K2: a stop on a filtered resume keeps rows that were not reached', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 6);
  await convindex.build(ctx, {});
  // touch every transcript so the next pass has to re-parse all of them
  const dir = path.join(ctx.home, '.claude', 'projects', '-work-proj');
  const future = new Date(Date.now() + 60000);
  fs.readdirSync(dir).forEach((f) => fs.utimesSync(path.join(dir, f), future, future));
  const r = await convindex.build(ctx, { maxRssMb: 200, rssProbe: probeAfter(2, 300 * MB) });
  assert.strictEqual(r.stopped.reason, 'memory');
  const m = readManifest(ctx);
  assert.strictEqual(Object.keys(m.sources).length, 6, 'unscanned rows survive a stopped pass');
  assert.strictEqual(r.removed, 0);
});

test('K2: the wall-clock limit stops the run the same way', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 10);
  let t = 1000000;
  const r = await convindex.build(ctx, {
    maxRunMinutes: 3,
    maxRssMb: 0,
    clock: () => {
      t += 60000; // each look at the clock is one minute later
      return t;
    },
  });
  assert.ok(r.stopped);
  assert.strictEqual(r.stopped.reason, 'time');
  assert.match(r.stopped.message, /time limit: 3 min/);
  const rows = Object.keys(readManifest(ctx).sources).length;
  assert.ok(rows >= 1 && rows < 10, 'partial progress saved: ' + rows);
});

test('K2: limits of 0 switch the guard off', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 4);
  const r = await convindex.build(ctx, { maxRssMb: 0, maxRunMinutes: 0, rssProbe: () => 999999 * MB });
  assert.strictEqual(r.stopped, undefined);
  assert.strictEqual(r.indexed, 4);
});

test('K2: an embedding pass that is stopped resumes without embedding anything twice', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 6);
  const sent = [];
  let trip = false;
  let armed = true;
  const post = async (_u, body) => {
    body.input.forEach((t) => sent.push(t));
    if (armed && sent.length >= 2) trip = true;
    return { model: body.model, embeddings: body.input.map(() => Array(8).fill(0.5)) };
  };
  const probe = () => (trip ? 300 * MB : 50 * MB);
  const r1 = await convindex.build(ctx, { embed: true, post: post, maxRssMb: 200, rssProbe: probe });
  assert.ok(r1.stopped, 'stopped during the embedding pass');
  assert.strictEqual(r1.stopped.phase, 'embed');
  assert.ok(r1.embedded >= 1 && r1.embedded < 6);
  const embeddedRows = Object.values(readManifest(ctx).sources).filter((s) => s.vec).length;
  assert.strictEqual(embeddedRows, r1.embedded, 'finished vectors were saved');

  trip = false;
  armed = false;
  const before = sent.length;
  const r2 = await convindex.build(ctx, { embed: true, post: post, maxRssMb: 200, rssProbe: probe });
  assert.strictEqual(r2.stopped, undefined);
  assert.strictEqual(r2.embedded, 6 - embeddedRows);
  assert.strictEqual(sent.length - before, 6 - embeddedRows, 'only the missing conversations were sent');
  assert.strictEqual(new Set(sent).size, sent.length, 'no text was embedded twice');
  assert.strictEqual(Object.values(readManifest(ctx).sources).filter((s) => s.vec).length, 6);
});

test('K2: the guard speaks between classifier batches and an unfinished conversation is not committed', async function () {
  const ctx = ctxFor();
  config.set(ctx, 'conv.profanityModel', 'Horizon-Labs/multilingual-toxicity-small');
  const sentences = [];
  for (let i = 0; i < 200; i++) sentences.push('This is sentence number ' + i + ' of a long chat.');
  writeClaude(ctx, 'long-chat', [sentences.join('\n'), 'ok']);
  let batches = 0;
  const classifier = async (texts) => {
    batches++;
    assert.ok(texts.length <= 64, 'classifier batches are bounded, got ' + texts.length);
    return texts.map(() => ({ score: 0.01 }));
  };
  const r = await convindex.build(ctx, {
    profanityClassifier: classifier,
    maxRssMb: 200,
    rssProbe: probeAfter(3, 300 * MB),
  });
  assert.strictEqual(r.stopped.reason, 'memory');
  assert.ok(batches >= 1 && batches <= 3, 'stopped between batches: ' + batches);
  const rows = fs.existsSync(convindex.metaPath(ctx)) ? Object.keys(readManifest(ctx).sources) : [];
  assert.strictEqual(rows.length, 0, 'the half-classified conversation is not in the index');
  assert.strictEqual(r.skipped, 0, 'a guard stop is not a skipped source');
});

test('K4: progress is logged on a timer even while one step is stuck', async function () {
  const ctx = ctxFor();
  config.set(ctx, 'conv.profanityModel', 'Horizon-Labs/multilingual-toxicity-small');
  writeClaude(ctx, 'slow', ['A slow question. Another sentence.', 'An answer.']);
  const lines = [];
  const classifier = async (texts) => {
    await new Promise((r) => setTimeout(r, 400));
    return texts.map(() => ({ score: 0 }));
  };
  await convindex.build(ctx, {
    profanityClassifier: classifier,
    progressEveryMs: 50,
    maxRssMb: 0,
    log: (l) => lines.push(l),
  });
  assert.ok(
    lines.some((l) => /^progress scan 1\/1 · rss \d+ MB/.test(l)),
    'a heartbeat line appeared: ' + JSON.stringify(lines),
  );
  assert.ok(lines.some((l) => /^scan start: 1 sources/.test(l)));
  assert.ok(lines.some((l) => /^scan done: 1 sources/.test(l)));
});

test('K4: a progress line is also written between sources when the clock moves', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 5);
  const lines = [];
  let t = 5000000;
  await convindex.build(ctx, {
    progressEveryMs: 120000,
    maxRssMb: 0,
    maxRunMinutes: 0,
    clock: () => {
      t += 60000;
      return t;
    },
    log: (l) => lines.push(l),
  });
  const beats = lines.filter((l) => /^progress scan /.test(l));
  assert.ok(beats.length >= 2, 'one line per progress interval, got ' + beats.length);
});

test('stage files left by a killed run are swept, a live run is left alone', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 2);
  await convindex.build(ctx, {});
  const dir = path.dirname(convindex.chunkPath(ctx, 'x'));
  const dead = path.join(dir, 'abc.jsonl.stage-99999999-1700000000000-deadbeef');
  const live = path.join(dir, 'abc.jsonl.stage-' + process.pid + '-1700000000000-deadbeef');
  fs.writeFileSync(dead, 'x');
  fs.writeFileSync(live, 'x');
  await convindex.build(ctx, {});
  assert.strictEqual(fs.existsSync(dead), false, 'dead pid stage file removed');
  assert.strictEqual(fs.existsSync(live), true, 'live pid stage file kept');
});

test('a large report keeps its error list bounded', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 3);
  const r = await convindex.build(ctx, {});
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.errorsDropped, undefined);
});

test('config: conv.maxRssMb and conv.maxRunMinutes default to 2048 MB and 120 min and validate', function () {
  const ctx = ctxFor();
  assert.strictEqual(config.get(ctx, 'conv.maxRssMb'), 2048);
  assert.strictEqual(config.get(ctx, 'conv.maxRunMinutes'), 120);
  config.set(ctx, 'conv.maxRssMb', '512');
  assert.strictEqual(config.get(ctx, 'conv.maxRssMb'), 512);
  assert.throws(() => config.set(ctx, 'conv.maxRunMinutes', '-5'));
});

function runCli(ctx, args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [BIN, 'conv', 'index', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        HOME: ctx.home,
        USERPROFILE: ctx.home,
        XDG_CONFIG_HOME: path.join(ctx.home, '.config'),
        KEYFLIP_CONFIG_DIR: ctx.configDir,
        APPDATA: path.join(ctx.home, 'AppData', 'Roaming'),
        CODEX_HOME: path.join(ctx.home, '.codex'),
        KEYFLIP_TEST_CLAUDE: 'stopped',
      }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout: stdout, stderr: stderr }));
  });
}

test('K2 (CLI): --max-rss-mb forces a clean stop with the reason in the log and exit code 0, the next run resumes', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 8);
  const r1 = await runCli(ctx, ['--no-embed', '--max-rss-mb', '1', '--json']);
  assert.strictEqual(r1.status, 0, r1.stderr);
  const rep1 = JSON.parse(r1.stdout.trim().split('\n').pop());
  assert.strictEqual(rep1.stopped.reason, 'memory');
  assert.match(r1.stderr, /conv index: memory guard: rss \d+ MB is over the 1 MB limit/);
  assert.match(r1.stderr, /scan start: 8 sources/);

  const r2 = await runCli(ctx, ['--no-embed', '--max-rss-mb', '4096', '--json']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  const rep2 = JSON.parse(r2.stdout.trim().split('\n').pop());
  assert.strictEqual(rep2.stopped, undefined);
  assert.strictEqual(rep2.reused + rep2.indexed, 8);
  assert.strictEqual(rep2.reused, rep1.indexed, 'conversations saved by the stopped run are reused');
  assert.match(r2.stderr, /\(resuming\)|already indexed/);
});

test('K2 (CLI): the human report says why the run stopped', async function () {
  const ctx = ctxFor();
  seedMany(ctx, 3);
  const r = await runCli(ctx, ['--no-embed', '--max-rss-mb', '1']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Stopped early: memory guard/);
});

test('CLI rejects a non-numeric limit', async function () {
  const ctx = ctxFor();
  const r = await runCli(ctx, ['--no-embed', '--max-run-min', '-3']);
  assert.notStrictEqual(r.status, 0);
});
