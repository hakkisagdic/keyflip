'use strict';
// Adversarial tests for the PII detector/redactor (src/pii.js). The bar mirrors secretscan's:
// every category has a POSITIVE that redacts AND a NEGATIVE that must survive — with special
// emphasis on the checksum-validated categories (a wrong-checksum TCKN, a non-Luhn 16-digit
// number, a broken IBAN are NOT flagged). Also covers custom patterns loaded from a temp
// configDir, overlap resolution (no double-redact), counts, and the opt-in LLM hook with an
// INJECTED fake fetch (applies spans; no-op when url is unset or the fetch throws). No network,
// no clock — deterministic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pii = require('../src/pii');

function tmpCtx() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-pii-'));
  const configDir = path.join(home, '.config', 'keyflip');
  fs.mkdirSync(configDir, { recursive: true });
  return { configDir: configDir };
}
function labels(text, opts) { return pii.detect(text, opts).map(function (m) { return m.label; }); }
function redacted(text, opts) { return pii.scrub(text, opts).text; }

// ---- per-category positive + negative ---------------------------------------------------

test('email: positive redacts, negative survives', function () {
  const r = pii.scrub('reach me at john.doe+tag@sub.example.co.uk please');
  assert.strictEqual(r.counts.email, 1);
  assert.ok(r.text.indexOf('john.doe') === -1);
  assert.ok(r.text.indexOf('[REDACTED:email]') !== -1);
  assert.deepStrictEqual(labels('no address here, just an @ sign and words'), []);
});

test('phone: E.164 + Turkish mobile/landline positive; short number negative', function () {
  ['+14155552671', '+90 532 123 45 67', '0(532) 123 45 67', '0212 345 67 89', '05321234567'].forEach(function (num) {
    assert.ok(labels('call ' + num).indexOf('phone') !== -1, num + ' should be a phone');
  });
  assert.strictEqual(labels('code 12345 and year 2024').indexOf('phone'), -1);
});

test('tckn: valid checksum redacts; wrong checksum is NOT flagged', function () {
  assert.ok(labels('TC 10000000146').indexOf('tckn') !== -1);          // valid checksum
  assert.strictEqual(labels('TC 12345678901').indexOf('tckn'), -1);    // 11 digits, bad checksum
  assert.strictEqual(labels('TC 00000000000').indexOf('tckn'), -1);    // leading zero rejected
});

test('passport: uppercase alnum positive; lowercase look-alike negative', function () {
  assert.ok(labels('passport AB1234567', { categories: ['passport'] }).indexOf('passport') !== -1);
  assert.strictEqual(labels('ref ab1234567', { categories: ['passport'] }).indexOf('passport'), -1);
});

test('creditCard: Luhn-valid redacts (with spaces); non-Luhn 16-digit is NOT flagged', function () {
  assert.ok(labels('card 4111 1111 1111 1111').indexOf('creditCard') !== -1);
  assert.ok(labels('card 4111111111111111').indexOf('creditCard') !== -1);
  assert.strictEqual(labels('num 4111111111111112').indexOf('creditCard'), -1); // fails Luhn
  assert.strictEqual(labels('num 1234567890123456').indexOf('creditCard'), -1); // fails Luhn
});

test('creditCard: a valid card preceded by an IPv4 / lone digit / dash is STILL redacted (regression)', function () {
  // The old matcher anchored on a stray leading digit and ran Luhn over the over-match, so a real
  // card next to an IP or a small quantity leaked. Each of these must fully redact the card.
  ['192.168.1.1 4111111111111111', 'row 7 4111111111111111 total', '192.168.1.1 5555555555554444'].forEach(function (t) {
    const out = pii.scrub(t, {}).text;
    assert.ok(out.indexOf('4111111111111111') === -1 && out.indexOf('5555555555554444') === -1, 'card leaked in: ' + t);
    assert.ok(out.indexOf('[REDACTED:creditCard]') !== -1, 'card not redacted in: ' + t);
  });
});

test('iban: mod-97-valid redacts; broken checksum is NOT flagged', function () {
  assert.ok(labels('acct GB82WEST12345698765432').indexOf('iban') !== -1);
  assert.ok(labels('acct TR330006100519786457841326').indexOf('iban') !== -1);
  assert.strictEqual(labels('acct GB82WEST12345698765433').indexOf('iban'), -1); // last digit wrong
});

test('ipv4: valid octets redact; out-of-range negative', function () {
  assert.ok(labels('host 192.168.1.1').indexOf('ipv4') !== -1);
  assert.strictEqual(labels('ver 999.999.999.999').indexOf('ipv4'), -1);
});

test('ipv6: full + compressed positive; prose negative', function () {
  assert.ok(labels('addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334').indexOf('ipv6') !== -1);
  assert.ok(labels('addr fe80::1').indexOf('ipv6') !== -1);
  assert.strictEqual(labels('just some plain words here').indexOf('ipv6'), -1);
});

test('secret category is delegated to secretscan and redacts a known key shape', function () {
  const r = pii.scrub('token sk-ant-api03-AbCdEf1234567890AbCdEf1234567890 end');
  assert.strictEqual(r.counts.secret, 1);
  assert.ok(r.text.indexOf('sk-ant-') === -1);
});

test('address is OFF by default and ON only when explicitly enabled', function () {
  assert.strictEqual(labels('123 Main Street, Springfield').indexOf('address'), -1);
  assert.ok(labels('123 Main Street, Springfield', { categories: ['address'] }).indexOf('address') !== -1);
});

// ---- custom patterns from a temp configDir ----------------------------------------------

test('loadCustom merges validated custom patterns and ignores malformed entries', function () {
  const ctx = tmpCtx();
  fs.writeFileSync(path.join(ctx.configDir, 'pii-patterns.json'), JSON.stringify([
    { label: 'employee-id', regex: 'EMP-\\d{4}', flags: 'i' }, // valid
    { label: 'bad label!!', regex: 'x' },                       // invalid label -> ignored
    { label: 'toolong', regex: 'a'.repeat(400) },               // regex too long -> ignored
    { label: 'broken', regex: '([' },                           // won't compile -> ignored
    { label: 'badflags', regex: 'x', flags: 'z' },              // bad flags -> ignored
  ]));
  const custom = pii.loadCustom(ctx);
  assert.strictEqual(custom.length, 1);
  assert.strictEqual(custom[0].label, 'employee-id');

  const r = pii.scrub('ticket emp-1234 for user', { categories: ['email'], custom: custom });
  assert.strictEqual(r.counts['employee-id'], 1); // 'i' flag => case-insensitive match
  assert.ok(r.text.indexOf('[REDACTED:employee-id]') !== -1);
});

test('loadCustom refuses ReDoS-prone nested quantifiers and caps the pattern count (regression)', function () {
  const ctx = tmpCtx();
  const many = [];
  for (let i = 0; i < 200; i++) many.push({ label: 'p' + i, regex: 'z' + i });
  fs.writeFileSync(path.join(ctx.configDir, 'pii-patterns.json'), JSON.stringify(
    [{ label: 'evil1', regex: '(a+)+$' }, { label: 'evil2', regex: '(\\d*)*' }, { label: 'evil3', regex: '(x{1,})+' },
     { label: 'ok', regex: '(abc)+' }].concat(many)));
  const custom = pii.loadCustom(ctx);
  assert.ok(custom.length <= 64, 'pattern count capped: ' + custom.length);
  const labelsLoaded = custom.map(function (c) { return c.label; });
  ['evil1', 'evil2', 'evil3'].forEach(function (l) { assert.strictEqual(labelsLoaded.indexOf(l), -1, l + ' (ReDoS) must be refused'); });
  assert.ok(labelsLoaded.indexOf('ok') !== -1, 'a benign quantified group is still accepted');
  // and a catastrophic pattern that slipped in could not wedge scrub — prove the guard holds:
  const start = Date.now();
  pii.scrub('a'.repeat(40) + '!', { categories: [], custom: custom });
  assert.ok(Date.now() - start < 1000, 'scrub did not hang on the loaded (safe) patterns');
});

test('loadCustom returns [] when the file is missing or corrupt', function () {
  const ctx = tmpCtx();
  assert.deepStrictEqual(pii.loadCustom(ctx), []);
  fs.writeFileSync(path.join(ctx.configDir, 'pii-patterns.json'), 'not json{');
  assert.deepStrictEqual(pii.loadCustom(ctx), []);
});

// ---- overlap resolution + counts --------------------------------------------------------

test('overlapping matches: longest/outermost wins, no double-redact', function () {
  // A custom pattern that spans an email; the whole span must be redacted ONCE, under the
  // outer label — not redacted twice or nested.
  const custom = [{ label: 'wide', re: /contact john\.doe@example\.com now/g }];
  const r = pii.scrub('please contact john.doe@example.com now thanks', { categories: ['email'], custom: custom });
  assert.strictEqual((r.text.match(/\[REDACTED:/g) || []).length, 1, 'exactly one redaction marker');
  assert.strictEqual(r.text.indexOf('[REDACTED:wide]') !== -1, true, 'outer (longer) span wins');
  assert.strictEqual(r.counts.email, undefined, 'nested email not counted');
  assert.strictEqual(r.counts.wide, 1);
});

test('counts reflect every distinct redaction', function () {
  const r = pii.scrub('a@x.io, b@y.io and host 10.0.0.1 plus 10.0.0.2');
  assert.strictEqual(r.counts.email, 2);
  assert.strictEqual(r.counts.ipv4, 2);
});

test('opts.categories restricts which categories run', function () {
  const text = 'mail a@b.io ip 1.2.3.4';
  assert.deepStrictEqual(labels(text, { categories: ['email'] }), ['email']);
  assert.deepStrictEqual(labels(text, { categories: ['ipv4'] }), ['ipv4']);
});

test('redactString redacts caller-supplied spans with overlap handling', function () {
  const out = pii.redactString('abcdefgh', [
    { start: 1, end: 4, label: 'x' },
    { start: 2, end: 3, label: 'y' }, // nested -> dropped
    { start: 5, end: 7, label: 'z' },
  ]);
  assert.strictEqual(out, 'a[REDACTED:x]e[REDACTED:z]h');
});

// ---- scrubViaLLM (opt-in, injected fetch) -----------------------------------------------

test('scrubViaLLM applies returned spans via an injected fake fetch', async function () {
  const text = 'secret agent 007 lives here';
  const fakeFetch = function (url, init) {
    assert.strictEqual(url, 'http://localhost:11434/redact');
    const body = JSON.parse(init.body);
    assert.strictEqual(body.text, text);
    const start = text.indexOf('007');
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ spans: [{ start: start, end: start + 3, label: 'codename' }] }); } });
  };
  const out = await pii.scrubViaLLM(text, { url: 'http://localhost:11434/redact', fetch: fakeFetch, model: 'llama3' });
  assert.strictEqual(out, 'secret agent [REDACTED:codename] lives here');
});

test('scrubViaLLM applies the {redactions:[{text}]} substring contract', async function () {
  const text = 'name Jane Roe here';
  const fakeFetch = function () {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ redactions: [{ text: 'Jane Roe', label: 'name' }] }); } });
  };
  const out = await pii.scrubViaLLM(text, { url: 'http://x', fetch: fakeFetch });
  assert.strictEqual(out, 'name [REDACTED:name] here');
});

test('scrubViaLLM is a strict no-op when url is unset (never calls fetch)', async function () {
  let called = false;
  const fetchSpy = function () { called = true; return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ spans: [] }); } }); };
  const out = await pii.scrubViaLLM('untouched text', { fetch: fetchSpy });
  assert.strictEqual(out, 'untouched text');
  assert.strictEqual(called, false, 'fetch must NOT be called without a url');
});

test('scrubViaLLM fails open (returns original) when the fetch throws or times out', async function () {
  const boom = function () { return Promise.reject(new Error('connection refused')); };
  assert.strictEqual(await pii.scrubViaLLM('keep me', { url: 'http://x', fetch: boom }), 'keep me');
  const notOk = function () { return Promise.resolve({ ok: false }); };
  assert.strictEqual(await pii.scrubViaLLM('keep me too', { url: 'http://x', fetch: notOk }), 'keep me too');
});

test('scrubViaLLM ignores out-of-range or malformed spans', async function () {
  const text = 'short';
  const fakeFetch = function () {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ spans: [{ start: 0, end: 999 }, { start: 3, end: 2 }] }); } });
  };
  assert.strictEqual(await pii.scrubViaLLM(text, { url: 'http://x', fetch: fakeFetch }), 'short');
});
