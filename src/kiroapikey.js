// Kiro API key references (`keyflip kiro apikey ...`). The key is the headless
// kiro-cli's KIRO_API_KEY. keyflip never stores the value in its own files: the
// metadata file only names the Keychain service that holds it. A value passed on
// stdin is written to a keyflip-owned Keychain item (`keyflip:kiro-apikey:<name>`)
// by the kfkc helper (stdin, never argv); the helper creates the item, so it is
// the only program that reads it back and macOS never asks. Without a helper
// (no compiler) it falls back to `security -i`. The value is read back in-process
// only by `test`, and handed to the child as KIRO_API_KEY alone.
// KEYFLIP_KEYCHAIN_FILE=<file> (tests) confines every Keychain call to one keychain file.
import fs from 'fs';
import path from 'path';
import { run as defaultRun } from './exec.js';
import { atomicWrite } from './fsutil.js';
import { registerSecret, redact } from './redact.js';
import KeychainStore, { SECURITY } from './stores/keychain.js';
import { ensureHelper } from './kiro.js';
import { active as guardActive, isTempKeychainFile } from './spawnguard.js';

function keychainFile(deps) {
  const f = ((deps && deps.env) || process.env).KEYFLIP_KEYCHAIN_FILE || null;
  return f && (guardActive() || isTempKeychainFile(f)) ? f : null;
}
function helperEnv(deps) {
  const f = keychainFile(deps);
  return f ? Object.assign({}, (deps && deps.env) || process.env, { KFKC_KEYCHAIN: f }) : undefined;
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOLD_PREFIX = 'kiro-api-hold:';
const OWNED_PREFIX = 'keyflip:kiro-apikey:';
const OWNED_ACCOUNT = 'kiro-apikey';
const DEFAULT_TIMEOUT_S = 60;

function err(message, code) {
  const e = /** @type {any} */ (new Error(message));
  e.code = code || 'KIRO_APIKEY';
  return e;
}

function depsOf(d) {
  d = d || {};
  return {
    run: d.run || defaultRun,
    helper: d.helper || null,
    cc: d.cc,
    kiroCli: d.kiroCli || null,
    env: d.env || null,
    noLength: !!d.noLength,
    notify: d.notify || null,
  };
}

function metaDir(ctx) {
  return path.join(ctx.configDir, 'kiro-apikey');
}
function metaFile(ctx, account) {
  return path.join(metaDir(ctx), account + '.json');
}

function checkName(account) {
  if (!NAME_RE.test(String(account || ''))) {
    throw err(
      "invalid account name: '" + redact(String(account || '')) + "' (allowed: A-Z a-z 0-9 . _ -, max 64)",
      'KIRO_APIKEY_NAME',
    );
  }
}

function isHold(service) {
  return (
    String(service || '')
      .toLowerCase()
      .indexOf(HOLD_PREFIX) === 0
  );
}
function refuseHold(service) {
  if (isHold(service)) {
    throw err(
      'refused: Keychain items named "' + HOLD_PREFIX + '*" are reserved and never touched',
      'KIRO_APIKEY_HOLD',
    );
  }
}

function readMeta(ctx, account) {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(ctx, account), 'utf8'));
    if (m && typeof m.service === 'string') return m;
  } catch (e) {
    /* absent or unreadable */
  }
  return null;
}

// Existence only: no -w / -g, so the value is never printed.
function itemExists(service, deps) {
  const f = keychainFile(deps);
  const r = deps.run(SECURITY, ['find-generic-password', '-s', service].concat(f ? [f] : []), undefined, {
    timeoutMs: 5000,
  });
  return r.code === 0;
}

// Byte length via the kfkc helper (value hidden); null when unavailable.
function itemLength(ctx, service, deps) {
  if (deps.noLength) return null;
  // With the real runner in a confined (test) keychain a foreign item is never read: that would make macOS ask.
  if (deps.run === defaultRun && keychainFile(deps) && String(service).indexOf(OWNED_PREFIX) !== 0) return null;
  try {
    const h = ensureHelper(ctx, { run: deps.run, helper: deps.helper, cc: deps.cc });
    if (!h.ok) return null;
    const r = deps.run(h.path, ['stat', service], undefined, { timeoutMs: 10000, env: helperEnv(deps) });
    const m = r && r.code === 0 ? /bytes=(\d+)/.exec(String(r.stdout || '')) : null;
    return m ? parseInt(m[1], 10) : null;
  } catch (e) {
    return null;
  }
}

function writeMeta(ctx, account, meta) {
  atomicWrite(metaFile(ctx, account), JSON.stringify(meta, null, 2) + '\n', 0o600);
}

function nowIso(ctx) {
  return ctx && typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
}

// The helper for keyflip-owned items, or null when it cannot be had (then `security` is the fallback).
function ownedHelper(ctx, deps) {
  try {
    const h = ensureHelper(ctx, { run: deps.run, helper: deps.helper, cc: deps.cc });
    return h.ok ? h.path : null;
  } catch (e) {
    return null;
  }
}

function addByService(ctx, account, service, d) {
  const deps = depsOf(d);
  checkName(account);
  if (!service) throw err('usage: keyflip kiro apikey add <account> --keychain-service <name>', 'KIRO_APIKEY_USAGE');
  refuseHold(service);
  if (!itemExists(service, deps)) {
    throw err('no Keychain item with service "' + service + '"; nothing was recorded', 'KIRO_APIKEY_MISSING');
  }
  // Reading the length of an item another program created makes macOS ask once for permission: say so
  // BEFORE the prompt appears (--no-length skips the read and the prompt altogether).
  if (!deps.noLength && deps.notify) {
    deps.notify(
      'macOS will ask once for permission to read "' +
        service +
        '" (to show its length); choose Always Allow, or use --no-length',
    );
  }
  const meta = { account: account, service: service, owned: false, addedAt: nowIso(ctx) };
  writeMeta(ctx, account, meta);
  return Object.assign({ present: true, bytes: itemLength(ctx, service, deps) }, meta);
}

function addByValue(ctx, account, value, d) {
  const deps = depsOf(d);
  checkName(account);
  const v = String(value == null ? '' : value).replace(/\r?\n$/, '');
  if (!v) throw err('the key read from stdin is empty; nothing was written', 'KIRO_APIKEY_EMPTY');
  registerSecret(v);
  const service = OWNED_PREFIX + account;
  const h = ownedHelper(ctx, deps);
  if (h) {
    const r = deps.run(h, ['put', service, OWNED_ACCOUNT], v, { timeoutMs: 20000, env: helperEnv(deps) });
    if (r.code !== 0)
      throw err('could not write the Keychain item "' + service + '" (kfkc exit ' + r.code + ')', 'KIRO_APIKEY_WRITE');
  } else {
    const store = new KeychainStore({ account: OWNED_ACCOUNT, runner: deps.run });
    store.setProfile('kiro-apikey:' + account, v);
  }
  const meta = { account: account, service: service, owned: true, addedAt: nowIso(ctx) };
  writeMeta(ctx, account, meta);
  return Object.assign({ present: true, bytes: itemLength(ctx, service, deps) }, meta);
}

function listKeys(ctx, d) {
  const deps = depsOf(d);
  let files = [];
  try {
    files = fs.readdirSync(metaDir(ctx)).filter(function (f) {
      return /\.json$/.test(f);
    });
  } catch (e) {
    return [];
  }
  const out = [];
  let told = false;
  files.sort().forEach(function (f) {
    const m = readMeta(ctx, f.replace(/\.json$/, ''));
    if (!m) return;
    const present = !isHold(m.service) && itemExists(m.service, deps);
    if (present && !m.owned && !deps.noLength && deps.notify && !told) {
      told = true;
      deps.notify(
        'macOS may ask once for permission to read a key item made by another program (to show its length); choose Always Allow, or use --no-length',
      );
    }
    out.push({
      account: m.account,
      service: m.service,
      owned: !!m.owned,
      present: present,
      bytes: present ? itemLength(ctx, m.service, deps) : null,
    });
  });
  return out;
}

function removeKey(ctx, account, opts, d) {
  const deps = depsOf(d);
  checkName(account);
  const m = readMeta(ctx, account);
  if (!m) throw err("no such Kiro API key account: '" + account + "'", 'KIRO_APIKEY_NOT_FOUND');
  let deleted = false;
  if (opts && opts.deleteItem) {
    refuseHold(m.service);
    if (m.owned !== true || String(m.service).indexOf(OWNED_PREFIX) !== 0) {
      throw err(
        'refused: "' +
          m.service +
          '" is not a keyflip-owned item; only the reference can be removed (drop --delete-item)',
        'KIRO_APIKEY_FOREIGN',
      );
    }
    const h = ownedHelper(ctx, deps);
    if (h) {
      deps.run(h, ['del', m.service], undefined, { timeoutMs: 20000, env: helperEnv(deps) });
    } else {
      const store = new KeychainStore({ account: OWNED_ACCOUNT, runner: deps.run });
      store.delProfile('kiro-apikey:' + account);
    }
    deleted = true;
  }
  fs.rmSync(metaFile(ctx, account), { force: true });
  return { removed: account, itemDeleted: deleted };
}

function classify(r) {
  const text = String((r.stdout || '') + '\n' + (r.stderr || '')).toLowerCase();
  if (r.timedOut) return 'timeout';
  if (r.error && r.error.code === 'ENOENT') return 'cli missing';
  if (r.code === 0) return 'ok';
  if (/not eligible|plan|subscription|upgrade|entitle/.test(text)) return 'plan not eligible';
  if (/invalid|unauthor|forbidden|reject|denied|expired|\b40[13]\b/.test(text)) return 'rejected';
  return 'failed';
}

function cleanEnv(base, key) {
  const env = {};
  Object.keys(base).forEach(function (k) {
    if (/^(KIRO_|AWS_)/i.test(k)) return;
    env[k] = base[k];
  });
  env.KIRO_API_KEY = key;
  return env;
}

function readValue(ctx, service, deps) {
  if (String(service).indexOf(OWNED_PREFIX) === 0) {
    const h = ownedHelper(ctx, deps);
    if (h) {
      const g = deps.run(h, ['get', service], undefined, { timeoutMs: 10000, env: helperEnv(deps) });
      if (g.code !== 0) return null;
      const gv = String(g.stdout || '').replace(/\r?\n$/, '');
      return gv ? registerSecret(gv) : null;
    }
  }
  const f = keychainFile(deps);
  const r = deps.run(SECURITY, ['find-generic-password', '-s', service, '-w'].concat(f ? [f] : []), undefined, {
    timeoutMs: 5000,
  });
  if (r.code !== 0) return null;
  const v = String(r.stdout || '').replace(/\r?\n$/, '');
  return v ? registerSecret(v) : null;
}

function kiroBinary(ctx, deps) {
  return deps.kiroCli || process.env.KEYFLIP_KIRO_CLI || 'kiro-cli';
}

function testKey(ctx, account, opts, d) {
  const deps = depsOf(d);
  checkName(account);
  const m = readMeta(ctx, account);
  if (!m) throw err("no such Kiro API key account: '" + account + "'", 'KIRO_APIKEY_NOT_FOUND');
  refuseHold(m.service);
  const value = readValue(ctx, m.service, deps);
  if (!value) return { account: account, pass: false, category: 'key missing', credits: null, detail: '' };
  const timeoutS = (opts && opts.timeoutS) || DEFAULT_TIMEOUT_S;
  const r = deps.run(
    kiroBinary(ctx, deps),
    ['chat', '--no-interactive', '--trust-tools=', 'Reply with OK'],
    undefined,
    { timeoutMs: timeoutS * 1000, env: cleanEnv(deps.env || process.env, value) },
  );
  const cat = classify(r);
  const out = redact(String((r.stdout || '') + '\n' + (r.stderr || '')));
  const cm = /^.*\bcredits?\b.*$/im.exec(out);
  return {
    account: account,
    pass: cat === 'ok',
    category: cat === 'ok' ? 'ok' : cat,
    credits: cm ? cm[0].trim().slice(0, 200) : null,
    detail: cat === 'ok' ? '' : out.trim().slice(0, 300),
  };
}

// Split CLI args into positionals and the apikey flags (flag values are not positionals).
function parseArgs(args) {
  const o = {
    positional: [],
    keychainService: null,
    keyFile: null,
    deleteItem: false,
    timeoutS: null,
    noLength: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--keychain-service') o.keychainService = args[++i] || '';
    else if (a === '--key-file') o.keyFile = args[++i] || '';
    else if (a === '--timeout') o.timeoutS = parseInt(args[++i], 10) || null;
    else if (a === '--delete-item') o.deleteItem = true;
    else if (a === '--no-length') o.noLength = true;
    else if (a && a[0] !== '-') o.positional.push(a);
  }
  return o;
}

export {
  NAME_RE,
  HOLD_PREFIX,
  OWNED_PREFIX,
  metaDir,
  metaFile,
  addByService,
  addByValue,
  listKeys,
  removeKey,
  testKey,
  classify,
  cleanEnv,
  parseArgs,
  itemLength as _itemLength,
};
