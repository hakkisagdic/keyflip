// Regenerates the container-v3 vectors. Fixed bytes, made-up passphrase, no real data.
//   node test/vectors/container-v3/generate.mjs
// Passphrase for every encrypted vector: PASSPHRASE below (also in test/migrate-v3.test.js).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as container from '../../../src/migrate-container.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PASSPHRASE = 'example-vector-passphrase';

function fixedRandom(seed) {
  let n = 0;
  return function (len) {
    return crypto
      .createHash('sha256')
      .update(seed + ':' + n++)
      .digest()
      .subarray(0, len);
  };
}

const TX = [
  { project: 'example-project', sessionId: 'session-one', text: 'first transcript line\n' },
  { project: 'example-project', sessionId: 'session-two', text: 'second transcript line\n' },
];

function build(name, o) {
  const writer = container.createWriter({
    passphrase: o.plain ? null : PASSPHRASE,
    bundleId: 'vector-' + name,
    tool: 'keyflip',
    toolVersion: '1.6.1',
    createdAt: '2026-01-01T00:00:00.000Z',
    transcripts: TX.length,
    bytes: TX.reduce((n, t) => n + Buffer.byteLength(t.text), 0),
    randomBytes: fixedRandom(name),
    kdfN: o.kdfN,
  });
  const meta = {
    format: 'keyflip-migrate',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    accounts: [],
    providers: [],
    transcripts: [],
    memory: [{ rel: 'NOTES.md', content: 'vector notes\n' }],
    config: {},
    agents: [],
    agentConfig: [],
  };
  const out = [writer.headerText];
  out.push(writer.seal({ type: 'meta', data: meta, fromHome: '/home/alice', fromUser: 'alice' }));
  TX.forEach(function (t) {
    const buf = Buffer.from(t.text);
    out.push(writer.seal({ type: 'tx', project: t.project, sessionId: t.sessionId, bytes: buf.length }));
    out.push(writer.seal({ type: 'chunk', n: buf.length, data: buf.toString('base64') }));
    out.push(writer.seal({ type: 'tx-end' }));
  });
  out.push(
    writer.seal({
      type: 'end',
      transcripts: TX.length,
      bytes: TX.reduce((n, t) => n + Buffer.byteLength(t.text), 0),
      counts: {},
    }),
  );
  return out.join('').split('\n');
}

function save(name, lines) {
  fs.writeFileSync(path.join(dir, name), lines.join('\n'), { mode: 0o600 });
}
function flipChar(s, at) {
  const c = s[at];
  return s.slice(0, at) + (c === 'A' ? 'B' : 'A') + s.slice(at + 1);
}

const valid = build('valid', {});
save('valid.kf', valid);

// A byte flipped inside the ciphertext of a record in the SECOND transcript.
const rec = valid.slice();
const target = 6; // lines: 0 magic, 1 header, 2 meta, 3..5 first tx, 6 second tx start
const obj = JSON.parse(rec[target]);
obj.ct = flipChar(obj.ct, 4);
rec[target] = JSON.stringify(obj);
save('flipped-record.kf', rec);

// One character of the clear header changed (the bundle id).
const hdr = valid.slice();
hdr[1] = hdr[1].replace('vector-valid', 'vector-valie');
save('flipped-header.kf', hdr);

// The end record (and the newline after it) cut off.
save('truncated.kf', valid.slice(0, valid.length - 2));

save('plaintext.kf', build('plaintext', { plain: true }));
save('n14.kf', build('n14', { kdfN: 16384 }));
console.log('vectors written to ' + dir);
