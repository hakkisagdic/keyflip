'use strict';
// G6: a zero-dependency QR-code encoder, just enough to render the LAN-transfer pairing
// info (`keyflip://transfer?...`) so the other machine can scan instead of typing the code.
// Byte mode; ECC levels L/M; versions 1-10 (payloads are short). Follows ISO/IEC 18004.
// Every primitive (GF(256) arithmetic, Reed-Solomon, BCH format/version info) is verified
// against published constants in test/qr.test.js — a wrong QR is worse than none.

// ---- Galois field GF(256), primitive polynomial 0x11d (x^8+x^4+x^3+x^2+1) ----
const EXP = new Array(512);
const LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

// Reed-Solomon generator polynomial of the given degree (coefficients, high->low).
function rsGenerator(degree) {
  let poly = [1];
  for (let d = 0; d < degree; d++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= gfMul(poly[i], EXP[d]);
      next[i + 1] ^= poly[i];
    }
    poly = next;
  }
  return poly;
}
// EC codewords for `data` (array of bytes) with `ecLen` error-correction codewords.
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.shift();
    res.push(0);
    if (factor !== 0) {
      const lf = LOG[factor];
      // gen is stored low->high (gen[ecLen]=leading 1); the division needs the non-leading
      // coefficients high->low, i.e. gen[ecLen-1-j].
      for (let j = 0; j < ecLen; j++) res[j] ^= EXP[lf + LOG[gen[ecLen - 1 - j]]];
    }
  }
  return res;
}

// ---- error-correction block layout: ECB[level][version] = { ec, groups:[[nBlocks,dataCw]...] }
// Levels L and M, versions 1-10 (ISO/IEC 18004 Table 9). Index [0]=unused.
const ECB = {
  L: [null,
    { ec: 7, groups: [[1, 19]] }, { ec: 10, groups: [[1, 34]] }, { ec: 15, groups: [[1, 55]] },
    { ec: 20, groups: [[1, 80]] }, { ec: 26, groups: [[1, 108]] }, { ec: 18, groups: [[2, 68]] },
    { ec: 20, groups: [[2, 78]] }, { ec: 24, groups: [[2, 97]] }, { ec: 30, groups: [[2, 116]] },
    { ec: 18, groups: [[2, 68], [2, 69]] }],
  M: [null,
    { ec: 10, groups: [[1, 16]] }, { ec: 16, groups: [[1, 28]] }, { ec: 26, groups: [[1, 44]] },
    { ec: 18, groups: [[2, 32]] }, { ec: 24, groups: [[2, 43]] }, { ec: 16, groups: [[4, 27]] },
    { ec: 18, groups: [[4, 31]] }, { ec: 22, groups: [[2, 38], [2, 39]] }, { ec: 22, groups: [[3, 36], [2, 37]] },
    { ec: 26, groups: [[4, 43], [1, 44]] }],
};
// Alignment-pattern centre coordinates per version (ISO Table E.1), versions 1-10.
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 }; // 2-bit level indicator for format info

function dataCapacity(level, version) {
  const g = ECB[level][version];
  let cw = 0;
  g.groups.forEach(function (grp) { cw += grp[0] * grp[1]; });
  return cw; // total DATA codewords (excludes EC)
}
function countBits(version) { return version < 10 ? 8 : 16; } // byte mode, versions 1-10

// Smallest version (>=minVersion) whose data capacity holds `byteLen` bytes in byte mode.
function pickVersion(level, byteLen, minVersion) {
  for (let v = Math.max(1, minVersion || 1); v <= 10; v++) {
    const bits = 4 + countBits(v) + 8 * byteLen;
    if (Math.ceil(bits / 8) <= dataCapacity(level, v)) return v;
  }
  return -1; // too big for the supported versions
}

// ---- bit buffer ----
function BitBuf() { this.bits = []; }
BitBuf.prototype.put = function (val, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1); };
BitBuf.prototype.toBytes = function () {
  const out = [];
  for (let i = 0; i < this.bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
    out.push(b);
  }
  return out;
};

// Encode text (UTF-8) into the full codeword stream (data + EC, interleaved) for a version.
function buildCodewords(bytes, level, version) {
  const cap = dataCapacity(level, version);
  const bb = new BitBuf();
  bb.put(0x4, 4);                       // byte mode indicator
  bb.put(bytes.length, countBits(version));
  bytes.forEach(function (b) { bb.put(b, 8); });
  // terminator (up to 4 zero bits) + pad to a byte boundary
  const totalBits = cap * 8;
  for (let i = 0; i < 4 && bb.bits.length < totalBits; i++) bb.bits.push(0);
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  const data = bb.toBytes();
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < cap; i++) data.push(pads[i % 2]);

  // split into blocks, compute EC per block
  const ecb = ECB[level][version];
  const blocks = [];
  let idx = 0;
  ecb.groups.forEach(function (grp) {
    for (let b = 0; b < grp[0]; b++) {
      const d = data.slice(idx, idx + grp[1]); idx += grp[1];
      blocks.push({ data: d, ec: rsEncode(d, ecb.ec) });
    }
  });
  // interleave data codewords, then EC codewords
  const maxData = Math.max.apply(null, blocks.map(function (b) { return b.data.length; }));
  const out = [];
  for (let i = 0; i < maxData; i++) blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
  for (let i = 0; i < ecb.ec; i++) blocks.forEach(function (b) { out.push(b.ec[i]); });
  return out;
}

// ---- BCH: format info (15 bits) and version info (18 bits) ----
function bch(data, gen, glen) {
  let d = data << (glen - 1);
  while (bitLen(d) >= glen) d ^= gen << (bitLen(d) - glen);
  return d;
}
function bitLen(x) { let n = 0; while (x) { n++; x >>>= 1; } return n; }
function formatInfo(level, mask) {
  const data = (ECC_BITS[level] << 3) | mask;      // 5 bits: 2 ecc + 3 mask
  return ((data << 10) | bch(data, 0x537, 11)) ^ 0x5412; // 15-bit BCH, XOR mask
}
function versionInfo(version) { return (version << 12) | bch(version, 0x1f25, 13); } // 18-bit

// ---- matrix construction ----
function buildMatrix(version, level, codewords, mask) {
  const size = version * 4 + 17;
  const m = []; const reserved = [];
  for (let r = 0; r < size; r++) { m.push(new Array(size).fill(0)); reserved.push(new Array(size).fill(false)); }
  function set(r, c, v) { m[r][c] = v ? 1 : 0; reserved[r][c] = true; }

  // finder patterns + separators at 3 corners
  function finder(r0, c0) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6)) || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      set(rr, cc, on);
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // timing patterns
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // alignment patterns
  const ac = ALIGN[version];
  for (let i = 0; i < ac.length; i++) for (let j = 0; j < ac.length; j++) {
    const r0 = ac[i], c0 = ac[j];
    if ((r0 <= 7 && c0 <= 7) || (r0 <= 7 && c0 >= size - 8) || (r0 >= size - 8 && c0 <= 7)) continue; // overlaps a finder
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      set(r0 + r, c0 + c, on);
    }
  }
  // dark module
  set(size - 8, 8, 1);
  // reserve format-info areas (filled after masking)
  for (let i = 0; i < 9; i++) { if (!reserved[8][i]) reserved[8][i] = true; if (!reserved[i][8]) reserved[i][8] = true; }
  for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  // reserve version-info areas (v>=7)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; }
  }

  // place data with the zigzag walk, applying the mask on the fly
  let bitIdx = 0;
  const bitAt = function (i) { return (codewords[i >> 3] >> (7 - (i & 7))) & 1; };
  const totalBits = codewords.length * 8;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        let dark = bitIdx < totalBits ? bitAt(bitIdx) : 0;
        bitIdx++;
        if (maskFn(mask, row, cc)) dark ^= 1;
        m[row][cc] = dark;
      }
    }
    up = !up;
  }

  // format info, both copies, in the exact module sequence a decoder expects (ISO §8.9).
  const fmt = formatInfo(level, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    // vertical copy down column 8 (top block skips the timing row; then the bottom block)
    if (i < 6) m[i][8] = bit; else if (i < 8) m[i + 1][8] = bit; else m[size - 15 + i][8] = bit;
    // horizontal copy along row 8 (right block; the dark-module row is untouched; then left)
    if (i < 8) m[8][size - 1 - i] = bit; else if (i === 8) m[8][7] = bit; else m[8][14 - i] = bit;
  }
  // version info (v>=7)
  if (version >= 7) {
    const vi = versionInfo(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vi >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[r][size - 11 + c] = bit;
      m[size - 11 + c][r] = bit;
    }
  }
  return m;
}

function maskFn(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
  return false;
}

// ---- mask penalty (ISO 18004 §8.8.2) to choose the best mask ----
function penalty(m) {
  const n = m.length; let score = 0;
  // rule 1: runs of >=5 same-colour modules in row/col
  for (let r = 0; r < n; r++) for (let axis = 0; axis < 2; axis++) {
    let run = 1, prev = -1;
    for (let c = 0; c < n; c++) {
      const v = axis === 0 ? m[r][c] : m[c][r];
      if (v === prev) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
      else { run = 1; prev = v; }
    }
  }
  // rule 2: 2x2 blocks of same colour
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // rule 3: finder-like 1011101 (x0000) patterns in rows/cols
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const rpat = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) for (let c = 0; c <= n - 11; c++) {
    if (matches(m, r, c, pat, true) || matches(m, r, c, rpat, true)) score += 40;
    if (matches(m, c, r, pat, false) || matches(m, c, r, rpat, false)) score += 40;
  }
  // rule 4: proportion of dark modules
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  const ratio = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}
function matches(m, r, c, pat, horiz) {
  for (let i = 0; i < pat.length; i++) { const v = horiz ? m[r][c + i] : m[r + i][c]; if (v !== pat[i]) return false; }
  return true;
}

// ---- public API ----
// encode(text, {ecc:'L'|'M', minVersion}) -> { version, size, ecc, mask, modules: number[][] (1=dark) }
function encode(text, opts) {
  opts = opts || {};
  const level = opts.ecc === 'L' ? 'L' : 'M';
  const bytes = Array.prototype.slice.call(Buffer.from(String(text), 'utf8'));
  const version = pickVersion(level, bytes.length, opts.minVersion);
  if (version < 0) throw new Error('payload too large for a version-1..10 QR (' + bytes.length + ' bytes)');
  const cw = buildCodewords(bytes, level, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(version, level, cw, mask);
    const p = penalty(m);
    if (!best || p < best.p) best = { p: p, m: m, mask: mask };
  }
  return { version: version, size: best.m.length, ecc: level, mask: best.mask, modules: best.m };
}

// Render a QR to text using Unicode half-blocks (each row of text = 2 module rows) + a
// quiet zone. `dark`/`light` let a caller invert for a light terminal.
function toText(qr, opts) {
  opts = opts || {};
  const q = opts.quiet == null ? 2 : opts.quiet;
  const m = qr.modules, n = m.length;
  const at = function (r, c) { return (r >= 0 && r < n && c >= 0 && c < n) ? m[r][c] : 0; };
  const D = opts.invert ? ' ' : '', L = opts.invert ? '' : ' ';
  const lines = [];
  for (let r = -q; r < n + q; r += 2) {
    let line = '';
    for (let c = -q; c < n + q; c++) {
      const top = at(r, c), bot = (r + 1 < n + q) ? at(r + 1, c) : 0;
      // in a light-background terminal a dark module should be a filled block
      const t = opts.invert ? !top : top, b = opts.invert ? !bot : bot;
      line += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  encode: encode, toText: toText,
  // exposed for tests:
  gfMul: gfMul, rsGenerator: rsGenerator, rsEncode: rsEncode,
  formatInfo: formatInfo, versionInfo: versionInfo, pickVersion: pickVersion,
  dataCapacity: dataCapacity, buildCodewords: buildCodewords, penalty: penalty,
};
