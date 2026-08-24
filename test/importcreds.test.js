// IMPORT credentials from a .env file / environment. parseEnv + detect are pure;
// apply integrates with the real provider module over a hermetic makeCtx (temp
// configDir + in-memory store). The load-bearing invariant across all of it: a
// real key is NEVER present in any summary/returned value, only on the candidate
// object handed to provider.add.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as imp from '../src/importcreds.js';
import * as provider from '../src/provider.js';
import { makeCtx } from './helpers.js';
import * as _profiles from '../src/profiles.js';

// ---- parseEnv ---------------------------------------------------------------

test('parseEnv: basic KEY=VALUE, blanks and comments', function () {
  const v = imp.parseEnv('A=1\n\n# a comment\n   \nB=two');
  assert.strictEqual(v.A, '1');
  assert.strictEqual(v.B, 'two');
});

test('parseEnv: export prefix is stripped', function () {
  const v = imp.parseEnv('export FOO=bar\nexport   BAZ=qux');
  assert.strictEqual(v.FOO, 'bar');
  assert.strictEqual(v.BAZ, 'qux');
});

test('parseEnv: double quotes with escapes, single quotes literal', function () {
  const v = imp.parseEnv('A="hello world"\nB="line1\\nline2\\ttab"\nC=\'raw $x #nope\'');
  assert.strictEqual(v.A, 'hello world');
  assert.strictEqual(v.B, 'line1\nline2\ttab');
  assert.strictEqual(v.C, 'raw $x #nope'); // single quotes: no escape/comment processing
});

test('parseEnv: inline comments only after whitespace; # inside value kept', function () {
  const v = imp.parseEnv('A=bar # trailing comment\nB=bar#nocomment\nC="a # b" # after\nD=   # all comment');
  assert.strictEqual(v.A, 'bar');
  assert.strictEqual(v.B, 'bar#nocomment');
  assert.strictEqual(v.C, 'a # b'); // # inside quotes survives, trailing comment dropped
  assert.strictEqual(v.D, ''); // whole value was a comment
});

test('parseEnv: whitespace around key and value trimmed', function () {
  const v = imp.parseEnv('  K   =   v   ');
  assert.strictEqual(v.K, 'v');
});

test('parseEnv: malformed lines ignored, last duplicate wins', function () {
  const v = imp.parseEnv('NOEQUALS\n=noKey\n1BAD=x\nGOOD=ok\nGOOD=override');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(v, 'NOEQUALS'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(v, '1BAD'), false);
  assert.strictEqual(v.GOOD, 'override');
});

test('parseEnv: unterminated quote is malformed (ignored)', function () {
  const v = imp.parseEnv('A="oops\nB=fine');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(v, 'A'), false);
  assert.strictEqual(v.B, 'fine');
});

test('parseEnv: null-prototype map, no prototype pollution', function () {
  const v = imp.parseEnv('__proto__=polluted\nconstructor=nope\nnormal=ok');
  assert.strictEqual(Object.getPrototypeOf(v), null);
  assert.strictEqual({}.polluted, undefined, 'Object.prototype untouched');
  assert.strictEqual(v.normal, 'ok');
  assert.strictEqual(v.__proto__, 'polluted'); // stored as a plain own key
});

test('parseEnv: non-string / empty input is safe', function () {
  assert.deepStrictEqual(Object.keys(imp.parseEnv('')), []);
  assert.deepStrictEqual(Object.keys(imp.parseEnv(null)), []);
  assert.deepStrictEqual(Object.keys(imp.parseEnv(undefined)), []);
});

// ---- detect -----------------------------------------------------------------

test('detect: Anthropic base + auth token -> bearer provider', function () {
  const c = imp.detect(imp.parseEnv('ANTHROPIC_BASE_URL=https://relay.example.com/v1\nANTHROPIC_AUTH_TOKEN=tok-123'));
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'provider');
  assert.strictEqual(c[0].vendor, 'anthropic');
  assert.strictEqual(c[0].name, 'relay.example.com');
  assert.strictEqual(c[0].baseUrl, 'https://relay.example.com/v1');
  assert.strictEqual(c[0].authScheme, 'bearer');
  assert.strictEqual(c[0].key, 'tok-123');
  assert.deepStrictEqual(c[0].envKeys, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
});

test('detect: Anthropic base + api key (no token) -> api-key scheme', function () {
  const c = imp.detect({ ANTHROPIC_BASE_URL: 'https://gw.corp/api', ANTHROPIC_API_KEY: 'sk-ant-xyz' });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].authScheme, 'api-key');
  assert.strictEqual(c[0].key, 'sk-ant-xyz');
  assert.deepStrictEqual(c[0].envKeys, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']);
});

test('detect: base + both -> auth token wins (bearer)', function () {
  const c = imp.detect({ ANTHROPIC_BASE_URL: 'https://x.io', ANTHROPIC_AUTH_TOKEN: 'T', ANTHROPIC_API_KEY: 'K' });
  assert.strictEqual(c[0].authScheme, 'bearer');
  assert.strictEqual(c[0].key, 'T');
});

test('detect: bare Anthropic API key -> anthropic-key at official base', function () {
  const c = imp.detect({ ANTHROPIC_API_KEY: 'sk-ant-bare' });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].name, 'anthropic-key');
  assert.strictEqual(c[0].baseUrl, imp.ANTHROPIC_DEFAULT_BASE);
  assert.strictEqual(c[0].authScheme, 'api-key');
  assert.strictEqual(c[0].key, 'sk-ant-bare');
});

test('detect: bare Anthropic auth token -> anthropic-key bearer', function () {
  const c = imp.detect({ ANTHROPIC_AUTH_TOKEN: 'tk' });
  assert.strictEqual(c[0].name, 'anthropic-key');
  assert.strictEqual(c[0].authScheme, 'bearer');
  assert.strictEqual(c[0].key, 'tk');
});

test('detect: OpenAI key + base -> provider from host', function () {
  const c = imp.detect({ OPENAI_API_KEY: 'sk-oai', OPENAI_BASE_URL: 'https://api.groq.com/openai/v1' });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].vendor, 'openai');
  assert.strictEqual(c[0].name, 'api.groq.com');
  assert.strictEqual(c[0].baseUrl, 'https://api.groq.com/openai/v1');
  assert.strictEqual(c[0].authScheme, 'bearer');
  assert.strictEqual(c[0].key, 'sk-oai');
});

test('detect: OpenAI key without base -> default base, name openai', function () {
  const c = imp.detect({ OPENAI_API_KEY: 'sk-oai' });
  assert.strictEqual(c[0].name, 'openai');
  assert.strictEqual(c[0].baseUrl, imp.OPENAI_DEFAULT_BASE);
  assert.deepStrictEqual(c[0].envKeys, ['OPENAI_API_KEY']);
});

test('detect: multiple vendors in one env -> multiple candidates', function () {
  const c = imp.detect({
    ANTHROPIC_BASE_URL: 'https://relay.io',
    ANTHROPIC_AUTH_TOKEN: 'A',
    OPENAI_API_KEY: 'O',
  });
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(
    c.map(function (x) {
      return x.vendor;
    }),
    ['anthropic', 'openai'],
  );
});

test('detect: unparseable base URL falls back to a valid name', function () {
  const c = imp.detect({ ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_AUTH_TOKEN: 'A' });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].name, 'anthropic');
  const profiles = _profiles;
  assert.ok(profiles.isValidName(c[0].name));
});

test('detect: base with no credential yields nothing; blank values ignored', function () {
  assert.deepStrictEqual(imp.detect({ ANTHROPIC_BASE_URL: 'https://x.io' }), []);
  assert.deepStrictEqual(imp.detect({ ANTHROPIC_API_KEY: '   ' }), []);
});

test('detect: hostile / non-object input is safe', function () {
  assert.deepStrictEqual(imp.detect(null), []);
  assert.deepStrictEqual(imp.detect('nope'), []);
  assert.deepStrictEqual(imp.detect([1, 2, 3]), []);
  assert.deepStrictEqual(imp.detect({}), []);
});

// ---- redaction --------------------------------------------------------------

test('redactKey / summarize never reveal the real key', function () {
  const c = imp.detect({ ANTHROPIC_API_KEY: 'super-secret-value-123' });
  const s = imp.summarize(c);
  assert.strictEqual(s[0].key.indexOf('super-secret'), -1);
  assert.ok(/chars/.test(s[0].key));
  assert.strictEqual(JSON.stringify(s).indexOf('super-secret-value-123'), -1);
  assert.strictEqual(imp.redactKey(''), '(none)');
  assert.strictEqual(imp.redactKey(null), '(none)');
  // The candidate itself DOES retain the real key (for provider.add).
  assert.strictEqual(c[0].key, 'super-secret-value-123');
});

// ---- fromFile / fromEnv -----------------------------------------------------

test('fromFile: reads and detects, keeping the real key on the candidate', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-imp-'));
  const p = path.join(dir, '.env');
  fs.writeFileSync(p, 'ANTHROPIC_BASE_URL=https://relay.io\nANTHROPIC_AUTH_TOKEN="tok-real"\n');
  const r = imp.fromFile(makeCtx(), p);
  assert.strictEqual(r.path, p);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].key, 'tok-real');
});

test('fromFile: missing file throws a clear error', function () {
  assert.throws(function () {
    imp.fromFile(makeCtx(), '/no/such/dir/.env');
  }, /no env file at/);
});

test('fromFile: expands a leading ~/ against ctx.home', function () {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.home, '.env'), 'OPENAI_API_KEY=k\n');
  const r = imp.fromFile(ctx, '~/.env');
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].vendor, 'openai');
});

test('fromEnv: detects from a supplied environment object', function () {
  const r = imp.fromEnv(makeCtx(), { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://api.openai.com/v1' });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].name, 'api.openai.com');
});

// ---- apply (integration with provider.add) ----------------------------------

test('apply: persists provider meta to disk and the key to ctx.store', function () {
  const ctx = makeCtx();
  const { candidates } = imp.fromEnv(ctx, {
    ANTHROPIC_BASE_URL: 'https://relay.example.com',
    ANTHROPIC_AUTH_TOKEN: 'real-token',
  });
  const res = imp.apply(ctx, candidates);
  assert.strictEqual(res.imported.length, 1);
  const meta = provider.read(ctx, 'relay.example.com');
  assert.ok(meta, 'provider meta written');
  assert.strictEqual(meta.baseUrl, 'https://relay.example.com');
  assert.strictEqual(meta.authScheme, 'bearer');
  // key lands in the store under provider__<name>, not in meta on disk
  assert.strictEqual(ctx.store.getProfile('provider__relay.example.com'), 'real-token');
  assert.strictEqual(JSON.stringify(meta).indexOf('real-token'), -1, 'no secret in meta');
  // returned summary is redacted
  assert.strictEqual(JSON.stringify(res).indexOf('real-token'), -1, 'no secret in return value');
});

test('apply: round-trips multiple candidates via injected add fn', function () {
  const ctx = makeCtx();
  const calls = [];
  const { candidates } = imp.fromEnv(ctx, {
    ANTHROPIC_BASE_URL: 'https://a.io',
    ANTHROPIC_API_KEY: 'K1',
    OPENAI_API_KEY: 'K2',
  });
  const res = imp.apply(ctx, candidates, {
    add: function (c, name, opts) {
      calls.push({ name: name, opts: opts });
    },
  });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].name, 'a.io');
  assert.strictEqual(calls[0].opts.key, 'K1');
  assert.strictEqual(calls[0].opts.authScheme, 'api-key');
  assert.strictEqual(calls[1].name, 'openai');
  assert.strictEqual(calls[1].opts.key, 'K2');
  assert.strictEqual(res.imported.length, 2);
});

test('apply: skips malformed / non-provider candidates', function () {
  const ctx = makeCtx();
  const calls = [];
  const res = imp.apply(
    ctx,
    [
      { kind: 'provider', name: 'ok', baseUrl: 'https://ok.io', authScheme: 'bearer', key: 'k' },
      { kind: 'other', name: 'x', baseUrl: 'https://x.io' },
      { kind: 'provider', name: '', baseUrl: 'https://y.io' },
      { kind: 'provider', name: 'z' }, // no baseUrl
      null,
    ],
    {
      add: function (c, name) {
        calls.push(name);
      },
    },
  );
  assert.deepStrictEqual(calls, ['ok']);
  assert.strictEqual(res.imported.length, 1);
});

test('apply: empty / non-array candidates -> nothing imported', function () {
  const ctx = makeCtx();
  assert.deepStrictEqual(imp.apply(ctx, []).imported, []);
  assert.deepStrictEqual(imp.apply(ctx, null).imported, []);
});
