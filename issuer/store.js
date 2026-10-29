'use strict';
// ISSUER / store.js — the issuer's own bookkeeping: the license records it has
// minted, and the webhook event log.
//
// WHAT THIS STORE IS (and is not):
//   * It holds NON-SECRET metadata only: who was licensed, at what tier, until
//     when, and what happened to it. It NEVER holds a license TOKEN, a signing
//     key, or a provider webhook secret — a leaked store file must never be
//     enough to unlock a paid feature on someone's machine.
//   * The token itself is minted, handed to the buyer out-of-band, and dropped.
//     Nothing here can re-create it.
//
// THE HONEST LIMIT OF OFFLINE LICENSES (read before touching "revoke"):
//   A keyflip license is verified LOCALLY against an embedded public key, with no
//   phone-home. That is the product promise — and it means a license that is
//   already activated on a customer machine CANNOT be un-activated from here.
//   There is no server in the loop at verify time to consult. So "revoke" here
//   means: record the revocation, stop the issuer from reissuing that license id
//   or renewing that order, and flag it in the admin view. The customer's
//   existing token stays valid until it EXPIRES. The only true remote kill-switch
//   would be a phone-home check, which keyflip deliberately refuses to ship.
//
//   That is why `reissue` exists: a fresh license with a shorter expiry is the
//   honest way to shorten a customer's access — they activate the new token,
//   and the old one stops mattering once it lapses.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tiers the issuer may grant. Mirrors src/license.js TIER_ORDER (minus 'free',
// which is what an absent license means — the issuer never mints 'free').
const TIERS = ['pro', 'team', 'enterprise'];
const MAX_MONTHS = 120;
const MAX_EMAIL_LEN = 254;
const MAX_REASON_LEN = 200;
const MAX_EVENTS = 500; // how many events the admin view returns.

function nowIso() {
  return new Date().toISOString();
}

// A short, unguessable-enough id for an issued license. It is an IDENTIFIER,
// not a secret: it carries no capability (a token is still needed to unlock).
function newLicenseId() {
  return 'lic_' + crypto.randomBytes(8).toString('hex');
}

// Loose but bounded email check: one @, no whitespace, sane length. This is a
// typo guard, not an identity proof — the provider's webhook is what proves
// who paid.
function normalizeEmail(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.length > MAX_EMAIL_LEN) return null; // null = invalid
  if (/\s/.test(s)) return null;
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  if (s.indexOf('@', at + 1) !== -1) return null;
  return s.toLowerCase();
}

// Months -> expiry. Clamps day overflow the way Date arithmetic does.
function addMonths(iso, months) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString();
}

// ---- license store ------------------------------------------------------------
// A JSON array on disk, mode 0600, written atomically (tmp file + rename) so a
// crash mid-write cannot leave a truncated store behind.
class LicenseStore {
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null;
    this.now = opts.now || nowIso;
    this.records = new Map(); // licenseId -> record
    this._load();
  }

  _load() {
    if (!this.file) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // absent => empty
    }
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      return; // corrupt => start empty (fail closed, never half-applied)
    }
    if (!Array.isArray(arr)) return;
    for (const rec of arr) {
      if (rec && typeof rec.licenseId === 'string') this.records.set(rec.licenseId, rec);
    }
  }

  _persist() {
    if (!this.file) return;
    const arr = Array.from(this.records.values());
    const tmp = this.file + '.tmp.' + process.pid;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }

  // Create a record. The TOKEN IS NOT AN ARGUMENT on purpose — there is no code
  // path that can store one, even by accident.
  create(fields) {
    const issuedAt = fields.issuedAt || this.now();
    const months = Number.isFinite(fields.months) ? Math.max(1, Math.min(MAX_MONTHS, fields.months)) : 0;
    const rec = {
      licenseId: fields.licenseId || newLicenseId(),
      email: fields.email || '',
      tier: fields.tier,
      issuedAt: issuedAt,
      expiry: months > 0 ? addMonths(issuedAt, months) : null,
      months: months,
      source: fields.source || 'admin',
      orderId: fields.orderId || null,
      provider: fields.provider || null,
      status: 'active',
      revokedAt: null,
      revokeReason: null,
      supersedes: fields.supersedes || null,
      supersededBy: null,
    };
    this.records.set(rec.licenseId, rec);
    this._persist();
    return rec;
  }

  get(id) {
    return this.records.get(String(id)) || null;
  }

  // List newest first. Optional filters: email (exact), tier, status, and a
  // free-text `q` over email/licenseId/orderId.
  list(filters) {
    filters = filters || {};
    let out = Array.from(this.records.values());
    if (filters.email) out = out.filter((r) => r.email === filters.email);
    if (filters.tier) out = out.filter((r) => r.tier === filters.tier);
    if (filters.status) out = out.filter((r) => r.status === filters.status);
    if (filters.q) {
      const q = String(filters.q).toLowerCase();
      out = out.filter(
        (r) =>
          String(r.email || '')
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.licenseId || '')
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.orderId || '')
            .toLowerCase()
            .indexOf(q) !== -1,
      );
    }
    out.sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
    const limit = Math.max(1, Math.min(500, Number(filters.limit) || 200));
    return out.slice(0, limit);
  }

  // Mark a license revoked. Returns { ok, record } — ok=false when the id is
  // unknown or already revoked (revoking twice is not an error, it is a no-op
  // the caller can see).
  revoke(id, reason) {
    const rec = this.get(id);
    if (!rec) return { ok: false, reason: 'not-found' };
    if (rec.status === 'revoked') return { ok: false, reason: 'already-revoked', record: rec };
    rec.status = 'revoked';
    rec.revokedAt = this.now();
    rec.revokeReason = String(reason == null ? '' : reason).slice(0, MAX_REASON_LEN);
    this._persist();
    return { ok: true, record: rec };
  }

  // Mark `oldId` superseded by a new record. Keeps the chain intact: the new
  // license says which one it replaces, the old one says what replaced it.
  supersede(oldId, newRec) {
    const old = this.get(oldId);
    if (!old) return null;
    old.status = 'superseded';
    old.supersededBy = newRec.licenseId;
    this._persist();
    return old;
  }

  // Find the newest active license for an email (used by reissue).
  findActiveByEmail(email) {
    const list = this.list({ email: email, status: 'active' });
    return list.length ? list[0] : null;
  }
}

// ---- event log ----------------------------------------------------------------
// Append-only JSONL: one JSON object per line. Used for the admin "what
// happened" view (webhook received / license issued / license revoked).
// No token, no key, no provider secret ever reaches a line here.
class EventLog {
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null;
    this.now = opts.now || nowIso;
    this.lines = []; // in-memory tail, bounded
  }

  append(evt) {
    const rec = Object.assign({ ts: this.now() }, evt || {});
    this.lines.push(rec);
    if (this.lines.length > MAX_EVENTS) this.lines = this.lines.slice(-MAX_EVENTS);
    if (!this.file) return rec;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch {
      /* best effort: the log is for humans, the ledger is for correctness */
    }
    return rec;
  }

  // Read back the tail of the on-disk log (falls back to the in-memory tail).
  recent(limit) {
    const n = Math.max(1, Math.min(MAX_EVENTS, Number(limit) || 100));
    let rows = this.lines.slice();
    if (this.file) {
      let raw;
      try {
        raw = fs.readFileSync(this.file, 'utf8');
      } catch {
        raw = '';
      }
      const parsed = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (o && typeof o === 'object') parsed.push(o);
        } catch {
          /* skip a torn line */
        }
      }
      if (parsed.length) rows = parsed;
    }
    rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return rows.slice(0, n);
  }
}

module.exports = {
  TIERS: TIERS,
  MAX_MONTHS: MAX_MONTHS,
  newLicenseId: newLicenseId,
  normalizeEmail: normalizeEmail,
  addMonths: addMonths,
  LicenseStore: LicenseStore,
  EventLog: EventLog,
};
