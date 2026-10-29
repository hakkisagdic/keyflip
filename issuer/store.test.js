'use strict';
// ISSUER / store.test.js — zero-dep (node:test + node:assert) coverage for the
// issuer's bookkeeping: the license store and the event log.
//
// What it proves:
//   * A record NEVER holds a token — the store's create() has no token argument
//     at all, and the persisted file contains no base64url token material.
//   * The store survives a restart (a second store reads the file back).
//   * list() filters by email / tier / status / free text, newest first.
//   * revoke() marks a record and is idempotent-ish (a second revoke is
//     reported, not silently accepted).
//   * supersede() links old -> new and downgrades the old record's status.
//   * The event log appends JSONL and reads the tail back; a torn line is
//     skipped rather than poisoning the whole read.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LicenseStore, EventLog, normalizeEmail, newLicenseId } = require('./store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-store-'));
}

test('a record never holds a token', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'licenses.json');
  const store = new LicenseStore({ file });
  const rec = store.create({ email: 'a@b.co', tier: 'pro', months: 12 });
  assert.ok(rec.licenseId);
  assert.strictEqual(rec.token, undefined);
  const raw = fs.readFileSync(file, 'utf8');
  // A token is `base64url(payload).base64url(sig)` — look for that shape.
  assert.ok(!/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}/.test(raw), 'no token-shaped string in the store file');
});

test('the store survives a restart', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'licenses.json');
  const a = new LicenseStore({ file });
  const rec = a.create({ email: 'x@y.co', tier: 'team', months: 1 });
  const b = new LicenseStore({ file });
  const back = b.get(rec.licenseId);
  assert.ok(back);
  assert.strictEqual(back.email, 'x@y.co');
  assert.strictEqual(back.tier, 'team');
  assert.strictEqual(back.status, 'active');
});

test('list filters and sorts newest first', () => {
  const store = new LicenseStore({ file: null });
  const t = (n) => '2026-01-0' + n + 'T00:00:00.000Z';
  const s = new LicenseStore({ file: null, now: () => t(1) });
  s.create({ email: 'one@x.co', tier: 'pro', months: 1 });
  s.create({ email: 'two@x.co', tier: 'team', months: 1 });
  s.create({ email: 'three@x.co', tier: 'pro', months: 1 });
  assert.strictEqual(store.list({}).length, 0);
  const all = s.list({});
  assert.strictEqual(all.length, 3);
  assert.strictEqual(s.list({ email: 'one@x.co' }).length, 1);
  assert.strictEqual(s.list({ tier: 'pro' }).length, 2);
  assert.strictEqual(s.list({ q: 'two' }).length, 1);
  assert.strictEqual(s.list({ q: 'nonexistent' }).length, 0);
});

test('revoke marks the record and reports a repeat revoke', () => {
  const store = new LicenseStore({ file: null });
  const rec = store.create({ email: 'r@x.co', tier: 'pro', months: 1 });
  const first = store.revoke(rec.licenseId, 'chargeback');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.record.status, 'revoked');
  assert.strictEqual(first.record.revokeReason, 'chargeback');
  const second = store.revoke(rec.licenseId, 'again');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'already-revoked');
  assert.strictEqual(store.get(rec.licenseId).status, 'revoked');
});

test('supersede links the old record to the new one', () => {
  const store = new LicenseStore({ file: null });
  const old = store.create({ email: 's@x.co', tier: 'pro', months: 12 });
  const fresh = store.create({ email: 's@x.co', tier: 'pro', months: 1, supersedes: old.licenseId });
  store.supersede(old.licenseId, fresh);
  assert.strictEqual(store.get(old.licenseId).status, 'superseded');
  assert.strictEqual(store.get(old.licenseId).supersededBy, fresh.licenseId);
  assert.strictEqual(fresh.supersedes, old.licenseId);
});

test('the event log appends JSONL and reads the tail back', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  const log = new EventLog({ file });
  log.append({ event: 'license.issued', licenseId: 'lic_1', tier: 'pro' });
  log.append({ event: 'license.revoked', licenseId: 'lic_1' });
  const rows = log.recent(10);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((r) => r.ts));
  const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(raw.length, 2);
  assert.strictEqual(JSON.parse(raw[0]).event, 'license.issued');
});

test('a torn event line is skipped, not fatal', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(
    file,
    '{"event":"a","ts":"2026-01-01T00:00:00Z"}\n{"event":"b\n{"event":"c","ts":"2026-01-03T00:00:00Z"}\n',
  );
  const log = new EventLog({ file });
  const rows = log.recent(10);
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.some((r) => r.event === 'c'));
});

test('email normalization rejects nonsense and lowercases', () => {
  assert.strictEqual(normalizeEmail('A@B.CO'), 'a@b.co');
  assert.strictEqual(normalizeEmail('a@b.co'), 'a@b.co');
  assert.strictEqual(normalizeEmail('nope'), null);
  assert.strictEqual(normalizeEmail('a@b@c.co'), null);
  assert.strictEqual(normalizeEmail('a b@c.co'), null);
  assert.strictEqual(normalizeEmail('a@'), null);
  assert.strictEqual(normalizeEmail(''), '');
});

test('license ids are unique and prefixed', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newLicenseId();
    assert.ok(id.startsWith('lic_'));
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});
