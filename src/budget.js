// SPEND/QUOTA BUDGETS + VIRTUAL KEYS (vk_...):
// 1) Per-account usage ceilings with breach / near-breach alerts (<configDir>/budget.json, 0600).
// 2) Zero-dependency Virtual Keys (<configDir>/virtual-keys.json, 0600) with per-key & per-model
//    USD/TRY spend caps, RPM limits, model allowlists, and expiring temporary budget boosts (tempBoost).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as profiles from './profiles.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

const WARN_MARGIN = 10; // pct below the ceiling at which we raise a 'warn'
const DEFAULT_KEY = '*'; // the catch-all defaults entry (applies to every account)
const USD_TO_TRY_RATE = 34.9;
const METRICS = [
  { metric: 'fiveHour', limitKey: 'fiveHourPct' },
  { metric: 'sevenDay', limitKey: 'sevenDayPct' },
];

// In-memory sliding 60-second RPM window per virtual key id.
const _rpmWindows = new Map();

function budgetPath(ctx) {
  return path.join(ctx.configDir, 'budget.json');
}
function virtualKeysPath(ctx) {
  return path.join(ctx.configDir, 'virtual-keys.json');
}
function cachePath(ctx) {
  return path.join(ctx.configDir, '.usage-cache.json');
}

function validPct(n) {
  return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100;
}

function validKey(name) {
  return name === DEFAULT_KEY || profiles.isValidName(name);
}

function cleanEntry(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  METRICS.forEach(function (m) {
    if (validPct(raw[m.limitKey])) out[m.limitKey] = raw[m.limitKey];
  });
  return out;
}

function sanitize(parsed) {
  const out = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  Object.keys(parsed).forEach(function (k) {
    if (!validKey(k)) return;
    const e = cleanEntry(parsed[k]);
    if (Object.keys(e).length) out[k] = e;
  });
  return out;
}

function readSafe(ctx) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(budgetPath(ctx), 'utf8')));
  } catch (e) {
    return Object.create(null);
  }
}

function get(ctx) {
  return readSafe(ctx);
}

function mergeLimits(cfg, name) {
  const out = Object.create(null);
  [cfg[DEFAULT_KEY], cfg[name]].forEach(function (src) {
    if (src)
      METRICS.forEach(function (m) {
        if (validPct(src[m.limitKey])) out[m.limitKey] = src[m.limitKey];
      });
  });
  return out;
}

function limitsFor(ctx, name) {
  return mergeLimits(readSafe(ctx), name);
}

function persist(ctx, cfg) {
  atomicWrite(budgetPath(ctx), JSON.stringify(cfg, null, 2), 0o600);
}

function setLimit(ctx, name, limits) {
  if (!validKey(name)) throw new Error("invalid account name: '" + name + "'");
  limits = limits || {};
  METRICS.forEach(function (m) {
    const v = limits[m.limitKey];
    if (v !== undefined && v !== null && !validPct(v)) throw new Error(m.limitKey + ' must be a number 0-100');
  });
  const provided = METRICS.some(function (m) {
    return limits[m.limitKey] !== undefined;
  });
  if (!provided) throw new Error('nothing to set — give a 5h and/or 7d ceiling');
  const cfg = sanitize(readJsonForWrite(budgetPath(ctx)));
  const entry = cfg[name] || Object.create(null);
  METRICS.forEach(function (m) {
    const v = limits[m.limitKey];
    if (v === null) delete entry[m.limitKey];
    else if (v !== undefined) entry[m.limitKey] = v;
  });
  if (Object.keys(entry).length) cfg[name] = entry;
  else delete cfg[name];
  persist(ctx, cfg);
  return cfg[name] ? Object.assign({}, cfg[name]) : null;
}

function clear(ctx, name) {
  if (!validKey(name)) throw new Error("invalid account name: '" + name + "'");
  const cfg = sanitize(readJsonForWrite(budgetPath(ctx)));
  if (!(name in cfg)) return false;
  delete cfg[name];
  persist(ctx, cfg);
  return true;
}

function readUsageCache(ctx) {
  const out = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(ctx), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach(function (name) {
        const e = parsed[name];
        if (e && typeof e === 'object') out[name] = e;
      });
    }
  } catch (e) {
    /* missing / corrupt -> no usage known */
  }
  return out;
}

function pctOf(entry, metric) {
  const w = entry && entry.usage && entry.usage[metric];
  return w && typeof w.pct === 'number' && isFinite(w.pct) ? w.pct : null;
}

function candidateNames(cfg, cache) {
  const names = Object.create(null);
  Object.keys(cfg).forEach(function (k) {
    if (k !== DEFAULT_KEY) names[k] = true;
  });
  if (cfg[DEFAULT_KEY])
    Object.keys(cache).forEach(function (k) {
      if (validKey(k) && k !== DEFAULT_KEY) names[k] = true;
    });
  return names;
}

function evaluate(ctx) {
  const cfg = readSafe(ctx);
  const cache = readUsageCache(ctx);
  const names = candidateNames(cfg, cache);
  const out = [];
  Object.keys(names).forEach(function (name) {
    const limits = mergeLimits(cfg, name);
    const entry = cache[name];
    METRICS.forEach(function (m) {
      const limit = limits[m.limitKey];
      if (!validPct(limit)) return;
      const pct = pctOf(entry, m.metric);
      if (pct === null) return;
      if (pct >= limit)
        out.push({ name: name, metric: m.metric, pct: pct, limit: limit, breached: true, level: 'breach' });
      else if (pct >= limit - WARN_MARGIN)
        out.push({ name: name, metric: m.metric, pct: pct, limit: limit, breached: false, level: 'warn' });
    });
  });
  out.sort(function (a, b) {
    if (a.breached !== b.breached) return a.breached ? -1 : 1;
    if (b.pct !== a.pct) return b.pct - a.pct;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

function status(ctx) {
  const cfg = readSafe(ctx);
  const cache = readUsageCache(ctx);
  const alerts = evaluate(ctx);
  const byName = Object.create(null);
  alerts.forEach(function (a) {
    (byName[a.name] || (byName[a.name] = [])).push(a);
  });
  const names = candidateNames(cfg, cache);
  const accounts = Object.keys(names)
    .sort()
    .map(function (name) {
      const limits = mergeLimits(cfg, name);
      const entry = cache[name];
      return {
        name: name,
        limits: {
          fiveHourPct: validPct(limits.fiveHourPct) ? limits.fiveHourPct : null,
          sevenDayPct: validPct(limits.sevenDayPct) ? limits.sevenDayPct : null,
        },
        usage: { fiveHour: pctOf(entry, 'fiveHour'), sevenDay: pctOf(entry, 'sevenDay') },
        alerts: byName[name] || [],
      };
    });
  const def = cfg[DEFAULT_KEY];
  return {
    defaults: def
      ? {
          fiveHourPct: validPct(def.fiveHourPct) ? def.fiveHourPct : null,
          sevenDayPct: validPct(def.sevenDayPct) ? def.sevenDayPct : null,
        }
      : null,
    accounts: accounts,
    alerts: alerts,
    breached: alerts.some(function (a) {
      return a.breached;
    }),
    virtualKeys: listVirtualKeys(ctx),
  };
}

// ---- Virtual Keys (vk_...) ---------------------------------------------------

function nowIso(ctx) {
  return ctx && typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
}

function readVirtualKeysRaw(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(virtualKeysPath(ctx), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

function writeVirtualKeysRaw(ctx, arr) {
  atomicWrite(virtualKeysPath(ctx), JSON.stringify(arr, null, 2), 0o600);
}

function isBoostActive(rec, nowMs) {
  if (!rec || typeof rec.tempBoostUsd !== 'number' || rec.tempBoostUsd <= 0) return false;
  if (!rec.boostExpiresAt) return false;
  const exp = Date.parse(rec.boostExpiresAt);
  if (isNaN(exp)) return false;
  return nowMs <= exp;
}

function decorateVirtualKey(rec, nowMs) {
  const boostActive = isBoostActive(rec, nowMs);
  const activeBoost = boostActive ? rec.tempBoostUsd : 0;
  const maxUsd = typeof rec.maxBudgetUsd === 'number' && isFinite(rec.maxBudgetUsd) ? rec.maxBudgetUsd : null;
  const effectiveBudgetUsd = maxUsd !== null ? Math.round((maxUsd + activeBoost) * 1e6) / 1e6 : null;
  const spentUsd = typeof rec.spentUsd === 'number' && isFinite(rec.spentUsd) ? Math.round(rec.spentUsd * 1e6) / 1e6 : 0;
  const remainingUsd =
    effectiveBudgetUsd !== null ? Math.max(0, Math.round((effectiveBudgetUsd - spentUsd) * 1e6) / 1e6) : null;
  return {
    id: rec.id,
    key: rec.key,
    maskedKey: rec.key ? rec.key.slice(0, 7) + '...' + rec.key.slice(-4) : '',
    label: rec.label || '',
    allowedModels: Array.isArray(rec.allowedModels) ? rec.allowedModels.slice() : ['*'],
    maxBudgetUsd: maxUsd,
    maxBudgetTry: maxUsd !== null ? Math.round(maxUsd * USD_TO_TRY_RATE * 100) / 100 : null,
    tempBoostUsd: boostActive ? rec.tempBoostUsd : 0,
    boostExpiresAt: boostActive ? rec.boostExpiresAt : null,
    boostActive: boostActive,
    effectiveBudgetUsd: effectiveBudgetUsd,
    effectiveBudgetTry: effectiveBudgetUsd !== null ? Math.round(effectiveBudgetUsd * USD_TO_TRY_RATE * 100) / 100 : null,
    spentUsd: spentUsd,
    spentTry: Math.round(spentUsd * USD_TO_TRY_RATE * 100) / 100,
    remainingUsd: remainingUsd,
    modelBudgets: rec.modelBudgets && typeof rec.modelBudgets === 'object' ? Object.assign({}, rec.modelBudgets) : {},
    spentByModel: rec.spentByModel && typeof rec.spentByModel === 'object' ? Object.assign({}, rec.spentByModel) : {},
    rpmLimit: typeof rec.rpmLimit === 'number' && rec.rpmLimit > 0 ? rec.rpmLimit : null,
    status: rec.status || 'active',
    createdAt: rec.createdAt || null,
    revokedAt: rec.revokedAt || null,
  };
}

function createVirtualKey(ctx, opts) {
  opts = opts || {};
  const label = String(opts.label || 'default').trim();
  if (!label) throw new Error('virtual key label is required');
  let maxBudgetUsd = null;
  if (opts.maxBudgetUsd !== undefined && opts.maxBudgetUsd !== null) {
    const n = Number(opts.maxBudgetUsd);
    if (!Number.isFinite(n) || n < 0) throw new Error('maxBudgetUsd must be a non-negative number');
    maxBudgetUsd = n;
  }
  let rpmLimit = null;
  if (opts.rpmLimit !== undefined && opts.rpmLimit !== null) {
    const r = Number(opts.rpmLimit);
    if (!Number.isInteger(r) || r <= 0) throw new Error('rpmLimit must be a positive integer');
    rpmLimit = r;
  }
  let allowedModels = ['*'];
  if (opts.allowedModels) {
    const list = Array.isArray(opts.allowedModels)
      ? opts.allowedModels
      : String(opts.allowedModels)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    if (list.length) allowedModels = list;
  }
  const modelBudgets = {};
  if (opts.modelBudgets && typeof opts.modelBudgets === 'object' && !Array.isArray(opts.modelBudgets)) {
    Object.keys(opts.modelBudgets).forEach(function (m) {
      const v = Number(opts.modelBudgets[m]);
      if (Number.isFinite(v) && v >= 0) modelBudgets[m] = v;
    });
  }
  const id = 'vkid_' + crypto.randomBytes(6).toString('hex');
  const key =
    typeof opts.key === 'string' && opts.key.startsWith('vk_')
      ? opts.key
      : 'vk_' + crypto.randomBytes(16).toString('hex');
  const nowStr = nowIso(ctx);
  const rec = {
    id: id,
    key: key,
    label: label,
    allowedModels: allowedModels,
    maxBudgetUsd: maxBudgetUsd,
    modelBudgets: modelBudgets,
    spentUsd: 0,
    spentByModel: {},
    rpmLimit: rpmLimit,
    tempBoostUsd: 0,
    boostExpiresAt: null,
    status: 'active',
    createdAt: nowStr,
    revokedAt: null,
  };
  const all = readVirtualKeysRaw(ctx);
  all.push(rec);
  writeVirtualKeysRaw(ctx, all);
  const nowMs = Date.parse(nowStr) || Date.now();
  return decorateVirtualKey(rec, nowMs);
}

function listVirtualKeys(ctx, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.parse(nowIso(ctx)) || Date.now();
  return readVirtualKeysRaw(ctx).map(function (r) {
    const d = decorateVirtualKey(r, nowMs);
    if (!opts.includeRawKey) delete d.key;
    return d;
  });
}

function findVirtualKeyIndex(arr, idOrKeyOrLabel) {
  const q = String(idOrKeyOrLabel || '').trim();
  if (!q) return -1;
  return arr.findIndex(function (r) {
    return r.id === q || r.key === q || r.label === q;
  });
}

function revokeVirtualKey(ctx, idOrKey) {
  const all = readVirtualKeysRaw(ctx);
  const idx = findVirtualKeyIndex(all, idOrKey);
  if (idx === -1) throw new Error("no such virtual key: '" + idOrKey + "'");
  all[idx].status = 'revoked';
  all[idx].revokedAt = nowIso(ctx);
  writeVirtualKeysRaw(ctx, all);
  return decorateVirtualKey(all[idx], Date.now());
}

function boostVirtualKeyBudget(ctx, idOrKey, opts) {
  opts = opts || {};
  const amountUsd = Number(opts.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('boost amountUsd must be a positive number');
  }
  const durationMinutes =
    opts.durationMinutes !== undefined && Number.isFinite(Number(opts.durationMinutes)) && Number(opts.durationMinutes) > 0
      ? Number(opts.durationMinutes)
      : 60;
  const all = readVirtualKeysRaw(ctx);
  const idx = findVirtualKeyIndex(all, idOrKey);
  if (idx === -1) throw new Error("no such virtual key: '" + idOrKey + "'");
  if (all[idx].status === 'revoked') throw new Error('cannot boost a revoked virtual key');
  const nowMs = Date.parse(nowIso(ctx)) || Date.now();
  const expiresIso = new Date(nowMs + durationMinutes * 60 * 1000).toISOString();
  all[idx].tempBoostUsd = Math.round(amountUsd * 1e6) / 1e6;
  all[idx].boostExpiresAt = expiresIso;
  writeVirtualKeysRaw(ctx, all);
  return decorateVirtualKey(all[idx], nowMs);
}

function modelMatchesAllowlist(allowedModels, model) {
  if (!Array.isArray(allowedModels) || !allowedModels.length) return true;
  if (allowedModels.indexOf('*') !== -1) return true;
  if (!model) return true;
  const m = String(model).toLowerCase();
  return allowedModels.some(function (pat) {
    const p = String(pat).toLowerCase();
    if (p === '*' || p === m) return true;
    if (p.endsWith('*') && m.startsWith(p.slice(0, -1))) return true;
    return m.indexOf(p) !== -1;
  });
}

function checkVirtualKey(ctx, keyStr, opts) {
  opts = opts || {};
  const k = String(keyStr || '').trim();
  if (!k) return { allowed: false, status: 401, code: 'invalid_virtual_key', reason: 'missing virtual key' };
  const all = readVirtualKeysRaw(ctx);
  const rec = all.find(function (r) {
    return r.key === k || r.id === k;
  });
  if (!rec) {
    return { allowed: false, status: 401, code: 'invalid_virtual_key', reason: 'unrecognized virtual key' };
  }
  if (rec.status === 'revoked') {
    return {
      allowed: false,
      status: 403,
      code: 'virtual_key_revoked',
      reason: "virtual key '" + rec.label + "' has been revoked",
    };
  }
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.parse(nowIso(ctx)) || Date.now();
  const model = opts.model || null;
  if (!modelMatchesAllowlist(rec.allowedModels, model)) {
    return {
      allowed: false,
      status: 403,
      code: 'model_not_allowed',
      reason: "virtual key '" + rec.label + "' is not allowed to call model '" + model + "'",
    };
  }
  const dec = decorateVirtualKey(rec, nowMs);
  if (dec.effectiveBudgetUsd !== null && dec.spentUsd >= dec.effectiveBudgetUsd) {
    return {
      allowed: false,
      status: 429,
      code: 'budget_exceeded',
      reason:
        "virtual key '" +
        rec.label +
        "' budget exhausted ($" +
        dec.spentUsd.toFixed(4) +
        ' / $' +
        dec.effectiveBudgetUsd.toFixed(4) +
        ') — use `keyflip budget vkey boost ' +
        rec.label +
        ' --usd <N>` for a temporary boost',
    };
  }
  if (model && rec.modelBudgets && typeof rec.modelBudgets === 'object') {
    const modelCap = rec.modelBudgets[model];
    const modelSpent = (rec.spentByModel && rec.spentByModel[model]) || 0;
    if (typeof modelCap === 'number' && isFinite(modelCap) && modelSpent >= modelCap) {
      return {
        allowed: false,
        status: 429,
        code: 'model_budget_exceeded',
        reason:
          "virtual key '" +
          rec.label +
          "' model budget exhausted for " +
          model +
          ' ($' +
          modelSpent.toFixed(4) +
          ' / $' +
          modelCap.toFixed(4) +
          ')',
      };
    }
  }
  if (dec.rpmLimit !== null) {
    const winKey = rec.id;
    const prev = (_rpmWindows.get(winKey) || []).filter(function (ts) {
      return nowMs - ts < 60 * 1000;
    });
    if (prev.length >= dec.rpmLimit) {
      _rpmWindows.set(winKey, prev);
      return {
        allowed: false,
        status: 429,
        code: 'rpm_limit_exceeded',
        reason: "virtual key '" + rec.label + "' exceeded RPM limit (" + dec.rpmLimit + ' req/min)',
      };
    }
    if (opts.recordHit !== false) {
      prev.push(nowMs);
      _rpmWindows.set(winKey, prev);
    }
  }
  return {
    allowed: true,
    status: 200,
    record: dec,
    effectiveBudgetUsd: dec.effectiveBudgetUsd,
    remainingUsd: dec.remainingUsd,
  };
}

function recordVirtualKeySpend(ctx, keyStr, opts) {
  opts = opts || {};
  const k = String(keyStr || '').trim();
  if (!k) return null;
  const costUsd = typeof opts.costUsd === 'number' && isFinite(opts.costUsd) && opts.costUsd > 0 ? opts.costUsd : 0;
  const all = readVirtualKeysRaw(ctx);
  const idx = findVirtualKeyIndex(all, k);
  if (idx === -1) return null;
  all[idx].spentUsd = Math.round(((all[idx].spentUsd || 0) + costUsd) * 1e6) / 1e6;
  if (opts.model) {
    all[idx].spentByModel = all[idx].spentByModel || {};
    all[idx].spentByModel[opts.model] =
      Math.round(((all[idx].spentByModel[opts.model] || 0) + costUsd) * 1e6) / 1e6;
  }
  writeVirtualKeysRaw(ctx, all);
  return decorateVirtualKey(all[idx], Date.now());
}

function extractVirtualKeyFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i].toLowerCase();
    const v = headers[keys[i]];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s !== 'string') continue;
    if (k === 'x-keyflip-virtual-key' && s.trim()) return s.trim();
    if (k === 'x-api-key' && s.trim().startsWith('vk_')) return s.trim();
    if (k === 'authorization') {
      const m = /^Bearer\s+(vk_[A-Za-z0-9_-]+)$/i.exec(s.trim());
      if (m) return m[1];
    }
  }
  return null;
}

export {
  get,
  setLimit,
  clear,
  evaluate,
  status,
  limitsFor,
  budgetPath,
  virtualKeysPath,
  createVirtualKey,
  listVirtualKeys,
  revokeVirtualKey,
  boostVirtualKeyBudget,
  checkVirtualKey,
  recordVirtualKeySpend,
  extractVirtualKeyFromHeaders,
  WARN_MARGIN,
  DEFAULT_KEY,
};
