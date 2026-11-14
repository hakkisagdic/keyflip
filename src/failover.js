// P4: when EVERY Claude account is over the threshold, keep working — on the API, through keysmith.
//
// keysmith (a separate tool) runs an OpenAI/Anthropic-compatible gateway on 127.0.0.1:8787 and OWNS
// the failover: its alias `claude-failover` (gmail API key -> kiro-emu -> agy on this machine) and the
// spend cap on the paid first leg (keysmith `limits.spend`, e.g. 25 USD over 12 Nov..9 Dec), past
// which the gateway refuses that leg and the alias falls through. keyflip USES that alias, it does
// not define one: it never creates or edits an alias and never writes a cap. It only
//   - reads the alias's legs and the paid leg's cap (keysmith's config, in-process, never printed),
//   - mints a key scoped to exactly that alias and its legs, kept in keyflip's credential store as
//     the key of a keyflip provider profile (never printed, never on a command line),
//   - engages only once the RUNNING gateway reports a cap of at most failover.capUsd on that leg.
// Engaging points Claude Code at the alias (settings.json env, hot reload, no restart) and asks Claude
// Desktop to move to third-party gateway mode, applied on a restart taken only while it is idle (P5).
// Releasing undoes both once a Claude account has headroom again.
//
// Every side effect is injectable (run, fetch, keysmith config path, provider/desktop ops) so tests
// never touch the real gateway, keychain, settings.json or app.
import { spawnSync as _spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run as _run } from './exec.js';
import { atomicWrite, writeJsonStable } from './fsutil.js';
import * as _provider from './provider.js';
import * as _settings from './settings.js';
import * as _config from './config.js';
import * as _history from './history.js';
import * as _desktopgw from './desktopgw.js';
import * as _desktoprestart from './desktoprestart.js';
import * as _fosurface from './fosurface.js';
import * as _sessions from './sessions.js';
import * as _log from './log.js';
import { redact, registerSecret } from './redact.js';
import { writeLiveSince } from './livesince.js';

const STATE_FILE = '.failover-state.json';
const ENGAGE_FAIL_FILE = '.failover-engage-fail.json';
const EXHAUSTED_FILE = '.exhausted.json';
const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:8787',
  alias: 'claude-failover',
  capUsd: 25,
  provider: 'keysmith-failover',
  keyLabel: 'keyflip-failover',
};

function cfg(ctx, key, dflt) {
  try {
    const v = _config.get(ctx, key);
    return v === undefined || v === null || v === '' ? dflt : v;
  } catch (e) {
    return dflt;
  }
}

// The plan, from config (failover.*) over the defaults. Pure: reads keyflip's config only. The legs
// are keysmith's (aliasLegs); `capUsd` is the most the failover accepts on the paid leg, not a cap
// keyflip sets.
function plan(ctx) {
  return {
    enabled: cfg(ctx, 'failover.enabled', true) !== false,
    gatewayUrl: String(cfg(ctx, 'failover.gatewayUrl', DEFAULTS.gatewayUrl)).replace(/\/+$/, ''),
    alias: cfg(ctx, 'failover.alias', DEFAULTS.alias),
    capUsd: cfg(ctx, 'failover.capUsd', DEFAULTS.capUsd),
    provider: cfg(ctx, 'failover.provider', DEFAULTS.provider),
    legs: null,
    capAdapter: null,
  };
}

// How to run keysmith: `keysmith` on PATH, else the checkout's src/cli.js under this node.
function keysmithCommand(opts) {
  opts = opts || {};
  const runner = opts.run || _run;
  const w = runner('which', ['keysmith']);
  if (w && w.code === 0 && String(w.stdout || '').trim())
    return { exec: String(w.stdout).trim().split('\n')[0], args: [] };
  const dir = opts.keysmithDir || process.env.KEYSMITH_DIR || path.join(os.homedir(), 'Projects', 'keysmith');
  return { exec: process.execPath, args: [path.join(dir, 'src', 'cli.js')] };
}
function keysmithConfigPath(opts) {
  opts = opts || {};
  if (opts.keysmithConfig) return opts.keysmithConfig;
  if (process.env.KEYSMITH_CONFIG) return process.env.KEYSMITH_CONFIG;
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'keysmith', 'config.json');
}
// keysmith's config holds the gateway's own keys: it is parsed in-process for the alias and the caps
// and NEVER printed or written by keyflip.
function readKeysmithConfig(opts) {
  const p = keysmithConfigPath(opts);
  let j;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { error: 'could not read the keysmith config (' + p + '): ' + (e.code || e.message) };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'the keysmith config is not an object' };
  return { config: j };
}

// A cap keysmith holds for an adapter, in any of the forms it accepts (prefixed, nested, flat id)
// -> the raw value, or undefined.
function existingCap(spend, adapterId) {
  if (!spend || typeof spend !== 'object') return undefined;
  const pre = spend['adapter:' + adapterId];
  if (pre !== undefined && pre !== null) return pre;
  const nests = ['adapters', 'adapter', 'byAdapter'];
  for (let n = 0; n < nests.length; n++) {
    const sub = spend[nests[n]];
    if (
      sub &&
      typeof sub === 'object' &&
      !Array.isArray(sub) &&
      sub[adapterId] !== undefined &&
      sub[adapterId] !== null
    )
      return sub[adapterId];
  }
  if (spend[adapterId] !== undefined && spend[adapterId] !== null) return spend[adapterId];
  return undefined;
}
function capUsdOf(v) {
  const n = v && typeof v === 'object' ? (v.usd !== undefined ? v.usd : v.cap !== undefined ? v.cap : v.limit) : v;
  const x = Number(n);
  return n === null || n === undefined || n === false || n === '' || !isFinite(x) ? null : x;
}
function describeCap(v) {
  const usd = capUsdOf(v);
  if (usd === null) return 'no cap';
  const w = v && typeof v === 'object' && (v.since || v.until) ? v : null;
  return '$' + usd + (w ? ' over ' + (w.since || '…') + '..' + (w.until || '…') : '/month');
}

// The alias keysmith serves, read from its config: its legs in order, the paid first leg's adapter
// and the cap keysmith holds on it. -> { legs, capAdapter, cap: { usd, text } | null } | { error }
function aliasLegs(p, opts) {
  const r = readKeysmithConfig(opts);
  if (r.error) return { error: r.error };
  const aliases = r.config.aliases && typeof r.config.aliases === 'object' ? r.config.aliases : {};
  const raw = aliases[p.alias];
  const legs = (Array.isArray(raw) ? raw : raw && Array.isArray(raw.legs) ? raw.legs : [])
    .map(function (s) {
      return typeof s === 'string' ? s.trim() : '';
    })
    .filter(Boolean);
  if (!legs.length)
    return {
      error:
        'keysmith has no alias ' +
        p.alias +
        " — keyflip uses the gateway's own failover alias and does not create one (keysmith alias " +
        p.alias +
        ' <leg>…)',
    };
  const capAdapter = legs[0].split('/')[0];
  const spend = r.config.limits && typeof r.config.limits === 'object' ? r.config.limits.spend : null;
  const c = existingCap(spend, capAdapter);
  return {
    legs: legs,
    capAdapter: capAdapter,
    cap: c === undefined ? null : { usd: capUsdOf(c), text: describeCap(c) },
  };
}

// plan() + the alias as keysmith defines it. Never throws: a keysmith that cannot be read leaves
// legs null and says why in `aliasError`.
function resolvePlan(ctx, opts) {
  const p = plan(ctx);
  const a = aliasLegs(p, opts);
  if (a.error) p.aliasError = a.error;
  else {
    p.legs = a.legs;
    p.capAdapter = a.capAdapter;
    p.configCap = a.cap;
  }
  return p;
}

// `keyflip failover setup`: check keysmith's alias and cap (read-only), mint the scoped key, save the
// provider profile. Idempotent; changes nothing in keysmith but adding that one key (which the
// gateway picks up without a restart).
// -> { ok, steps: [{ step, ok, detail }], plan, restartGateway: false }
async function setup(ctx, opts) {
  opts = opts || {};
  const runner = opts.run || _run;
  const p = resolvePlan(ctx, opts);
  const steps = [];
  const dry = !!opts.dryRun;
  // 1) the alias: keysmith's, as it is
  if (p.aliasError) {
    steps.push({ step: 'alias', ok: false, detail: p.aliasError });
    return { ok: false, steps: steps, plan: p, restartGateway: false };
  }
  steps.push({
    step: 'alias',
    ok: true,
    detail: p.alias + ' = ' + p.legs.join(' -> ') + " (keysmith's own; keyflip does not change it)",
  });
  // 2) the cap on the paid leg: keysmith's to set, keyflip only checks it
  const cap = p.configCap;
  const capOk = !!(cap && cap.usd !== null && cap.usd <= p.capUsd);
  steps.push({
    step: 'spend-cap',
    ok: capOk,
    detail: !cap
      ? 'keysmith holds no spend cap on ' +
        p.capAdapter +
        ' — the failover stays off until keysmith caps it at $' +
        p.capUsd +
        ' or less (keyflip never writes caps)'
      : 'keysmith caps ' +
        p.capAdapter +
        ' at ' +
        cap.text +
        (capOk
          ? ' (enforced by the gateway; keyflip never writes caps)'
          : ' — looser than the $' + p.capUsd + ' the failover accepts; it stays off until keysmith caps it tighter'),
  });
  // 3) a key scoped to the alias and its legs, handed over through a 0600 file, kept in the store
  let haveKey = false;
  try {
    haveKey = !!registerSecret(ctx.store.getProfile('provider__' + p.provider));
  } catch {
    haveKey = false;
  }
  const allow = ['alias:' + p.alias].concat(p.legs).join(',');
  if (haveKey) steps.push({ step: 'key', ok: true, detail: 'provider ' + p.provider + ' already holds a gateway key' });
  else if (dry) steps.push({ step: 'key', ok: true, detail: 'would mint a key scoped to ' + allow });
  else {
    const ks = keysmithCommand({ run: runner, keysmithDir: opts.keysmithDir });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-failover-'));
    const keyFile = path.join(tmpDir, 'key');
    try {
      const r = runner(
        ks.exec,
        ks.args.concat(['key', 'add', DEFAULTS.keyLabel, '--allow', allow, '--out', keyFile]),
        undefined,
        { timeoutMs: 30000 },
      );
      let key = null;
      try {
        key = fs.readFileSync(keyFile, 'utf8').trim();
      } catch {
        key = null;
      }
      if (r && r.code === 0 && key) {
        registerSecret(key);
        ctx.store.setProfile('provider__' + p.provider, key);
        steps.push({
          step: 'key',
          ok: true,
          detail: 'minted a key scoped to ' + allow + ' (stored, never printed)',
        });
      } else
        steps.push({
          step: 'key',
          ok: false,
          detail:
            'keysmith key add failed: ' +
            redact(String((r && (r.stderr || r.stdout)) || ''))
              .trim()
              .slice(0, 300),
        });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  // 4) the keyflip provider profile every surface is pointed at (saved, NOT activated)
  const models = { default: p.alias, smallFast: p.alias, haiku: p.alias, sonnet: p.alias, opus: p.alias };
  if (dry)
    steps.push({ step: 'provider', ok: true, detail: 'would save provider ' + p.provider + ' -> ' + p.gatewayUrl });
  else {
    _provider.add(ctx, p.provider, {
      baseUrl: p.gatewayUrl,
      authScheme: 'bearer',
      compat: 'anthropic',
      models: models,
    });
    steps.push({
      step: 'provider',
      ok: true,
      detail: p.provider + ' -> ' + p.gatewayUrl + ' (model ' + p.alias + '; saved, not in use)',
    });
  }
  return {
    ok: steps.every(function (s) {
      return s.ok;
    }),
    steps: steps,
    plan: p,
    // Nothing keysmith reads at start was changed; a new key is picked up by the running gateway.
    restartGateway: false,
  };
}

// The gateway checks (GET /v1/models, the usage route). The gateway answers in well under a second,
// but this machine runs at load averages near 75, where 3 s was not always enough and a false
// "unreachable" held the failover back. Each try gets GATEWAY_TIMEOUT_MS; a try that got no HTTP
// answer at all (a failed connection or a timeout) is retried once after GATEWAY_RETRY_PAUSE_MS.
// An HTTP status (401/403/404/5xx) is a real answer and is never retried. One deadline covers the
// whole check, every request in it: 2 x 15 s + 1 s = 31 s at most, so `failover status` with the
// gateway down returns within that, and a tick that checks twice (autoswitch re-checks once, 1.5 s
// apart) waits at most ~64 s on the gateway, well inside the 120 s autoswitch interval.
const GATEWAY_TIMEOUT_MS = 15000;
const GATEWAY_TRIES = 2;
const GATEWAY_RETRY_PAUSE_MS = 1000;

function sleepMs(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}
function secondsText(ms) {
  return ms < 1000 ? ms + ' ms' : Math.round(ms / 100) / 10 + ' s'; // 14998 -> "15 s", 14800 -> "14.8 s"
}
function isTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

// One budget per check: per-try timeout, pause, and the deadline shared by every request in it.
// opts: timeoutMs, retryPauseMs, sleep, now (tests).
function gatewayBudget(opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || GATEWAY_TIMEOUT_MS;
  const pauseMs = opts.retryPauseMs !== undefined ? opts.retryPauseMs : GATEWAY_RETRY_PAUSE_MS;
  const now = opts.now || Date.now;
  return {
    timeoutMs: timeoutMs,
    pauseMs: pauseMs,
    sleep: opts.sleep || sleepMs,
    now: now,
    deadline: now() + GATEWAY_TRIES * timeoutMs + (GATEWAY_TRIES - 1) * pauseMs,
  };
}

// GET url with the failover key and read its JSON body, within budget b. Retried only when no HTTP
// answer came. -> { res, json } (json null for a non-2xx or a body that is not JSON)
//               | { error: 'timed out after 15 s, 2 tries' | 'connection failed: ECONNREFUSED, 2 tries' }
async function gatewayGet(doFetch, url, key, b) {
  let tries = 0;
  let last = null;
  let lastTimeoutMs = b.timeoutMs;
  for (;;) {
    const left = b.deadline - b.now();
    if (left <= 0) break;
    lastTimeoutMs = Math.min(b.timeoutMs, left);
    tries++;
    try {
      const res = await doFetch(url, {
        headers: { Authorization: 'Bearer ' + key },
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(lastTimeoutMs) : undefined,
      });
      if (!res || !res.ok || typeof res.json !== 'function') return { res: res || null, json: null };
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        if (!e || e.name !== 'SyntaxError') throw e; // the body stalled or the connection dropped
      }
      return { res: res, json: json };
    } catch (e) {
      last = e;
    }
    if (tries >= GATEWAY_TRIES || b.deadline - b.now() <= b.pauseMs) break;
    await b.sleep(b.pauseMs);
  }
  const n = tries + (tries === 1 ? ' try' : ' tries');
  if (!tries) return { error: 'not asked: the check ran out of time' };
  if (isTimeout(last)) return { error: 'timed out after ' + secondsText(lastTimeoutMs) + ', ' + n };
  const code = last && ((last.cause && last.cause.code) || last.code);
  return { error: 'connection failed' + (code && /^[A-Z0-9_]+$/.test(code) ? ': ' + code : '') + ', ' + n };
}

// Does the RUNNING gateway enforce a spend cap of at most capUsd on the paid leg? A cap in keysmith's
// config is not proof (it reads limits at start); its own usage route is. Asked with the failover's
// scoped key, which sees exactly the caps on the adapters it can reach — and its OWN spend under them.
// opts.budget: the calling check's budget (gatewayReady); else a fresh one from opts.
async function capLoaded(p, key, doFetch, opts) {
  opts = opts || {};
  if (!p.capAdapter) return { ok: false, reason: p.aliasError || 'the alias has no paid leg to check' };
  const got = await gatewayGet(
    doFetch,
    p.gatewayUrl + '/v1/keysmith/usage?hours=1',
    key,
    opts.budget || gatewayBudget(opts),
  );
  if (got.error) return { ok: false, reason: 'could not read the spend caps from the gateway (' + got.error + ')' };
  const res = got.res;
  if (!res || !res.ok)
    return {
      ok: false,
      reason:
        'the gateway does not report its spend caps (' +
        ((res && res.status) || 'no answer') +
        '); refusing to fail over uncapped',
    };
  const j = got.json;
  const hit = (j && Array.isArray(j.spend) ? j.spend : []).find(function (r) {
    return r && r.kind === 'adapter' && r.target === p.capAdapter && typeof r.cap === 'number' && r.cap <= p.capUsd;
  });
  if (!hit)
    return {
      ok: false,
      reason:
        'the running gateway enforces no spend cap of at most $' +
        p.capUsd +
        ' on ' +
        p.capAdapter +
        ' (set it in keysmith and restart it); refusing to fail over uncapped',
    };
  const cap = { kind: hit.kind, target: hit.target, cap: hit.cap, spent: hit.spent, exceeded: !!hit.exceeded };
  if (hit.window && typeof hit.window === 'object') cap.window = { since: hit.window.since, until: hit.window.until };
  if (hit.windowStatus) cap.windowStatus = hit.windowStatus;
  return { ok: true, cap: cap };
}

// Is the gateway up, does our key work, does it serve the alias — and (unless opts.capCheck is
// false: the per-tick health check) does it enforce the spend cap? GET /v1/models + the usage route,
// both within one budget (gatewayBudget: opts.timeoutMs, retryPauseMs, sleep, now).
async function gatewayReady(ctx, opts) {
  opts = opts || {};
  const p = opts.plan || resolvePlan(ctx, opts);
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  let key = null;
  try {
    key = registerSecret(ctx.store.getProfile('provider__' + p.provider));
  } catch {
    return { ok: false, retry: true, reason: 'keychain unavailable' };
  }
  if (!key) return { ok: false, reason: 'not set up (keyflip failover setup)' };
  if (!_provider.exists(ctx, p.provider))
    return { ok: false, reason: 'provider ' + p.provider + ' missing (keyflip failover setup)' };
  if (!doFetch) return { ok: false, reason: 'no fetch' };
  const budget = gatewayBudget(opts);
  const got = await gatewayGet(doFetch, p.gatewayUrl + '/v1/models', key, budget);
  if (got.error) return { ok: false, reason: 'gateway unreachable at ' + p.gatewayUrl + ' (' + got.error + ')' };
  const res = got.res;
  if (!res || !res.ok) return { ok: false, reason: 'gateway answered ' + ((res && res.status) || 'nothing') };
  const ids = ((got.json && got.json.data) || [])
    .map(function (m) {
      return m && m.id;
    })
    .filter(Boolean);
  if (ids.indexOf(p.alias) === -1)
    return { ok: false, reason: 'gateway does not serve ' + p.alias + ' to the failover key' };
  if (opts.capCheck === false) return { ok: true, models: ids };
  const c = await capLoaded(p, key, doFetch, { budget: budget });
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, cap: c.cap, models: ids };
}

// "$25 over 2026-11-12..2026-12-09" / "$25/month" for a cap the gateway reported.
function capText(cap) {
  if (!cap || typeof cap.cap !== 'number') return null;
  return '$' + cap.cap + (cap.window ? ' over ' + cap.window.since + '..' + cap.window.until : '/month');
}

function statePath(ctx) {
  return path.join(ctx.configDir, STATE_FILE);
}
function engageFailPath(ctx) {
  return path.join(ctx.configDir, ENGAGE_FAIL_FILE);
}
function readEngageFail(ctx) {
  if (!ctx || !ctx.configDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(engageFailPath(ctx), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}
function writeEngageFail(ctx, rec) {
  if (!ctx || !ctx.configDir) return;
  atomicWrite(engageFailPath(ctx), JSON.stringify(rec, null, 2) + '\n', 0o600);
}
function clearEngageFail(ctx) {
  if (!ctx || !ctx.configDir) return;
  try {
    fs.unlinkSync(engageFailPath(ctx));
  } catch {
    /* absent */
  }
}
function state(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'));
    return j && j.engaged ? j : null;
  } catch (e) {
    return null;
  }
}

function markLost(ctx, at) {
  if (!ctx || !ctx.configDir) return null;
  const cur = state(ctx);
  if (!cur) return null;
  const iso =
    typeof at === 'number' && isFinite(at)
      ? new Date(at).toISOString()
      : typeof at === 'string' && at
        ? at
        : new Date().toISOString();
  if (!cur.lostSince) {
    cur.lostSince = iso;
    atomicWrite(statePath(ctx), JSON.stringify(cur, null, 2) + '\n', 0o600);
  }
  return cur;
}

function clearLost(ctx) {
  const cur = state(ctx);
  if (!cur) return null;
  if (cur.lostSince) {
    delete cur.lostSince;
    atomicWrite(statePath(ctx), JSON.stringify(cur, null, 2) + '\n', 0o600);
    _log.log('gateway back');
  }
  return cur;
}

function stripUrlQuery(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1');
}

function assertSettingsWritable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  if (process.platform !== 'win32') {
    const mode = fs.statSync(filePath).mode;
    if ((mode & 0o222) === 0) {
      const err = new Error('EACCES: permission denied, open ' + filePath);
      err.code = 'EACCES';
      throw err;
    }
  }
  fs.accessSync(filePath, fs.constants.W_OK);
}

// §4.3: Move onto the API failover as a transaction (write -> probe -> commit or rollback).
// Never touches Claude Desktop or requests a gateway-* restart.
async function engage(ctx, info, deps) {
  deps = deps || {};
  info = info || {};
  const p = plan(ctx);
  if (!p.enabled) return { ok: false, disabled: true, reason: 'failover is disabled (failover.enabled=false)' };
  const cur = state(ctx);
  if (cur) {
    if (info.manual && !cur.manual) {
      cur.manual = true;
      if (info.reason) cur.reason = redact(stripUrlQuery(info.reason));
      atomicWrite(statePath(ctx), JSON.stringify(cur, null, 2) + '\n', 0o600);
    }
    return { ok: true, already: true, state: cur };
  }

  const nowFn =
    deps.now ||
    (deps.nowMs !== undefined
      ? function () {
          return deps.nowMs;
        }
      : info.nowMs !== undefined
        ? function () {
            return info.nowMs;
          }
        : ctx && ctx.nowMs !== undefined
          ? function () {
              return ctx.nowMs;
            }
          : function () {
              return Date.now();
            });
  const nowMs = nowFn();

  if (!info.manual) {
    const prevFail = readEngageFail(ctx);
    if (prevFail) {
      const atMs = typeof prevFail.at === 'number' ? prevFail.at : Date.parse(prevFail.at);
      if (isFinite(atMs)) {
        const probeEveryMin = Number(cfg(ctx, 'failover.probeEveryMinutes', 10)) || 10;
        const backoffMs = Math.max(probeEveryMin, 30) * 60 * 1000;
        let nextTryMs = atMs + backoffMs;
        if (prevFail.class === 'quota' && prevFail.resetAt) {
          const resetMs = Date.parse(prevFail.resetAt);
          if (isFinite(resetMs) && resetMs > nowMs) {
            nextTryMs = Math.min(resetMs, atMs + 6 * 3600 * 1000);
          }
        }
        if (nowMs < nextTryMs) {
          const failClass = prevFail.class || 'other';
          return {
            ok: false,
            backoff: true,
            reason:
              'engage failed at ' +
              new Date(atMs).toISOString() +
              ' (' +
              failClass +
              '); next try after ' +
              new Date(nextTryMs).toISOString(),
          };
        }
      }
    }
  }

  const rp = resolvePlan(ctx, { keysmithConfig: deps.keysmithConfig });
  const ready = await gatewayReady(ctx, { plan: rp, fetch: deps.fetch });
  if (!ready.ok) {
    return ready.retry ? { ok: false, retry: true, reason: ready.reason } : { ok: false, reason: ready.reason };
  }

  const chosen = _fosurface.chooseSurface(ctx, ready.models || []);
  let fallbackReason = chosen.fallbackReason || null;
  if (fallbackReason) {
    _log.log('failover: falling back to cli-launcher (' + fallbackReason + ')');
  }

  async function attemptSurface(surface) {
    const startedAt = nowFn();
    const txnRec = _fosurface.beginTxn(ctx, surface, {
      plan: rp,
      startedAt: startedAt,
      useProvider: deps.useProvider,
    });
    const probeEnabled = cfg(ctx, 'failover.probeEnabled', true) !== false;
    let pRes;
    if (probeEnabled) {
      pRes = await _fosurface.probe(ctx, surface, {
        spawn: deps.spawn,
        run: deps.run,
        env: deps.env,
        now: nowFn,
        timeoutMs: deps.probeTimeoutMs,
        supportsNoSessionPersistence: deps.supportsNoSessionPersistence,
        claudeBin: deps.claudeBin,
      });
    } else {
      pRes = {
        at: startedAt,
        ok: true,
        ms: 0,
        models: [],
        reason: null,
        costUsd: null,
      };
    }
    const probeSummary = {
      at: pRes.at,
      ok: !!pRes.ok,
      ms: typeof pRes.ms === 'number' ? pRes.ms : 0,
      models: Array.isArray(pRes.models) ? pRes.models : [],
      reason: pRes.reason || null,
      costUsd: pRes.costUsd !== undefined ? pRes.costUsd : null,
    };
    if (pRes.resetAt) probeSummary.resetAt = pRes.resetAt;

    if (pRes.ok) {
      const liveTxn = _fosurface.readTxn(ctx);
      if (!liveTxn || liveTxn.phase !== 'probing' || liveTxn.startedAt !== txnRec.startedAt) {
        return {
          ok: false,
          surface: surface,
          startedAt: startedAt,
          probe: probeSummary,
          class: 'other',
          reason: 'transaction was rolled back during the probe',
        };
      }
      _fosurface.commitTxn(ctx, txnRec, probeSummary);
      return { ok: true, surface: surface, startedAt: startedAt, probe: probeSummary };
    }

    _fosurface.rollbackTxn(ctx, txnRec, probeSummary);
    _history.recordEvent(ctx, {
      kind: 'failover-engage-failed',
      surface: surface,
      reason: stripUrlQuery(pRes.reason || 'probe failed'),
    });
    return {
      ok: false,
      surface: surface,
      startedAt: startedAt,
      probe: probeSummary,
      class: pRes.class || 'other',
      reason: pRes.reason || 'probe failed',
    };
  }

  let attempt = await attemptSurface(chosen.surface);
  // §4.3 step 7: if surface was `cli-settings` and failure is not gateway-wide (`auth`/`quota`),
  // retry once with `cli-launcher`.
  if (!attempt.ok && chosen.surface === 'cli-settings' && attempt.class !== 'auth' && attempt.class !== 'quota') {
    fallbackReason = 'cli-settings probe failed (' + attempt.reason + ')';
    _log.log('failover: retrying cli-launcher after ' + fallbackReason);
    attempt = await attemptSurface('cli-launcher');
  }

  if (!attempt.ok) {
    const prevFail = readEngageFail(ctx);
    const failClass = attempt.class || 'other';
    const shouldNotify = !prevFail || prevFail.class !== failClass;
    writeEngageFail(ctx, {
      at: attempt.startedAt !== undefined ? attempt.startedAt : nowFn(),
      class: failClass,
      reason: redact(stripUrlQuery(attempt.reason || 'probe failed')),
      resetAt: (attempt.probe && attempt.probe.resetAt) || null,
      count: (prevFail && typeof prevFail.count === 'number' ? prevFail.count : 0) + 1,
    });
    if (deps.notify && shouldNotify) {
      await deps.notify('quota', 'API failover could not be switched on: ' + attempt.reason);
    }
    return {
      ok: false,
      surface: attempt.surface,
      reason: attempt.reason,
      probe: attempt.probe,
      fallbackReason: fallbackReason,
    };
  }

  clearEngageFail(ctx);

  const cleanReason = redact(stripUrlQuery(info.reason || 'every Claude account is over the threshold'));
  const st = {
    engaged: true,
    at: attempt.startedAt,
    surface: attempt.surface,
    from: info.from || null,
    reason: cleanReason,
    manual: !!info.manual,
    provider: p.provider,
    alias: p.alias,
    recoverAt: info.recoverAt || null,
    cap: ready.cap || null,
    txn: attempt.probe,
  };
  if (fallbackReason) st.fallbackReason = fallbackReason;
  atomicWrite(statePath(ctx), JSON.stringify(st, null, 2) + '\n', 0o600);
  _history.recordEvent(ctx, {
    kind: 'failover-engage',
    from: st.from,
    to: p.provider,
    surface: attempt.surface,
    reason: cleanReason,
    probeMs: attempt.probe.ms,
  });
  if (deps.notify) {
    await deps.notify(
      'quota',
      'All Claude accounts are over the threshold — now on the API failover (' +
        rp.alias +
        ': ' +
        (rp.legs || []).join(' -> ') +
        ', surface ' +
        attempt.surface +
        ', paid leg capped at ' +
        (capText(ready.cap) || '$' + p.capUsd) +
        ' by keysmith).',
    );
  }
  return { ok: true, state: st, surface: attempt.surface, fallbackReason: fallbackReason };
}

// §8.1 & §8.2: Turn the failover off. Works regardless of `failover.enabled`.
// Each cleanup step runs independently so a failure in one never skips the rest.
async function release(ctx, info, deps) {
  deps = deps || {};
  info = info || {};
  const liveMarkerOpts = { nowMs: deps.nowMs !== undefined ? deps.nowMs : info.nowMs };
  const p = plan(ctx);
  const cur = state(ctx);
  const txnRec = _fosurface.readTxn(ctx);
  const activeRec = _provider.readActive(ctx);
  const cleaned = [];
  const failed = [];

  const targetProvider = (cur && cur.provider) || p.provider;
  const shouldCleanActive = !!(activeRec && (!activeRec.name || activeRec.name === targetProvider));

  // Step 1: settings.json — remove recorded keys + any unrecorded managed keys carrying our gateway URL/alias.
  try {
    if (typeof deps.useOfficial === 'function') {
      deps.useOfficial();
      cleaned.push('settings.json');
    } else if (ctx && ctx.claudeSettingsPath && fs.existsSync(ctx.claudeSettingsPath)) {
      const cfgObj = _settings.read(ctx.claudeSettingsPath);
      if (cfgObj && cfgObj.env && typeof cfgObj.env === 'object') {
        const recordedSet = new Set();
        if (txnRec && Array.isArray(txnRec.wrote)) {
          txnRec.wrote.forEach(function (w) {
            if (w && w.kind === 'settings-env' && Array.isArray(w.keys)) {
              w.keys.forEach(function (k) {
                if (_provider.ALL_MANAGED.indexOf(k) !== -1) recordedSet.add(k);
              });
            }
          });
        }
        if (shouldCleanActive && Array.isArray(activeRec.envKeys)) {
          activeRec.envKeys.forEach(function (k) {
            if (_provider.ALL_MANAGED.indexOf(k) !== -1) recordedSet.add(k);
          });
        }
        const unrecordedSet = new Set();
        if (
          typeof cfgObj.env.ANTHROPIC_BASE_URL === 'string' &&
          cfgObj.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') === p.gatewayUrl
        ) {
          unrecordedSet.add('ANTHROPIC_BASE_URL');
          if ('ANTHROPIC_AUTH_TOKEN' in cfgObj.env) unrecordedSet.add('ANTHROPIC_AUTH_TOKEN');
          if ('ANTHROPIC_API_KEY' in cfgObj.env) unrecordedSet.add('ANTHROPIC_API_KEY');
        }
        Object.keys(_provider.MODEL_KEYS).forEach(function (role) {
          const mk = _provider.MODEL_KEYS[role];
          if (cfgObj.env[mk] === p.alias) unrecordedSet.add(mk);
        });

        const toRemove = [];
        let removedUnrecorded = false;
        _provider.ALL_MANAGED.forEach(function (k) {
          if (!(k in cfgObj.env)) return;
          if (recordedSet.has(k)) {
            toRemove.push(k);
          } else if (unrecordedSet.has(k)) {
            toRemove.push(k);
            removedUnrecorded = true;
          }
        });

        if (toRemove.length) {
          assertSettingsWritable(ctx.claudeSettingsPath);
          toRemove.forEach(function (k) {
            delete cfgObj.env[k];
          });
          if (!Object.keys(cfgObj.env).length) delete cfgObj.env;
          writeJsonStable(ctx.claudeSettingsPath, cfgObj, 0o600);
          cleaned.push(removedUnrecorded ? 'settings.json (unrecorded gateway keys removed)' : 'settings.json');
        }
      }
    }
  } catch (e) {
    failed.push({ step: 'settings.json', error: redact((e && e.message) || String(e)) });
  }

  // Step 2: `.failover-env.json`, `.failover-txn.json`, `.failover-state.json`, provider active file.
  if (txnRec && Array.isArray(txnRec.wrote)) {
    txnRec.wrote.forEach(function (w) {
      if (w && w.backup) {
        try {
          fs.unlinkSync(w.backup);
          fs.rmdirSync(path.dirname(w.backup));
        } catch {
          /* best effort */
        }
      }
    });
  }

  clearEngageFail(ctx);

  const stateFiles = [
    ['.failover-env.json', _fosurface.envPath(ctx)],
    ['.failover-txn.json', _fosurface.txnPath(ctx)],
    ['.failover-state.json', statePath(ctx)],
  ];
  if (shouldCleanActive) {
    stateFiles.push(['providers/.active.json', _provider.activePath(ctx)]);
  }
  stateFiles.forEach(function (pair) {
    const label = pair[0];
    const fp = pair[1];
    try {
      if (fp && fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        cleaned.push(label);
      }
    } catch (e) {
      failed.push({ step: label, error: redact((e && e.message) || String(e)) });
    }
  });

  // Step 3: Desktop gateway leftovers (`desktopgw.restore`).
  try {
    const gwRes = _desktopgw.restore(ctx);
    if (gwRes && gwRes.restored && Array.isArray(gwRes.cleaned)) {
      gwRes.cleaned.forEach(function (item) {
        cleaned.push(item);
      });
    }
  } catch (e) {
    failed.push({ step: 'desktopgw', error: redact((e && e.message) || String(e)) });
  }

  // Step 4: Pending record — drop any `gateway-*` action.
  try {
    const dr = _desktoprestart.dropGatewayActions(ctx);
    if (dr && dr.dropped) {
      cleaned.push('.desktop-restart.json (' + dr.removed.join(', ') + ')');
    }
  } catch (e) {
    failed.push({ step: '.desktop-restart.json', error: redact((e && e.message) || String(e)) });
  }

  try {
    writeLiveSince(ctx, liveMarkerOpts);
  } catch {
    /* best effort */
  }

  // §8.2: scan running processes still carrying gateway env (names only, never values).
  let stillCarrying = [];
  try {
    stillCarrying = await _fosurface.scanGatewayProcesses(ctx, {
      listProcesses: deps.listProcesses,
      lsof: deps.lsof,
      run: deps.run,
    });
  } catch {
    stillCarrying = [];
  }

  if (!cur && !cleaned.length && !failed.length) {
    return { ok: true, already: true, cleaned: [], failed: [], stillCarrying: stillCarrying };
  }

  // Step 5: History + notification.
  const by = info.by || (info.lost ? 'gateway-lost' : info.to ? 'autoswitch' : 'manual');
  _history.recordEvent(ctx, {
    kind: 'failover-release',
    by: by,
    from: targetProvider,
    to: info.to || null,
    reason: info.reason || 'recovered',
    cleaned: cleaned,
    failed: failed,
  });

  if (cur && deps.notify) {
    await deps.notify(
      info.lost ? 'quota' : 'switch',
      info.lost
        ? 'The API failover gateway stopped answering — Claude Code is back on ' +
            (info.to || 'your Claude account') +
            ' (it may still be over its limit).'
        : 'Back on Claude (' + (info.to || 'your account') + ') — the API failover is off.',
    );
  }

  const out = {
    ok: failed.length === 0,
    cleaned: cleaned,
    failed: failed,
    stillCarrying: stillCarrying,
  };
  if (failed.length) {
    out.reason = failed
      .map(function (f) {
        return f.step + ': ' + f.error;
      })
      .join('; ');
  }
  return out;
}

function exhaustedPath(ctx) {
  return path.join(ctx.configDir, EXHAUSTED_FILE);
}

function exhausted(ctx) {
  if (!ctx || !ctx.configDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(exhaustedPath(ctx), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildClaudeArgs(ctx, extraArgs) {
  const mcpCfg = String(cfg(ctx, 'failover.mcpConfig', '') || '').trim();
  const extra = Array.isArray(extraArgs) ? extraArgs.slice() : [];
  const prefix = [];
  if (mcpCfg && extra.indexOf('--mcp-config') === -1) {
    prefix.push('--strict-mcp-config', '--mcp-config', mcpCfg);
  }
  return prefix.concat(extra);
}

function formatFailoverCommand(kind, opts) {
  opts = opts || {};
  const parts = ['keyflip', 'failover', kind];
  if (kind === 'resume') {
    if (opts.sessionId) parts.push(shellQuote(opts.sessionId));
    else if (opts.last) parts.push('--last');
    if (opts.desktop) parts.push('--desktop');
    if (opts.yes) parts.push('--yes');
  }
  if (opts.forceGateway) parts.push('--force-gateway');
  const extra = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
  if (extra.length) {
    parts.push('--');
    extra.forEach(function (a) {
      parts.push(shellQuote(a));
    });
  }
  return parts.join(' ');
}

// §4.5: `keyflip failover run [--force-gateway] [--print-command] [--] [claude args…]`.
// Spawns `claude` with token ONLY in child env, never in argv.
function run(ctx, claudeArgs, opts) {
  opts = opts || {};
  const extraArgs = Array.isArray(claudeArgs) ? claudeArgs.slice() : [];
  const fullArgs = buildClaudeArgs(ctx, extraArgs);
  const cmdString = formatFailoverCommand('run', {
    forceGateway: !!opts.forceGateway,
    extraArgs: extraArgs,
  });

  if (opts.printCommand) {
    return {
      ok: true,
      exitCode: 0,
      printed: true,
      command: cmdString,
      args: fullArgs,
      cwd: opts.cwd || process.cwd(),
    };
  }

  const st = state(ctx);
  const stSurface = st && st.engaged ? st.surface || 'cli-launcher' : null;
  const hasLauncherEnv = !!_fosurface.readLauncherEnv(ctx);
  const onLauncher = !!(stSurface === 'cli-launcher' && hasLauncherEnv);
  if (!onLauncher && !opts.forceGateway) {
    return {
      ok: false,
      exitCode: 1,
      error:
        st && st.engaged
          ? stSurface === 'cli-launcher'
            ? '.failover-env.json is missing; run: keyflip failover off && keyflip failover on'
            : 'failover is engaged on ' +
              st.surface +
              ', not cli-launcher — pass --force-gateway to launch through the gateway'
          : 'API failover is not engaged on cli-launcher (run `keyflip failover on` or pass --force-gateway)',
    };
  }

  const p = plan(ctx);
  let childEnv;
  try {
    childEnv = _fosurface.buildChildEnv(ctx, 'cli-launcher', opts.env, {
      forceGateway: !onLauncher || !!opts.forceGateway,
      plan: p,
    });
  } catch (e) {
    return {
      ok: false,
      exitCode: 1,
      error: redact((e && e.message) || String(e)),
    };
  }

  const spawnSyncFn = opts.spawnSync || (ctx && ctx.spawnSync) || null;
  const bin = opts.claudeBin || (ctx && ctx.claudeBin) || process.env.KEYFLIP_CLAUDE_BIN || 'claude';
  let cwd = opts.cwd || process.cwd();
  let missingCwd = null;
  if (!spawnSyncFn && opts.cwd && !fs.existsSync(opts.cwd)) {
    missingCwd = opts.cwd;
    cwd = fs.existsSync(ctx.home) ? ctx.home : process.cwd();
  }

  const actualSpawnSync = spawnSyncFn || _spawnSync;
  const res = actualSpawnSync(bin, fullArgs, {
    stdio: opts.stdio || 'inherit',
    cwd: cwd,
    env: childEnv,
  });
  if (res && res.error) {
    return {
      ok: false,
      exitCode: 1,
      error: redact((res.error && res.error.message) || String(res.error)),
      args: fullArgs,
      cwd: cwd,
    };
  }
  const exitCode = res && typeof res.status === 'number' ? res.status : 1;
  return {
    ok: exitCode === 0,
    exitCode: exitCode,
    args: fullArgs,
    cwd: cwd,
    missingCwd: missingCwd,
  };
}

// §4.5: `keyflip failover resume <session-id|--last> [--desktop] [--yes] [--force-gateway] [--print-command]`.
// Resolves session cwd + id via `sessions.resolveResume`, refuses with exit 3 when that session's pid is alive
// (unless `--yes`), then spawns `claude --resume <id>` in that cwd with token ONLY in child env.
function resume(ctx, opts) {
  opts = opts || {};
  let resolved;
  try {
    resolved = _sessions.resolveResume(ctx, {
      id: opts.id,
      last: !!opts.last,
      desktop: !!opts.desktop,
      pidAlive: opts.pidAlive,
      listProcesses: opts.listProcesses,
      run: opts.run,
    });
  } catch (e) {
    return {
      ok: false,
      exitCode: 1,
      error: redact((e && e.message) || String(e)),
    };
  }

  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs.slice() : [];
  const resumeArgs = resolved.args.concat(extraArgs);
  const fullArgs = buildClaudeArgs(ctx, resumeArgs);
  const cmdString = formatFailoverCommand('resume', {
    sessionId: resolved.sessionId,
    desktop: !!opts.desktop,
    forceGateway: !!opts.forceGateway,
    extraArgs: extraArgs,
  });

  if (opts.printCommand) {
    return {
      ok: true,
      exitCode: 0,
      printed: true,
      command: cmdString,
      sessionId: resolved.sessionId,
      cwd: resolved.cwd,
      args: fullArgs,
      livePid: resolved.livePid || null,
    };
  }

  if (resolved.livePid && !opts.yes) {
    return {
      ok: false,
      exitCode: 3,
      busy: true,
      pid: resolved.livePid,
      sessionId: resolved.sessionId,
      cwd: resolved.cwd,
      error: 'stop this session in Desktop first (one writer per transcript)',
    };
  }

  const r = run(ctx, resumeArgs, {
    forceGateway: !!opts.forceGateway,
    cwd: resolved.cwd || ctx.home,
    env: opts.env,
    spawnSync: opts.spawnSync,
    claudeBin: opts.claudeBin,
    stdio: opts.stdio,
  });
  return Object.assign({}, r, {
    sessionId: resolved.sessionId,
    cwd: r.cwd || resolved.cwd,
  });
}

// §4.6 item 5 & doctor: inspect failover leftovers without mutating anything or exposing secret values.
function leftovers(ctx) {
  if (!ctx || !ctx.configDir) return { ok: true, items: [] };
  const items = [];
  const engaged = !!state(ctx);
  const p = plan(ctx);
  const activeProv = _provider.readActive(ctx);

  if (!engaged) {
    // 1) Managed ANTHROPIC_* keys in settings.json while not engaged.
    if (ctx.claudeSettingsPath && fs.existsSync(ctx.claudeSettingsPath)) {
      try {
        const cfgObj = JSON.parse(fs.readFileSync(ctx.claudeSettingsPath, 'utf8'));
        const envObj = cfgObj && cfgObj.env && typeof cfgObj.env === 'object' ? cfgObj.env : null;
        if (envObj) {
          const present = _provider.ALL_MANAGED.filter(function (k) {
            return Object.prototype.hasOwnProperty.call(envObj, k);
          });
          if (present.length) {
            const hasGatewayMarker =
              (typeof envObj.ANTHROPIC_BASE_URL === 'string' &&
                envObj.ANTHROPIC_BASE_URL.replace(/\/+$/, '') === p.gatewayUrl) ||
              Object.keys(_provider.MODEL_KEYS).some(function (role) {
                return envObj[_provider.MODEL_KEYS[role]] === p.alias;
              });
            const unrelatedActive = !!(activeProv && activeProv.name && activeProv.name !== p.provider);
            if (!unrelatedActive || hasGatewayMarker) {
              items.push('settings.json has managed keys while not engaged (' + present.join(', ') + ')');
            }
          }
        }
      } catch {
        /* settingsJson check owns invalid JSON */
      }
    }

    // 2) .failover-env.json while not engaged.
    if (fs.existsSync(_fosurface.envPath(ctx))) {
      items.push('.failover-env.json present while not engaged');
    }

    // Unfinished probing transaction while not engaged.
    const txnRec = _fosurface.readTxn(ctx);
    if (txnRec && txnRec.phase === 'probing') {
      items.push('.failover-txn.json stuck in phase "probing"');
    }
  }

  // 3) Desktop 3p config / keyflip-gateway-*.json / .keyflip-gateway.json (never valid: Desktop cannot use gateway).
  const dirs = _desktopgw.configDirs(ctx);
  dirs.forEach(function (d) {
    const label = path.basename(d);
    const cp = path.join(d, 'claude_desktop_config.json');
    if (fs.existsSync(cp)) {
      try {
        const dc = JSON.parse(fs.readFileSync(cp, 'utf8'));
        if (dc && dc.deploymentMode === '3p') {
          items.push(label + '/claude_desktop_config.json has deploymentMode "3p"');
        } else if (
          dc &&
          dc.enterpriseConfig &&
          typeof dc.enterpriseConfig.activeConfigId === 'string' &&
          /^keyflip-gateway-/.test(dc.enterpriseConfig.activeConfigId)
        ) {
          items.push(label + '/claude_desktop_config.json has activeConfigId ' + dc.enterpriseConfig.activeConfigId);
        }
      } catch {
        /* ignore */
      }
    }
    const lib = path.join(d, 'configLibrary');
    try {
      const files = fs.readdirSync(lib).filter(function (f) {
        return /^keyflip-gateway-.*\.json$/.test(f);
      });
      if (files.length) {
        items.push(label + '/configLibrary/' + files.join(', '));
      }
    } catch {
      /* ignore */
    }
  });

  if (fs.existsSync(path.join(ctx.configDir, _desktopgw.META))) {
    items.push(_desktopgw.META + ' present');
  }

  // 4) Pending gateway-* actions in .desktop-restart.json.
  try {
    const rawPending = JSON.parse(fs.readFileSync(path.join(ctx.configDir, _desktoprestart.PENDING_FILE), 'utf8'));
    if (rawPending && Array.isArray(rawPending.actions)) {
      const gwKinds = rawPending.actions
        .map(function (a) {
          return a && a.kind;
        })
        .filter(function (k) {
          return typeof k === 'string' && /^gateway-/.test(k);
        });
      if (gwKinds.length) {
        items.push('.desktop-restart.json has pending ' + gwKinds.join(', '));
      }
    }
  } catch {
    /* absent or unreadable */
  }

  return { ok: items.length === 0, items: items };
}

function expandHomePath(ctx, rawPath) {
  const s = String(rawPath || '').trim();
  if (!s) return '';
  if (s === '~') return (ctx && ctx.home) || os.homedir();
  if (s.slice(0, 2) === '~/' || s.slice(0, 2) === '~\\') {
    return path.join((ctx && ctx.home) || os.homedir(), s.slice(2));
  }
  return s;
}

function parseRowTimestampMs(row) {
  if (!row || typeof row !== 'object') return null;
  const raw =
    row.ts !== undefined
      ? row.ts
      : row.timestamp !== undefined
        ? row.timestamp
        : row.at !== undefined
          ? row.at
          : row.time !== undefined
            ? row.time
            : row.createdAt;
  if (typeof raw === 'number' && isFinite(raw)) {
    return raw < 1e11 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string' && raw.trim()) {
    if (/^\d+$/.test(raw.trim())) {
      const n = parseInt(raw.trim(), 10);
      return n < 1e11 ? n * 1000 : n;
    }
    const parsed = Date.parse(raw);
    return isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readUsageLogRows(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { exists: false, rows: [] };
  let txt;
  try {
    txt = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { exists: false, rows: [] };
  }
  const rows = [];
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j === 'object') rows.push(j);
    } catch {
      /* skip malformed line */
    }
  }
  return { exists: true, rows: rows };
}

function formatShortWindow(win) {
  if (!win || typeof win !== 'object') return null;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return String(iso || '…');
    const day = parseInt(m[3], 10);
    const mon = MONTHS[parseInt(m[2], 10) - 1] || m[2];
    return day + ' ' + mon;
  }
  if (!win.since && !win.until) return null;
  return fmtDay(win.since) + '–' + fmtDay(win.until);
}

function formatMoney(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0';
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

function matchRowToLeg(row, legs) {
  const rowLeg = typeof row.leg === 'string' && row.leg ? row.leg : typeof row.target === 'string' ? row.target : '';
  const rowAdapter = typeof row.adapter === 'string' ? row.adapter : rowLeg ? rowLeg.split('/')[0] : '';
  const rowModel =
    typeof row.upstreamModel === 'string'
      ? row.upstreamModel
      : typeof row.targetModel === 'string'
        ? row.targetModel
        : typeof row.model === 'string'
          ? row.model
          : '';
  const composite = rowAdapter && rowModel ? rowAdapter + '/' + rowModel : '';

  if (Array.isArray(legs) && legs.length) {
    for (let i = 0; i < legs.length; i++) {
      if (legs[i] === rowLeg || legs[i] === composite) return legs[i];
    }
    for (let i = 0; i < legs.length; i++) {
      if (rowAdapter && legs[i].split('/')[0] === rowAdapter) return legs[i];
    }
  }
  return rowLeg || composite || rowAdapter || null;
}

function rowErrorText(row) {
  const parts = [];
  if (row.error) {
    if (typeof row.error === 'string') parts.push(row.error);
    else if (typeof row.error === 'object') {
      if (row.error.message) parts.push(String(row.error.message));
      if (row.error.type) parts.push(String(row.error.type));
      if (row.error.code) parts.push(String(row.error.code));
    }
  }
  if (typeof row.message === 'string') parts.push(row.message);
  if (typeof row.reason === 'string') parts.push(row.reason);
  if (typeof row.errorClass === 'string') parts.push(row.errorClass);
  if (typeof row.class === 'string') parts.push(row.class);
  if (typeof row.status === 'number' && row.status >= 400) parts.push('HTTP ' + row.status);
  if (typeof row.httpStatus === 'number' && row.httpStatus >= 400) parts.push('HTTP ' + row.httpStatus);
  return parts.join(' ').trim();
}

function isRowOk(row, errTxt) {
  if (row.ok === true) return true;
  if (row.ok === false) return false;
  if (typeof row.status === 'number') return row.status >= 200 && row.status < 400 && !row.error;
  if (typeof row.httpStatus === 'number') return row.httpStatus >= 200 && row.httpStatus < 400 && !row.error;
  return !errTxt;
}

// §4.6: Read-only verification of the API failover across all 7 checks.
// Writes nothing to keyflip state or settings.json.
// Exit codes: 0 all ok, 2 any warn (no fail), 1 any fail.
async function verify(ctx, opts) {
  opts = opts || {};
  const nowFn =
    opts.now ||
    (opts.nowMs !== undefined
      ? function () {
          return opts.nowMs;
        }
      : function () {
          return Date.now();
        });
  const nowMs = nowFn();
  const rp = resolvePlan(ctx, { keysmithConfig: opts.keysmithConfig });
  const doFetch = opts.fetch || (ctx && ctx.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
  const checks = [];
  let spentUsd = 0;

  // 1. gateway
  const ready = await gatewayReady(ctx, {
    plan: rp,
    fetch: doFetch,
    timeoutMs: opts.timeoutMs,
    retryPauseMs: opts.retryPauseMs,
    sleep: opts.sleep,
    now: nowFn,
  });
  if (!ready.ok) {
    if (ready.retry) {
      checks.push({
        id: 'gateway',
        state: 'warn',
        reason: 'retry: ' + redact(ready.reason || 'keychain unavailable'),
        detail: { retry: true, gatewayUrl: rp.gatewayUrl, alias: rp.alias },
      });
    } else {
      checks.push({
        id: 'gateway',
        state: 'fail',
        reason: redact(ready.reason || 'gateway not ready'),
        detail: { gatewayUrl: rp.gatewayUrl, alias: rp.alias },
      });
    }
  } else {
    const cap = ready.cap || null;
    const winLabel = cap && cap.window ? formatShortWindow(cap.window) : null;
    const capSummary = cap
      ? '$' +
        formatMoney(typeof cap.spent === 'number' ? cap.spent : 0) +
        ' of $' +
        formatMoney(cap.cap) +
        (winLabel ? ', window ' + winLabel : '')
      : 'no cap reported';
    checks.push({
      id: 'gateway',
      state: cap && cap.exceeded ? 'warn' : 'ok',
      reason:
        'reachable, ' +
        rp.alias +
        ' served (' +
        capSummary +
        (cap && cap.exceeded ? '; paid leg cap reached' : '') +
        ')',
      detail: {
        gatewayUrl: rp.gatewayUrl,
        alias: rp.alias,
        models: ready.models || [],
        cap: cap,
      },
    });
  }

  // Read keysmith usage.jsonl once for checks 2 (`legs`) and 7 (`toolCount`).
  const rawUsagePath =
    opts.usageLogPath || cfg(ctx, 'failover.keysmithUsageLog', '~/.local/share/keysmith/usage.jsonl');
  const usageLogFile = expandHomePath(ctx, rawUsagePath);
  const usageLog = readUsageLogRows(usageLogFile);

  // 2. legs (within 48 h)
  const cutoff48h = nowMs - 48 * 3600 * 1000;
  const lastByLeg = new Map();
  for (let i = 0; i < usageLog.rows.length; i++) {
    const row = usageLog.rows[i];
    const tsMs = parseRowTimestampMs(row);
    if (tsMs !== null && tsMs < cutoff48h) continue;
    const legId = matchRowToLeg(row, rp.legs);
    if (!legId) continue;
    const prev = lastByLeg.get(legId);
    if (!prev || (tsMs !== null && (prev.tsMs === null || tsMs >= prev.tsMs))) {
      lastByLeg.set(legId, { row: row, tsMs: tsMs });
    }
  }
  const legOrder = Array.isArray(rp.legs) && rp.legs.length ? rp.legs : Array.from(lastByLeg.keys());
  const legDetails = [];
  const legWarns = [];
  legOrder.forEach(function (legId) {
    const hit = lastByLeg.get(legId);
    if (!hit) {
      legDetails.push({ leg: legId, adapter: legId.split('/')[0], state: 'idle', class: null, at: null, resetAt: null });
      return;
    }
    const adapter =
      (typeof hit.row.adapter === 'string' && hit.row.adapter) || String(legId).split('/')[0] || 'unknown';
    const atIso = hit.tsMs !== null ? new Date(hit.tsMs).toISOString() : null;
    const errTxt = rowErrorText(hit.row);
    const okRow = isRowOk(hit.row, errTxt);
    if (okRow) {
      legDetails.push({ leg: legId, adapter: adapter, state: 'ok', class: 'ok', at: atIso, resetAt: null });
    } else {
      const classified = _fosurface.classifyProbeFailure(
        { timedOut: false, code: 1, stdout: '', stderr: errTxt },
        { nowMs: hit.tsMs !== null ? hit.tsMs : nowMs },
      );
      legDetails.push({
        leg: legId,
        adapter: adapter,
        state: 'warn',
        class: classified.class,
        reason: classified.reason,
        at: atIso,
        resetAt: classified.resetAt || null,
      });
      legWarns.push(
        adapter +
          ' (' +
          legId +
          '): ' +
          classified.class +
          (classified.resetAt ? ' (resets ' + classified.resetAt + ')' : ''),
      );
    }
  });
  if (legWarns.length) {
    checks.push({
      id: 'legs',
      state: 'warn',
      reason: redact(legWarns.join('; ')),
      detail: { legs: legDetails, logPath: usageLogFile },
    });
  } else if (!usageLog.exists || lastByLeg.size === 0) {
    checks.push({
      id: 'legs',
      state: 'ok',
      reason: usageLog.exists ? 'no leg traffic in last 48h' : 'no usage log yet (' + usageLogFile + ')',
      detail: { legs: legDetails, logPath: usageLogFile },
    });
  } else {
    const summaryParts = legDetails
      .filter(function (d) {
        return d.state === 'ok';
      })
      .map(function (d) {
        return d.adapter + ': ok' + (d.at ? ' @ ' + d.at : '');
      });
    checks.push({
      id: 'legs',
      state: 'ok',
      reason: summaryParts.join(', ') || 'all recent legs ok',
      detail: { legs: legDetails, logPath: usageLogFile },
    });
  }

  // 3. modelIds
  const cliTarget = cfg(ctx, 'failover.cliTarget', 'launcher');
  const requiredModels = String(
    cfg(ctx, 'failover.modelIds', 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5') || '',
  )
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  if (!ready.ok) {
    checks.push({
      id: 'modelIds',
      state: 'warn',
      reason: 'could not check modelIds (gateway not ready)',
      detail: { cliTarget: cliTarget, required: requiredModels, missing: requiredModels },
    });
  } else {
    const servedModels = ready.models || [];
    const missingModels = requiredModels.filter(function (m) {
      return servedModels.indexOf(m) === -1;
    });
    if (missingModels.length === 0) {
      checks.push({
        id: 'modelIds',
        state: 'ok',
        reason: 'all modelIds served (' + requiredModels.join(', ') + ')',
        detail: { cliTarget: cliTarget, required: requiredModels, missing: [] },
      });
    } else if (cliTarget === 'settings') {
      checks.push({
        id: 'modelIds',
        state: 'warn',
        reason: 'missing modelIds needed for cli-settings: ' + missingModels.join(', '),
        detail: { cliTarget: cliTarget, required: requiredModels, missing: missingModels },
      });
    } else {
      checks.push({
        id: 'modelIds',
        state: 'ok',
        reason: 'not served (' + missingModels.join(', ') + '; needed only for cli-settings)',
        detail: { cliTarget: cliTarget, required: requiredModels, missing: missingModels },
      });
    }
  }

  // 4. probe (skipped with --no-spend)
  if (opts.noSpend) {
    checks.push({
      id: 'probe',
      state: 'ok',
      reason: 'skipped (--no-spend)',
      detail: { skipped: true, deep: !!opts.deep },
    });
  } else if (!ready.ok) {
    checks.push({
      id: 'probe',
      state: ready.retry ? 'warn' : 'fail',
      reason: 'skipped (' + redact(ready.reason || 'gateway not ready') + ')',
      detail: { skipped: true },
    });
  } else {
    const beforeSpent = ready.cap && typeof ready.cap.spent === 'number' ? ready.cap.spent : null;
    const pRes = await _fosurface.probe(ctx, 'cli-launcher', {
      forceGateway: true,
      plan: rp,
      deep: !!opts.deep,
      spawn: opts.spawn || (ctx && ctx.spawn),
      run: opts.run || (ctx && ctx.run),
      env: opts.env,
      now: nowFn,
      timeoutMs: opts.probeTimeoutMs,
      supportsNoSessionPersistence: opts.supportsNoSessionPersistence,
      claudeBin: opts.claudeBin,
    });

    let afterSpent = null;
    try {
      const gwKey = registerSecret(ctx.store.getProfile('provider__' + rp.provider));
      if (gwKey && doFetch) {
        const afterCap = await capLoaded(rp, gwKey, doFetch, {
          timeoutMs: opts.timeoutMs,
          retryPauseMs: opts.retryPauseMs,
          sleep: opts.sleep,
          now: nowFn,
        });
        if (afterCap && afterCap.ok && afterCap.cap && typeof afterCap.cap.spent === 'number') {
          afterSpent = afterCap.cap.spent;
        }
      }
    } catch {
      afterSpent = null;
    }

    if (beforeSpent !== null && afterSpent !== null) {
      spentUsd = Math.max(0, Math.round((afterSpent - beforeSpent) * 1e6) / 1e6);
    } else if (typeof pRes.costUsd === 'number' && isFinite(pRes.costUsd)) {
      spentUsd = Math.max(0, pRes.costUsd);
    }

    if (pRes.ok) {
      const ranLabels = (pRes.models || []).concat(pRes.deepChecks || []);
      checks.push({
        id: 'probe',
        state: 'ok',
        reason:
          'passed (' +
          ranLabels.join(', ') +
          ', ' +
          pRes.ms +
          'ms, metered +$' +
          formatMoney(spentUsd) +
          ')',
        detail: {
          models: pRes.models || [],
          deepChecks: pRes.deepChecks || [],
          ms: pRes.ms,
          cliEstimateUsd: pRes.costUsd,
          spentUsd: spentUsd,
        },
      });
    } else {
      checks.push({
        id: 'probe',
        state: 'fail',
        reason: redact(pRes.reason || 'probe failed'),
        detail: {
          models: pRes.models || [],
          deepChecks: pRes.deepChecks || [],
          failedModel: pRes.failedModel || null,
          class: pRes.class || 'other',
          resetAt: pRes.resetAt || null,
          ms: pRes.ms,
          spentUsd: spentUsd,
        },
      });
    }
  }

  // 5. leftovers
  const lo = leftovers(ctx);
  checks.push({
    id: 'leftovers',
    state: lo.items.length ? 'warn' : 'ok',
    reason: lo.items.length ? lo.items.join('; ') + ' (run: keyflip failover off)' : 'none',
    detail: { items: lo.items },
  });

  // 6. processes (§8.2 scan, names only)
  const procs = await _fosurface.scanGatewayProcesses(ctx, {
    listProcesses: opts.listProcesses,
    lsof: opts.lsof,
    run: opts.run,
  });
  const engagedNow = !!state(ctx);
  const unexpectedProcs = procs.filter(function (pr) {
    return !engagedNow || pr.kind === 'desktop session';
  });
  if (unexpectedProcs.length) {
    const desc = unexpectedProcs
      .map(function (pr) {
        return 'pid ' + pr.pid + ' (' + pr.kind + ': ' + (pr.vars || []).join(', ') + ')';
      })
      .join('; ');
    checks.push({
      id: 'processes',
      state: 'warn',
      reason: desc,
      detail: { processes: procs },
    });
  } else {
    checks.push({
      id: 'processes',
      state: 'ok',
      reason: procs.length ? procs.length + ' active gateway CLI process(es)' : 'none carrying gateway env',
      detail: { processes: procs },
    });
  }

  // 7. toolCount (last 7 days of usage log for too-many-tools rejection)
  const cutoff7d = nowMs - 7 * 86400 * 1000;
  let toolHits = 0;
  let lastToolAt = null;
  for (let i = 0; i < usageLog.rows.length; i++) {
    const row = usageLog.rows[i];
    const tsMs = parseRowTimestampMs(row);
    if (tsMs !== null && tsMs < cutoff7d) continue;
    const errTxt = rowErrorText(row);
    if (
      row.errorClass === 'too-many-tools' ||
      row.class === 'too-many-tools' ||
      /at most 128\b|too[ _-]?many[ _-]?tools/i.test(errTxt)
    ) {
      toolHits++;
      if (tsMs !== null) lastToolAt = new Date(tsMs).toISOString();
    }
  }
  const mcpCfgHint = String(cfg(ctx, 'failover.mcpConfig', '') || '').trim();
  if (toolHits > 0) {
    checks.push({
      id: 'toolCount',
      state: 'warn',
      reason:
        toolHits +
        ' too-many-tools (>128) rejection(s) in last 7d — set `keyflip config set failover.mcpConfig <path>`' +
        (mcpCfgHint ? ' (configured: ' + mcpCfgHint + ')' : ''),
      detail: { hits: toolHits, lastAt: lastToolAt, mcpConfig: mcpCfgHint || null },
    });
  } else {
    checks.push({
      id: 'toolCount',
      state: 'ok',
      reason: 'no too-many-tools rejections in last 7d',
      detail: { hits: 0, lastAt: null, mcpConfig: mcpCfgHint || null },
    });
  }

  const anyFail = checks.some(function (c) {
    return c.state === 'fail';
  });
  const anyWarn = checks.some(function (c) {
    return c.state === 'warn';
  });
  const exitCode = anyFail ? 1 : anyWarn ? 2 : 0;

  return {
    ok: exitCode === 0,
    exitCode: exitCode,
    checks: checks,
    spentUsd: spentUsd,
  };
}

export {
  plan,
  resolvePlan,
  aliasLegs,
  setup,
  gatewayReady,
  capLoaded,
  capText,
  engage,
  release,
  run,
  resume,
  verify,
  leftovers,
  exhausted,
  exhaustedPath,
  state,
  markLost,
  clearLost,
  keysmithCommand,
  keysmithConfigPath,
  DEFAULTS,
  STATE_FILE,
  ENGAGE_FAIL_FILE,
  engageFailPath,
  readEngageFail,
  EXHAUSTED_FILE,
  GATEWAY_TIMEOUT_MS,
  GATEWAY_RETRY_PAUSE_MS,
};
