'use strict';
// Tests for the zero-dep QR encoder (src/qr.js). A wrong QR is worse than none, so we pin
// every primitive to published ISO/IEC 18004 constants AND round-trip a real payload back
// out of the rendered matrix (self-decode) to prove masking + placement + byte encoding.
const test = require('node:test');
const assert = require('node:assert');
const qr = require('../src/qr');

// ---- GF(256) + Reed-Solomon primitives ----
test('GF(256) multiply matches known values', function () {
  assert.strictEqual(qr.gfMul(0, 5), 0);
  assert.strictEqual(qr.gfMul(1, 5), 5);
  assert.strictEqual(qr.gfMul(2, 2), 4);
  assert.strictEqual(qr.gfMul(3, 7), 9);   // α^25 · α^198 = α^223 = 9
});

test('Reed-Solomon generator polynomials have the right shape + known small case', function () {
  // (x-α^0)(x-α^1) = x^2 + 3x + 2  (stored low->high, so [2,3,1] with a monic leading 1)
  assert.deepStrictEqual(qr.rsGenerator(2), [2, 3, 1]);
  assert.strictEqual(qr.rsGenerator(10).length, 11);
  assert.strictEqual(qr.rsGenerator(7).length, 8);
  assert.strictEqual(qr.rsGenerator(10)[10], 1, 'generator is monic (leading coeff 1)');
});

// Definitive RS check: (data · x^ec + EC) must be exactly divisible by the generator — that
// IS the property a scanner's error correction relies on. Independent GF poly division here.
test('rsEncode produces codewords divisible by the generator (valid Reed-Solomon)', function () {
  function remainder(msg, genHiLo) {
    const res = msg.slice();
    for (let i = 0; i <= msg.length - genHiLo.length; i++) {
      const coef = res[i];
      if (coef !== 0) for (let j = 0; j < genHiLo.length; j++) res[i + j] ^= qr.gfMul(genHiLo[j], coef);
    }
    return res.slice(res.length - (genHiLo.length - 1));
  }
  [[[0x10, 0x20, 0x0c, 0x56, 0x61, 0x80], 10], [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 16]].forEach(function (tc) {
    const data = tc[0], ecLen = tc[1];
    const ec = qr.rsEncode(data, ecLen);
    assert.strictEqual(ec.length, ecLen);
    const genHiLo = qr.rsGenerator(ecLen).slice().reverse(); // -> leading coeff 1 first
    const rem = remainder(data.concat(ec), genHiLo);
    assert.ok(rem.every(function (x) { return x === 0; }), 'message polynomial is divisible by the generator');
  });
});

// ---- BCH format + version information (canonical tables) ----
test('formatInfo matches the published 15-bit strings', function () {
  assert.strictEqual(qr.formatInfo('M', 0), 0x5412);
  assert.strictEqual(qr.formatInfo('M', 7), 0x4aa0);
  assert.strictEqual(qr.formatInfo('L', 0), 0x77c4);
  assert.strictEqual(qr.formatInfo('Q', 0), 0x355f);
  assert.strictEqual(qr.formatInfo('H', 0), 0x1689);
});

test('versionInfo matches the published 18-bit strings', function () {
  assert.strictEqual(qr.versionInfo(7), 0x07c94);
  assert.strictEqual(qr.versionInfo(10), 0x0a4d3);
});

// ---- capacity / version selection ----
test('pickVersion chooses the smallest version that fits (byte mode)', function () {
  assert.strictEqual(qr.pickVersion('M', 14, 1), 1);   // v1-M byte capacity = 14
  assert.strictEqual(qr.pickVersion('M', 15, 1), 2);   // spills to v2
  assert.strictEqual(qr.pickVersion('L', 17, 1), 1);   // v1-L capacity = 17
  assert.strictEqual(qr.pickVersion('M', 5000, 1), -1); // beyond v10
});

// ---- structure ----
test('encode produces a correctly-sized matrix with three finder patterns', function () {
  const q = qr.encode('keyflip', { ecc: 'M' });
  assert.strictEqual(q.size, q.version * 4 + 17);
  const m = q.modules;
  // a finder pattern is a 7x7 with a dark border + 3x3 dark centre; check all three corners
  function isFinder(r0, c0) {
    return m[r0][c0] === 1 && m[r0 + 6][c0] === 1 && m[r0][c0 + 6] === 1 &&
      m[r0 + 3][c0 + 3] === 1 && m[r0 + 1][c0 + 1] === 0 && m[r0 + 2][c0 + 2] === 1;
  }
  assert.ok(isFinder(0, 0), 'top-left finder');
  assert.ok(isFinder(0, q.size - 7), 'top-right finder');
  assert.ok(isFinder(q.size - 7, 0), 'bottom-left finder');
  // timing pattern alternates
  assert.strictEqual(m[6][8], m[6][10]);
  assert.notStrictEqual(m[6][8], m[6][9]);
  // the mandatory dark module
  assert.strictEqual(m[q.size - 8][8], 1);
});

// ---- end-to-end round-trip via a minimal self-decoder (single-block versions) ----
// Reverses the zigzag placement + mask to recover the interleaved codewords; for a
// single-block version those ARE the data codewords, so we can read mode+count+bytes back.
function selfDecode(q) {
  const m = q.modules, size = q.size;
  const reserved = reservedMask(q.version, size);
  function mask(r, c) {
    switch (q.mask) {
      case 0: return (r + c) % 2 === 0; case 1: return r % 2 === 0; case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0; case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0; case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }
  const bits = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        bits.push(m[row][cc] ^ (mask(row, cc) ? 1 : 0));
      }
    }
    up = !up;
  }
  const read = function (off, len) { let v = 0; for (let i = 0; i < len; i++) v = (v << 1) | bits[off + i]; return v; };
  const mode = read(0, 4);
  const cb = q.version < 10 ? 8 : 16;
  const len = read(4, cb);
  const out = [];
  for (let i = 0; i < len; i++) out.push(read(4 + cb + i * 8, 8));
  return { mode: mode, len: len, text: Buffer.from(out).toString('utf8') };
}
// Rebuild the reserved-area map the same way the encoder does (function/format/version zones).
function reservedMask(version, size) {
  const res = []; for (let r = 0; r < size; r++) res.push(new Array(size).fill(false));
  function block(r0, c0, r1, c1) { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r >= 0 && r < size && c >= 0 && c < size) res[r][c] = true; }
  block(0, 0, 7, 7); block(0, 8, 8, 8); block(8, 0, 8, 7);                 // TL finder + separators + format
  block(0, size - 8, 7, size - 1); block(8, size - 8, 8, size - 1);        // TR finder + separators + format
  block(size - 8, 0, size - 1, 7); block(size - 8, 8, size - 1, 8);        // BL finder + separators + format
  for (let i = 0; i < size; i++) { res[6][i] = true; res[i][6] = true; }   // timing
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][version];
  for (let i = 0; i < ALIGN.length; i++) for (let j = 0; j < ALIGN.length; j++) {
    const r0 = ALIGN[i], c0 = ALIGN[j];
    if ((r0 <= 7 && c0 <= 7) || (r0 <= 7 && c0 >= size - 8) || (r0 >= size - 8 && c0 <= 7)) continue;
    block(r0 - 2, c0 - 2, r0 + 2, c0 + 2);
  }
  if (version >= 7) { block(0, size - 11, 5, size - 9); block(size - 11, 0, size - 9, 5); }
  return res;
}

test('round-trip: a single-block QR self-decodes back to the exact payload (M, v<=3)', function () {
  ['x', 'keyflip', 'K7Q29FMR', 'host=10.0.0.9:8899;code=ABCD2345'].forEach(function (payload) {
    const q = qr.encode(payload, { ecc: 'M' });
    assert.ok(q.version <= 3, payload + ' should stay single-block (v<=3), got v' + q.version);
    const d = selfDecode(q);
    assert.strictEqual(d.mode, 0x4, 'byte mode indicator');
    assert.strictEqual(d.len, Buffer.byteLength(payload), 'char count');
    assert.strictEqual(d.text, payload, 'payload survives mask+placement round-trip');
  });
});

test('round-trip works with ECC level L too', function () {
  const q = qr.encode('keyflip://x', { ecc: 'L' });
  const d = selfDecode(q);
  assert.strictEqual(d.text, 'keyflip://x');
});

// Read the format info back from the matrix in the DECODER's reading order and confirm it
// equals the intended value. This is what a scanner does first; a wrong placement (the bug an
// independent decoder caught) makes this mismatch even when the data round-trip still passes.
test('format info is placed in the exact sequence a decoder reads (horizontal copy)', function () {
  ['M', 'L'].forEach(function (ecc) {
    const q = qr.encode('keyflip', { ecc: ecc });
    const m = q.modules, size = q.size;
    let fmt = 0;
    for (let i = 0; i < 15; i++) {
      let bit;
      if (i < 8) bit = m[8][size - 1 - i]; else if (i === 8) bit = m[8][7]; else bit = m[8][14 - i];
      fmt |= (bit << i);
    }
    assert.strictEqual(fmt, qr.formatInfo(q.ecc, q.mask), ecc + ': format info reads back correctly');
    // and the vertical copy must carry the identical value
    let fmt2 = 0;
    for (let i = 0; i < 15; i++) {
      let bit;
      if (i < 6) bit = m[i][8]; else if (i < 8) bit = m[i + 1][8]; else bit = m[size - 15 + i][8];
      fmt2 |= (bit << i);
    }
    assert.strictEqual(fmt2, fmt, 'both format-info copies agree');
  });
});

test('a realistic pairing payload encodes without error and picks a sane version', function () {
  const payload = 'keyflip://transfer?host=192.168.1.234:8899&code=K7Q29FMR&fp=A3F2';
  const q = qr.encode(payload, { ecc: 'M' });
  assert.ok(q.version >= 4 && q.version <= 7, 'multi-block version for ~63 bytes, got v' + q.version);
  assert.strictEqual(q.size, q.version * 4 + 17);
});

test('toText renders half-block rows with a quiet zone and never throws', function () {
  const q = qr.encode('keyflip', { ecc: 'M' });
  const txt = qr.toText(q, { quiet: 2 });
  const lines = txt.split('\n');
  assert.ok(lines.length >= Math.ceil((q.size + 4) / 2));
  assert.ok(/[█▀▄ ]/.test(txt));
  // the first and last lines are within the quiet zone (all spaces)
  assert.ok(/^ +$/.test(lines[0]), 'top quiet row is blank');
});

test('payload too large throws rather than emitting a broken QR', function () {
  assert.throws(function () { qr.encode('x'.repeat(500), { ecc: 'M' }); }, /too large/);
});
