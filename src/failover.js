// P4: when EVERY Claude account is over the threshold, keep working — on the API, through keysmith.
//
// keysmith (a separate tool) runs an OpenAI/Anthropic-compatible gateway on 127.0.0.1:8787. keyflip
// only CONFIGURES and CALLS it, never edits its code:
//   - an alias chain, tried in order while nothing has reached the client:
//       claude-api (the gmail promo API key)  ->  agy  ->  kiro-emu
//   - a monthly spend cap on the gmail promo key (keysmith `limits.spend`, default 25 USD): past
//     it keysmith refuses that leg with a 429 and the alias falls through to the next one
//   - a key scoped to exactly that alias and its legs, stored in keyflip's credential store as the
//     key of a keyflip provider profile (never printed, never on a command line)
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
  alias: 'keyflip-failover',
  legs: ['claude-api/claude-opus-5-5', 'agy/claude-opus-5-5-medium', 'kiro-emu/claude-opus-5.5'],
  capUsd: 25,
  provider: 'keysmith-failover',
};

function cfg(ctx, key, dflt) {
  try {
    const v = _config.get(ctx, key);
    return v === undefined || v === null || v === '' ? dflt : v;
  } catch (e) {
    return dflt;
  }
}

// The plan, from config (failover.*) over the defaults. Pure: reads config only.
function plan(ctx) {
  const legsRaw = cfg(ctx, 'failover.legs', '');
  const legs = legsRaw
    ? String(legsRaw)
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean)
    : DEFAULTS.legs.slice();
  const alias = cfg(ctx, 'failover.alias', DEFAULTS.alias);
  const capUsd = cfg(ctx, 'failover.capUsd', DEFAULTS.capUsd);
  // The first leg is the paid API key: that is what the spend cap guards.
  const capAdapter = legs.length ? legs[0].split('/')[0] : null;
  return {
    enabled: cfg(ctx, 'failover.enabled', true) !== false,
    gatewayUrl: String(cfg(ctx, 'failover.gatewayUrl', DEFAULTS.gatewayUrl)).replace(/\/+$/, ''),
    alias: alias,
    legs: legs,
    capUsd: capUsd,
    capAdapter: capAdapter,
    capAccount: cfg(ctx, 'failover.capAccount', false) === true,
    provider: cfg(ctx, 'failover.provider', DEFAULTS.provider),
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

// A cap keysmith already holds for `target` ('adapter:<id>' / 'account:<name>') in any of the forms
// it accepts (prefixed, nested adapters/accounts, flat id) -> the raw value, or undefined.
function existingCap(spend, target) {
  const i = target.indexOf(':');
  const kind = target.slice(0, i);
  const id = target.slice(i + 1);
  if (spend[target] !== undefined && spend[target] !== null) return spend[target];
  const nests = kind === 'adapter' ? ['adapters', 'adapter', 'byAdapter'] : ['accounts', 'account', 'byAccount'];
  for (let n = 0; n < nests.length; n++) {
    const sub = spend[nests[n]];
    if (sub && typeof sub === 'object' && !Array.isArray(sub) && sub[id] !== undefined && sub[id] !== null)
      return sub[id];
  }
  if (spend[id] !== undefined && spend[id] !== null) return spend[id];
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
  return (
    '$' + usd + (v && typeof v === 'object' && (v.since || v.until) ? ' over ' + v.since + '..' + v.until : '/month')
  );
}

// limits.spend in keysmith's config, merged in place (every other key kept, mode kept, atomic).
// A cap already there is NEVER replaced — it may be the owner's own (a windowed total, a budget for
// other work on that key); it is reported instead, and gatewayReady decides whether it is tight
// enough. The file holds the gateway's own keys: it is read and rewritten in-process, NEVER printed.
function ensureSpendCap(p, targets, capUsd) {
  const raw = fs.readFileSync(p, 'utf8');
  const cfgObj = JSON.parse(raw);
  if (!cfgObj || typeof cfgObj !== 'object' || Array.isArray(cfgObj))
    throw new Error('keysmith config is not an object');
  const limits = cfgObj.limits && typeof cfgObj.limits === 'object' ? cfgObj.limits : {};
  const spend = limits.spend && typeof limits.spend === 'object' && !Array.isArray(limits.spend) ? limits.spend : {};
  const changed = [];
  const kept = [];
  targets.forEach(function (t) {
    const cur = existingCap(spend, t);
    if (cur === undefined) {
      spend[t] = capUsd;
      changed.push(t);
    } else kept.push({ target: t, cap: describeCap(cur), usd: capUsdOf(cur) });
  });
  if (!changed.length) return { changed: [], kept: kept };
  limits.spend = spend;
  cfgObj.limits = limits;
  let mode = 0o600;
  try {
    mode = fs.statSync(p).mode & 0o777;
  } catch (e) {
    /* keep 0600 */
  }
  atomicWrite(p, JSON.stringify(cfgObj, null, 2) + '\n', mode);
  return { changed: changed, kept: kept };
}

// The credential ACCOUNT keysmith meters the first leg's key under — so the cap covers every adapter
// sharing that key, not only this alias's leg. Asked from keysmith's own code (same derivation the
// gateway uses); null when it cannot be told, and the adapter cap still applies.
async function capAccount(p, adapterId, opts) {
  opts = opts || {};
  if (opts.accountOf) return opts.accountOf(adapterId);
  try {
    const ks = JSON.parse(fs.readFileSync(p, 'utf8'));
    const a = ks && ks.adapters && ks.adapters[adapterId];
    if (!a) return null;
    const dir = opts.keysmithDir || process.env.KEYSMITH_DIR || path.join(os.homedir(), 'Projects', 'keysmith');
    const mod = await import(path.join(dir, 'src', 'usage.js'));
    const acct = typeof mod.credentialAccount === 'function' ? mod.credentialAccount(a) : null;
    return typeof acct === 'string' && acct && acct !== 'exec' ? acct : null;
  } catch (e) {
    return null;
  }
}

// `keyflip failover setup`: alias, spend cap, scoped key, provider profile. Idempotent.
// -> { ok, steps: [{ step, ok, detail }], restartGateway: bool }
async function setup(ctx, opts) {
  opts = opts || {};
  const runner = opts.run || _run;
  const p = plan(ctx);
  const ks = keysmithCommand({ run: runner, keysmithDir: opts.keysmithDir });
  const steps = [];
  const dry = !!opts.dryRun;
  function ksRun(args) {
    return runner(ks.exec, ks.args.concat(args), undefined, { timeoutMs: 30000 });
  }
  // 1) the alias chain
  if (dry) steps.push({ step: 'alias', ok: true, detail: 'would set ' + p.alias + ' = ' + p.legs.join(' -> ') });
  else {
    const r = ksRun(['alias', p.alias].concat(p.legs));
    steps.push({
      step: 'alias',
      ok: !!(r && r.code === 0),
      detail:
        r && r.code === 0
          ? p.alias + ' = ' + p.legs.join(' -> ')
          : 'keysmith alias failed: ' +
            String((r && (r.stderr || r.stdout)) || '')
              .trim()
              .slice(0, 300),
    });
  }
  // 2) the spend cap on the paid leg's key
  const cfgPath = keysmithConfigPath(opts);
  const targets = p.capAdapter ? ['adapter:' + p.capAdapter] : [];
  // The account cap covers EVERY use of that key through keysmith (other jobs too): opt-in only.
  const acct = p.capAdapter && p.capAccount ? await capAccount(cfgPath, p.capAdapter, opts) : null;
  if (acct) targets.push('account:' + acct);
  if (!targets.length) steps.push({ step: 'spend-cap', ok: false, detail: 'no paid leg to cap' });
  else if (dry)
    steps.push({
      step: 'spend-cap',
      ok: true,
      detail: 'would cap ' + targets.join(', ') + ' at $' + p.capUsd + '/month',
    });
  else {
    try {
      const r = ensureSpendCap(cfgPath, targets, p.capUsd);
      const loose = r.kept.filter(function (k) {
        return k.usd === null || k.usd > p.capUsd;
      });
      const parts = [];
      if (r.changed.length) parts.push('set ' + r.changed.join(', ') + ' = $' + p.capUsd + '/month');
      r.kept.forEach(function (k) {
        parts.push('kept the existing cap on ' + k.target + ' (' + k.cap + ')');
      });
      steps.push({
        step: 'spend-cap',
        // An existing cap looser than the failover's is the owner's to change, not keyflip's: the
        // failover then stays off (gatewayReady) until a cap of at most $capUsd covers the paid leg.
        ok: loose.length === 0,
        detail:
          parts.join('; ') +
          (loose.length
            ? ' — looser than the $' +
              p.capUsd +
              ' the failover needs; it stays off until the paid leg is capped at that or less'
            : ''),
        changed: r.changed.length > 0,
      });
    } catch (e) {
      steps.push({ step: 'spend-cap', ok: false, detail: 'could not write ' + cfgPath + ': ' + e.message });
    }
  }
  // 3) a key scoped to the alias and its legs, handed over through a 0600 file, kept in the store
  let haveKey = false;
  try {
    haveKey = !!ctx.store.getProfile('provider__' + p.provider);
  } catch (e) {
    haveKey = false;
  }
  if (haveKey) steps.push({ step: 'key', ok: true, detail: 'provider ' + p.provider + ' already holds a gateway key' });
  else if (dry)
    steps.push({ step: 'key', ok: true, detail: 'would mint a key scoped to alias:' + p.alias + ' and its legs' });
  else {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-failover-'));
    const keyFile = path.join(tmpDir, 'key');
    try {
      const allow = ['alias:' + p.alias].concat(p.legs).join(',');
      const r = ksRun(['key', 'add', 'keyflip-failover', '--allow', allow, '--out', keyFile]);
      let key = null;
      try {
        key = fs.readFileSync(keyFile, 'utf8').trim();
      } catch (e) {
        key = null;
      }
      if (r && r.code === 0 && key) {
        ctx.store.setProfile('provider__' + p.provider, key);
        haveKey = true;
        steps.push({
          step: 'key',
          ok: true,
          detail: 'minted a key scoped to alias:' + p.alias + ' (stored, never printed)',
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
  // 4) the keyflip provider profile every surface is pointed at
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
    steps.push({ step: 'provider', ok: true, detail: p.provider + ' -> ' + p.gatewayUrl + ' (model ' + p.alias + ')' });
  }
  return {
    ok: steps.every(function (s) {
      return s.ok;
    }),
    steps: steps,
    plan: p,
    // keysmith reads aliases and limits once, at start: the running gateway needs a restart.
    restartGateway: !dry,
  };
}

// Does the RUNNING gateway enforce a spend cap of at most capUsd on the paid leg? keysmith reads
// limits at start, so a cap written to its config is not proof; its own usage route is. Asked with
// the failover's scoped key, which sees exactly the caps on the adapters/accounts it can reach.
async function capLoaded(p, key, doFetch, opts) {
  if (!p.capAdapter) return { ok: true, detail: 'no paid leg' };
  let res;
  try {
    res = await doFetch(p.gatewayUrl + '/v1/keysmith/usage?hours=1', {
      headers: { Authorization: 'Bearer ' + key },
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 3000)
          : undefined,
    });
  } catch (e) {
    return { ok: false, reason: 'could not read the spend caps from the gateway' };
  }
  if (!res || !res.ok)
    return {
      ok: false,
      reason:
        'the gateway does not report its spend caps (' +
        ((res && res.status) || 'no answer') +
        '); refusing to fail over uncapped',
    };
  let j = null;
  try {
    j = await res.json();
  } catch (e) {
    j = null;
  }
  const rows = (j && Array.isArray(j.spend) ? j.spend : []).filter(function (r) {
    return r && typeof r.cap === 'number' && r.cap <= p.capUsd;
  });
  const acct = opts.capAccountName || null;
  const hit = rows.find(function (r) {
    return (r.kind === 'adapter' && r.target === p.capAdapter) || (acct && r.kind === 'account' && r.target === acct);
  });
  if (!hit)
    return {
      ok: false,
      reason:
        'the running gateway enforces no spend cap of at most $' +
        p.capUsd +
        ' on ' +
        p.capAdapter +
        ' (keyflip failover setup, then restart keysmith); refusing to fail over uncapped',
    };
  return {
    ok: true,
    cap: { kind: hit.kind, target: hit.target, cap: hit.cap, spent: hit.spent, exceeded: !!hit.exceeded },
  };
}

// Is the gateway up, does our key work, does it serve the alias — and (unless opts.capCheck is
// false: the per-tick health check) does it enforce the spend cap? GET /v1/models + the usage route.
async function gatewayReady(ctx, opts) {
  opts = opts || {};
  const p = opts.plan || plan(ctx);
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
  try {
    const res = await doFetch(p.gatewayUrl + '/v1/models', {
      headers: { Authorization: 'Bearer ' + key },
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 3000)
          : undefined,
    });
    if (!res || !res.ok) return { ok: false, reason: 'gateway answered ' + ((res && res.status) || 'nothing') };
    const j = await res.json();
    const ids = ((j && j.data) || []).map(function (m) {
      return m && m.id;
    });
    if (ids.indexOf(p.alias) === -1)
      return { ok: false, reason: 'gateway does not serve ' + p.alias + ' yet (restart keysmith)' };
  } catch (e) {
    return { ok: false, reason: 'gateway unreachable at ' + p.gatewayUrl };
  }
  if (opts.capCheck === false) return { ok: true };
  let acct = null;
  if (p.capAccount && p.capAdapter) {
    try {
      acct = await capAccount(keysmithConfigPath(opts), p.capAdapter, opts);
    } catch (e) {
      acct = null;
    }
  }
  const c = await capLoaded(p, key, doFetch, { timeoutMs: opts.timeoutMs, capAccountName: acct });
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, cap: c.cap };
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
  const ready = await gatewayReady(ctx, { plan: p, fetch: deps.fetch, keysmithConfig: deps.keysmithConfig });
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
        p.legs.join(' -> ') +
        ', capped at $' +
        p.capUsd +
        '/month).',
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
  setup,
  gatewayReady,
  capLoaded,
  engage,
  release,
  state,
  ensureSpendCap,
  keysmithCommand,
  keysmithConfigPath,
  DEFAULTS,
  STATE_FILE,
};
