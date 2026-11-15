// Unified supervised daemon (`keyflip daemon` / `com.keyflip.daemon`).
// Consolidates the 4 legacy launchd jobs:
//   - com.keyflip.refresh          (15m Claude OAuth token renewal)
//   - com.keyflip.refresh-daemon   (5m Antigravity / Codex / Kiro refresh)
//   - com.keyflip.autoswitch       (2m usage check, threshold switch, failover, idle Desktop restart)
//   - com.keyflip.conv-index       (30m conversation indexing + embeddings)
// into a single KeepAlive launchd process with an internal non-overlapping scheduler
// and a local 0600 Unix domain socket API (`~/.keyflip/daemon.sock`) for the CLI and
// the macOS menu bar application.
//
// SECURITY INVARIANT: No secret (accessToken, refreshToken, sessionKey, cookie, apiKey)
// may ever be returned over the socket or written to the daemon log. Every outbound
// payload passes through `redactSecrets()`.
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawnSync } from 'child_process';
import { atomicWrite } from './fsutil.js';
import * as _selfbin from './selfbin.js';
import * as _config from './config.js';
import * as _profiles from './profiles.js';
import * as _core from './core.js';
import * as _oauth from './oauth.js';
import * as _refresh from './refresh.js';
import * as _usage from './usage.js';
import * as _autoswitch from './autoswitch.js';
import * as _failover from './failover.js';
import * as _desktoprestart from './desktoprestart.js';
import * as _appauth from './appauth.js';
import * as _identity from './identity.js';
import * as _convindex from './convindex.js';
import * as _log from './log.js';
import * as _history from './history.js';
import * as _notify from './notify.js';
import * as _controlcenter from './controlcenter.js';

const LABEL = 'com.keyflip.daemon';
const LEGACY_LABELS = [
  'com.keyflip.refresh',
  'com.keyflip.refresh-daemon',
  'com.keyflip.autoswitch',
  'com.keyflip.conv-index',
];
const RECORD_NAME = 'daemon-schedule.json'; // reserved in profiles.RESERVED_FILES
const STATE_NAME = 'daemon-state.json'; // reserved in profiles.RESERVED_FILES
const SOCKET_NAME = 'daemon.sock';
const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB rotating log cap
const MAX_REQUEST_BYTES = 64 * 1024; // 64 KiB cap on socket requests

const JOB_NAMES = ['autoswitch', 'refresh', 'surface-refresh', 'conv-index', 'usage'];

// Keys that must NEVER appear in any socket response or log payload.
const SECRET_KEY_RE =
  /^(access_?token|refresh_?token|id_?token|session_?key|api_?key|secret|password|cookie|cookies|authorization|x-api-key|credential|credentials|raw_?token|blob)$/i;
// Token value patterns scrubbed as defense-in-depth from any string field.
const SECRET_VAL_RE =
  /(sk-ant-[a-zA-Z0-9_-]{6,}|sk-[a-zA-Z0-9_-]{16,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{5,}|sessionKey=[^\s;"']+)/g;

function redactText(str) {
  if (typeof str !== 'string') return str;
  return str.replace(SECRET_VAL_RE, '[REDACTED]');
}

// Recursively strip secret-named properties and token-shaped substrings from any value.
function redactSecrets(val, seen) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return redactText(val);
  if (typeof val !== 'object') return val;
  seen = seen || new Set();
  if (seen.has(val)) return null;
  seen.add(val);
  if (Array.isArray(val)) {
    return val.map(function (item) {
      return redactSecrets(item, seen);
    });
  }
  const out = {};
  Object.keys(val).forEach(function (k) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
      return;
    }
    out[k] = redactSecrets(val[k], seen);
  });
  return out;
}

function socketPath(ctx, opts) {
  opts = opts || {};
  if (opts.socketPath) return opts.socketPath;
  const candidate = path.join(ctx.configDir, SOCKET_NAME);
  // macOS sockaddr_un.sun_path limit is 104 bytes; fall back to /tmp/kf-d-<hash>.sock when configDir is deep.
  if (Buffer.byteLength(candidate, 'utf8') > 96) {
    const h = crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 12);
    return path.join('/tmp', 'kf-d-' + h + '.sock');
  }
  return candidate;
}

function recordPath(ctx) {
  return path.join(ctx.configDir, RECORD_NAME);
}

function statePath(ctx) {
  return path.join(ctx.configDir, STATE_NAME);
}

function plistPath(home) {
  return path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
}

function legacyPlistPaths(home) {
  return LEGACY_LABELS.map(function (label) {
    return {
      label: label,
      path: path.join(home, 'Library', 'LaunchAgents', label + '.plist'),
    };
  });
}

function logPath(home, opts) {
  opts = opts || {};
  if (opts.logPath) return opts.logPath;
  return path.join(home, 'Library', 'Logs', 'keyflip-daemon.log');
}

// Rotate log file to `<logPath>.1` when it reaches `maxBytes`.
function rotateLogIfNeeded(filePath, maxBytes) {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES;
  try {
    const st = fs.statSync(filePath);
    if (st.size >= limit) {
      try {
        fs.renameSync(filePath, filePath + '.1');
      } catch (_) {
        /* ignore rename failure */
      }
    }
  } catch (_) {
    /* file does not exist yet */
  }
}

function appendDaemonLog(ctx, msg, opts) {
  opts = opts || {};
  const clean = redactText(String(msg || ''));
  _log.log('daemon: ' + clean);
  const home = opts.home || (ctx && ctx.home) || '';
  if (!home && !opts.logPath) return;
  const lf = logPath(home, opts);
  try {
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    rotateLogIfNeeded(lf, opts.maxLogBytes);
    const nowIso = opts.nowMs
      ? new Date(opts.nowMs()).toISOString()
      : ctx && ctx.now
        ? ctx.now()
        : new Date().toISOString();
    fs.appendFileSync(lf, nowIso + ' ' + clean + '\n', { mode: 0o600 });
  } catch (_) {
    /* logging must never crash the daemon */
  }
}

function readState(ctx) {
  try {
    return JSON.parse(fs.readFileSync(statePath(ctx), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function writeState(ctx, state) {
  try {
    fs.mkdirSync(ctx.configDir, { recursive: true, mode: 0o700 });
    atomicWrite(statePath(ctx), JSON.stringify(redactSecrets(state), null, 2), 0o600);
  } catch (_) {
    /* best effort */
  }
}

function readRecord(ctx) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(ctx), 'utf8'));
  } catch (_) {
    return null;
  }
}

function defaultFailoverAdapter(ctx, opts) {
  opts = opts || {};
  if (!_config.get(ctx, 'failover.enabled')) return null;
  const note = function (title, msg) {
    if (_config.get(ctx, 'notify.desktop')) _notify.desktop(ctx, title, msg);
    if (ctx.appDataDir && _config.get(ctx, 'desktop.autoRestart')) {
      const kind = /failover$/i.test(title) ? 'failover' : 'failback';
      _desktoprestart.request(ctx, { kind: kind, reason: msg });
    }
  };
  return {
    state: function () {
      return _failover.state(ctx);
    },
    gatewayHealth: function () {
      return _failover.gatewayReady(ctx, { fetch: opts.fetch || ctx.fetch, capCheck: false });
    },
    engage: function (info) {
      return _failover.engage(ctx, info, {
        fetch: opts.fetch || ctx.fetch,
        keysmithConfig: opts.keysmithConfig || ctx.keysmithConfig,
        nowMs: opts.nowMs || ctx.nowMs,
        notify: note,
      });
    },
    release: function (info) {
      return _failover.release(ctx, info, {
        nowMs: opts.nowMs || ctx.nowMs,
        notify: note,
      });
    },
  };
}

// Read `.usage-throttle.json` directly so the daemon never violates the machine-wide Retry-After window.
function readUsageThrottle(ctx, nowMs) {
  const now = typeof nowMs === 'function' ? nowMs() : Date.now();
  try {
    const p = path.join(ctx.configDir, '.usage-throttle.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (raw && typeof raw.retryAt === 'number' && raw.retryAt > now) {
      return {
        throttled: true,
        retryAt: new Date(raw.retryAt).toISOString(),
        retryAtMs: raw.retryAt,
        strike: raw.strike || 1,
      };
    }
  } catch (_) {
    /* absent or unreadable */
  }
  return { throttled: false, retryAt: null, retryAtMs: 0, strike: 0 };
}

function readUsageCacheMap(ctx) {
  try {
    const p = path.join(ctx.configDir, '.usage-cache.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

// Create the internal job scheduler. All side effects are injectable via `opts` so tests
// run deterministically with fake timers and fake job handlers.
function createScheduler(ctx, opts) {
  opts = opts || {};
  const nowFn =
    opts.nowMs ||
    ctx.nowMs ||
    function () {
      return Date.now();
    };
  const setIntervalFn = opts.setInterval || setInterval;
  const clearIntervalFn = opts.clearInterval || clearInterval;

  const prev = readState(ctx);
  const prevJobs = (prev && prev.jobs) || {};

  function initJobMeta(name, intervalSeconds) {
    const old = prevJobs[name] || {};
    return {
      intervalSeconds: intervalSeconds,
      running: false,
      lastRunAt: old.lastRunAt || null,
      lastDurationMs: typeof old.lastDurationMs === 'number' ? old.lastDurationMs : null,
      lastResult: old.lastResult || null,
      lastError: old.lastError || null,
      runCount: typeof old.runCount === 'number' ? old.runCount : 0,
    };
  }

  function intervalsFromConfig() {
    return {
      autoswitch: _config.get(ctx, 'daemon.autoswitchIntervalSeconds'),
      refresh: _config.get(ctx, 'daemon.refreshIntervalSeconds'),
      'surface-refresh': _config.get(ctx, 'daemon.surfaceRefreshIntervalSeconds'),
      'conv-index': _config.get(ctx, 'daemon.convIndexIntervalSeconds'),
      usage: _config.get(ctx, 'usage.cacheTtlSeconds'),
    };
  }

  const ivs = intervalsFromConfig();
  const jobsState = {
    autoswitch: initJobMeta('autoswitch', ivs.autoswitch),
    refresh: initJobMeta('refresh', ivs.refresh),
    'surface-refresh': initJobMeta('surface-refresh', ivs['surface-refresh']),
    'conv-index': initJobMeta('conv-index', ivs['conv-index']),
    usage: initJobMeta('usage', ivs.usage),
  };

  const inFlight = Object.create(null);
  const timers = Object.create(null);
  const startedAtIso = new Date(nowFn()).toISOString();
  let stopped = false;

  const customJobs = opts.jobs || {};

  const defaultRunners = {
    autoswitch: async function () {
      const threshold = _config.get(ctx, 'autoswitch.threshold');
      const strategy = _config.get(ctx, 'autoswitch.strategy') || 'best';
      const group = _config.get(ctx, 'autoswitch.group') || undefined;
      const fa = opts.failover !== undefined ? opts.failover : defaultFailoverAdapter(ctx, opts);
      const r = await _autoswitch.tick(ctx, {
        threshold: threshold,
        strategy: strategy,
        group: group,
        fetch: opts.fetch || ctx.fetch,
        nowMs: nowFn,
        timeZone: ctx.timeZone,
        performSwitch:
          opts.performSwitch ||
          function (name) {
            return _core.performSwitch(ctx, name);
          },
        repairLabel:
          opts.repairLabel ||
          function () {
            return _identity.repairIfMismatched(ctx);
          },
        failover: fa,
      });
      if (ctx.appDataDir && _config.get(ctx, 'desktop.autoRestart') && opts.followDesktop !== false) {
        const to = r && r.switchedTo;
        if ((r.state === 'switched' || r.state === 'switched-back') && to && _appauth.hasProfile(ctx, to.name)) {
          _desktoprestart.request(ctx, {
            kind: 'account',
            target: to.name,
            email: to.email || null,
            reason: 'autoswitch',
          });
        }
        try {
          await _desktoprestart.processPending(ctx, {});
        } catch (_) {
          /* non-fatal */
        }
      }
      return { state: (r && r.state) || 'ok', detail: r };
    },
    refresh: async function () {
      const leadMin = _config.get(ctx, 'refresh.leadMinutes');
      const r = await _oauth.refreshDue(ctx, {
        leadMs: leadMin * 60 * 1000,
        fetch: opts.fetch || ctx.fetch,
        now: nowFn,
      });
      const failed = ((r && r.results) || []).filter(function (x) {
        return x.status === 'failed' || x.status === 'persist-failed';
      });
      return {
        state: failed.length ? 'partial-error' : 'ok',
        refreshed: ((r && r.results) || []).filter(function (x) {
          return x.status === 'refreshed';
        }).length,
        checked: ((r && r.results) || []).length,
      };
    },
    'surface-refresh': async function () {
      await _refresh.tick(ctx);
      return { state: 'ok' };
    },
    'conv-index': async function () {
      const r = await _convindex.build(ctx, { embed: true });
      return {
        state: 'ok',
        indexed: (r && r.indexed) || 0,
      };
    },
    usage: async function () {
      const th = readUsageThrottle(ctx, nowFn);
      if (th.throttled) {
        return { state: 'throttled', retryAt: th.retryAt };
      }
      const names = _profiles.list(ctx.configDir);
      if (!names.length) return { state: 'no-accounts' };
      const rows = await _usage.usageForProfiles(ctx, names, {
        fetch: opts.fetch || ctx.fetch,
        now: nowFn,
        ttlMs: 0, // explicit usage refresh requested
      });
      return {
        state: 'ok',
        accounts: rows.length,
      };
    },
  };

  function persist() {
    writeState(ctx, {
      pid: process.pid,
      startedAt: startedAtIso,
      updatedAt: new Date(nowFn()).toISOString(),
      jobs: jobsState,
    });
  }

  async function runJob(name, runOpts) {
    runOpts = runOpts || {};
    if (JOB_NAMES.indexOf(name) === -1) {
      throw new Error("unknown daemon job: '" + name + "'");
    }
    if (inFlight[name]) {
      return inFlight[name];
    }
    const runner = customJobs[name] || defaultRunners[name];
    const meta = jobsState[name];
    meta.running = true;
    const t0 = nowFn();

    const p = Promise.resolve()
      .then(function () {
        return runner(runOpts);
      })
      .then(
        function (res) {
          const dt = Math.max(0, nowFn() - t0);
          meta.running = false;
          meta.lastRunAt = new Date(nowFn()).toISOString();
          meta.lastDurationMs = dt;
          meta.lastResult = (res && res.state) || 'ok';
          meta.lastError = (res && res.error) || null;
          meta.runCount = (meta.runCount || 0) + 1;
          persist();
          appendDaemonLog(ctx, 'job ' + name + ' -> ' + meta.lastResult + ' (' + dt + 'ms)', opts);
          return {
            ok: true,
            job: name,
            result: meta.lastResult,
            durationMs: dt,
            lastRunAt: meta.lastRunAt,
            detail: redactSecrets(res),
          };
        },
        function (err) {
          const dt = Math.max(0, nowFn() - t0);
          const msg = redactText((err && err.message) || String(err));
          meta.running = false;
          meta.lastRunAt = new Date(nowFn()).toISOString();
          meta.lastDurationMs = dt;
          meta.lastResult = 'error';
          meta.lastError = msg;
          meta.runCount = (meta.runCount || 0) + 1;
          persist();
          appendDaemonLog(ctx, 'job ' + name + ' ERROR: ' + msg, opts);
          return {
            ok: false,
            job: name,
            result: 'error',
            error: msg,
            durationMs: dt,
            lastRunAt: meta.lastRunAt,
          };
        },
      )
      .finally(function () {
        delete inFlight[name];
      });

    inFlight[name] = p;
    return p;
  }

  function scheduleTimers() {
    Object.keys(timers).forEach(function (k) {
      clearIntervalFn(timers[k]);
      delete timers[k];
    });
    if (stopped) return;
    const cur = intervalsFromConfig();
    ['autoswitch', 'refresh', 'surface-refresh', 'conv-index'].forEach(function (name) {
      const sec = cur[name];
      jobsState[name].intervalSeconds = sec;
      if (typeof sec === 'number' && sec > 0) {
        const t = setIntervalFn(function () {
          runJob(name, { trigger: 'timer' }).catch(function () {});
        }, sec * 1000);
        if (t && typeof t.unref === 'function' && opts.unrefTimers) t.unref();
        timers[name] = t;
      }
    });
  }

  function start(startOpts) {
    startOpts = startOpts || {};
    stopped = false;
    persist();
    scheduleTimers();
    if (startOpts.runOnStart !== false) {
      runJob('refresh', { trigger: 'startup' }).catch(function () {});
      runJob('surface-refresh', { trigger: 'startup' }).catch(function () {});
      runJob('autoswitch', { trigger: 'startup' }).catch(function () {});
    }
  }

  function stop() {
    stopped = true;
    Object.keys(timers).forEach(function (k) {
      clearIntervalFn(timers[k]);
      delete timers[k];
    });
  }

  function getJobsSnapshot() {
    const cur = intervalsFromConfig();
    const out = {};
    Object.keys(jobsState).forEach(function (k) {
      out[k] = Object.assign({}, jobsState[k], {
        intervalSeconds: cur[k],
        running: Boolean(inFlight[k]),
      });
    });
    return out;
  }

  return {
    start: start,
    stop: stop,
    runJob: runJob,
    reloadIntervals: scheduleTimers,
    getJobsSnapshot: getJobsSnapshot,
    startedAt: function () {
      return startedAtIso;
    },
  };
}

// Build the complete zero-secret status snapshot for `GET /v1/status` and `keyflip daemon status`.
async function buildStatus(ctx, scheduler, opts) {
  opts = opts || {};
  const nowFn =
    opts.nowMs ||
    ctx.nowMs ||
    function () {
      return Date.now();
    };
  const now = nowFn();
  const home = opts.home || ctx.home || '';

  const listed = _core.listProfiles(ctx);
  const rState = _oauth.readRefreshState(ctx);
  const uCache = readUsageCacheMap(ctx);
  const uThrottle = readUsageThrottle(ctx, nowFn);
  const ttlMs = _config.get(ctx, 'usage.cacheTtlSeconds') * 1000;

  let activeAccount = null;
  const accounts = listed.map(function (row) {
    const meta = _profiles.read(ctx.configDir, row.name) || {};
    const tokSt = _oauth.tokenStatusForAccount(ctx, row.name, { now: now });
    const rs = rState[row.name] || {};
    const cached = uCache[row.name] || null;
    const rawUsage = cached && cached.usage ? cached.usage : null;
    const fetchedAtMs = cached && typeof cached.fetchedAt === 'number' ? cached.fetchedAt : null;
    const isStale = fetchedAtMs ? now - fetchedAtMs > ttlMs : true;

    const usageObj = rawUsage
      ? {
          fiveHour: rawUsage.fiveHour
            ? { pct: rawUsage.fiveHour.pct, resetsAt: rawUsage.fiveHour.resetsAt || null }
            : null,
          sevenDay: rawUsage.sevenDay
            ? { pct: rawUsage.sevenDay.pct, resetsAt: rawUsage.sevenDay.resetsAt || null }
            : null,
          sevenDaySonnet: rawUsage.sevenDaySonnet
            ? { pct: rawUsage.sevenDaySonnet.pct, resetsAt: rawUsage.sevenDaySonnet.resetsAt || null }
            : null,
          extraUsage: rawUsage.extraUsage
            ? {
                isEnabled: Boolean(rawUsage.extraUsage.isEnabled),
                usedCredits: rawUsage.extraUsage.usedCredits ?? null,
                monthlyLimit: rawUsage.extraUsage.monthlyLimit ?? null,
                utilization: rawUsage.extraUsage.utilization ?? null,
              }
            : null,
          effectiveHeadroom: _usage.effectiveHeadroom(rawUsage),
          stale: isStale,
          fetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
        }
      : null;

    const acct = {
      name: row.name,
      email: row.email || '',
      tier: meta.tier || null,
      enabled: row.enabled !== false,
      active: Boolean(row.active),
      token: {
        status: (tokSt && tokSt.status) || 'unknown',
        expiresAt:
          tokSt && typeof tokSt.expiresAt === 'number' ? new Date(tokSt.expiresAt).toISOString() : null,
        remainingMs: tokSt && typeof tokSt.remainingMs === 'number' ? tokSt.remainingMs : null,
        refreshable: Boolean(tokSt && tokSt.refreshable),
        lastResult: rs.lastResult || null,
        lastRefreshAt: rs.lastAttemptAt || null,
        lastError: rs.lastError ? redactText(rs.lastError) : null,
      },
      usage: usageObj,
    };
    if (acct.active) {
      activeAccount = {
        name: acct.name,
        email: acct.email,
        tier: acct.tier,
      };
    }
    return acct;
  });

  // Failover status
  const fPlan = _failover.resolvePlan(ctx, { keysmithConfig: opts.keysmithConfig || ctx.keysmithConfig });
  const fState = _failover.state(ctx);
  let gwReady = { ok: false, reason: 'not probed', cap: null };
  if (typeof opts.gatewayReady === 'function') {
    try {
      gwReady = await opts.gatewayReady();
    } catch (e) {
      gwReady = { ok: false, reason: (e && e.message) || 'error', cap: null };
    }
  } else if (opts.probeGateway || opts.fetch || ctx.fetch) {
    try {
      gwReady = await _failover.gatewayReady(ctx, {
        fetch: opts.fetch || ctx.fetch,
        keysmithConfig: opts.keysmithConfig || ctx.keysmithConfig,
      });
    } catch (e) {
      gwReady = { ok: false, reason: (e && e.message) || 'error', cap: null };
    }
  }

  const failoverInfo = {
    enabled: Boolean(fPlan.enabled),
    engaged: Boolean(fState),
    manual: Boolean(fState && fState.manual),
    since: fState && fState.at ? new Date(fState.at).toISOString() : null,
    fromAccount: (fState && fState.fromAccount) || null,
    reason: (fState && fState.reason) || null,
    recoverAt: (fState && fState.recoverAt) || null,
    alias: fPlan.alias,
    legs: fPlan.legs || null,
    gatewayUrl: fPlan.gatewayUrl,
    gatewayReady: Boolean(gwReady && gwReady.ok),
    gatewayReason: (gwReady && gwReady.reason) || null,
    cap:
      gwReady && gwReady.cap
        ? {
            max: gwReady.cap.max ?? fPlan.capUsd,
            spent: gwReady.cap.spent ?? null,
            remaining: gwReady.cap.remaining ?? null,
            period: gwReady.cap.period || null,
            exceeded: Boolean(gwReady.cap.exceeded),
            windowStatus: gwReady.cap.windowStatus || null,
          }
        : {
            max: fPlan.capUsd,
            spent: null,
            remaining: null,
            period: null,
            exceeded: false,
            windowStatus: null,
          },
  };

  // Pending Claude Desktop restart
  const pend = _desktoprestart.readPending(ctx);
  const desktopRestart = {
    pending: Boolean(pend),
    since: pend && pend.since ? new Date(pend.since).toISOString() : null,
    actions:
      pend && Array.isArray(pend.actions)
        ? pend.actions.map(function (a) {
            return { kind: a.kind, target: a.target || null, reason: a.reason || null };
          })
        : [],
  };

  // Jobs snapshot
  const jobs = scheduler ? scheduler.getJobsSnapshot() : (readState(ctx) && readState(ctx).jobs) || {};

  // Warnings
  const warnings = [];
  const threshold = _config.get(ctx, 'autoswitch.threshold');
  accounts.forEach(function (a) {
    if (a.token.lastResult === 'dead' || a.token.lastResult === 'persist-failed' || a.token.status === 'expired') {
      warnings.push({
        id: 'token-' + a.name,
        severity: 'error',
        title: a.name + ': token yenilenemedi veya süresi doldu',
        detail: a.token.lastError || a.token.status,
        fix: 'keyflip login ' + a.name,
      });
    }
    if (a.active && a.usage && a.usage.fiveHour && typeof a.usage.fiveHour.pct === 'number') {
      if (a.usage.fiveHour.pct >= threshold) {
        warnings.push({
          id: 'quota-' + a.name,
          severity: 'warn',
          title: a.name + ': 5 saatlik kullanım %' + a.usage.fiveHour.pct + ' (eşik %' + threshold + ')',
          detail: 'Otomatik geçiş veya yedek zincir (failover) eşiğinde.',
          fix: 'keyflip next',
        });
      }
    }
  });
  if (uThrottle.throttled) {
    warnings.push({
      id: 'usage-throttled',
      severity: 'warn',
      title: 'Kullanım uç noktası hız sınırında (Retry-After)',
      detail: 'Sessiz pencere bitişi: ' + uThrottle.retryAt,
    });
  }
  if (failoverInfo.engaged) {
    warnings.push({
      id: 'failover-engaged',
      severity: 'warn',
      title: 'Yedek zincir (API failover) devrede',
      detail: failoverInfo.reason || 'Tüm hesaplar eşik üzerinde',
      fix: 'keyflip failover off',
    });
  }
  if (home) {
    const lingering = legacyPlistPaths(home).filter(function (lp) {
      return fs.existsSync(lp.path);
    });
    if (lingering.length) {
      warnings.push({
        id: 'legacy-launchd',
        severity: 'warn',
        title: lingering.length + ' eski launchd plist dosyası hâlâ mevcut',
        detail: lingering
          .map(function (l) {
            return l.label;
          })
          .join(', '),
        fix: 'keyflip daemon install -y',
      });
    }
  }

  const startedAtIso = scheduler ? scheduler.startedAt() : (readState(ctx) && readState(ctx).startedAt) || null;
  const uptimeSeconds = startedAtIso ? Math.max(0, Math.floor((now - Date.parse(startedAtIso)) / 1000)) : 0;

  const payload = {
    ok: true,
    daemon: {
      pid: process.pid,
      startedAt: startedAtIso,
      uptimeSeconds: uptimeSeconds,
      socketPath: socketPath(ctx, opts),
      logPath: home ? logPath(home, opts) : null,
    },
    activeAccount: activeAccount,
    accounts: accounts,
    usageThrottle: {
      throttled: uThrottle.throttled,
      retryAt: uThrottle.retryAt,
      strike: uThrottle.strike,
    },
    failover: failoverInfo,
    desktopRestart: desktopRestart,
    jobs: jobs,
    warnings: warnings,
    config: {
      'autoswitch.threshold': _config.get(ctx, 'autoswitch.threshold'),
      'autoswitch.strategy': _config.get(ctx, 'autoswitch.strategy'),
      'refresh.leadMinutes': _config.get(ctx, 'refresh.leadMinutes'),
      'failover.enabled': _config.get(ctx, 'failover.enabled'),
      'failover.capUsd': _config.get(ctx, 'failover.capUsd'),
      'notify.desktop': _config.get(ctx, 'notify.desktop'),
      'desktop.autoRestart': _config.get(ctx, 'desktop.autoRestart'),
      'daemon.autoswitchIntervalSeconds': _config.get(ctx, 'daemon.autoswitchIntervalSeconds'),
      'daemon.refreshIntervalSeconds': _config.get(ctx, 'daemon.refreshIntervalSeconds'),
      'daemon.surfaceRefreshIntervalSeconds': _config.get(ctx, 'daemon.surfaceRefreshIntervalSeconds'),
      'daemon.convIndexIntervalSeconds': _config.get(ctx, 'daemon.convIndexIntervalSeconds'),
      'menubar.statusFile': _config.get(ctx, 'menubar.statusFile'),
      'menubar.extraStatusFiles': _config.get(ctx, 'menubar.extraStatusFiles'),
      'desktop.snoozeUntil': _config.get(ctx, 'desktop.snoozeUntil'),
    },
  };

  return redactSecrets(payload);
}


// Build the full Control Center payload (status + otherQuotas + services + fleet + server + preferences).
async function buildControlCenter(ctx, scheduler, opts) {
  opts = opts || {};
  const base = await buildStatus(ctx, scheduler, opts);
  const ccOpts = Object.assign({ homeDir: opts.home || ctx.home, configDir: ctx.configDir }, opts.controlCenter || {});
  base.otherQuotas = _controlcenter.collectOtherQuotas(ctx, ccOpts);
  base.services = _controlcenter.collectServicesStatus(ctx, ccOpts);
  base.fleet = _controlcenter.collectFleetStatus(ctx, ccOpts);
  base.server = _controlcenter.collectServerStatus(ctx, ccOpts);
  base.statusBoard = _controlcenter.collectStatusBoard(ctx, ccOpts);
  base.failover.spendHealth = _controlcenter.evaluateFailoverSpendHealth(base.failover, { nowMs: opts.nowMs || ctx.nowMs });
  base.failover.costEstimate = _controlcenter.estimateFailoverSessionCost(base.failover);
  base.poolReadiness = _controlcenter.evaluatePoolReadiness(base.accounts);
  base.poolResilience = _controlcenter.evaluatePoolResilienceScore(base.accounts, base.failover);
  base.quotaForecast = _controlcenter.computeQuotaForecast(base.accounts, { nowMs: opts.nowMs || ctx.nowMs });
  base.auditTimeline = _controlcenter.collectAuditTimeline(ctx, ccOpts);
  base.poolHorizon = _controlcenter.evaluatePoolHorizonAndQuietHours(base.accounts);
  base.weeklyResetCalendar = _controlcenter.buildWeeklyResetCalendar(base.accounts, { nowMs: opts.nowMs || ctx.nowMs });
  base.multiProviderContinuity = _controlcenter.evaluateMultiProviderContinuity(base.accounts, base.failover, base.otherQuotas);
  base.servicesHealth = _controlcenter.evaluateServicesHealthSummary(base.services);
  base.bottleneckWindow = _controlcenter.predictDailyBottleneckWindow(ctx);
  base.sessionReadiness = _controlcenter.evaluateWorkSessionReadiness({
    accounts: base.accounts,
    failover: base.failover,
    services: base.services,
    statusBoard: base.statusBoard
  });
  base.subscriptionRoi = _controlcenter.evaluateSubscriptionValueROI(base.accounts, base.otherQuotas, base.failover);
  base.rotationStability = _controlcenter.evaluateRotationStability(ctx);
  base.fleetEfficiency = _controlcenter.evaluateFleetEfficiency(base.fleet);
  base.serverSitesHealth = _controlcenter.evaluateServerSitesHealth(base.server);
  base.secondaryQuotasAlert = _controlcenter.evaluateSecondaryQuotasAlert(base.otherQuotas);
  base.autonomousPosture = _controlcenter.evaluateAutonomousOpsPosture({
    poolResilience: base.poolResilience,
    sessionReadiness: base.sessionReadiness,
    multiProviderContinuity: base.multiProviderContinuity,
    servicesHealth: base.servicesHealth,
    statusBoard: base.statusBoard
  });
  base.ownerQueue = _controlcenter.prioritizeOwnerNeededQueue(base.statusBoard);
  base.oauthReliability = _controlcenter.evaluateOAuthRefreshReliability(base.accounts);
  base.adaptiveThreshold = _controlcenter.recommendAdaptiveAutoswitchThreshold({
    currentThreshold: base.config['autoswitch.threshold'],
    accounts: base.accounts,
    quotaForecast: base.quotaForecast,
    bottleneckWindow: base.bottleneckWindow,
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.sectionHealthBreakdown = _controlcenter.summarizeSectionHealthBreakdown(base.statusBoard);
  base.remediationPlaybook = _controlcenter.buildRemediationPlaybook({
    accounts: base.accounts,
    failover: base.failover,
    services: base.services,
    statusBoard: base.statusBoard
  });
  base.poolLoadBalance = _controlcenter.evaluatePoolLoadBalance(base.accounts);
  base.agingIssues = _controlcenter.listAgingStatusBoardIssues(base.statusBoard, { nowMs: opts.nowMs || ctx.nowMs });
  base.failoverRecovery = _controlcenter.evaluateFailoverRecoveryCountdown(base.failover, base.accounts, {
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.dailyAuditActivity = _controlcenter.summarizeDailyAuditActivity(ctx, {
    configDir: ctx.configDir,
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.schedulerHealth = _controlcenter.evaluateDaemonSchedulerHealth(base.jobs, { nowMs: opts.nowMs || ctx.nowMs });
  base.weeklyUnclaimedQuota = _controlcenter.evaluateWeeklyUnclaimedQuota(base.accounts, {
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.ownerProjectGroups = _controlcenter.groupOwnerNeededByProject(base.statusBoard);
  base.serverResourcePressure = _controlcenter.evaluateServerResourcePressure(base.server);
  base.desktopRestartSafety = _controlcenter.evaluateDesktopRestartSafety(base.desktopRestart, base.config, {
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.sonnetModelSplit = _controlcenter.evaluateSonnetModelSplitHealth(base.accounts);
  base.serviceLogHygiene = _controlcenter.evaluateServiceLogHygiene(base.services);
  base.multiHostBreakdown = _controlcenter.summarizeMultiHostStatusBreakdown(base.statusBoard);
  base.usageThrottleRecovery = _controlcenter.evaluateUsageThrottleRecovery(base.usageThrottle, {
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.extraUsagePool = _controlcenter.summarizeExtraUsageCreditsPool(base.accounts);
  base.usageCacheFreshness = _controlcenter.evaluateUsageCacheFreshness(base.accounts, {
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.backupGuardianContinuity = _controlcenter.evaluateBackupAndGuardianContinuity(base.services);
  base.legacyLaunchdCleanliness = _controlcenter.evaluateLegacyLaunchdCleanliness(base.warnings);
  base.otherQuotasFreshness = _controlcenter.evaluateOtherQuotasFreshness(base.otherQuotas, {
    nowMs: opts.nowMs || ctx.nowMs
  });
  base.fleetCapacityReclaim = _controlcenter.evaluateFleetCapacityReclaim(base.fleet);
  base.accountTierAlignment = _controlcenter.evaluateAccountTierAlignment(base.accounts);
  base.failoverChainRedundancy = _controlcenter.evaluateFailoverChainRedundancy(base.failover);
  base.daemonUptime = _controlcenter.evaluateDaemonUptimeStability(base.daemon);
  base.fiveHourCollision = _controlcenter.detectFiveHourResetCollision(base.accounts);
  base.statusBoardUnknownNoise = _controlcenter.evaluateStatusBoardUnknownNoise(base.statusBoard);
  base.fiveHourStaggering = _controlcenter.evaluateFiveHourWindowStaggering(base.accounts);
  base.statusBoardHotspot = _controlcenter.evaluateStatusBoardHotspot(base.statusBoard);
  base.refreshLeadMargin = _controlcenter.evaluateRefreshLeadTimeMargin(base.config);
  base.servicesByKind = _controlcenter.summarizeServicesByKind(base.services);
  base.apiPromoGrant = _controlcenter.evaluateApiPromoGrantHealth(base.otherQuotas);
  base.activeSafetyCushion = _controlcenter.evaluateActiveAccountSafetyCushion(base.accounts, base.config);
  base.fleetWorkingUtilization = _controlcenter.evaluateFleetWorkingUtilization(base.fleet);
  base.compactSummary = _controlcenter.formatDaemonCompactSummary(base);
  base.preferences = _controlcenter.collectPreferences(ctx);
  base.markdownReport = _controlcenter.buildControlCenterMarkdown(base);
  base.diagnosticBundle = _controlcenter.buildDiagnosticBundle(base);
  return redactSecrets(base);
}

// Execute a command received over the Unix domain socket.
async function handleCommand(ctx, scheduler, req, opts) {
  opts = opts || {};
  req = req || {};
  const cmd = String(req.cmd || '').trim();

  if (cmd === 'status') {
    return { status: 200, body: await buildStatus(ctx, scheduler, opts) };
  }

  if (cmd === 'control-center') {
    return { status: 200, body: await buildControlCenter(ctx, scheduler, opts) };
  }

  if (cmd === 'service-restart') {
    if (req.confirm !== true) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'confirmation_required',
          message: 'Restarting a service requires confirm: true',
        },
      };
    }
    const label = String(req.label || '').trim();
    try {
      const r = _controlcenter.restartManagedService(ctx, {
        label: label,
        confirm: true,
        runner: opts.serviceRunner,
      });
      appendDaemonLog(ctx, 'audit service-restart: ' + label + ' -> ok', opts);
      return {
        status: 200,
        body: redactSecrets(r),
      };
    } catch (e) {
      const msg = redactText((e && e.message) || String(e));
      appendDaemonLog(ctx, 'audit service-restart FAILED -> ' + label + ': ' + msg, opts);
      const code = e && e.code === 'SERVICE_NOT_ALLOWED' ? 403 : 500;
      const errKey = e && e.code === 'SERVICE_NOT_ALLOWED' ? 'service_not_allowed' : 'restart_failed';
      return {
        status: code,
        body: { ok: false, error: errKey, message: msg },
      };
    }
  }

  if (cmd === 'switch') {
    if (req.confirm !== true) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'confirmation_required',
          message: 'Switching accounts requires confirm: true',
        },
      };
    }
    const target = String(req.account || '').trim();
    if (!target || !_profiles.exists(ctx.configDir, target)) {
      return {
        status: 404,
        body: {
          ok: false,
          error: 'unknown_account',
          message: "no such saved account: '" + target + "'",
        },
      };
    }
    const prevList = _core.listProfiles(ctx);
    const prevActive = prevList.find(function (p) {
      return p.active;
    });
    const reason = redactText(String(req.reason || 'daemon-api'));
    const doSwitch =
      opts.performSwitch ||
      function (name) {
        return _core.performSwitch(ctx, name);
      };
    try {
      const r = await doSwitch(target);
      if (ctx.appDataDir && _config.get(ctx, 'desktop.autoRestart') && _appauth.hasProfile(ctx, target)) {
        _desktoprestart.request(ctx, {
          kind: 'account',
          target: target,
          email: _profiles.email(ctx.configDir, target) || null,
          reason: reason,
        });
      }
      appendDaemonLog(
        ctx,
        'audit switch: ' + ((prevActive && prevActive.name) || 'none') + ' -> ' + target + ' (reason=' + reason + ')',
        opts,
      );
      _history.recordEvent(ctx, {
        kind: 'daemon-switch',
        from: (prevActive && prevActive.name) || null,
        to: target,
        reason: reason,
      });
      return {
        status: 200,
        body: redactSecrets({
          ok: true,
          switchedTo: target,
          previous: (prevActive && prevActive.name) || null,
          cli: Boolean(r && r.cli),
        }),
      };
    } catch (e) {
      const msg = redactText((e && e.message) || String(e));
      appendDaemonLog(ctx, 'audit switch FAILED -> ' + target + ': ' + msg, opts);
      return {
        status: 500,
        body: { ok: false, error: 'switch_failed', message: msg },
      };
    }
  }

  if (cmd === 'failover') {
    if (req.confirm !== true) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'confirmation_required',
          message: 'Toggling failover requires confirm: true',
        },
      };
    }
    const action = String(req.action || '').trim();
    if (action !== 'on' && action !== 'off') {
      return {
        status: 400,
        body: { ok: false, error: 'invalid_action', message: "action must be 'on' or 'off'" },
      };
    }
    const fa = opts.failover !== undefined ? opts.failover : defaultFailoverAdapter(ctx, opts);
    if (!fa) {
      return {
        status: 400,
        body: { ok: false, error: 'failover_disabled', message: 'failover is disabled in config' },
      };
    }
    const reason = redactText(String(req.reason || 'daemon-api'));
    const r =
      action === 'on'
        ? await fa.engage({ manual: true, reason: reason })
        : await fa.release({ reason: reason });
    appendDaemonLog(
      ctx,
      'audit failover ' + action + ' (ok=' + Boolean(r && r.ok) + ', reason=' + reason + ')',
      opts,
    );
    _history.recordEvent(ctx, {
      kind: 'daemon-failover-' + action,
      ok: Boolean(r && r.ok),
      reason: reason,
    });
    if (!r || !r.ok) {
      return {
        status: 400,
        body: redactSecrets({
          ok: false,
          error: 'failover_error',
          message: (r && r.reason) || 'could not toggle failover',
        }),
      };
    }
    return {
      status: 200,
      body: redactSecrets({
        ok: true,
        action: action,
        already: Boolean(r.already),
        failover: _failover.state(ctx),
      }),
    };
  }

  if (cmd === 'run-now') {
    const job = String(req.job || '').trim();
    if (JOB_NAMES.indexOf(job) === -1) {
      return {
        status: 400,
        body: {
          ok: false,
          error: 'invalid_job',
          message: 'job must be one of: ' + JOB_NAMES.join(', '),
        },
      };
    }
    if (!scheduler) {
      return {
        status: 503,
        body: { ok: false, error: 'no_scheduler', message: 'scheduler is not running' },
      };
    }
    appendDaemonLog(ctx, 'audit run-now: ' + job, opts);
    const r = await scheduler.runJob(job, { trigger: 'manual' });
    return {
      status: r.ok ? 200 : 500,
      body: redactSecrets(r),
    };
  }

  if (cmd === 'config') {
    if (req.set && typeof req.set === 'object' && !Array.isArray(req.set)) {
      if (req.confirm !== true) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'confirmation_required',
            message: 'Updating config requires confirm: true',
          },
        };
      }
      const updated = {};
      try {
        Object.keys(req.set).forEach(function (k) {
          updated[k] = _config.set(ctx, k, req.set[k]);
        });
      } catch (e) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'invalid_config',
            message: redactText((e && e.message) || String(e)),
          },
        };
      }
      if (scheduler) scheduler.reloadIntervals();
      appendDaemonLog(ctx, 'audit config set: ' + Object.keys(updated).join(', '), opts);
      _history.recordEvent(ctx, {
        kind: 'daemon-config',
        keys: Object.keys(updated),
      });
      return {
        status: 200,
        body: redactSecrets({
          ok: true,
          updated: updated,
          config: Object.assign({}, _config.getAll(ctx)),
        }),
      };
    }
    return {
      status: 200,
      body: redactSecrets({
        ok: true,
        config: Object.assign({}, _config.getAll(ctx)),
      }),
    };
  }

  return {
    status: 404,
    body: { ok: false, error: 'unknown_command', message: "unknown command: '" + cmd + "'" },
  };
}

// Map an HTTP method + path + parsed JSON body to a canonical command request object.
function mapHttpToCommand(method, urlPath, bodyObj) {
  const cleanPath = String(urlPath || '/').split('?')[0];
  const base = bodyObj && typeof bodyObj === 'object' ? Object.assign({}, bodyObj) : {};
  if (method === 'GET' && (cleanPath === '/v1/status' || cleanPath === '/status' || cleanPath === '/')) {
    return { cmd: 'status' };
  }
  if (method === 'GET' && (cleanPath === '/v1/control-center' || cleanPath === '/control-center')) {
    return { cmd: 'control-center' };
  }
  if (method === 'GET' && (cleanPath === '/v1/config' || cleanPath === '/config')) {
    return { cmd: 'config' };
  }
  if (method === 'POST' && (cleanPath === '/v1/switch' || cleanPath === '/switch')) {
    return Object.assign(base, { cmd: 'switch' });
  }
  if (method === 'POST' && (cleanPath === '/v1/failover' || cleanPath === '/failover')) {
    return Object.assign(base, { cmd: 'failover' });
  }
  if (method === 'POST' && (cleanPath === '/v1/run-now' || cleanPath === '/run-now')) {
    return Object.assign(base, { cmd: 'run-now' });
  }
  if (method === 'POST' && (cleanPath === '/v1/config' || cleanPath === '/config')) {
    return Object.assign(base, { cmd: 'config' });
  }
  if (method === 'POST' && (cleanPath === '/v1/service-restart' || cleanPath === '/service-restart')) {
    return Object.assign(base, { cmd: 'service-restart' });
  }
  if (method === 'POST' && (cleanPath === '/v1/command' || cleanPath === '/command')) {
    return base;
  }
  return { cmd: '__not_found__' };
}

function statusReasonPhrase(code) {
  if (code === 200) return 'OK';
  if (code === 400) return 'Bad Request';
  if (code === 404) return 'Not Found';
  if (code === 503) return 'Service Unavailable';
  return 'Internal Server Error';
}

// Start the Unix domain socket server (supports both HTTP/1.1 and single-line JSON-RPC).
async function startServer(ctx, scheduler, opts) {
  opts = opts || {};
  const sock = socketPath(ctx, opts);
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  try {
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
  } catch (_) {
    /* ignore */
  }

  const server = net.createServer(function (conn) {
    let buf = '';
    let handledHttp = false;

    conn.setEncoding('utf8');
    conn.on('data', function (chunk) {
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        conn.end(JSON.stringify({ ok: false, error: 'payload_too_large' }) + '\n');
        conn.destroy();
        return;
      }

      const trimmed = buf.replace(/^\s+/, '');
      if (!trimmed) return;

      // Mode 1: Raw JSON-RPC line (`{"cmd":"status"}\n`)
      if (trimmed[0] === '{') {
        const nl = buf.indexOf('\n');
        // Allow either newline-terminated or complete JSON object
        let candidate = nl !== -1 ? buf.slice(0, nl).trim() : buf.trim();
        let parsed;
        try {
          parsed = JSON.parse(candidate);
        } catch (e) {
          if (nl === -1) return; // wait for more data
          conn.end(JSON.stringify({ ok: false, error: 'invalid_json' }) + '\n');
          return;
        }
        buf = nl !== -1 ? buf.slice(nl + 1) : '';
        handleCommand(ctx, scheduler, parsed, opts)
          .then(function (res) {
            const payload = JSON.stringify(redactSecrets(res.body)) + '\n';
            conn.end(payload);
          })
          .catch(function (e) {
            conn.end(
              JSON.stringify({ ok: false, error: redactText((e && e.message) || 'internal_error') }) + '\n',
            );
          });
        return;
      }

      // Mode 2: HTTP/1.1 over Unix domain socket
      if (handledHttp) return;
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headPart = buf.slice(0, headerEnd);
      const lines = headPart.split('\r\n');
      const reqLine = (lines[0] || '').split(' ');
      const method = (reqLine[0] || 'GET').toUpperCase();
      const urlPath = reqLine[1] || '/';

      let contentLength = 0;
      for (let i = 1; i < lines.length; i++) {
        const m = /^content-length:\s*(\d+)/i.exec(lines[i]);
        if (m) contentLength = parseInt(m[1], 10);
      }

      const bodyReceived = Buffer.byteLength(buf.slice(headerEnd + 4), 'utf8');
      if (bodyReceived < contentLength) return; // wait for full HTTP body
      handledHttp = true;

      const rawBody = buf.slice(headerEnd + 4);
      let bodyObj = {};
      if (rawBody.trim()) {
        try {
          bodyObj = JSON.parse(rawBody);
        } catch (_) {
          const errJson = JSON.stringify({ ok: false, error: 'invalid_json' });
          conn.end(
            'HTTP/1.1 400 Bad Request\r\n' +
              'Content-Type: application/json; charset=utf-8\r\n' +
              'Content-Length: ' +
              Buffer.byteLength(errJson, 'utf8') +
              '\r\n' +
              'Connection: close\r\n\r\n' +
              errJson,
          );
          return;
        }
      }

      const cmdReq = mapHttpToCommand(method, urlPath, bodyObj);
      handleCommand(ctx, scheduler, cmdReq, opts)
        .then(function (res) {
          const jsonStr = JSON.stringify(redactSecrets(res.body));
          const code = res.status || 200;
          conn.end(
            'HTTP/1.1 ' +
              code +
              ' ' +
              statusReasonPhrase(code) +
              '\r\n' +
              'Content-Type: application/json; charset=utf-8\r\n' +
              'Content-Length: ' +
              Buffer.byteLength(jsonStr, 'utf8') +
              '\r\n' +
              'Connection: close\r\n\r\n' +
              jsonStr,
          );
        })
        .catch(function (e) {
          const jsonStr = JSON.stringify({
            ok: false,
            error: redactText((e && e.message) || 'internal_error'),
          });
          conn.end(
            'HTTP/1.1 500 Internal Server Error\r\n' +
              'Content-Type: application/json; charset=utf-8\r\n' +
              'Content-Length: ' +
              Buffer.byteLength(jsonStr, 'utf8') +
              '\r\n' +
              'Connection: close\r\n\r\n' +
              jsonStr,
          );
        });
    });

    conn.on('error', function () {
      /* ignore client disconnect errors */
    });
  });

  await new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(sock, function () {
      server.removeListener('error', reject);
      try {
        fs.chmodSync(sock, 0o600);
      } catch (_) {
        /* ignore on platforms without unix socket chmod */
      }
      resolve();
    });
  });

  return {
    socketPath: sock,
    server: server,
    close: function () {
      return new Promise(function (resolve) {
        server.close(function () {
          try {
            if (fs.existsSync(sock)) fs.unlinkSync(sock);
          } catch (_) {
            /* ignore */
          }
          resolve();
        });
      });
    },
  };
}

// Query a running daemon over the Unix domain socket using newline-delimited JSON.
function querySocket(ctx, req, opts) {
  opts = opts || {};
  const sock = socketPath(ctx, opts);
  const timeoutMs = opts.timeoutMs || 3000;
  return new Promise(function (resolve) {
    if (!fs.existsSync(sock)) {
      resolve({ ok: false, reachable: false, reason: 'socket_missing', socketPath: sock });
      return;
    }
    let done = false;
    const finish = function (val) {
      if (done) return;
      done = true;
      resolve(val);
    };
    const client = net.createConnection({ path: sock });
    let buf = '';
    const timer = setTimeout(function () {
      client.destroy();
      finish({ ok: false, reachable: false, reason: 'timeout', socketPath: sock });
    }, timeoutMs);

    client.setEncoding('utf8');
    client.on('connect', function () {
      client.write(JSON.stringify(req || { cmd: 'status' }) + '\n');
    });
    client.on('data', function (chunk) {
      buf += chunk;
    });
    client.on('end', function () {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(buf.trim());
        finish({ ok: Boolean(parsed && parsed.ok !== false), reachable: true, response: parsed, socketPath: sock });
      } catch (e) {
        finish({ ok: false, reachable: true, reason: 'invalid_response', socketPath: sock });
      }
    });
    client.on('error', function (err) {
      clearTimeout(timer);
      finish({
        ok: false,
        reachable: false,
        reason: (err && err.code) || (err && err.message) || 'connect_error',
        socketPath: sock,
      });
    });
  });
}

// ---- launchd plist generation, legacy migration & service lifecycle ----

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plistXml(opts) {
  const argv = opts.argv || [];
  const log = opts.log || '';
  const pathEnv = opts.pathEnv || '';
  const home = opts.home || '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '<dict>\n' +
    '  <key>Label</key>\n' +
    '  <string>' +
    LABEL +
    '</string>\n' +
    '  <key>ProgramArguments</key>\n' +
    '  <array>\n' +
    argv
      .map(function (a) {
        return '    <string>' + xmlEscape(a) + '</string>';
      })
      .join('\n') +
    '\n' +
    '  </array>\n' +
    (pathEnv || home
      ? '  <key>EnvironmentVariables</key>\n' +
        '  <dict>\n' +
        (pathEnv ? '    <key>PATH</key>\n    <string>' + xmlEscape(pathEnv) + '</string>\n' : '') +
        (home ? '    <key>HOME</key>\n    <string>' + xmlEscape(home) + '</string>\n' : '') +
        '  </dict>\n'
      : '') +
    '  <key>RunAtLoad</key>\n' +
    '  <true/>\n' +
    '  <key>KeepAlive</key>\n' +
    '  <true/>\n' +
    '  <key>ThrottleInterval</key>\n' +
    '  <integer>10</integer>\n' +
    (log
      ? '  <key>StandardOutPath</key>\n' +
        '  <string>' +
        xmlEscape(log) +
        '</string>\n' +
        '  <key>StandardErrorPath</key>\n' +
        '  <string>' +
        xmlEscape(log) +
        '</string>\n'
      : '') +
    '</dict>\n' +
    '</plist>\n'
  );
}

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Install `com.keyflip.daemon.plist` and cleanly migrate/unload the 4 legacy launchd plists
// with a backup and rollback note under `<configDir>/backups/legacy-launchd/<timestamp>/`.
function install(ctx, opts) {
  opts = opts || {};
  const platform = opts.platform || ctx.platform || process.platform;
  if (platform !== 'darwin') {
    return { ok: false, kind: 'unsupported', reason: 'keyflip daemon launchd install is macOS-only' };
  }
  const home = opts.home || ctx.home;
  const run = opts.run || defaultRun;
  const selfOpts = Object.assign({ run: run }, opts.self || {});
  const self = _selfbin.resolveSelf(selfOpts);
  const cmdObj = _selfbin.argvFor(self, ['daemon', 'run']);
  const argv = [cmdObj.exec].concat(cmdObj.args);
  const probs = _selfbin.problems(cmdObj, selfOpts);
  if (probs.length) {
    return { ok: false, kind: 'launchd', reason: 'unrunnable', detail: probs.join('; ') };
  }
  const pathEnv = _selfbin.jobPath(self.exec, opts.self);
  const lf = logPath(home, opts);
  const dest = plistPath(home);
  const nowIso = ctx.now ? ctx.now() : new Date().toISOString();
  const stamp = nowIso.replace(/[:.]/g, '-');

  // 1. Migrate & back up any existing legacy plists
  const foundLegacy = legacyPlistPaths(home).filter(function (lp) {
    return fs.existsSync(lp.path);
  });
  let backupDir = null;
  const removedLegacy = [];

  if (foundLegacy.length) {
    backupDir = path.join(ctx.configDir, 'backups', 'legacy-launchd', stamp);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    foundLegacy.forEach(function (lp) {
      const copyDest = path.join(backupDir, path.basename(lp.path));
      fs.copyFileSync(lp.path, copyDest);
      run('launchctl', ['unload', '-w', lp.path]);
      try {
        fs.unlinkSync(lp.path);
      } catch (_) {
        /* ignore */
      }
      removedLegacy.push(lp.label);
    });

    const rollbackMd =
      '# Eski Keyflip Launchd İşlerine Geri Dönüş (Rollback)\n\n' +
      'Bu yedek `' +
      nowIso +
      '` tarihinde `keyflip daemon install` tarafından oluşturuldu.\n\n' +
      'Yedeklenen eski plist dosyaları:\n' +
      removedLegacy
        .map(function (l) {
          return '- `' + l + '.plist`';
        })
        .join('\n') +
      '\n\n' +
      '## Geri Yükleme Adımları\n\n' +
      '```bash\n' +
      'keyflip daemon uninstall\n' +
      'cp "' +
      backupDir +
      '"/*.plist "' +
      path.join(home, 'Library', 'LaunchAgents') +
      '/"\n' +
      removedLegacy
        .map(function (l) {
          return 'launchctl load -w "' + path.join(home, 'Library', 'LaunchAgents', l + '.plist') + '"';
        })
        .join('\n') +
      '\n```\n';
    atomicWrite(path.join(backupDir, 'ROLLBACK.md'), rollbackMd, 0o600);
  }

  // 2. Write and load com.keyflip.daemon.plist
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  const xml = plistXml({ argv: argv, log: lf, pathEnv: pathEnv, home: home });
  atomicWrite(dest, xml, 0o644);
  run('launchctl', ['unload', '-w', dest]);
  const loadRes = run('launchctl', ['load', '-w', dest]);

  const receipt = {
    job: 'daemon',
    label: LABEL,
    kind: 'launchd',
    path: dest,
    log: lf,
    socketPath: socketPath(ctx, opts),
    argv: argv,
    ephemeral: Boolean(self.ephemeral),
    migratedLegacy: removedLegacy,
    legacyBackupDir: backupDir,
    installedAt: nowIso,
  };
  fs.mkdirSync(ctx.configDir, { recursive: true, mode: 0o700 });
  atomicWrite(recordPath(ctx), JSON.stringify(receipt, null, 2), 0o600);
  appendDaemonLog(
    ctx,
    'installed ' +
      LABEL +
      (removedLegacy.length ? ' (migrated legacy: ' + removedLegacy.join(', ') + ')' : ''),
    opts,
  );

  return Object.assign({ ok: loadRes.code === 0, loadCode: loadRes.code }, receipt);
}

function uninstall(ctx, opts) {
  opts = opts || {};
  const platform = opts.platform || ctx.platform || process.platform;
  if (platform !== 'darwin') {
    return { ok: false, kind: 'unsupported' };
  }
  const home = opts.home || ctx.home;
  const run = opts.run || defaultRun;
  const dest = plistPath(home);
  const existed = fs.existsSync(dest);
  const prevRec = readRecord(ctx);

  if (existed) {
    run('launchctl', ['unload', '-w', dest]);
    try {
      fs.unlinkSync(dest);
    } catch (_) {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(recordPath(ctx));
  } catch (_) {
    /* ignore */
  }
  const sock = socketPath(ctx, opts);
  try {
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
  } catch (_) {
    /* ignore */
  }
  appendDaemonLog(ctx, 'uninstalled ' + LABEL, opts);
  return {
    ok: true,
    kind: 'launchd',
    existed: existed,
    path: dest,
    legacyBackupDir: (prevRec && prevRec.legacyBackupDir) || null,
  };
}

function parseProgramArguments(xml) {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!m) return [];
  const out = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let s;
  while ((s = re.exec(m[1])) !== null) out.push(s[1]);
  return out;
}

function parseLaunchctlSingle(out) {
  if (!out) return { loaded: false, pid: null, lastExit: null };
  const pidMatch = /"PID"\s*=\s*(-?\d+)\s*;/.exec(out);
  const exitMatch = /"LastExitStatus"\s*=\s*(-?\d+)\s*;/.exec(out);
  return {
    loaded: true,
    pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
    lastExit: exitMatch ? parseInt(exitMatch[1], 10) : null,
  };
}

// Inspect the launchd plist, launchctl state, legacy plist leftovers, and optionally query the live socket.
async function status(ctx, opts) {
  opts = opts || {};
  const home = opts.home || ctx.home || '';
  const p = home ? plistPath(home) : '';
  const rec = readRecord(ctx);
  const plistExists = Boolean(p && fs.existsSync(p));
  const installed = Boolean(plistExists || rec);
  const problems = [];

  let argv = (rec && rec.argv) || [];
  if (plistExists) {
    try {
      const xml = fs.readFileSync(p, 'utf8');
      const parsed = parseProgramArguments(xml);
      if (parsed.length) argv = parsed;
    } catch (_) {
      /* ignore */
    }
  }

  if (argv.length) {
    _selfbin.problems({ exec: argv[0], args: argv.slice(1) }, opts.self).forEach(function (pr) {
      problems.push(pr);
    });
  }

  let loaded = null;
  let pid = null;
  let lastExit = null;
  if (plistExists && opts.run) {
    const r = opts.run('launchctl', ['list', LABEL]);
    if (r && r.code === 0) {
      const info = parseLaunchctlSingle(r.stdout || '');
      loaded = info.loaded;
      pid = info.pid;
      lastExit = info.lastExit;
    } else {
      loaded = false;
      problems.push('launchd has not loaded ' + LABEL + ' — run `keyflip daemon install -y`');
    }
  }

  const lingeringLegacy = home
    ? legacyPlistPaths(home)
        .filter(function (lp) {
          return fs.existsSync(lp.path);
        })
        .map(function (lp) {
          return lp.label;
        })
    : [];

  if (lingeringLegacy.length) {
    problems.push(
      'legacy launchd job(s) still present (' +
        lingeringLegacy.join(', ') +
        ') — run `keyflip daemon install -y` to consolidate',
    );
  }

  let socketInfo = { ok: false, reachable: false, reason: 'not_probed', socketPath: socketPath(ctx, opts) };
  if (opts.probeSocket !== false) {
    socketInfo = await querySocket(ctx, { cmd: 'status' }, opts);
  }

  return redactSecrets({
    installed: installed,
    plistExists: plistExists,
    label: LABEL,
    path: p || (rec && rec.path) || null,
    log: home ? logPath(home, opts) : (rec && rec.log) || null,
    socketPath: socketPath(ctx, opts),
    loaded: loaded,
    pid: pid || (socketInfo.response && socketInfo.response.daemon && socketInfo.response.daemon.pid) || null,
    lastExit: lastExit,
    socketReachable: Boolean(socketInfo.reachable && socketInfo.ok),
    liveStatus: socketInfo.ok ? socketInfo.response : null,
    stateOnDisk: readState(ctx),
    lingeringLegacy: lingeringLegacy,
    legacyBackupDir: (rec && rec.legacyBackupDir) || null,
    healthy: Boolean(installed && problems.length === 0 && loaded !== false),
    problems: problems,
  });
}

// Start the full daemon (scheduler + Unix socket server) and return a handle `{ scheduler, server, stop }`.
async function startDaemon(ctx, opts) {
  opts = opts || {};
  const scheduler = createScheduler(ctx, opts);
  const srv = await startServer(ctx, scheduler, opts);
  scheduler.start({ runOnStart: opts.runOnStart !== false });
  appendDaemonLog(ctx, 'started (pid=' + process.pid + ', socket=' + srv.socketPath + ')', opts);

  return {
    scheduler: scheduler,
    server: srv,
    socketPath: srv.socketPath,
    stop: async function () {
      scheduler.stop();
      await srv.close();
      appendDaemonLog(ctx, 'stopped (pid=' + process.pid + ')', opts);
    },
  };
}

export {
  LABEL,
  LEGACY_LABELS,
  RECORD_NAME,
  STATE_NAME,
  SOCKET_NAME,
  JOB_NAMES,
  socketPath,
  recordPath,
  statePath,
  plistPath,
  legacyPlistPaths,
  logPath,
  redactSecrets,
  redactText,
  rotateLogIfNeeded,
  appendDaemonLog,
  createScheduler,
  buildStatus,
  buildControlCenter,
  handleCommand,
  startServer,
  querySocket,
  plistXml,
  install,
  uninstall,
  status,
  startDaemon,
};
