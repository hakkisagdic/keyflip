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
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run as _run } from './exec.js';
import { atomicWrite } from './fsutil.js';
import * as _provider from './provider.js';
import * as _config from './config.js';
import * as _history from './history.js';
import * as _desktoprestart from './desktoprestart.js';

const STATE_FILE = '.failover-state.json';
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
    haveKey = !!ctx.store.getProfile('provider__' + p.provider);
  } catch (e) {
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
      } catch (e) {
        key = null;
      }
      if (r && r.code === 0 && key) {
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
            String((r && (r.stderr || r.stdout)) || '')
              .trim()
              .slice(0, 300),
        });
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {
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
    key = ctx.store.getProfile('provider__' + p.provider);
  } catch (e) {
    key = null;
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
  const ids = ((got.json && got.json.data) || []).map(function (m) {
    return m && m.id;
  });
  if (ids.indexOf(p.alias) === -1)
    return { ok: false, reason: 'gateway does not serve ' + p.alias + ' to the failover key' };
  if (opts.capCheck === false) return { ok: true };
  const c = await capLoaded(p, key, doFetch, { budget: budget });
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, cap: c.cap };
}

// "$25 over 2026-11-12..2026-12-09" / "$25/month" for a cap the gateway reported.
function capText(cap) {
  if (!cap || typeof cap.cap !== 'number') return null;
  return '$' + cap.cap + (cap.window ? ' over ' + cap.window.since + '..' + cap.window.until : '/month');
}

function statePath(ctx) {
  return path.join(ctx.configDir, STATE_FILE);
}
function state(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'));
    return j && j.engaged ? j : null;
  } catch (e) {
    return null;
  }
}

// Move onto the API failover. deps: fetch, nowMs, useProvider, requestDesktop, notify.
async function engage(ctx, info, deps) {
  deps = deps || {};
  info = info || {};
  const p = plan(ctx);
  if (!p.enabled) return { ok: false, reason: 'failover is disabled (failover.enabled=false)' };
  const cur = state(ctx);
  if (cur) return { ok: true, already: true, state: cur };
  const rp = resolvePlan(ctx, { keysmithConfig: deps.keysmithConfig });
  const ready = await gatewayReady(ctx, { plan: rp, fetch: deps.fetch });
  if (!ready.ok) return { ok: false, reason: ready.reason };
  const useProvider =
    deps.useProvider ||
    function (name) {
      return _provider.use(ctx, name);
    };
  useProvider(p.provider); // Claude Code: settings.json env, hot-reloaded
  // Claude Desktop reads its gateway config at start: the change waits for an idle restart (P5).
  const requestDesktop =
    deps.requestDesktop ||
    function (rec) {
      return ctx.appDataDir ? _desktoprestart.request(ctx, rec, { nowMs: deps.nowMs }) : null;
    };
  requestDesktop({ kind: 'gateway-on', target: p.provider, reason: 'every Claude account is over the threshold' });
  const st = {
    engaged: true,
    at: deps.nowMs !== undefined ? deps.nowMs : Date.now(),
    from: info.from || null,
    reason: info.reason || 'every Claude account is over the threshold',
    provider: p.provider,
    alias: p.alias,
    // When the account that ran out has headroom again by the clock (its binding window resets):
    // the failback that needs no usage reading.
    recoverAt: info.recoverAt || null,
    cap: ready.cap || null,
  };
  atomicWrite(statePath(ctx), JSON.stringify(st, null, 2) + '\n', 0o600);
  _history.recordEvent(ctx, { kind: 'failover-engage', from: st.from, to: p.provider, reason: st.reason });
  if (deps.notify)
    await deps.notify(
      'quota',
      'All Claude accounts are over the threshold — now on the API failover (' +
        rp.alias +
        ': ' +
        (rp.legs || []).join(' -> ') +
        ', paid leg capped at ' +
        (capText(ready.cap) || '$' + p.capUsd) +
        ' by keysmith).',
    );
  return { ok: true, state: st };
}

// Back to the Claude account. deps: useOfficial, requestDesktop, notify.
async function release(ctx, info, deps) {
  deps = deps || {};
  info = info || {};
  const cur = state(ctx);
  if (!cur) return { ok: true, already: true };
  const useOfficial =
    deps.useOfficial ||
    function () {
      return _provider.useOfficial(ctx);
    };
  useOfficial();
  const requestDesktop =
    deps.requestDesktop ||
    function (rec) {
      return ctx.appDataDir ? _desktoprestart.request(ctx, rec, { nowMs: deps.nowMs }) : null;
    };
  requestDesktop({
    kind: 'gateway-off',
    target: null,
    reason: info.lost ? 'the failover gateway stopped answering' : 'a Claude account has headroom again',
  });
  try {
    fs.unlinkSync(statePath(ctx));
  } catch (e) {
    /* gone */
  }
  _history.recordEvent(ctx, {
    kind: 'failover-release',
    from: cur.provider,
    to: info.to || null,
    reason: info.reason || 'recovered',
  });
  if (deps.notify)
    await deps.notify(
      info.lost ? 'quota' : 'switch',
      info.lost
        ? 'The API failover gateway stopped answering — Claude Code is back on ' +
            (info.to || 'your Claude account') +
            ' (it may still be over its limit).'
        : 'Back on Claude (' + (info.to || 'your account') + ') — the API failover is off.',
    );
  return { ok: true };
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
  state,
  keysmithCommand,
  keysmithConfigPath,
  DEFAULTS,
  STATE_FILE,
  GATEWAY_TIMEOUT_MS,
  GATEWAY_RETRY_PAUSE_MS,
};
