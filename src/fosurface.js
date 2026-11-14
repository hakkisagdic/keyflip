// §3, §4, §8.2: Failover surface registry, transactional write/probe/rollback,
// crash recovery, Desktop-leak guard, and gateway process scanner.
import crypto from 'crypto';
import { spawn as _nodeSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { run as _run } from './exec.js';
import { atomicWrite, writeJsonStable } from './fsutil.js';
import { _pidAlive } from './lock.js';
import * as _config from './config.js';
import * as _provider from './provider.js';
import * as _settings from './settings.js';
import * as _history from './history.js';
import * as _log from './log.js';
import { redact, registerSecret } from './redact.js';

const TXN_FILE = '.failover-txn.json';
const ENV_FILE = '.failover-env.json';
const STATE_FILE = '.failover-state.json';

// §3 surface registry.
const SURFACES = Object.freeze({
  'cli-launcher': Object.freeze({
    id: 'cli-launcher',
    canUseGateway: true,
    conditional: false,
    how: 'child-env',
    description: 'only in the env of a child claude spawned by keyflip failover run / resume',
  }),
  'cli-settings': Object.freeze({
    id: 'cli-settings',
    canUseGateway: true,
    conditional: true,
    how: 'settings-json',
    description: '~/.claude/settings.json env (URL + token only, no model keys)',
  }),
  desktop: Object.freeze({
    id: 'desktop',
    canUseGateway: false,
    conditional: false,
    how: 'never',
    description: 'not on the gateway (cannot use it)',
  }),
  chrome: Object.freeze({
    id: 'chrome',
    canUseGateway: false,
    conditional: false,
    how: 'never',
    description: 'not on the gateway (cannot use it)',
  }),
});

// Cache `--no-session-persistence` flag support by `<resolvedPath>:<mtimeMs>`.
const helpFlagCache = new Map();

function cfg(ctx, key, dflt) {
  try {
    const v = _config.get(ctx, key);
    return v === undefined || v === null ? dflt : v;
  } catch {
    return dflt;
  }
}

function parseCsv(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function txnPath(ctx) {
  return path.join(ctx.configDir, TXN_FILE);
}
function envPath(ctx) {
  return path.join(ctx.configDir, ENV_FILE);
}
function statePath(ctx) {
  return path.join(ctx.configDir, STATE_FILE);
}

function readTxn(ctx) {
  if (!ctx || !ctx.configDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(txnPath(ctx), 'utf8'));
    return j && typeof j === 'object' && j.v === 1 ? j : null;
  } catch {
    return null;
  }
}

function writeTxn(ctx, rec) {
  atomicWrite(txnPath(ctx), JSON.stringify(rec, null, 2) + '\n', 0o600);
}

function readLauncherEnv(ctx) {
  if (!ctx || !ctx.configDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(envPath(ctx), 'utf8'));
    return j && typeof j === 'object' && j.baseUrl ? j : null;
  } catch {
    return null;
  }
}

// §3: choose `cli-settings` only when `failover.cliTarget === 'settings'`,
// every id in `failover.modelIds` is served by `GET /v1/models`, and
// `failover.desktopLeakGuard` is enabled; otherwise fall back to `cli-launcher`
// with an explicit reason.
function chooseSurface(ctx, gatewayModelIds) {
  const target = cfg(ctx, 'failover.cliTarget', 'launcher');
  if (target !== 'settings') {
    return { surface: 'cli-launcher', fallbackReason: null };
  }
  const guardOn = cfg(ctx, 'failover.desktopLeakGuard', true) === true;
  if (!guardOn) {
    return {
      surface: 'cli-launcher',
      fallbackReason: 'cli-settings requires failover.desktopLeakGuard=true',
    };
  }
  const served = Array.isArray(gatewayModelIds) ? gatewayModelIds : [];
  const required = parseCsv(
    cfg(ctx, 'failover.modelIds', 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5'),
  );
  if (!required.length) {
    return {
      surface: 'cli-launcher',
      fallbackReason: 'cli-settings requires non-empty failover.modelIds',
    };
  }
  const missing = required.filter(function (id) {
    return served.indexOf(id) === -1;
  });
  if (missing.length) {
    return {
      surface: 'cli-launcher',
      fallbackReason: 'gateway does not serve modelIds: ' + missing.join(', '),
    };
  }
  return { surface: 'cli-settings', fallbackReason: null };
}

function statFileMode(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

function makeBackupFile(ctx, startedAt, filePath, backupName) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const dir = path.join(ctx.configDir, 'backups', 'failover', String(startedAt));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, backupName);
  const raw = fs.readFileSync(filePath);
  atomicWrite(dest, raw, 0o600);
  return dest;
}

// §4.2 & §4.3 step 3-4: record `.failover-txn.json` in `phase:"probing"` and
// perform the surface write. Never writes tokens to `.failover-txn.json` or `.failover-env.json`.
function beginTxn(ctx, surface, opts) {
  opts = opts || {};
  const p = opts.plan || {};
  const startedAt = opts.startedAt !== undefined ? opts.startedAt : Date.now();
  const pid = opts.pid !== undefined ? opts.pid : process.pid;
  const providerName = p.provider || cfg(ctx, 'failover.provider', 'keysmith-failover');
  const alias = p.alias || cfg(ctx, 'failover.alias', 'claude-failover');
  const gatewayUrl = String(p.gatewayUrl || cfg(ctx, 'failover.gatewayUrl', 'http://127.0.0.1:8787')).replace(
    /\/+$/,
    '',
  );
  const meta = _provider.read(ctx, providerName);
  const authScheme = meta && meta.authScheme === 'api-key' ? 'api-key' : 'bearer';
  const authKeyName = authScheme === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';

  if (surface === 'cli-launcher') {
    const ep = envPath(ctx);
    const epMode = statFileMode(ep);
    const backup = makeBackupFile(ctx, startedAt, ep, ENV_FILE);
    const modelEnv = {};
    Object.keys(_provider.MODEL_KEYS).forEach(function (role) {
      const envKey = _provider.MODEL_KEYS[role];
      modelEnv[envKey] = (meta && meta.models && meta.models[role]) || alias;
    });
    const keys = ['ANTHROPIC_BASE_URL', authKeyName].concat(Object.keys(modelEnv));
    const wroteEntry = { path: ep, kind: 'launcher-env', keys: keys, backup: backup };
    if (epMode !== null) wroteEntry.mode = epMode;
    const txnRec = {
      v: 1,
      pid: pid,
      surface: 'cli-launcher',
      phase: 'probing',
      startedAt: startedAt,
      wrote: [wroteEntry],
      probe: null,
    };
    writeTxn(ctx, txnRec);
    const envPayload = {
      baseUrl: (meta && meta.baseUrl) || gatewayUrl,
      provider: providerName,
      authScheme: authScheme,
      modelEnv: modelEnv,
      tokenRef: 'provider__' + providerName,
    };
    atomicWrite(ep, JSON.stringify(envPayload, null, 2) + '\n', 0o600);
    return txnRec;
  }

  if (surface === 'cli-settings') {
    const settingsFile = ctx.claudeSettingsPath;
    const activeFile = _provider.activePath(ctx);
    const settingsMode = statFileMode(settingsFile);
    const activeMode = statFileMode(activeFile);
    const settingsBackup = makeBackupFile(ctx, startedAt, settingsFile, 'settings.json');
    const activeBackup = makeBackupFile(ctx, startedAt, activeFile, 'provider-active.json');
    let preEnvKeys = [];
    if (settingsBackup) {
      try {
        const preCfg = JSON.parse(fs.readFileSync(settingsBackup, 'utf8'));
        if (preCfg && preCfg.env && typeof preCfg.env === 'object') {
          preEnvKeys = Object.keys(preCfg.env);
        }
      } catch {
        preEnvKeys = [];
      }
    }
    const initialKeys = ['ANTHROPIC_BASE_URL', authKeyName];
    const priorKeys = preEnvKeys.filter(function (k) {
      return _provider.ALL_MANAGED.indexOf(k) !== -1 || initialKeys.indexOf(k) !== -1;
    });
    const settingsWrote = {
      path: settingsFile,
      kind: 'settings-env',
      keys: initialKeys,
      priorKeys: priorKeys,
      backup: settingsBackup,
    };
    if (settingsMode !== null) settingsWrote.mode = settingsMode;
    const activeWrote = {
      path: activeFile,
      kind: 'provider-active',
      keys: [],
      backup: activeBackup,
    };
    if (activeMode !== null) activeWrote.mode = activeMode;
    const wrote = [settingsWrote, activeWrote];
    const txnRec = {
      v: 1,
      pid: pid,
      surface: 'cli-settings',
      phase: 'probing',
      startedAt: startedAt,
      priorKeys: priorKeys,
      wrote: wrote,
      probe: null,
    };
    writeTxn(ctx, txnRec);
    const useFn =
      opts.useProvider ||
      function (name, uopts) {
        return _provider.use(ctx, name, uopts);
      };
    try {
      const res = useFn(providerName, { models: false });
      if (res && Array.isArray(res.injected)) {
        txnRec.wrote[0].keys = res.injected.slice();
        const updatedPrior = preEnvKeys.filter(function (k) {
          return _provider.ALL_MANAGED.indexOf(k) !== -1 || txnRec.wrote[0].keys.indexOf(k) !== -1;
        });
        txnRec.wrote[0].priorKeys = updatedPrior;
        txnRec.priorKeys = updatedPrior;
        writeTxn(ctx, txnRec);
      }
    } catch (e) {
      rollbackTxn(ctx, txnRec, {
        at: startedAt,
        ok: false,
        ms: 0,
        models: [],
        reason: redact((e && e.message) || String(e)).slice(0, 160),
        costUsd: null,
      });
      throw e;
    }
    return txnRec;
  }

  throw new Error("surface '" + surface + "' cannot use the failover gateway");
}

function commitTxn(ctx, txnRec, probeSummary) {
  const next = Object.assign({}, txnRec, {
    phase: 'kept',
    probe: probeSummary || null,
  });
  writeTxn(ctx, next);
  return next;
}

function cleanupBackupDir(txnRec) {
  if (!txnRec || !Array.isArray(txnRec.wrote)) return;
  const dirs = new Set();
  txnRec.wrote.forEach(function (w) {
    if (!w || !w.backup) return;
    dirs.add(path.dirname(w.backup));
    try {
      fs.unlinkSync(w.backup);
    } catch {
      /* ignore */
    }
  });
  dirs.forEach(function (d) {
    try {
      fs.rmdirSync(d);
    } catch {
      /* non-empty or gone */
    }
  });
}

function rollbackTxn(ctx, txnRec, probeSummary, opts) {
  opts = opts || {};
  if (!txnRec || !Array.isArray(txnRec.wrote)) return null;
  const isKept = !!opts.kept || txnRec.phase === 'kept';
  for (let i = txnRec.wrote.length - 1; i >= 0; i--) {
    const w = txnRec.wrote[i];
    if (!w || !w.path) continue;
    const mode = typeof w.mode === 'number' ? w.mode : 0o600;
    if (isKept && w.kind === 'settings-env') {
      if (fs.existsSync(w.path)) {
        try {
          const cfgObj = _settings.read(w.path);
          let backupEnv = null;
          if (w.backup && fs.existsSync(w.backup)) {
            try {
              const bObj = JSON.parse(fs.readFileSync(w.backup, 'utf8'));
              if (bObj && bObj.env && typeof bObj.env === 'object') backupEnv = bObj.env;
            } catch {
              backupEnv = null;
            }
          }
          if (cfgObj && typeof cfgObj === 'object') {
            if (cfgObj.env && typeof cfgObj.env === 'object') {
              (Array.isArray(w.keys) ? w.keys : []).forEach(function (k) {
                delete cfgObj.env[k];
              });
            }
            const pKeys = Array.isArray(w.priorKeys)
              ? w.priorKeys
              : Array.isArray(txnRec.priorKeys)
                ? txnRec.priorKeys
                : [];
            if (pKeys.length && backupEnv) {
              if (!cfgObj.env || typeof cfgObj.env !== 'object') cfgObj.env = {};
              pKeys.forEach(function (pk) {
                if (Object.prototype.hasOwnProperty.call(backupEnv, pk)) {
                  cfgObj.env[pk] = backupEnv[pk];
                }
              });
            }
            if (cfgObj.env && typeof cfgObj.env === 'object' && !Object.keys(cfgObj.env).length) {
              delete cfgObj.env;
            }
            writeJsonStable(w.path, cfgObj, mode);
          }
        } catch {
          /* best effort */
        }
      }
      continue;
    }
    if (w.backup === null || w.backup === undefined) {
      try {
        fs.unlinkSync(w.path);
      } catch {
        /* already absent */
      }
    } else if (fs.existsSync(w.backup)) {
      try {
        const raw = fs.readFileSync(w.backup);
        atomicWrite(w.path, raw, mode);
      } catch {
        /* best effort */
      }
    } else {
      _log.log('failover: rollback warning — backup missing for ' + w.path + '; leaving file untouched');
    }
  }
  cleanupBackupDir(txnRec);
  const next = Object.assign({}, txnRec, {
    phase: 'rolled-back',
    probe: probeSummary !== undefined ? probeSummary : txnRec.probe || null,
  });
  writeTxn(ctx, next);
  return next;
}

function rollbackKeptTxn(ctx, txnRec, probeSummary) {
  return rollbackTxn(ctx, txnRec, probeSummary, { kept: true });
}

function maxProbeLimitMs(ctx) {
  const timeoutSec = Math.max(1, Number(cfg(ctx, 'failover.probeTimeoutSeconds', 90)) || 90);
  const extraModels = parseCsv(cfg(ctx, 'failover.probeModels', 'sonnet'));
  const numModels = extraModels.length + 1;
  return (timeoutSec * numModels * 2 + 60) * 1000;
}

// §4.2: a record left in `phase:"probing"` (crash mid-transaction) is rolled back
// by the next tick before anything else, only when the owner process is gone or past the probe limit.
function recoverCrashedTxn(ctx, opts) {
  opts = opts || {};
  if (!ctx || !ctx.configDir) return { rolledBack: false };
  const txnRec = readTxn(ctx);
  if (!txnRec || txnRec.phase !== 'probing') return { rolledBack: false };
  const nowMs =
    opts.nowMs !== undefined ? opts.nowMs : ctx && ctx.nowMs !== undefined ? ctx.nowMs : Date.now();
  const pidAliveFn =
    typeof opts.pidAlive === 'function'
      ? opts.pidAlive
      : ctx && typeof ctx.pidAlive === 'function'
        ? ctx.pidAlive
        : _pidAlive;
  const limitMs = maxProbeLimitMs(ctx);
  const startedAt = typeof txnRec.startedAt === 'number' && isFinite(txnRec.startedAt) ? txnRec.startedAt : 0;
  const withinLimit = startedAt > 0 && nowMs - startedAt <= limitMs;
  const hasPid = typeof txnRec.pid === 'number' && isFinite(txnRec.pid) && txnRec.pid > 0;
  const ownerAlive = hasPid ? !!pidAliveFn(txnRec.pid) : false;

  if (!opts.force) {
    if (hasPid && ownerAlive && withinLimit) {
      return { rolledBack: false, skipped: 'in-progress' };
    }
    if (!hasPid && withinLimit) {
      return { rolledBack: false, skipped: 'in-progress' };
    }
  }

  rollbackTxn(ctx, txnRec, {
    at: nowMs,
    ok: false,
    ms: 0,
    models: [],
    reason: 'crash-recovery',
    costUsd: null,
  });
  _log.log('failover: rolled back unfinished transaction (' + txnRec.surface + ')');
  _history.recordEvent(ctx, {
    kind: 'failover-txn-rollback',
    surface: txnRec.surface,
    reason: 'crashed mid-probe transaction rolled back',
  });
  return { rolledBack: true, surface: txnRec.surface };
}

// Build child environment for `surface`:
// - `cli-launcher`: user's env minus every `ANTHROPIC_*` key + launcher env (with token from store)
// - `cli-settings`: user's env minus every `ANTHROPIC_*` key (child inherits settings.json)
// When `opts.forceGateway` is true and `.failover-env.json` is absent, synthesizes the launcher
// env in memory from the failover provider metadata without writing anything to disk.
function buildChildEnv(ctx, surface, baseEnv, opts) {
  opts = opts || {};
  const src = baseEnv || process.env;
  const clean = {};
  Object.keys(src).forEach(function (k) {
    if (/^ANTHROPIC_/.test(k)) return;
    if (src[k] !== undefined) clean[k] = src[k];
  });
  if (ctx && ctx.home) clean.HOME = ctx.home;
  if (surface === 'cli-settings') return clean;
  if (surface !== 'cli-launcher') {
    throw new Error("surface '" + surface + "' cannot spawn gateway child");
  }
  let envRec = readLauncherEnv(ctx);
  if (!envRec && opts.forceGateway) {
    const p = opts.plan || {};
    const providerName = p.provider || cfg(ctx, 'failover.provider', 'keysmith-failover');
    const alias = p.alias || cfg(ctx, 'failover.alias', 'claude-failover');
    const gatewayUrl = String(p.gatewayUrl || cfg(ctx, 'failover.gatewayUrl', 'http://127.0.0.1:8787')).replace(
      /\/+$/,
      '',
    );
    const meta = _provider.read(ctx, providerName);
    const authScheme = meta && meta.authScheme === 'api-key' ? 'api-key' : 'bearer';
    const modelEnv = {};
    Object.keys(_provider.MODEL_KEYS).forEach(function (role) {
      const envKey = _provider.MODEL_KEYS[role];
      modelEnv[envKey] = (meta && meta.models && meta.models[role]) || alias;
    });
    envRec = {
      baseUrl: (meta && meta.baseUrl) || gatewayUrl,
      provider: providerName,
      authScheme: authScheme,
      modelEnv: modelEnv,
      tokenRef: 'provider__' + providerName,
    };
  }
  if (!envRec) throw new Error('missing .failover-env.json for cli-launcher');
  let token;
  try {
    token = registerSecret(ctx.store.getProfile(envRec.tokenRef));
  } catch (e) {
    throw new Error('could not read gateway key from store: ' + ((e && e.message) || String(e)), { cause: e });
  }
  if (!token) throw new Error('no gateway key stored at ' + envRec.tokenRef);
  clean.ANTHROPIC_BASE_URL = envRec.baseUrl;
  const authKey = envRec.authScheme === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  clean[authKey] = token;
  if (envRec.modelEnv && typeof envRec.modelEnv === 'object') {
    Object.keys(envRec.modelEnv).forEach(function (k) {
      if (envRec.modelEnv[k]) clean[k] = envRec.modelEnv[k];
    });
  }
  return clean;
}

function supportsNoSessionPersistence(ctx, claudeBin, deps) {
  if (deps && typeof deps.supportsNoSessionPersistence === 'boolean') {
    return deps.supportsNoSessionPersistence;
  }
  const runner = (deps && deps.run) || (ctx && ctx.run) || null;
  if (!runner && process.env.KEYFLIP_TEST_OFFLINE === '1') {
    return true;
  }
  const runFn = runner || _run;
  let binKey = claudeBin;
  try {
    const w = runFn('which', [claudeBin], undefined, { timeoutMs: 3000 });
    const resolved = w && w.code === 0 ? String(w.stdout || '').trim().split('\n')[0] : '';
    if (resolved) {
      const st = fs.statSync(resolved);
      binKey = resolved + ':' + Math.floor(st.mtimeMs);
    }
  } catch {
    binKey = claudeBin;
  }
  if (helpFlagCache.has(binKey)) return helpFlagCache.get(binKey);
  let supported;
  try {
    const h = runFn(claudeBin, ['--help'], undefined, { timeoutMs: 5000 });
    supported = !!(h && String((h.stdout || '') + (h.stderr || '')).indexOf('--no-session-persistence') !== -1);
  } catch {
    supported = false;
  }
  helpFlagCache.set(binKey, supported);
  return supported;
}

function trashProbeTranscript(ctx, sessionId) {
  if (!ctx || !sessionId) return;
  const projectsDir = path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  dirs.forEach(function (ent) {
    if (!ent.isDirectory()) return;
    const f = path.join(projectsDir, ent.name, sessionId + '.jsonl');
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  });
}

function parseQuotaResetAt(text, nowMs) {
  const m = /resets in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(
    String(text || ''),
  );
  if (!m) return null;
  const d = m[1] ? parseInt(m[1], 10) : 0;
  const h = m[2] ? parseInt(m[2], 10) : 0;
  const min = m[3] ? parseInt(m[3], 10) : 0;
  const sec = m[4] ? parseInt(m[4], 10) : 0;
  const deltaSec = d * 86400 + h * 3600 + min * 60 + sec;
  if (!deltaSec || !isFinite(deltaSec)) return null;
  const base = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
  return new Date(base + deltaSec * 1000).toISOString();
}

function parseClaudeJsonOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object') return j;
  } catch {
    // Try last JSON object line if CLI emitted preamble lines.
  }
  const lines = s.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line[0] !== '{') continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object') return j;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

// §4.3 step 5 & §9: classify probe failure without ever keeping raw output
// (classified reason + at most 160 redacted chars).
function classifyProbeFailure(res, opts) {
  opts = opts || {};
  if (res && res.timedOut) {
    return { class: 'timeout', reason: 'timeout', resetAt: null };
  }
  const parsed = parseClaudeJsonOutput(res && res.stdout);
  const extraJsonText =
    parsed && typeof parsed === 'object'
      ? [parsed.result, parsed.error && (parsed.error.message || parsed.error)].filter(Boolean).join(' ')
      : '';
  const combined = [res && res.stderr, extraJsonText, res && res.stdout]
    .filter(function (x) {
      return typeof x === 'string' && x.trim();
    })
    .join(' ');
  const resetAt = parseQuotaResetAt(combined, opts.nowMs);
  // eslint-disable-next-line no-control-regex
  const safeText = redact(combined).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

  let cls = 'other';
  if (/at most 128\b|too many tools/i.test(combined)) {
    cls = 'too-many-tools';
  } else if (/quota reached|out of quota|usage limit|rate[ -]?limit|resets in\s+\d/i.test(combined)) {
    cls = 'quota';
  } else if (/model_not_found|model not found|\b404\b/i.test(combined)) {
    cls = 'model-not-found';
  } else if (/\b(401|403)\b|unauthorized|invalid[ _-]?api[ _-]?key|authentication[ _-]?error|forbidden/i.test(combined)) {
    cls = 'auth';
  }

  const snippetBudget = Math.max(0, 160 - cls.length - 2);
  const snippet = safeText.slice(0, snippetBudget).trim();
  const reason = snippet ? (cls + ': ' + snippet).slice(0, 160) : cls;
  return { class: cls, reason: reason, resetAt: resetAt };
}

function runSpawnWithTimeout(spawnFn, cmd, args, spawnOpts, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child = null;
    let timer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    try {
      child = spawnFn(cmd, args, spawnOpts);
    } catch (e) {
      finish({
        timedOut: false,
        code: 1,
        stdout: '',
        stderr: (e && e.message) || String(e),
      });
      return;
    }

    if (child && child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', function (chunk) {
        if (stdout.length < 65536) stdout += String(chunk);
      });
    }
    if (child && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', function (chunk) {
        if (stderr.length < 65536) stderr += String(chunk);
      });
    }
    if (child && typeof child.on === 'function') {
      child.on('error', function (err) {
        finish({
          timedOut: false,
          code: 1,
          stdout: stdout,
          stderr: stderr + '\n' + ((err && err.message) || String(err)),
        });
      });
      const onDone = function (code) {
        finish({
          timedOut: false,
          code: typeof code === 'number' ? code : 1,
          stdout: stdout,
          stderr: stderr,
        });
      };
      child.on('close', onDone);
      child.on('exit', onDone);
    }

    timer = setTimeout(function () {
      if (settled) return;
      if (child && typeof child.kill === 'function') {
        try {
          child.kill('SIGKILL');
        } catch {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
      }
      finish({
        timedOut: true,
        code: null,
        stdout: stdout,
        stderr: stderr,
      });
    }, timeoutMs);
  });
}

// §4.3 step 5: probe `surface` with real `claude -p` inference (default + each `failover.probeModels`).
async function probe(ctx, surface, deps) {
  deps = deps || {};
  const nowFn =
    deps.now ||
    function () {
      return Date.now();
    };
  const t0 = nowFn();
  const spawnFn = deps.spawn || (ctx && ctx.spawn) || null;
  if (!spawnFn && process.env.KEYFLIP_TEST_OFFLINE === '1') {
    return {
      at: t0,
      ok: false,
      ms: 0,
      models: [],
      class: 'other',
      reason: 'other: offline test without fake spawn',
      costUsd: null,
      costLabel: 'CLI estimate',
    };
  }
  const actualSpawn = spawnFn || _nodeSpawn;
  let childEnv;
  try {
    childEnv = buildChildEnv(ctx, surface, deps.env, {
      forceGateway: !!deps.forceGateway,
      plan: deps.plan,
    });
  } catch (e) {
    const safeErr = redact((e && e.message) || String(e)).slice(0, 150);
    return {
      at: t0,
      ok: false,
      ms: Math.max(0, nowFn() - t0),
      models: [],
      class: 'other',
      reason: ('other: ' + safeErr).slice(0, 160),
      costUsd: null,
      costLabel: 'CLI estimate',
    };
  }

  const claudeBin = deps.claudeBin || 'claude';
  const noPersist = supportsNoSessionPersistence(ctx, claudeBin, deps);
  const timeoutSec = cfg(ctx, 'failover.probeTimeoutSeconds', 90);
  const timeoutMs =
    deps.timeoutMs !== undefined ? deps.timeoutMs : Math.max(1, Number(timeoutSec) || 90) * 1000;
  const mcpCfg = String(cfg(ctx, 'failover.mcpConfig', '') || '').trim();
  const extraModels = parseCsv(cfg(ctx, 'failover.probeModels', 'sonnet'));
  const modelPlan = [null].concat(extraModels);
  const passedModels = [];
  let totalCostUsd = 0;
  let sawCost = false;

  for (let i = 0; i < modelPlan.length; i++) {
    const modelArg = modelPlan[i];
    const modelLabel = modelArg || 'default';
    const tempSessionId = noPersist ? null : crypto.randomUUID();
    const args = ['-p', 'Reply with exactly: OK', '--output-format', 'json', '--max-turns', '1'];
    if (noPersist) args.push('--no-session-persistence');
    else args.push('--session-id', tempSessionId);
    if (mcpCfg) args.push('--strict-mcp-config', '--mcp-config', mcpCfg);
    if (modelArg) args.push('--model', modelArg);

    let res;
    try {
      res = await runSpawnWithTimeout(
        actualSpawn,
        claudeBin,
        args,
        { cwd: ctx.home, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
        timeoutMs,
      );
    } finally {
      childEnv && void 0;
      if (tempSessionId) trashProbeTranscript(ctx, tempSessionId);
    }

    const parsed = !res.timedOut && res.code === 0 ? parseClaudeJsonOutput(res.stdout) : null;
    const resultText =
      parsed && typeof parsed === 'object' && parsed.result !== undefined ? String(parsed.result) : '';
    const isErr = !!(parsed && parsed.is_error);
    const passed = !res.timedOut && res.code === 0 && parsed && !isErr && /\bOK\b/.test(resultText);

    if (!passed) {
      const classified = classifyProbeFailure(res, { nowMs: nowFn() });
      return {
        at: t0,
        ok: false,
        ms: Math.max(0, nowFn() - t0),
        models: passedModels,
        failedModel: modelLabel,
        class: classified.class,
        reason: classified.reason,
        resetAt: classified.resetAt || null,
        costUsd: sawCost ? Math.round(totalCostUsd * 1e6) / 1e6 : null,
        costLabel: 'CLI estimate',
      };
    }

    passedModels.push(modelLabel);
    if (typeof parsed.total_cost_usd === 'number' && isFinite(parsed.total_cost_usd)) {
      totalCostUsd += parsed.total_cost_usd;
      sawCost = true;
    }
  }

  const deepChecks = [];
  if (deps.deep) {
    const deepSteps = [
      {
        id: 'bash',
        args: ['-p', 'run: echo hi', '--allowedTools', 'Bash', '--output-format', 'json', '--max-turns', '3'],
      },
      {
        id: 'subagent',
        args: [
          '-p',
          'Use a sonnet general-purpose subagent to reply with PONG, then reply with PONG',
          '--output-format',
          'json',
          '--max-turns',
          '4',
        ],
      },
    ];
    for (let d = 0; d < deepSteps.length; d++) {
      const step = deepSteps[d];
      const tempSessionId = noPersist ? null : crypto.randomUUID();
      const dArgs = step.args.slice();
      if (noPersist) dArgs.push('--no-session-persistence');
      else dArgs.push('--session-id', tempSessionId);
      if (mcpCfg) dArgs.push('--strict-mcp-config', '--mcp-config', mcpCfg);

      let res;
      try {
        res = await runSpawnWithTimeout(
          actualSpawn,
          claudeBin,
          dArgs,
          { cwd: ctx.home, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
          timeoutMs,
        );
      } finally {
        if (tempSessionId) trashProbeTranscript(ctx, tempSessionId);
      }

      const parsed = !res.timedOut && res.code === 0 ? parseClaudeJsonOutput(res.stdout) : null;
      const resultText =
        parsed && typeof parsed === 'object' && parsed.result !== undefined ? String(parsed.result).trim() : '';
      const isErr = !!(parsed && parsed.is_error);
      const passed = !res.timedOut && res.code === 0 && parsed && !isErr && resultText.length > 0;

      if (!passed) {
        const classified = classifyProbeFailure(res, { nowMs: nowFn() });
        return {
          at: t0,
          ok: false,
          ms: Math.max(0, nowFn() - t0),
          models: passedModels,
          deepChecks: deepChecks,
          failedModel: step.id,
          class: classified.class,
          reason: classified.reason,
          resetAt: classified.resetAt || null,
          costUsd: sawCost ? Math.round(totalCostUsd * 1e6) / 1e6 : null,
          costLabel: 'CLI estimate',
        };
      }

      deepChecks.push(step.id);
      if (typeof parsed.total_cost_usd === 'number' && isFinite(parsed.total_cost_usd)) {
        totalCostUsd += parsed.total_cost_usd;
        sawCost = true;
      }
    }
  }

  const okOut = {
    at: t0,
    ok: true,
    ms: Math.max(0, nowFn() - t0),
    models: passedModels,
    reason: null,
    costUsd: sawCost ? Math.round(totalCostUsd * 1e6) / 1e6 : 0,
    costLabel: 'CLI estimate',
  };
  if (deps.deep) okOut.deepChecks = deepChecks;
  return okOut;
}

// Parse `ps -Ewwo pid=,lstart=,command=` into `{ pid, startedAt, command, env }`.
function parsePsOutput(stdout) {
  const rows = [];
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let m = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) {
      m = /^\s*(\d+)\s+(\d{4}-\d{2}-\d{2}\S*|\d{10,13})\s+(.*)$/.exec(line);
    }
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const rawStart = m[2];
    const startedAt = /^\d+$/.test(rawStart) ? parseInt(rawStart, 10) : Date.parse(rawStart);
    const rest = m[3];
    const env = Object.create(null);
    const envRe = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=([^\s]*)/g;
    let em;
    let firstEnvIdx = -1;
    while ((em = envRe.exec(rest)) !== null) {
      if (firstEnvIdx === -1) firstEnvIdx = em.index;
      env[em[1]] = em[2];
    }
    const cmdPart = (firstEnvIdx > 0 ? rest.slice(0, firstEnvIdx) : rest).trim();
    rows.push({
      pid: pid,
      startedAt: isFinite(startedAt) ? startedAt : null,
      command: cmdPart,
      env: env,
    });
  }
  return rows;
}

// §4.4 default process lister (`ps -axEwwo pid=,lstart=,command=`).
function listProcesses(opts) {
  opts = opts || {};
  if (!opts.run && process.env.KEYFLIP_TEST_OFFLINE === '1') return [];
  const runner = opts.run || _run;
  const r = runner('ps', ['-axEwwo', 'pid=,lstart=,command='], undefined, {
    timeoutMs: 8000,
    env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }),
  });
  if (!r || r.code !== 0) return [];
  return parsePsOutput(r.stdout);
}

function normalizeStartedAtMs(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = /^\d+$/.test(v) ? parseInt(v, 10) : Date.parse(v);
    return isFinite(t) ? t : null;
  }
  return null;
}

function gatewayKeyHashOf(ctx, providerName) {
  let gwKey;
  try {
    gwKey = registerSecret(ctx.store.getProfile('provider__' + providerName));
  } catch {
    gwKey = null;
  }
  if (!gwKey) return null;
  return sha256Hex(gwKey);
}

// §4.4: Desktop-leak guard (only while `cli-settings` is kept).
// Lists processes, checks `CLAUDE_CODE_ENTRYPOINT=claude-desktop` started after
// `txn.startedAt` for `ANTHROPIC_*MODEL === alias` or `sha256(token) === sha256(gatewayKey)`,
// drops env values immediately, and on violation rolls `cli-settings` back to `cli-launcher`
// as a new transaction + records `failover-desktop-leak` + notifies.
async function checkDesktopLeak(ctx, deps) {
  deps = deps || {};
  if (!ctx || !ctx.configDir) return { leaked: false, pids: [] };
  if (cfg(ctx, 'failover.desktopLeakGuard', true) !== true) return { leaked: false, pids: [] };

  let st;
  try {
    st = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'));
  } catch {
    st = null;
  }
  const txnRec = readTxn(ctx);
  const onCliSettings =
    (st && st.engaged && st.surface === 'cli-settings') ||
    (txnRec && txnRec.phase === 'kept' && txnRec.surface === 'cli-settings');
  if (!onCliSettings) return { leaked: false, pids: [] };

  const startedAfter =
    txnRec && typeof txnRec.startedAt === 'number'
      ? txnRec.startedAt
      : st && typeof st.at === 'number'
        ? st.at
        : 0;
  const alias = (st && st.alias) || cfg(ctx, 'failover.alias', 'claude-failover');
  const providerName = (st && st.provider) || cfg(ctx, 'failover.provider', 'keysmith-failover');
  const gwKeyHash = gatewayKeyHashOf(ctx, providerName);

  const lister = deps.listProcesses || (ctx && ctx.listProcesses) || null;
  const procs = lister ? await lister() : listProcesses({ run: deps.run || (ctx && ctx.run) });
  const leakedPids = [];

  for (let i = 0; i < procs.length; i++) {
    const proc = procs[i];
    if (!proc || !proc.env || typeof proc.env !== 'object') continue;
    const env = proc.env;
    const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
    const procStart = normalizeStartedAtMs(proc.startedAt);
    if (entrypoint === 'claude-desktop' && procStart !== null && procStart > startedAfter) {
      let violated = false;
      const envKeys = Object.keys(env);
      for (let k = 0; k < envKeys.length; k++) {
        const name = envKeys[k];
        if (/^ANTHROPIC_.*MODEL$/.test(name) && env[name] === alias) {
          violated = true;
          break;
        }
      }
      if (!violated && gwKeyHash) {
        const authTok = env.ANTHROPIC_AUTH_TOKEN;
        const apiKey = env.ANTHROPIC_API_KEY;
        if (
          (typeof authTok === 'string' && authTok && sha256Hex(authTok) === gwKeyHash) ||
          (typeof apiKey === 'string' && apiKey && sha256Hex(apiKey) === gwKeyHash)
        ) {
          violated = true;
        }
      }
      if (violated && typeof proc.pid === 'number') leakedPids.push(proc.pid);
    }
    // Drop env values from our view immediately after checking/hashing.
    procs[i] = null;
  }

  if (!leakedPids.length) return { leaked: false, pids: [] };

  const nowMs = deps.nowMs !== undefined ? deps.nowMs : Date.now();
  // 1) Roll back the `cli-settings` transaction (key-wise removal for kept txn).
  if (txnRec) {
    rollbackKeptTxn(ctx, txnRec, txnRec.probe || null);
  } else {
    try {
      _provider.useOfficial(ctx);
    } catch {
      /* best effort */
    }
  }

  // 2) Start a new `cli-launcher` transaction.
  let launcherProbe;
  const newTxn = beginTxn(ctx, 'cli-launcher', {
    startedAt: nowMs,
    plan: {
      provider: providerName,
      alias: alias,
      gatewayUrl: cfg(ctx, 'failover.gatewayUrl', 'http://127.0.0.1:8787'),
    },
  });
  const probeEnabled = cfg(ctx, 'failover.probeEnabled', true) !== false;
  if (probeEnabled) {
    const pRes = await probe(ctx, 'cli-launcher', {
      spawn: deps.spawn || (ctx && ctx.spawn),
      run: deps.run || (ctx && ctx.run),
      env: deps.env,
      now: function () {
        return nowMs;
      },
      timeoutMs: deps.probeTimeoutMs,
    });
    launcherProbe = {
      at: pRes.at,
      ok: pRes.ok,
      ms: pRes.ms,
      models: pRes.models,
      reason: pRes.reason || null,
      costUsd: pRes.costUsd,
    };
  } else {
    launcherProbe = { at: nowMs, ok: true, ms: 0, models: [], reason: null, costUsd: null };
  }
  commitTxn(ctx, newTxn, launcherProbe);

  const degraded = !launcherProbe.ok
    ? { at: nowMs, reason: launcherProbe.reason || 'cli-launcher probe failed' }
    : null;

  if (st && st.engaged) {
    const nextState = Object.assign({}, st, {
      surface: 'cli-launcher',
      txn: launcherProbe,
      fallbackReason: 'desktop-leak (' + leakedPids.join(', ') + ')',
    });
    if (degraded) nextState.degraded = degraded;
    else delete nextState.degraded;
    atomicWrite(statePath(ctx), JSON.stringify(nextState, null, 2) + '\n', 0o600);
  }

  _history.recordEvent(ctx, {
    kind: 'failover-desktop-leak',
    pids: leakedPids,
    from: 'cli-settings',
    to: 'cli-launcher',
  });

  const msg = degraded
    ? 'Claude Desktop picked up gateway env (pid ' +
      leakedPids.join(', ') +
      ') — rolled failover back from settings.json to cli-launcher (degraded: ' +
      degraded.reason +
      ').'
    : 'Claude Desktop picked up gateway env (pid ' +
      leakedPids.join(', ') +
      ') — rolled failover back from settings.json to cli-launcher.';
  _log.log('failover: ' + msg);
  if (typeof deps.notify === 'function') {
    try {
      await deps.notify('quota', msg);
    } catch {
      /* notify never breaks tick */
    }
  }

  const leakOut = {
    leaked: true,
    pids: leakedPids,
    surface: 'cli-launcher',
  };
  if (degraded) leakOut.degraded = degraded;
  return leakOut;
}

function resolvePidCwd(pid, proc, opts) {
  if (typeof opts.lsof === 'function') {
    try {
      return opts.lsof(pid) || null;
    } catch {
      return null;
    }
  }
  if (proc && typeof proc.cwd === 'string' && proc.cwd) return proc.cwd;
  if (!opts.run && process.env.KEYFLIP_TEST_OFFLINE === '1') return null;
  const runner = opts.run || _run;
  let r;
  try {
    r = runner('lsof', ['-a', '-d', 'cwd', '-p', String(pid)], undefined, { timeoutMs: 3000 });
  } catch {
    return null;
  }
  if (!r || r.code !== 0 || !r.stdout) return null;
  const lines = String(r.stdout).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^COMMAND\s/i.test(line)) continue;
    if (line[0] === 'n' && line[1] === '/') return line.slice(1);
    const m = /\s(\/.*)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// §8.2: scan running processes for gateway env. Returns variable NAMES only, never values.
// -> [{ pid, kind: 'desktop session'|'cli'|'other', startedAt, cwd, vars: [...] }]
async function scanGatewayProcesses(ctx, opts) {
  opts = opts || {};
  if (!ctx || !ctx.configDir) return [];
  const gatewayUrl = String(cfg(ctx, 'failover.gatewayUrl', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
  const alias = cfg(ctx, 'failover.alias', 'claude-failover');
  const providerName = cfg(ctx, 'failover.provider', 'keysmith-failover');
  const gwKeyHash = gatewayKeyHashOf(ctx, providerName);

  const lister = opts.listProcesses || (ctx && ctx.listProcesses) || null;
  const procs = lister ? await lister() : listProcesses({ run: opts.run || (ctx && ctx.run) });
  const out = [];

  for (let i = 0; i < procs.length; i++) {
    const proc = procs[i];
    if (!proc || !proc.env || typeof proc.env !== 'object') continue;
    const env = proc.env;
    const matched = [];

    if (
      typeof env.ANTHROPIC_BASE_URL === 'string' &&
      env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') === gatewayUrl
    ) {
      matched.push('ANTHROPIC_BASE_URL');
    }
    const envKeys = Object.keys(env);
    for (let k = 0; k < envKeys.length; k++) {
      const name = envKeys[k];
      if (/^ANTHROPIC_.*MODEL$/.test(name) && env[name] === alias) {
        matched.push(name);
      }
    }
    if (gwKeyHash) {
      if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN) {
        if (sha256Hex(env.ANTHROPIC_AUTH_TOKEN) === gwKeyHash) matched.push('ANTHROPIC_AUTH_TOKEN');
      }
      if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY) {
        if (sha256Hex(env.ANTHROPIC_API_KEY) === gwKeyHash) matched.push('ANTHROPIC_API_KEY');
      }
    }

    const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
    const cmd = String(proc.command || '');
    let kind = 'other';
    if (entrypoint === 'claude-desktop' || (/Claude\.app\//.test(cmd) && /claude-code|\/claude(\s|$)/.test(cmd))) {
      kind = 'desktop session';
    } else if (entrypoint === 'cli' || /(^|[\\/\s])claude(\s|$)/.test(cmd)) {
      kind = 'cli';
    }

    // Drop reference before resolving cwd / pushing output.
    procs[i] = null;

    if (matched.length) {
      matched.sort();
      const startMs = normalizeStartedAtMs(proc.startedAt);
      const startedIso = startMs !== null ? new Date(startMs).toISOString() : null;
      const cwd = resolvePidCwd(proc.pid, proc, opts);
      out.push({
        pid: proc.pid,
        kind: kind,
        startedAt: startedIso,
        cwd: cwd,
        vars: matched,
      });
    }
  }
  return out;
}

function formatProcessReport(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const lines = ['  Processes still carrying gateway env (restart this session/app to drop the old env):'];
  rows.forEach(function (r) {
    lines.push(
      '    • pid ' +
        r.pid +
        ' (' +
        r.kind +
        ')' +
        (r.startedAt ? ' started ' + r.startedAt : '') +
        (r.cwd ? ' cwd ' + r.cwd : '') +
        ' — vars: ' +
        (r.vars || []).join(', ') +
        ' — restart this session/app to drop the old env',
    );
  });
  return lines;
}

export {
  SURFACES,
  TXN_FILE,
  ENV_FILE,
  txnPath,
  envPath,
  readTxn,
  writeTxn,
  readLauncherEnv,
  chooseSurface,
  beginTxn,
  commitTxn,
  rollbackTxn,
  rollbackKeptTxn,
  recoverCrashedTxn,
  buildChildEnv,
  probe,
  classifyProbeFailure,
  parseQuotaResetAt,
  listProcesses,
  parsePsOutput,
  checkDesktopLeak,
  scanGatewayProcesses,
  formatProcessReport,
};
