// Tests for the zero-dep read-only SQLite reader (src/sqliteread.js). Fixtures are built with
// the sqlite3 CLI (skipped if it's not installed) so we validate against REAL SQLite files,
// including large values that spill onto overflow pages.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cp from 'child_process';
import * as sq from '../src/sqliteread.js';

let HAS_SQLITE = false;
try { cp.execFileSync('sqlite3', ['--version'], { stdio: 'ignore' }); HAS_SQLITE = true; } catch (e) { HAS_SQLITE = false; }

function mkdb(sql) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-sq-')), 'x.db');
  cp.execFileSync('sqlite3', [f], { input: sql });
  return fs.readFileSync(f);
}
function esc(s) { return String(s).replace(/'/g, "''"); }

test('readTable / readKV round-trip a small key/value table', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const buf = mkdb("CREATE TABLE cursorDiskKV(key TEXT, value TEXT);\n" +
    "INSERT INTO cursorDiskKV VALUES('a','one');\n" +
    "INSERT INTO cursorDiskKV VALUES('b','two');\n");
  const kv = sq.readKV(buf, 'cursorDiskKV');
  assert.strictEqual(kv.a, 'one');
  assert.strictEqual(kv.b, 'two');
  assert.strictEqual(Object.getPrototypeOf(kv), null, 'readKV returns a null-prototype map (proto-pollution safe)');
  assert.strictEqual(sq.readTable(buf, 'cursorDiskKV').length, 2);
});

test('large values round-trip via overflow pages (the reason we handle them)', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const big = 'x'.repeat(9000) + '|END';
  const buf = mkdb("CREATE TABLE kv(key TEXT, value TEXT);\n" +
    "INSERT INTO kv VALUES('big','" + esc(big) + "');\n" +
    "INSERT INTO kv VALUES('small','hi');\n");
  const kv = sq.readKV(buf, 'kv');
  assert.strictEqual(kv.big.length, big.length, 'the 9 KB value is not truncated');
  assert.ok(kv.big.slice(-4) === '|END', 'the tail of the overflowed value is intact');
  assert.strictEqual(kv.small, 'hi');
});

test('handles many rows spanning multiple B-tree leaf pages', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  let sql = 'CREATE TABLE t(key TEXT, value TEXT);\n';
  for (let i = 0; i < 500; i++) sql += "INSERT INTO t VALUES('k" + i + "','v" + i + "');\n";
  const rows = sq.readTable(mkdb(sql), 't');
  assert.strictEqual(rows.length, 500, 'all rows read across interior/leaf pages');
  const keys = rows.map(function (r) { return r[0]; });
  assert.ok(keys.indexOf('k0') !== -1 && keys.indexOf('k499') !== -1);
});

test('integer + null + blob serial types decode correctly', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const buf = mkdb("CREATE TABLE m(a INTEGER, b TEXT, c BLOB, d INTEGER);\n" +
    "INSERT INTO m VALUES(42, NULL, x'0102ff', -7);\n");
  const r = sq.readTable(buf, 'm')[0];
  assert.strictEqual(r[0], 42);
  assert.strictEqual(r[1], null);
  assert.ok(Buffer.isBuffer(r[2]) && r[2].length === 3 && r[2][2] === 0xff);
  assert.strictEqual(r[3], -7, 'negative integers decode (two’s complement)');
});

test('a missing table throws; a non-SQLite buffer throws', function (t) {
  if (!HAS_SQLITE) return t.skip('sqlite3 CLI not installed');
  const buf = mkdb('CREATE TABLE only(x TEXT);\n');
  assert.throws(function () { sq.readTable(buf, 'nope'); }, /no such table/);
  assert.throws(function () { sq.readTable(Buffer.from('not a database at all'), 'x'); }, /not a SQLite/);
});

// SECURITY (review P0): a hostile record header-size varint must not hang/OOM the parser.
test('parseRecord bounds an attacker-controlled header size (no hang/OOM)', function () {
  // header-size varint 0x8100 = 128, but the payload is only 3 bytes — must not spin to 128.
  const t0 = Date.now();
  const rec = sq.parseRecord(Buffer.from([0x81, 0x00, 0x09]));
  assert.ok(Date.now() - t0 < 50, 'returns immediately, not a billion-iteration hang');
  assert.ok(rec.length <= 3, 'type count is bounded by the actual payload length');
});
