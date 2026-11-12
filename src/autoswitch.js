// Auto-switch on usage threshold (adopted from claude-swap PR #76 / issues #38,
// #50): watch the ACTIVE account's utilization and, when it crosses the
// threshold, swap the CLI credential to another account chosen by strategy.
// Only the CLI credential is swapped (Claude Code picks it up on its next
// request; the file backend re-reads immediately, the macOS keychain cache is
// ~30s) — the desktop app is never closed from under the user.
import fs from 'fs';
import path from 'path';
import * as core from './core.js';
import * as usage from './usage.js';
import * as breaker from './breaker.js';
import * as history from './history.js';
import * as _groups from './groups.js';
import * as fsutil from './fsutil.js';
import * as _config from './config.js';

const STATE_FILE = '.autoswitch-state.json';

function statePath(ctx) {
  return path.join(ctx.configDir, STATE_FILE);
}

function readState(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8'));
    return raw && typeof raw === 'object' && typeof raw.primary === 'string' ? raw : null;
  } catch (e) {
    return null;
  }
}

function writeState(ctx, state) {
  try {
    fsutil.atomicWrite(statePath(ctx), JSON.stringify(state, null, 2) + '\n', 0o600);
  } catch (e) {
    /* best effort */
  }
}

function clearState(ctx) {
  try {
    fs.unlinkSync(statePath(ctx));
  } catch (e) {
    /* ignore */
  }
}

// One watch iteration. Injectable deps for tests. Returns
//   { state: 'idle'|'no-active'|'below'|'switched'|'switched-back'|'no-candidate'|'unknown',
//     active, headroom, switchedTo }
async function tick(ctx, opts) {
  opts = opts || {};
  const threshold = opts.threshold !== undefined ? opts.threshold : 90; // switch at >= N% utilization
  const strategy = opts.strategy || 'next-available';
  const list = core.listProfiles(ctx);
  let activeIdx = -1;
  list.forEach(function (e, i) {
    if (e.active) activeIdx = i;
  });
  if (activeIdx === -1) return { state: 'no-active', active: null, headroom: null, switchedTo: null };
  const active = list[activeIdx];
  const bopts = { nowMs: opts.nowMs };
  const margin = 100 - threshold;

  const st = readState(ctx);
  if (st && st.primary === active.name) {
    clearState(ctx);
  }

  const infos = await usage.usageForProfiles(ctx, [active.name], {
    fetch: opts.fetch,
    nowMs: opts.nowMs,
    cacheTtlMs: opts.cacheTtlMs,
    liveFor: active.name,
    recordHistory: true,
  });
  // While the endpoint is throttled, a RECENT last-good reading still decides (usage.effectiveHeadroom).
  let maxStaleMs = opts.maxStaleMs;
  if (maxStaleMs === undefined) {
    try {
      maxStaleMs = _config.get(ctx, 'autoswitch.maxStaleSeconds') * 1000;
    } catch (e) {
      maxStaleMs = 900 * 1000;
    }
  }
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const eff = usage.effectiveHeadroom(infos[active.name], nowMs, maxStaleMs);
  const h = eff.headroom;
  const basis = eff.basis;
  const retryAt = (infos[active.name] && infos[active.name].retryAt) || null;

  // Automatic switch-back: if we previously auto-switched away from a primary
  // account and that primary account is enabled, healthy, and has recovered
  // with a +10% hysteresis buffer above the threshold, return to it.
  if (st && st.primary && st.primary !== active.name && opts.returnToPrimary !== false) {
    const primaryProfile = list.find(function (e) {
      return e.name === st.primary && e.enabled !== false;
    });
    let primaryHasCli = false;
    if (primaryProfile) {
      try {
        primaryHasCli = !!ctx.store.getProfile(primaryProfile.name);
      } catch (e) {
        primaryHasCli = false;
      }
    }
    if (primaryProfile && primaryHasCli && breaker.isAvailable(ctx, primaryProfile.name, bopts)) {
      const pinfos = await usage.usageForProfiles(ctx, [primaryProfile.name], {
        fetch: opts.fetch,
        nowMs: opts.nowMs,
        cacheTtlMs: opts.cacheTtlMs,
      });
      const pinfo = pinfos[primaryProfile.name];
      const recoveryFloor = Math.min(95, margin + 10);
      if (pinfo && pinfo.status === 'ok' && typeof pinfo.headroom === 'number' && pinfo.headroom >= recoveryFloor) {
        const doSwitchBack =
          opts.performSwitch ||
          function (name) {
            return core.performSwitch(ctx, name);
          };
        const didBack = await doSwitchBack(primaryProfile.name);
        if (!didBack || didBack.cli !== false) {
          clearState(ctx);
          history.recordEvent(ctx, {
            kind: 'autoswitch-return',
            from: active.name,
            to: primaryProfile.name,
            reason: 'primary recovered (' + Math.round(pinfo.headroom) + '% headroom)',
          });
          return { state: 'switched-back', active: active, headroom: h, switchedTo: primaryProfile };
        }
      }
    }
  }

  if (typeof h !== 'number')
    return {
      state: 'unknown',
      active: active,
      headroom: null,
      switchedTo: null,
      usageStatus: (infos[active.name] && infos[active.name].status) || null,
      retryAt: retryAt,
    };
  if (h > margin) return { state: 'below', active: active, headroom: h, switchedTo: null, basis: basis };

  // Threshold crossed — pick a target in rotation order. Only enabled accounts
  // with a captured CLI credential are candidates: switching to an app-only or
  // disabled profile wouldn't change the live login or would violate user pause.
  let candidates = [];
  for (let k = 1; k <= list.length; k++) {
    const e = list[(activeIdx + k) % list.length];
    if (e.active) continue;
    if (e.enabled === false) continue;
    let hasCli = false;
    try {
      hasCli = !!ctx.store.getProfile(e.name);
    } catch (err) {
      hasCli = false;
    }
    if (hasCli) candidates.push(e);
  }
  // Optional group scoping (config autoswitch.group / --group): rotate only within a tagged pool.
  // Applied BEFORE the usage fetch so out-of-group accounts aren't queried. Preserves rotation order.
  if (opts.group) candidates = _groups.filterProfiles(ctx, candidates, opts.group);
  if (!candidates.length) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };

  const cinfos = await usage.usageForProfiles(
    ctx,
    candidates.map(function (e) {
      return e.name;
    }),
    {
      fetch: opts.fetch,
      nowMs: opts.nowMs,
      cacheTtlMs: opts.cacheTtlMs,
    },
  );
  // Feed the circuit breaker: an expired token is a real failure signal; a
  // healthy read is a success. (Only definitive signals — throttled/unknown
  // never move breaker state.)
  candidates.forEach(function (c) {
    const st = cinfos[c.name] && cinfos[c.name].status;
    if (st === 'expired') breaker.recordFailure(ctx, c.name, bopts);
    else if (st === 'ok') breaker.recordSuccess(ctx, c.name, bopts);
  });
  // Only rotate to an account we KNOW is below the threshold AND whose breaker is
  // not open (recently-failing accounts are skipped until their recovery window).
  // A throttled candidate with a recent last-good reading is judged on that reading, like the active one.
  const effInfos = {};
  candidates.forEach(function (c) {
    const info = cinfos[c.name];
    const e = usage.effectiveHeadroom(info, nowMs, maxStaleMs);
    effInfos[c.name] = info ? Object.assign({}, info, { headroom: e.headroom, usage: info.usage || e.usage }) : info;
  });
  const pool = candidates.filter(function (c) {
    const info = effInfos[c.name];
    return (
      info && typeof info.headroom === 'number' && info.headroom > margin && breaker.isAvailable(ctx, c.name, bopts)
    );
  });
  if (!pool.length) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null, basis: basis };
  const picked = usage.pickByStrategy(pool, effInfos, strategy, { model: opts.model }) || pool[0];
  if (!picked) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };

  const doSwitch =
    opts.performSwitch ||
    function (name) {
      return core.performSwitch(ctx, name);
    };
  const did = await doSwitch(picked.name);
  // If nothing actually swapped (no CLI credential), report it rather than
  // claiming a switch — prevents the caller from looping on a phantom success.
  if (did && did.cli === false) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };
  writeState(ctx, {
    primary: st && st.primary ? st.primary : active.name,
    switchedTo: picked.name,
    at: opts.nowMs !== undefined ? opts.nowMs : Date.now(),
  });
  history.recordEvent(ctx, {
    kind: 'autoswitch',
    from: active.name,
    to: picked.name,
    reason:
      'usage ' + Math.round(100 - h) + '% >= threshold ' + threshold + (basis === 'last-good' ? ' (last good reading; endpoint throttled)' : ''),
  });
  return { state: 'switched', active: active, headroom: h, switchedTo: picked, basis: basis };
}

export { tick, readState, clearState };
