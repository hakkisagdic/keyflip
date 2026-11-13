'use strict';
// ISSUER / store.js — the issuer's own bookkeeping: the license records it has
// minted, the invoice/tax reconciliation ledger (invoices.jsonl), and the
// webhook event log.
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
//   existing token stays valid until it EXPIRES.

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

// A unique invoice identifier for accounting & e-Arşiv/e-Fatura reconciliation.
function newInvoiceId() {
  return 'inv_' + crypto.randomBytes(8).toString('hex');
}

// Resolve tax classification: domestic Turkish payments (TR / iyzico / paytr / TRY)
// carry 20% KDV ('domestic-vat-20pct'); international software export carries 0% VAT
// ('export-exempt-0pct').
function resolveTaxMode(provider, countryCode, currency) {
  const cc = String(countryCode || '').toUpperCase();
  const prov = String(provider || '').toLowerCase();
  const cur = String(currency || '').toUpperCase();
  if (cc === 'TR' || prov === 'iyzico' || prov === 'paytr' || cur === 'TRY') {
    return 'domestic-vat-20pct';
  }
  return 'export-exempt-0pct';
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
    const seats = Number.isInteger(Number(fields.seats)) && Number(fields.seats) > 0 ? Number(fields.seats) : 1;
    const rec = {
      licenseId: fields.licenseId || newLicenseId(),
      email: fields.email || '',
      tier: fields.tier,
      seats: seats,
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
  // unknown or already revoked.
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

  // Mark `oldId` superseded by a new record.
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

// ---- invoice store (invoices.jsonl) ------------------------------------------
// JSONL accounting & tax reconciliation ledger (<stateDir>/invoices.jsonl, 0600).
// Records every purchase and refund with currency (TRY/USD), seats, months, and
// taxMode ('domestic-vat-20pct' vs 'export-exempt-0pct'). NEVER stores a token.
class InvoiceStore {
  constructor(opts) {
    opts = opts || {};
    this.file = opts.file || null;
    this.now = opts.now || nowIso;
    this.byInvoiceId = new Map(); // invoiceId -> record
    this.byOrderId = new Map(); // orderId -> invoiceId
    this._load();
  }

  _load() {
    if (!this.file) return;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o;
      try {
        o = JSON.parse(t);
      } catch {
        continue;
      }
      if (o && typeof o.invoiceId === 'string') {
        this.byInvoiceId.set(o.invoiceId, o);
        if (o.orderId) this.byOrderId.set(String(o.orderId), o.invoiceId);
      }
    }
  }

  _appendLine(rec) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  recordPurchase(fields) {
    fields = fields || {};
    const orderId = fields.orderId ? String(fields.orderId) : null;
    if (orderId && this.byOrderId.has(orderId)) {
      return this.byInvoiceId.get(this.byOrderId.get(orderId));
    }
    const issuedAt = fields.issuedAt || this.now();
    const provider = fields.provider ? String(fields.provider) : 'manual';
    const currency = fields.currency
      ? String(fields.currency).toUpperCase()
      : provider === 'iyzico' || provider === 'paytr'
        ? 'TRY'
        : 'USD';
    const amount = Number.isFinite(Number(fields.amount)) && Number(fields.amount) >= 0 ? Number(fields.amount) : 0;
    const seats = Number.isInteger(Number(fields.seats)) && Number(fields.seats) > 0 ? Number(fields.seats) : 1;
    const months = Number.isInteger(Number(fields.months)) && Number(fields.months) > 0 ? Number(fields.months) : 12;
    const countryCode =
      fields.countryCode || (provider === 'iyzico' || provider === 'paytr' || currency === 'TRY' ? 'TR' : 'INTL');
    const taxMode = fields.taxMode || resolveTaxMode(provider, countryCode, currency);

    const rec = {
      invoiceId: fields.invoiceId || newInvoiceId(),
      orderId: orderId,
      licenseId: fields.licenseId || null,
      provider: provider,
      email: fields.email || '',
      tier: fields.tier || 'pro',
      seats: seats,
      months: months,
      amount: amount,
      currency: currency,
      countryCode: countryCode,
      taxMode: taxMode,
      issuedAt: issuedAt,
      status: 'paid',
      refundedAt: null,
      refundReason: null,
    };
    this.byInvoiceId.set(rec.invoiceId, rec);
    if (orderId) this.byOrderId.set(orderId, rec.invoiceId);
    this._appendLine(rec);
    return rec;
  }

  recordRefund(orderIdOrInvoiceId, reason) {
    const key = String(orderIdOrInvoiceId || '');
    const invId = this.byOrderId.get(key) || (this.byInvoiceId.has(key) ? key : null);
    if (!invId) return { ok: false, reason: 'not-found' };
    const existing = this.byInvoiceId.get(invId);
    if (existing.status === 'refunded') {
      return { ok: false, reason: 'already-refunded', invoice: existing };
    }
    const updated = Object.assign({}, existing, {
      status: 'refunded',
      refundedAt: this.now(),
      refundReason: String(reason == null ? 'refund' : reason).slice(0, MAX_REASON_LEN),
    });
    this.byInvoiceId.set(invId, updated);
    this._appendLine(updated);
    return { ok: true, invoice: updated };
  }

  get(id) {
    const k = String(id || '');
    if (this.byInvoiceId.has(k)) return this.byInvoiceId.get(k);
    if (this.byOrderId.has(k)) return this.byInvoiceId.get(this.byOrderId.get(k)) || null;
    return null;
  }

  list(filters) {
    filters = filters || {};
    let out = Array.from(this.byInvoiceId.values());
    if (filters.provider) out = out.filter((r) => r.provider === filters.provider);
    if (filters.currency) out = out.filter((r) => r.currency === String(filters.currency).toUpperCase());
    if (filters.status) out = out.filter((r) => r.status === filters.status);
    if (filters.taxMode) out = out.filter((r) => r.taxMode === filters.taxMode);
    if (filters.email) out = out.filter((r) => r.email === filters.email);
    if (filters.q) {
      const q = String(filters.q).toLowerCase();
      out = out.filter(
        (r) =>
          String(r.email || '')
            .toLowerCase()
            .indexOf(q) !== -1 ||
          String(r.invoiceId || '')
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

  revenueSummary() {
    const totalsByCurrency = {
      TRY: { paid: 0, refunded: 0, net: 0, count: 0, paidCount: 0, refundedCount: 0 },
      USD: { paid: 0, refunded: 0, net: 0, count: 0, paidCount: 0, refundedCount: 0 },
    };
    const byProvider = {};
    const byTaxMode = {
      'domestic-vat-20pct': { count: 0, netTry: 0, netUsd: 0 },
      'export-exempt-0pct': { count: 0, netTry: 0, netUsd: 0 },
    };

    for (const inv of this.byInvoiceId.values()) {
      const cur = inv.currency === 'TRY' ? 'TRY' : 'USD';
      const bucket = totalsByCurrency[cur];
      const amt = Number(inv.amount) || 0;
      bucket.count += 1;
      if (inv.status === 'refunded') {
        bucket.refunded = Math.round((bucket.refunded + amt) * 100) / 100;
        bucket.refundedCount += 1;
      } else {
        bucket.paid = Math.round((bucket.paid + amt) * 100) / 100;
        bucket.net = Math.round((bucket.net + amt) * 100) / 100;
        bucket.paidCount += 1;
      }
      const prov = inv.provider || 'unknown';
      if (!byProvider[prov]) byProvider[prov] = { count: 0, paidCount: 0, refundedCount: 0 };
      byProvider[prov].count += 1;
      if (inv.status === 'refunded') byProvider[prov].refundedCount += 1;
      else byProvider[prov].paidCount += 1;

      const tm = byTaxMode[inv.taxMode] || byTaxMode['export-exempt-0pct'];
      if (inv.status !== 'refunded') {
        tm.count += 1;
        if (cur === 'TRY') tm.netTry = Math.round((tm.netTry + amt) * 100) / 100;
        else tm.netUsd = Math.round((tm.netUsd + amt) * 100) / 100;
      }
    }

    return {
      totalInvoices: this.byInvoiceId.size,
      totalsByCurrency: totalsByCurrency,
      byProvider: byProvider,
      byTaxMode: byTaxMode,
    };
  }
}

// Convenience helpers over an InvoiceStore or file path.
function listInvoices(storeOrFile, filters) {
  const s = storeOrFile instanceof InvoiceStore ? storeOrFile : new InvoiceStore({ file: storeOrFile });
  return s.list(filters);
}

function revenueSummary(storeOrFile) {
  const s = storeOrFile instanceof InvoiceStore ? storeOrFile : new InvoiceStore({ file: storeOrFile });
  return s.revenueSummary();
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
  newInvoiceId: newInvoiceId,
  resolveTaxMode: resolveTaxMode,
  normalizeEmail: normalizeEmail,
  addMonths: addMonths,
  LicenseStore: LicenseStore,
  InvoiceStore: InvoiceStore,
  listInvoices: listInvoices,
  revenueSummary: revenueSummary,
  EventLog: EventLog,
};
