// apicredits — the Claude subscriber MONTHLY API credit, read from the Admin API.
//
// Since 2026-10-07 Claude Max and Team plans include a monthly Claude Platform (Console)
// credit: Max 5x $100, Max 20x $200, Team per seat (capped at $500). The claude.ai account
// links exactly ONE Console organization (claude.ai Settings → Billing → API credits →
// "Link organization"); the credit refreshes each billing cycle, never rolls over, expires at
// the cycle's end, and is spent before any prepaid funds. The Console shows the true remaining
// balance, but no API reads it (GET /v1/organizations/balance 404s — claude-code#47574). What
// an ADMIN key (sk-ant-admin01-…) CAN read is the organization list and the cost report:
//
//   GET /v1/organizations                  -> { data: [{ id, name, … }] }
//   GET /v1/organizations/cost_report      -> { data: [{ results: [{ amount, currency, … }] }],
//                                               has_more, next_page }
//
// So the remaining credit shown here is an ESTIMATE: the plan's grant minus the USD cost the
// report shows inside the current cycle, labelled as an estimate wherever it is printed.
//
// Individual orgs have no Admin API to talk to at all, so those accounts run in MANUAL mode:
// the user reads the Credits balance in the Console and records it with `api set` — see
// manualStatus below.
//
// Secrets: the admin key lives ONLY in the credential store (Keychain on macOS under the
// service `keyflip:admin-key` / account `api:<id>`, else <configDir>/creds/admin-key.cred,
// which the state repo ignores). It is never written to api-accounts.json, never printed, and
// never returned by any function here.
//
// Injectable like provusage: deps = { fetch, now, store }. `fetch` defaults to NULL (fail
// closed) — an un-injected caller must never send the saved key anywhere; the CLI passes the
// global fetch explicitly and tests pass a controlled stub.

import fs from 'fs';
import path from 'path';
import KeychainStore from './stores/keychain.js';
import FileStore from './stores/file.js';
import { atomicWrite } from './fsutil.js';

export const API_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const KEY_PROFILE = 'admin-key'; // store profile name; the store binds the api:<id> account
export const CONFIG_FILE = 'api-accounts.json';

// Plan → the monthly USD grant it includes (support.claude.com 17154008). `team` is per seat
// and capped, so its grant is whatever the org's seats work out to: it must be set explicitly.
export const PLANS = { max5x: 100, max20x: 200, team: null };

// Individual Console organizations have NO Admin API ("The Admin API is unavailable for
// individual accounts" — the admin-keys page 404s and no admin key can be provisioned), so an
// account there runs in MANUAL mode: the user reads the Credits balance the Console shows and
// records it with `keyflip api set <id> --balance <usd>`. One reading = one entry, kept here.
const MAX_ENTRIES = 200;

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_KEY_RE = /^sk-ant-admin/;
const FETCH_TIMEOUT_MS = 15000;
const MAX_PAGES = 20; // one page = up to `limit` buckets; a cycle never needs more

// ---------------------------------------------------------------------------
// Injectable dependency defaults. Tests override any of these.
// ---------------------------------------------------------------------------
function resolveDeps(deps) {
  deps = deps || {};
  return {
    // Fail closed: production callers (the CLI) pass fetch explicitly, tests pass a stub.
    fetch: deps.fetch || null,
    now:
      deps.now ||
      function () {
        return Date.now();
      },
    store: deps.store || null, // defaultStore(ctx, id) fills this in the callers that need one
  };
}

// Where the admin key for one api account lives. macOS: the login Keychain, service
// `keyflip:admin-key`, account `api:<id>`. Elsewhere: a 0600 file the state repo ignores.
export function defaultStore(ctx, id) {
  if (process.platform === 'darwin') {
    return new KeychainStore({ account: 'api:' + id });
  }
  return new FileStore({
    credsFilePath: path.join(ctx.configDir, 'creds', '.api-live-unused'),
    profileCredDir: path.join(ctx.configDir, 'creds'),
  });
}

// ---------------------------------------------------------------------------
// Config: api-accounts.json — metadata only, safe to commit. Never a key.
// ---------------------------------------------------------------------------
export function configPath(ctx) {
  return path.join(ctx.configDir, CONFIG_FILE);
}

// Returns { schemaVersion: 1, accounts: [...] }; a missing file is empty state, a corrupt one
// is the caller's error to show (it may hold the only record of which org an account linked).
export function readConfig(ctx) {
  let raw;
  try {
    raw = fs.readFileSync(configPath(ctx), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { schemaVersion: 1, accounts: [] };
    throw e;
  }
  const j = JSON.parse(raw);
  return { schemaVersion: 1, accounts: Array.isArray(j.accounts) ? j.accounts : [] };
}

export function writeConfig(ctx, cfg) {
  atomicWrite(configPath(ctx), JSON.stringify(cfg, null, 2) + '\n', 0o644);
}

export function accountById(cfg, id) {
  return (cfg.accounts || []).find(function (a) {
    return a.id === id;
  });
}

// Validates one account record and fills defaults. Throws Error with a human message.
export function normalizeAccount(input) {
  const id = String((input && input.id) || '').trim();
  if (!ACCOUNT_ID_RE.test(id)) {
    throw new Error("account id must be letters/digits/._- (got '" + id + "')");
  }
  const plan = input.plan === undefined || input.plan === null || input.plan === '' ? null : String(input.plan);
  if (plan !== null && !Object.prototype.hasOwnProperty.call(PLANS, plan)) {
    throw new Error("plan must be one of max5x | max20x | team (got '" + plan + "')");
  }
  let grant = null;
  if (input.grant !== undefined && input.grant !== null && input.grant !== '') {
    grant = Number(input.grant);
    if (!isFinite(grant) || grant <= 0) throw new Error('grant must be a positive USD number');
  }
  if (plan === 'team' && grant === null) {
    throw new Error('team is per seat and capped, so its grant must be set explicitly: --grant <usd>');
  }
  if (plan !== 'team' && grant === null && input.grantOverride !== undefined && input.grantOverride !== null) {
    grant = Number(input.grantOverride) || null;
  }
  let cycleDay = parseInt(input.cycleDay, 10);
  if (!isFinite(cycleDay)) cycleDay = 1;
  if (cycleDay < 1 || cycleDay > 28) throw new Error('cycle-day must be 1..28');
  const acct = {
    id: id,
    orgUuid: input.orgUuid ? String(input.orgUuid) : null,
    orgName: input.orgName ? String(input.orgName) : null,
    email: input.email ? String(input.email) : null,
    plan: plan,
    grant: grant, // explicit USD grant (required for team); PLANS[plan] fills the rest
    cycleDay: cycleDay,
    savedAt: new Date().toISOString(),
  };
  if (acct.orgUuid && !UUID_RE.test(acct.orgUuid)) {
    throw new Error("org uuid looks wrong: '" + acct.orgUuid + "'");
  }
  // Manual-mode readings ride along so a re-normalized record keeps its history.
  if (Array.isArray(input.entries)) acct.entries = input.entries;
  return acct;
}

// The USD grant this account's plan carries (an explicit one wins). null = unknown.
export function grantFor(acct) {
  if (!acct) return null;
  if (typeof acct.grant === 'number' && isFinite(acct.grant) && acct.grant > 0) return acct.grant;
  return Object.prototype.hasOwnProperty.call(PLANS, acct.plan) ? PLANS[acct.plan] : null;
}

// This cycle's bounds from the anchor day (the day the credit lands each month, UTC).
export function cycleBounds(acct, nowMs) {
  const day = Math.min(28, Math.max(1, parseInt((acct && acct.cycleDay) || 1, 10) || 1));
  const d = new Date(nowMs);
  let start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
  if (start.getTime() > nowMs) start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day));
  const resets = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day));
  return { startISO: start.toISOString(), resetsISO: resets.toISOString() };
}

// ---------------------------------------------------------------------------
// Manual mode. A balance reading is a number and a timestamp — never a secret — so it lives
// in api-accounts.json with the rest of the metadata, newest last, capped to MAX_ENTRIES.
// ---------------------------------------------------------------------------
export function appendEntry(ctx, cfg, acct, usd, nowMs) {
  const n = Math.round(Number(usd) * 100) / 100;
  if (!isFinite(n) || n < 0) throw new Error('balance must be a USD number ≥ 0');
  const entries = Array.isArray(acct.entries) ? acct.entries.slice() : [];
  const prev = entries.length ? entries[entries.length - 1] : null;
  const at = typeof nowMs === 'number' ? new Date(nowMs) : new Date();
  const entry = { at: at.toISOString(), usd: n };
  entries.push(entry);
  acct.entries = entries.slice(-MAX_ENTRIES);
  const existing = accountById(cfg, acct.id);
  if (existing) cfg.accounts.splice(cfg.accounts.indexOf(existing), 1, acct);
  else cfg.accounts.push(acct);
  writeConfig(ctx, cfg);
  return { entry: entry, prev: prev };
}

// Fill a readStatus-shaped `out` from an account's manual readings; false when there are none.
// The caller owns the cycle bounds (out.resetsISO) — they are set before this runs.
export function manualStatus(acct, out) {
  const entries = Array.isArray(acct.entries) ? acct.entries : [];
  if (!entries.length) return false;
  const last = entries[entries.length - 1];
  const prev = entries.length > 1 ? entries[entries.length - 2] : null;
  const grant = grantFor(acct);
  out.grant = grant;
  out.status = 'manual';
  out.balanceUsd = last.usd;
  out.remaining = last.usd;
  out.lastEntryISO = last.at;
  out.entriesCount = entries.length;
  if (prev) out.trendUsd = Math.round((last.usd - prev.usd) * 100) / 100;
  if (grant !== null) {
    out.used = Math.round(Math.max(0, grant - last.usd) * 100) / 100;
    out.usedPct = Math.round((out.used / grant) * 1000) / 10;
  }
  const d = new Date(last.at);
  out.error =
    'last reading ' +
    String(d).slice(4, 10) +
    ' ' +
    String(d).slice(16, 21) +
    (prev && out.trendUsd !== undefined
      ? ' · ' + (out.trendUsd >= 0 ? '+' : '−') + '$' + Math.abs(out.trendUsd).toFixed(2) + ' since the previous'
      : '') +
    ' · entered by hand (`keyflip api set ' + acct.id + ' --balance <usd>`)';
  return true;
}

// ---------------------------------------------------------------------------
// The Admin API. Every path here sends the key in one header and returns shaped,
// key-free results; error strings carry at most an HTTP status or a fetch message.
// ---------------------------------------------------------------------------
async function adminGet(deps, key, pathname, params) {
  const qs = params
    ? Object.keys(params)
        .filter(function (k) {
          return params[k] !== undefined && params[k] !== null;
        })
        .map(function (k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k]));
        })
        .join('&')
    : '';
  const url = API_BASE + pathname + (qs ? '?' + qs : '');
  let r;
  try {
    r = await deps.fetch(url, {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: 'network: ' + String((e && e.message) || e) };
  }
  let json;
  try {
    json = await r.json();
  } catch {
    json = null; // a non-JSON body: the status code still says what happened
  }
  return { ok: r.ok, status: r.status, json: json };
}

// One row's cost: the cost report names it `amount` (string) with `currency`; older schemas
// and the usage report named `cost_usd`. Both accepted, USD only — anything else would sum
// the wrong money against a USD grant.
function rowCostUsd(row) {
  if (!row) return null;
  const cur = String(row.currency || 'USD').toUpperCase();
  if (cur !== 'USD') return null;
  const v = row.cost_usd !== undefined && row.cost_usd !== null ? row.cost_usd : row.amount;
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isFinite(n) ? n : null;
}

// Sum one org's USD cost over [startISO, endISO], following has_more/next_page.
export async function costReport(deps, key, startISO, endISO) {
  let page = null;
  let usd = 0;
  let rows = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = { starting_at: startISO, ending_at: endISO, bucket_width: '1d', limit: 1000 };
    if (page) params.page = page;
    const r = await adminGet(deps, key, '/v1/organizations/cost_report', params);
    if (!r.ok) {
      return { ok: false, status: r.status, error: r.error || 'HTTP ' + r.status };
    }
    const data = r.json && Array.isArray(r.json.data) ? r.json.data : null;
    if (!data) return { ok: false, status: r.status, error: 'unexpected response shape' };
    for (const bucket of data) {
      const results = bucket && Array.isArray(bucket.results) ? bucket.results : [bucket];
      for (const row of results) {
        const n = rowCostUsd(row);
        if (n !== null) {
          usd += n;
          rows++;
        }
      }
    }
    if (r.json && r.json.has_more && r.json.next_page) {
      page = r.json.next_page;
    } else break;
  }
  return { ok: true, usd: Math.round(usd * 100) / 100, rows: rows };
}

// The organizations the key can see — how the user picks the org to save.
export async function listOrgs(ctx, id, deps) {
  const D = resolveDeps(deps);
  if (!D.fetch) return { status: 'unknown', error: 'no fetch injected', orgs: [] };
  const store = D.store || defaultStore(ctx, id);
  let key;
  try {
    key = store.getProfile(KEY_PROFILE);
  } catch (e) {
    return { status: 'unknown', error: 'credential store: ' + String((e && e.message) || e), orgs: [] };
  }
  if (!key) return { status: 'no-key', error: 'no admin key saved — keyflip api add ' + id, orgs: [] };
  if (!ADMIN_KEY_RE.test(key)) {
    return {
      status: 'unknown',
      error: 'the saved key is not an Admin API key (sk-ant-admin01-…) — the cost report refuses any other kind',
      orgs: [],
    };
  }
  const r = await adminGet(D, key, '/v1/organizations', null);
  if (!r.ok) {
    const status = r.status === 401 || r.status === 403 ? 'unauthenticated' : 'unknown';
    return { status: status, error: r.error || 'HTTP ' + r.status, orgs: [] };
  }
  const data = r.json && Array.isArray(r.json.data) ? r.json.data : null;
  if (!data) return { status: 'unknown', error: 'unexpected response shape', orgs: [] };
  return {
    status: 'ok',
    orgs: data.map(function (o) {
      return { id: o.id, name: o.name };
    }),
  };
}

// One account's credit reading. Never throws, never returns the key:
//   { id, plan, grant, orgUuid, orgName, cycleStartISO, resetsISO,
//     status: 'ok'|'manual'|'no-key'|'unauthenticated'|'grant-unknown'|'offline'|'unknown',
//     used, remaining, usedPct, error }
// 'manual' adds balanceUsd/lastEntryISO/entriesCount (+trendUsd when a previous reading exists)
// and carries no error — out.error then holds a dim human note, not a failure.
export async function readStatus(ctx, acct, deps) {
  const D = resolveDeps(deps);
  const out = {
    id: acct.id,
    email: acct.email || null,
    plan: acct.plan || null,
    orgUuid: acct.orgUuid || null,
    orgName: acct.orgName || null,
    cycleStartISO: null,
    resetsISO: null,
    status: 'unknown',
    used: null,
    remaining: null,
    usedPct: null,
    error: null,
  };
  const grant = grantFor(acct);
  out.grant = grant;
  const bounds = cycleBounds(acct, D.now());
  out.cycleStartISO = bounds.startISO;
  out.resetsISO = bounds.resetsISO;
  function grantUnknown() {
    out.status = 'grant-unknown';
    out.error = 'team credit is per seat — set it once with: keyflip api add ' + acct.id + ' --grant <usd>';
  }
  const hasReadings = Array.isArray(acct.entries) && acct.entries.length > 0;
  // An unknown grant only blocks when nothing else can answer: manual readings can.
  if (grant === null && !hasReadings) {
    grantUnknown();
    return out;
  }
  const store = D.store || defaultStore(ctx, acct.id);
  let key;
  try {
    key = store.getProfile(KEY_PROFILE);
  } catch (e) {
    out.status = 'unknown';
    out.error = 'credential store: ' + String((e && e.message) || e);
    return out;
  }
  if (!key) {
    // No key: either a manual-mode account (the entries ARE the readings — no network needed)
    // or an account that has neither, which is what the error should teach.
    if (manualStatus(acct, out)) return out;
    if (grant === null) {
      grantUnknown();
      return out;
    }
    out.status = 'no-key';
    out.error =
      'no admin key (individual orgs have none) — record the Console balance with: keyflip api set ' +
      acct.id +
      ' --balance <usd>';
    return out;
  }
  if (grant === null) {
    grantUnknown();
    return out;
  }
  if (!ADMIN_KEY_RE.test(key)) {
    out.status = 'unknown';
    out.error = 'the saved key is not an Admin API key (sk-ant-admin01-…) — the cost report refuses any other kind';
    return out;
  }
  const r = await costReport(D, key, bounds.startISO, bounds.resetsISO);
  if (!r.ok) {
    out.status = r.status === 401 || r.status === 403 ? 'unauthenticated' : 'unknown';
    out.error = r.error;
    return out;
  }
  out.status = 'ok';
  out.used = r.usd;
  out.remaining = Math.round(Math.max(0, grant - r.usd) * 100) / 100;
  out.usedPct = Math.round((r.usd / grant) * 1000) / 10;
  return out;
}
