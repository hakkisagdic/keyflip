// Social card: public/og-image.png is a real 1200×630 PNG, and every page head
// points og:image / twitter:image at an absolute URL taken from Astro's site.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import {
  BODY_FONT,
  COLORS,
  COPY,
  TITLE,
  TITLE_FONT,
  crc32,
  writeOgImage,
} from '../website/scripts/og-image.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngPath = path.join(root, 'website', 'public', 'og-image.png');
const layoutPath = path.join(root, 'website', 'src', 'layouts', 'BaseLayout.astro');
const probePath = path.join(root, 'website', 'public', '_byteprobe.bin');

if (fs.existsSync(probePath)) fs.unlinkSync(probePath);

const png = writeOgImage(pngPath);
const W = 1200;
const H = 630;

function ink(font, text) {
  let n = 0;
  for (const ch of text) {
    const rows = font[ch];
    assert.ok(rows, 'missing glyph ' + ch);
    for (const row of rows) {
      for (const bit of row) if (bit === '1') n += 1;
    }
  }
  return n;
}

function chunks(buf) {
  assert.ok(buf.length > 8);
  assert.deepStrictEqual(buf.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const out = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const stored = buf.readUInt32BE(offset + 8 + length);
    out.push({ type, data, crc: stored });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return out;
}

function pixelsOf(buf) {
  const parts = chunks(buf);
  const ihdr = parts.find((part) => part.type === 'IHDR');
  assert.ok(ihdr, 'IHDR');
  assert.strictEqual(ihdr.data.readUInt32BE(0), W);
  assert.strictEqual(ihdr.data.readUInt32BE(4), H);
  assert.strictEqual(ihdr.data[8], 8);
  assert.strictEqual(ihdr.data[9], 2);
  for (const part of parts) {
    const name = Buffer.from(part.type, 'ascii');
    assert.strictEqual(crc32(Buffer.concat([name, part.data])), part.crc, part.type + ' crc');
  }
  const idat = Buffer.concat(parts.filter((part) => part.type === 'IDAT').map((part) => part.data));
  const raw = zlib.inflateSync(idat);
  const stride = W * 3 + 1;
  assert.strictEqual(raw.length, stride * H);
  function at(x, y) {
    const i = y * stride + 1 + x * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  }
  let white = 0;
  let sub = 0;
  let foot = 0;
  let accent = 0;
  const subC = COLORS.sub;
  const footC = COLORS.foot;
  const accentC = COLORS.accent;
  for (let y = 0; y < H; y++) {
    assert.strictEqual(raw[y * stride], 0, 'filter');
    for (let x = 0; x < W; x++) {
      const p = at(x, y);
      if (p[0] === 255 && p[1] === 255 && p[2] === 255) white += 1;
      else if (p[0] === subC[0] && p[1] === subC[1] && p[2] === subC[2]) sub += 1;
      else if (p[0] === footC[0] && p[1] === footC[1] && p[2] === footC[2]) foot += 1;
      else if (p[0] === accentC[0] && p[1] === accentC[1] && p[2] === accentC[2]) accent += 1;
    }
  }
  return { at, white, sub, foot, accent };
}

function ogImageUrl(site) {
  const href = site.endsWith('/') ? site : site + '/';
  return new URL('og-image.png', href).href;
}

function metaContent(html, attr, name) {
  const tag = html.match(new RegExp('<meta\\b[^>]*\\b' + attr + '=["\']' + name + '["\'][^>]*>', 'i'));
  assert.ok(tag, attr + '=' + name);
  const content = tag[0].match(/\bcontent=["']([^"']+)["']/);
  assert.ok(content, name + ' content');
  return content[1];
}

test('crc32 matches the ISO HDLC check value', function () {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('og-image.png is a signed 1200x630 PNG', function () {
  const onDisk = fs.readFileSync(pngPath);
  assert.deepStrictEqual(onDisk, png);
  const parsed = chunks(onDisk);
  const ihdr = parsed.find((part) => part.type === 'IHDR');
  assert.strictEqual(ihdr.data.readUInt32BE(0), 1200);
  assert.strictEqual(ihdr.data.readUInt32BE(4), 630);
  assert.ok(fs.existsSync(path.join(root, 'website', 'public', 'og-image.svg')));
});

test('painted card is readable: title ink, subtitle, footer, and brand corners', function () {
  const view = pixelsOf(png);
  assert.deepStrictEqual(view.at(0, 0), [0x1e, 0x1b, 0x4b]);
  assert.deepStrictEqual(view.at(W - 1, H - 1), [0x31, 0x2e, 0x81]);
  assert.deepStrictEqual(COPY, {
    title: 'keyflip',
    line1: 'Multi-account switcher',
    line2: 'for Claude Code & AI tools',
    footer: 'github.com/hakkisagdic/keyflip',
  });
  assert.deepStrictEqual(TITLE_FONT.k, ['10000', '10000', '10010', '10100', '11000', '10100', '10010']);
  assert.strictEqual(ink(TITLE_FONT, COPY.title) * TITLE.scale * TITLE.scale, 12096);
  assert.strictEqual(view.white, 12096);
  assert.strictEqual(TITLE.x, 354);
  assert.strictEqual(TITLE.y, 210);
  assert.deepStrictEqual(view.at(TITLE.x, TITLE.y), [255, 255, 255]);
  const subScale = 5;
  assert.strictEqual(view.sub, ink(BODY_FONT, COPY.line1 + COPY.line2) * subScale * subScale);
  assert.ok(view.sub > 400);
  assert.strictEqual(view.foot, ink(BODY_FONT, COPY.footer) * 3 * 3);
  assert.ok(view.foot > 80);
  assert.ok(view.accent > 2000);
});

test('BaseLayout drops the og-image TODO and emits absolute image tags from site', function () {
  const layout = fs.readFileSync(layoutPath, 'utf8');
  const config = fs.readFileSync(path.join(root, 'website', 'astro.config.mjs'), 'utf8');
  assert.strictEqual(layout.includes('TODO'), false);
  assert.match(layout, /property="og:image"/);
  assert.match(layout, /name="twitter:image"/);
  assert.match(layout, /name="twitter:card"/);
  assert.match(layout, /new URL\('og-image\.png'/);
  assert.match(layout, /Astro\.site/);
  const site = config.match(/site:\s*'([^']+)'/);
  assert.ok(site, 'site setting');
  const expected = ogImageUrl(site[1]);
  assert.strictEqual(expected, 'https://hakkisagdic.github.io/keyflip/og-image.png');
  for (const rel of ['src/pages/index.astro', 'src/pages/tr/index.astro', 'src/pages/pricing.astro']) {
    const page = fs.readFileSync(path.join(root, 'website', rel), 'utf8');
    assert.match(page, /<BaseLayout\b/);
  }
});

test('built pages carry absolute og:image and twitter:image when dist exists', function () {
  const dist = path.join(root, 'website', 'dist');
  // The root gate runs npm test before the website build, so dist is often absent.
  // BaseLayout is checked above; this reads the real HTML once dist is present.
  if (!fs.existsSync(dist)) return;
  const config = fs.readFileSync(path.join(root, 'website', 'astro.config.mjs'), 'utf8');
  const site = config.match(/site:\s*'([^']+)'/);
  const expected = ogImageUrl(site[1]);
  const routes = {
    '/': ['index.html'],
    '/tr/': ['tr/index.html', 'tr.html'],
    '/pricing/': ['pricing/index.html', 'pricing.html'],
  };
  for (const names of Object.values(routes)) {
    const file = names.map((name) => path.join(dist, name)).find((candidate) => fs.existsSync(candidate));
    assert.ok(file, 'missing dist page ' + names.join(' or '));
    const html = fs.readFileSync(file, 'utf8');
    assert.strictEqual(metaContent(html, 'property', 'og:image'), expected);
    assert.strictEqual(metaContent(html, 'name', 'twitter:image'), expected);
    assert.strictEqual(html.includes('TODO'), false);
  }
});
