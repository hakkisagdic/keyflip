// Tests for the zero-dep SQLite WAL replayer (src/walmerge.js). Two layers:
//   1. GROUND TRUTH via the sqlite3 CLI (skipped if absent): a real DB in WAL mode with a
//      concurrent reader holding a snapshot so the writer's close cannot checkpoint the -wal
//      away — then we prove rows that live ONLY in the WAL surface after applyOverlay, and were
//      genuinely missing from the bare DB. This validates our checksum against real SQLite.
//   2. HAND-BUILT fixtures (a local WAL writer that computes the SAME running checksum) for the
//      cases sqlite3 won't hand us on demand: last-write-wins, uncommitted trailing frames, salt
//      mismatch, corrupt frames, big-endian checksums, file growth, and hostile/garbage input.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cp from 'child_process';
import * as wm from '../src/walmerge.js';
import * as sq from '../src/sqliteread.js';

let HAS_SQLITE = false;
try { cp.execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); HAS_SQLITE = true; } catch (e) { HAS_SQLITE = false; }

// ---- a reference WAL writer (mirrors the format walmerge.js reads) ---------------------------
function refChecksum(buf, start, nByte, bigEnd, s1, s2) {
  for (let i = 0; i < nByte; i += 8) {
    const w1 = bigEnd ? buf.readUInt32BE(start + i) : buf.readUInt32LE(start + i);
    const w2 = bigEnd ? buf.readUInt32BE(start + i + 4) : buf.readUInt32LE(start + i + 4);
    s1 = (s1 + w1 + s2) >>> 0;
    s2 = (s2 + w2 + s1) >>> 0;
  }
  return [s1, s2];
}
// opts: { pageSize, salt(Buffer 8), magic, badHeaderCksum, corruptFrame, frames:[{pgno,dbSize,data,salt}] }
function buildWal(opts) {
  const ps = opts.pageSize;
  const magic = opts.magic == null ? 0x377f0682 : opts.magic;
  const bigEnd = magic & 1;
  const salt = opts.salt || Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const header = Buffer.alloc(32);
  header.writeUInt32BE(magic >>> 0, 0);
  header.writeUInt32BE(3007000, 4);
  header.writeUInt32BE(ps, 8);
  header.writeUInt32BE(0, 12);
  salt.copy(header, 16);
  let [hs1, hs2] = refChecksum(header, 0, 24, bigEnd, 0, 0);
  if (opts.badHeaderCksum) hs1 = (hs1 ^ 0xffffffff) >>> 0;
  header.writeUInt32BE(hs1, 24);
  header.writeUInt32BE(hs2, 28);
  const parts = [header];
  let s1 = hs1, s2 = hs2; // running checksum seeds from the (computed) header checksum
  (opts.frames || []).forEach(function (f, idx) {
    const fh = Buffer.alloc(24);
    fh.writeUInt32BE(f.pgno >>> 0, 0);
    fh.writeUInt32BE((f.dbSize || 0) >>> 0, 4);
    (f.salt || salt).copy(fh, 8);
    [s1, s2] = refChecksum(fh, 0, 8, bigEnd, s1, s2);
    [s1, s2] = refChecksum(f.data, 0, ps, bigEnd, s1, s2);
    let c1 = s1, c2 = s2;
    if (opts.corruptFrame === idx) c1 = (c1 ^ 0xffffffff) >>> 0;
    fh.writeUInt32BE(c1, 16);
    fh.writeUInt32BE(c2, 20);
    parts.push(fh, f.data);
  });
  return Buffer.concat(parts);
}
function page(ps, fill) { return Buffer.alloc(ps, fill); }

// ---------------------------------------------------------------------------------------------

test('GROUND TRUTH: rows that live only in the -wal surface after applyOverlay', async function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-wal-'));
  const dbPath = path.join(dir, 't.db');
  let reader = null;
  try {
    cp.execFileSync('sqlite3', [dbPath], { input: "PRAGMA journal_mode=WAL;\nCREATE TABLE kv(key TEXT, value TEXT);\nINSERT INTO kv VALUES('seed','0');\n" });
    // a long-lived reader holds a read snapshot so the writer's close cannot reset the WAL
    reader = cp.spawn('sqlite3', [dbPath], { stdio: ['pipe', 'ignore', 'ignore'] });
    reader.stdin.write('PRAGMA busy_timeout=4000;\nPRAGMA journal_mode=WAL;\nBEGIN;\nSELECT count(*) FROM kv;\n');
    await new Promise(function (r) { setTimeout(r, 500); });
    cp.execFileSync('sqlite3', [dbPath], { input: "PRAGMA busy_timeout=4000;\nPRAGMA wal_autocheckpoint=0;\nINSERT INTO kv VALUES('alpha','1');\nINSERT INTO kv VALUES('beta','2');\n" });
    const db = fs.readFileSync(dbPath);
    let wal; try { wal = fs.readFileSync(dbPath + '-wal'); } catch (e) { wal = Buffer.alloc(0); }
    if (!wal.length) return t.skip('WAL was checkpointed before we could read it');
    const bare = sq.readKV(db, 'kv');
    if (('alpha' in bare) && ('beta' in bare)) return t.skip('DB got checkpointed; WAL replay not exercised');
    assert.ok(Object.keys(wm.overlay(wal)).length > 0, 'the WAL yields committed frames (checksums pass)');
    const kv = sq.readKV(wm.applyOverlay(db, wal), 'kv');
    assert.strictEqual(kv.alpha, '1', 'WAL-only row alpha is visible after overlay');
    assert.strictEqual(kv.beta, '2', 'WAL-only row beta is visible after overlay');
    assert.strictEqual(kv.seed, '0', 'the pre-existing committed row is preserved');
  } finally {
    if (reader) { try { reader.stdin.end(); } catch (e) {} try { reader.kill(); } catch (e) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});

test('overlay returns a null-prototype map of the committed pages', function () {
  const ps = 512;
  const wal = buildWal({ pageSize: ps, frames: [
    { pgno: 1, dbSize: 0, data: page(ps, 0x11) },
    { pgno: 2, dbSize: 2, data: page(ps, 0x22) }, // COMMIT: folds pages 1 and 2
  ] });
  const ov = wm.overlay(wal, ps);
  assert.strictEqual(Object.getPrototypeOf(ov), null, 'null-proto (proto-pollution safe)');
  assert.deepStrictEqual(Object.keys(ov).sort(), ['1', '2']);
  assert.ok(ov[1].every(function (b) { return b === 0x11; }));
  assert.ok(ov[2].every(function (b) { return b === 0x22; }));
});

test('only frames up to AND INCLUDING the last commit are applied (trailing txn dropped)', function () {
  const ps = 512;
  const wal = buildWal({ pageSize: ps, frames: [
    { pgno: 1, dbSize: 0, data: page(ps, 0xa1) },
    { pgno: 2, dbSize: 2, data: page(ps, 0xa2) }, // COMMIT of {1,2}
    { pgno: 3, dbSize: 0, data: page(ps, 0xb3) }, // uncommitted -> must NOT appear
  ] });
  const ov = wm.overlay(wal, ps);
  assert.deepStrictEqual(Object.keys(ov).sort(), ['1', '2'], 'uncommitted trailing frame excluded');
});

test('last write wins across successive commits', function () {
  const ps = 512;
  const wal = buildWal({ pageSize: ps, frames: [
    { pgno: 5, dbSize: 0, data: page(ps, 0x01) },
    { pgno: 5, dbSize: 5, data: page(ps, 0x02) }, // COMMIT (older content)
    { pgno: 5, dbSize: 5, data: page(ps, 0x03) }, // COMMIT (newest content wins)
  ] });
  const ov = wm.overlay(wal, ps);
  assert.strictEqual(ov[5][0], 0x03, 'the newest committed version of page 5 wins');
});

test('a salt mismatch stops the scan (older/checkpointed generation)', function () {
  const ps = 512;
  const wal = buildWal({ pageSize: ps, frames: [
    { pgno: 1, dbSize: 1, data: page(ps, 0x77) },                                   // COMMIT, matching salt
    { pgno: 2, dbSize: 2, data: page(ps, 0x88), salt: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]) }, // stale salt -> stop
  ] });
  const ov = wm.overlay(wal, ps);
  assert.deepStrictEqual(Object.keys(ov), ['1'], 'frames past the salt change are ignored');
});

test('a corrupt (bad-checksum) frame stops the scan; a bad header yields nothing', function () {
  const ps = 512;
  const corrupt = buildWal({ pageSize: ps, corruptFrame: 0, frames: [
    { pgno: 1, dbSize: 1, data: page(ps, 0x5a) },
  ] });
  assert.strictEqual(Object.keys(wm.overlay(corrupt, ps)).length, 0, 'first frame fails checksum -> empty');
  const badHdr = buildWal({ pageSize: ps, badHeaderCksum: true, frames: [
    { pgno: 1, dbSize: 1, data: page(ps, 0x5a) },
  ] });
  assert.strictEqual(Object.keys(wm.overlay(badHdr, ps)).length, 0, 'bad header checksum -> empty');
});

test('big-endian-checksum WAL (magic ...0683) is read correctly', function () {
  const ps = 1024;
  const wal = buildWal({ pageSize: ps, magic: 0x377f0683, frames: [
    { pgno: 3, dbSize: 3, data: page(ps, 0xee) },
  ] });
  const ov = wm.overlay(wal, ps);
  assert.deepStrictEqual(Object.keys(ov), ['3']);
  assert.strictEqual(ov[3][0], 0xee);
});

test('overlay infers page size from the WAL header when the arg is missing/bogus', function () {
  const ps = 2048;
  const wal = buildWal({ pageSize: ps, frames: [{ pgno: 1, dbSize: 1, data: page(ps, 0x42) }] });
  assert.deepStrictEqual(Object.keys(wm.overlay(wal)), ['1'], 'no arg -> header page size');
  assert.deepStrictEqual(Object.keys(wm.overlay(wal, 0)), ['1'], 'zero arg -> header page size');
  assert.deepStrictEqual(Object.keys(wm.overlay(wal, 999)), ['1'], 'non-power-of-two arg -> header page size');
  assert.strictEqual(Object.keys(wm.overlay(wal, 512)).length, 0, 'a valid but WRONG page size fails the checksum -> empty');
});

test('applyOverlay overlays pages and grows the file to the committed size', function () {
  const ps = 1024;
  const db = Buffer.alloc(2 * ps, 0xaa);
  db.writeUInt16BE(ps, 16); // DB-header page size so applyOverlay can size pages
  const wal = buildWal({ pageSize: ps, frames: [
    { pgno: 2, dbSize: 0, data: page(ps, 0xcc) },  // rewrite existing page 2
    { pgno: 4, dbSize: 4, data: page(ps, 0xdd) },  // COMMIT and grow the db to 4 pages
  ] });
  const merged = wm.applyOverlay(db, wal);
  assert.strictEqual(merged.length, 4 * ps, 'grew from 2 to 4 pages');
  assert.strictEqual(merged[0], 0xaa, 'page 1 preserved (bar the header field)');
  assert.strictEqual(merged[1 * ps], 0xcc, 'page 2 overlaid from the WAL');
  assert.strictEqual(merged[2 * ps], 0x00, 'page 3 zero-filled (not in the WAL)');
  assert.strictEqual(merged[3 * ps], 0xdd, 'page 4 written from the WAL');
});

test('SECURITY: a WAL declaring a huge page number cannot force a giant allocation (DoS cap)', function () {
  const ps = 1024;
  const db = Buffer.alloc(2 * ps, 0xaa);
  db.writeUInt16BE(ps, 16);
  // A ~1KB commit frame that CLAIMS page 250000 / db-size 250000 — unpatched this alloc'd ~256 MB.
  const wal = buildWal({ pageSize: ps, frames: [{ pgno: 250000, dbSize: 250000, data: page(ps, 0xee) }] });
  const merged = wm.applyOverlay(db, wal);
  const cap = (Math.ceil((db.length + wal.length) / ps) + 8) * ps;
  assert.ok(merged.length <= cap, 'output is bounded to the physical input size, not the declared page number (' + merged.length + ' <= ' + cap + ')');
  assert.ok(merged.length < 250000 * ps, 'did NOT allocate for the attacker-declared page count');
});

test('applyOverlay returns the DB unchanged when there is nothing to apply', function () {
  const ps = 1024;
  const db = Buffer.alloc(2 * ps, 0xaa);
  db.writeUInt16BE(ps, 16);
  assert.strictEqual(wm.applyOverlay(db, Buffer.from('not a wal at all, just junk')), db, 'garbage WAL -> same DB buffer');
  assert.strictEqual(wm.applyOverlay(db, Buffer.alloc(0)), db, 'empty WAL -> same DB buffer');
  assert.strictEqual(wm.applyOverlay(db, null), db, 'no WAL -> same DB buffer');
});

test('hostile / degenerate input never throws and yields an empty overlay', function () {
  assert.doesNotThrow(function () {
    assert.strictEqual(Object.keys(wm.overlay(null)).length, 0);
    assert.strictEqual(Object.keys(wm.overlay(undefined)).length, 0);
    assert.strictEqual(Object.keys(wm.overlay('a string')).length, 0);
    assert.strictEqual(Object.keys(wm.overlay(Buffer.alloc(0))).length, 0);
    assert.strictEqual(Object.keys(wm.overlay(Buffer.alloc(10))).length, 0);        // shorter than a header
    assert.strictEqual(Object.keys(wm.overlay(Buffer.alloc(64, 0xff))).length, 0);  // wrong magic
    assert.strictEqual(Object.keys(wm.overlay(Buffer.alloc(40, 0x00))).length, 0);  // zeroed / no valid header
  });
  // applyOverlay is equally defensive
  assert.doesNotThrow(function () {
    assert.strictEqual(wm.applyOverlay(null, Buffer.alloc(0)), null);
    assert.strictEqual(wm.applyOverlay(undefined, null), undefined);
  });
});

test('a WAL header with no frames yields an empty overlay', function () {
  const wal = buildWal({ pageSize: 1024, frames: [] });
  assert.strictEqual(Object.keys(wm.overlay(wal, 1024)).length, 0);
  assert.strictEqual(wal.length, 32, 'header only, no frame bytes');
});

test('a truncated final frame is ignored (only whole frames are read)', function () {
  const ps = 512;
  const wal = buildWal({ pageSize: ps, frames: [
    { pgno: 1, dbSize: 1, data: page(ps, 0x31) }, // COMMIT
  ] });
  const chopped = wal.subarray(0, wal.length - 100); // lop off part of the (only) frame's page data
  assert.strictEqual(Object.keys(wm.overlay(chopped, ps)).length, 0, 'incomplete trailing frame is not applied');
});
