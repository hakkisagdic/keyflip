// 1200×630 social card. Same wording and palette as public/og-image.svg.
// Drawn here because the site build has no SVG rasterizer; npm test and `prebuild` write the PNG.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const W = 1200;
const H = 630;

const BG0 = [0x1e, 0x1b, 0x4b];
const BG1 = [0x31, 0x2e, 0x81];
export const COLORS = {
  white: [0xff, 0xff, 0xff],
  sub: [0xc7, 0xd2, 0xfe],
  foot: [0x63, 0x66, 0xf1],
  accent: [0x81, 0x8c, 0xf8],
};

export const COPY = {
  title: 'keyflip',
  line1: 'Multi-account switcher',
  line2: 'for Claude Code & AI tools',
  footer: 'github.com/hakkisagdic/keyflip',
};

function glyph(rows) {
  if (rows.length !== 7 || rows.some((row) => !/^[01]{5}$/.test(row))) {
    throw new Error('glyph must be 7 rows of 5 bits');
  }
  return rows;
}

// Full-height title letters (no leading blank rows).
export const TITLE_FONT = {
  k: glyph(['10000', '10000', '10010', '10100', '11000', '10100', '10010']),
  e: glyph(['01111', '10000', '10000', '11110', '10000', '10000', '01111']),
  y: glyph(['10001', '10001', '01010', '00100', '00100', '00100', '00100']),
  f: glyph(['01111', '10000', '10000', '11100', '10000', '10000', '10000']),
  l: glyph(['10000', '10000', '10000', '10000', '10000', '10000', '11111']),
  i: glyph(['00100', '00000', '00100', '00100', '00100', '00100', '00100']),
  p: glyph(['11111', '10001', '10001', '11111', '10000', '10000', '10000']),
};

// 5×7 body font. Lowercase keeps a blank top so capitals share the baseline.
export const BODY_FONT = {
  ' ': glyph(['00000', '00000', '00000', '00000', '00000', '00000', '00000']),
  '-': glyph(['00000', '00000', '00000', '11111', '00000', '00000', '00000']),
  '.': glyph(['00000', '00000', '00000', '00000', '00000', '01100', '01100']),
  '/': glyph(['00001', '00010', '00010', '00100', '01000', '01000', '10000']),
  '&': glyph(['01100', '10010', '10100', '01000', '10101', '10010', '01101']),
  A: glyph(['01110', '10001', '10001', '11111', '10001', '10001', '10001']),
  C: glyph(['01110', '10001', '10000', '10000', '10000', '10001', '01110']),
  I: glyph(['11111', '00100', '00100', '00100', '00100', '00100', '11111']),
  M: glyph(['10001', '11011', '10101', '10001', '10001', '10001', '10001']),
  a: glyph(['00000', '00000', '01110', '00001', '01111', '10001', '01111']),
  b: glyph(['10000', '10000', '11110', '10001', '10001', '10001', '11110']),
  c: glyph(['00000', '00000', '01110', '10000', '10000', '10000', '01110']),
  d: glyph(['00001', '00001', '01111', '10001', '10001', '10001', '01111']),
  e: glyph(['00000', '00000', '01110', '10001', '11111', '10000', '01110']),
  f: glyph(['00111', '01000', '01000', '11110', '01000', '01000', '01000']),
  g: glyph(['00000', '01111', '10001', '10001', '01111', '00001', '01110']),
  h: glyph(['10000', '10000', '10110', '11001', '10001', '10001', '10001']),
  i: glyph(['00100', '00000', '00100', '00100', '00100', '00100', '00100']),
  k: glyph(['10000', '10000', '10010', '10100', '11000', '10100', '10010']),
  l: glyph(['00100', '00100', '00100', '00100', '00100', '00100', '00110']),
  m: glyph(['00000', '00000', '11010', '10101', '10101', '10001', '10001']),
  n: glyph(['00000', '00000', '10110', '11001', '10001', '10001', '10001']),
  o: glyph(['00000', '00000', '01110', '10001', '10001', '10001', '01110']),
  p: glyph(['00000', '11110', '10001', '10001', '11110', '10000', '10000']),
  r: glyph(['00000', '00000', '10110', '11001', '10000', '10000', '10000']),
  s: glyph(['00000', '00000', '01111', '10000', '01110', '00001', '11110']),
  t: glyph(['01000', '01000', '11110', '01000', '01000', '01001', '00110']),
  u: glyph(['00000', '00000', '10001', '10001', '10001', '10011', '01101']),
  w: glyph(['00000', '00000', '10001', '10001', '10101', '10101', '01010']),
  y: glyph(['00000', '10001', '10001', '01111', '00100', '01000', '10000']),
};

export function textWidth(text, scale) {
  if (text.length === 0) return 0;
  return text.length * 6 * scale - scale;
}

export function centeredX(text, scale) {
  return Math.floor((W - textWidth(text, scale)) / 2);
}

export const TITLE = { x: centeredX(COPY.title, 12), y: 210, scale: 12 };

export function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function renderRgb() {
  const rgb = Buffer.alloc(W * H * 3);
  function setPixel(x, y, color) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    rgb[i] = color[0];
    rgb[i + 1] = color[1];
    rgb[i + 2] = color[2];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x / (W - 1) + y / (H - 1)) / 2;
      setPixel(x, y, [
        Math.round(BG0[0] + (BG1[0] - BG0[0]) * t),
        Math.round(BG0[1] + (BG1[1] - BG0[1]) * t),
        Math.round(BG0[2] + (BG1[2] - BG0[2]) * t),
      ]);
    }
  }
  function fillRect(x, y, w, h, color) {
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) setPixel(x + xx, y + yy, color);
    }
  }
  function fillRing(cx, cy, outer, inner, color) {
    const outer2 = outer * outer;
    const inner2 = inner * inner;
    for (let y = cy - outer; y <= cy + outer; y++) {
      for (let x = cx - outer; x <= cx + outer; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = dx * dx + dy * dy;
        if (d <= outer2 && d >= inner2) setPixel(x, y, color);
      }
    }
  }
  function drawText(text, x, y, scale, color, font) {
    let cursor = x;
    for (let n = 0; n < text.length; n++) {
      const rows = font[text[n]];
      if (!rows) throw new Error('missing glyph for ' + JSON.stringify(text[n]));
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (rows[row][col] !== '1') continue;
          fillRect(cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
      cursor += 6 * scale;
    }
  }

  const accent = COLORS.accent;
  fillRing(640, 118, 54, 40, accent);
  fillRect(470, 100, 170, 36, accent);
  fillRect(488, 136, 18, 28, accent);
  fillRect(524, 136, 18, 36, accent);
  drawText(COPY.title, TITLE.x, TITLE.y, TITLE.scale, COLORS.white, TITLE_FONT);
  const barW = 280;
  fillRect(Math.floor((W - barW) / 2), 308, barW, 6, accent);
  const subScale = 5;
  drawText(COPY.line1, centeredX(COPY.line1, subScale), 336, subScale, COLORS.sub, BODY_FONT);
  drawText(COPY.line2, centeredX(COPY.line2, subScale), 384, subScale, COLORS.sub, BODY_FONT);
  const footScale = 3;
  drawText(COPY.footer, centeredX(COPY.footer, footScale), 560, footScale, COLORS.foot, BODY_FONT);
  return rgb;
}

export function renderOgImage() {
  const rgb = renderRgb();
  const stride = W * 3;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    rgb.copy(raw, row + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export function ogImagePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'og-image.png');
}

export function writeOgImage(file) {
  const png = renderOgImage();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return png;
}

function ranAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = path.resolve(fileURLToPath(import.meta.url));
  const arg = path.resolve(entry);
  return here === arg || here.toLowerCase() === arg.toLowerCase();
}

if (ranAsScript()) writeOgImage(ogImagePath());
