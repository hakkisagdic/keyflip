// Auto-switch on usage threshold (adopted from claude-swap PR #76 / issues #38,
// #50): watch the ACTIVE account's utilization and, when it crosses the
// threshold, swap the CLI credential to another account chosen by strategy.
// Only the CLI credential is swapped here (Claude Code picks it up on its next
// request; the file backend re-reads immediately, the macOS keychain cache is
// ~30s). Claude Desktop follows through desktoprestart.js (idle-only restart),
// driven by the caller, never by this module.
import fs from 'fs';
import path from 'path';
import * as core from './core.js';
import * as usage from './usage.js';
import * as breaker from './breaker.js';
import * as history from './history.js';
import * as _groups from './groups.js';
import * as fsutil from './fsutil.js';
import * as _config from './config.js';
import * as _identity from './identity.js';
import * as _limitsignal from './limitsignal.js';
import * as _log from './log.js';

const STATE_FILE = '.autoswitch-state.json';
const DEFAULT_THRESHOLD = 95;

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

// The live access token has simply aged past its expiry (Claude Code renews it on its next request),
// as opposed to a login the server rejects outright.
function liveTokenAged(ctx, nowMs) {
  try {
    const o = JSON.parse(ctx.store.getLive()).claudeAiOauth;
    return !!(o && typeof o.expiresAt === 'number' && o.expiresAt <= nowMs);
  } catch (e) {
    return false;
  }
}

// When the windows that put an account over the threshold reset — the moment it has headroom again
// whether or not its usage can be read then. ISO string or null.
function recoverAtOf(u, threshold) {
  if (!u || typeof u !== 'object') return null;
  let wins = [u.fiveHour, u.sevenDay].filter(Boolean);
  if (!wins.length) wins = [u.sevenDayOpus, u.sevenDaySonnet].filter(Boolean);
  let latest = null;
  wins.forEach(function (w) {
    if (typeof w.pct !== 'number' || w.pct < threshold) return;
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (!isNaN(t) && (latest === null || t > latest)) latest = t;
  });
  return latest === null ? null : new Date(latest).toISOString();
}

function sleepMs(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

function clearState(ctx) {
  try {
    fs.unlinkSync(statePath(ctx));
  } catch (e) {
    /* ignore */
  }
}

// H4: If the active account's usage reading for this tick is status 'ok' and fresh
// (eff.basis === 'live', not served from a stale/last-good cache) and the window named
// by the hit's kind (five_hour -> fiveHour, seven_day -> sevenDay, seven_day_opus -> sevenDayOpus;
// unknown kind -> both) is below the threshold, ignore the hit and return the log message.
function freshReadingOverrulesHit(activeInfo, eff, hit, threshold) {
  if (!activeInfo || activeInfo.status !== 'ok' || !activeInfo.usage) return null;
  if (!eff || eff.basis !== 'live') return null;
  const u = activeInfo.usage;
  const kind = (hit && hit.kind) || 'unknown';
  if (kind === 'five_hour' || kind === 'seven_day' || kind === 'seven_day_opus') {
    const prop = kind === 'five_hour' ? 'fiveHour' : kind === 'seven_day' ? 'sevenDay' : 'sevenDayOpus';
    const w = u[prop];
    if (w && typeof w.pct === 'number' && w.pct < threshold) {
      return 'limit signal ignored: a fresh reading shows ' + Math.round(w.pct) + '% (' + kind + ')';
    }
    return null;
  }
  const present = [
    { name: 'five_hour', w: u.fiveHour },
    { name: 'seven_day', w: u.sevenDay },
  ].filter(function (x) {
    return x.w && typeof x.w.pct === 'number';
  });
  if (
    present.length &&
    present.every(function (x) {
      return x.w.pct < threshold;
    })
  ) {
    const picked = present.reduce(function (a, b) {
      return b.w.pct > a.w.pct ? b : a;
    });
    return 'limit signal ignored: a fresh reading shows ' + Math.round(picked.w.pct) + '% (' + picked.name + ')';
  }
  return null;
}

async function tickInner(ctx, opts, out) {
  opts = opts || {};
  // Switch at >= N% utilization. 95 (P3): late enough not to waste a window, early enough that the
  // next account is in place before the current one starts refusing.
  const threshold = opts.threshold !== undefined ? opts.threshold : DEFAULT_THRESHOLD;
  const strategy = opts.strategy || 'next-available';
  // P2: the active account is the one the LIVE TOKEN belongs to. Resolve it first (offline match,
  // else the profile endpoint once per token), and if ~/.claude.json carries another account's label,
  // repair the label — under the switch lock when the caller provides one.
  if (opts.resolveIdentity !== false) {
    try {
      await _identity.resolveLive(ctx, { fetch: opts.identityFetch || opts.fetch, nowMs: opts.nowMs });
      const doRepair =
        opts.repairLabel ||
        function () {
          return _identity.repairIfMismatched(ctx);
        };
      const rep = await doRepair();
      if (rep && rep.repaired) {
        out.identityRepair = rep;
        history.recordEvent(ctx, {
          kind: 'identity-repair',
          from: rep.from || null,
          to: rep.to,
          reason: 'the live token belongs to ' + rep.to + '; the ~/.claude.json label said ' + (rep.from || 'nothing'),
        });
      }
    } catch (e) {
      /* identity stays label-based for this tick */
    }
  }
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
  const activeInfo = infos[active.name] || null;
  const activeStatus = (activeInfo && activeInfo.status) || null;
  let h = eff.headroom;
  let basis = eff.basis;
  // A live login the usage endpoint REJECTS (401/403) — and not merely an access token past its expiry,
  // which Claude Code renews on its next request — cannot serve Claude Code either. It counts as
  // exhausted, so a working account (or the failover) takes over instead of waiting on it forever.
  let activeDead = false;
  if (typeof h !== 'number' && activeStatus === 'expired' && !liveTokenAged(ctx, nowMs)) {
    h = 0;
    basis = 'rejected';
    activeDead = true;
  }
  const retryAt = (activeInfo && activeInfo.retryAt) || null;
  // Hysteresis: once away (on another account, or on the API failover), come back only at >= this.
  const recoveryFloor = Math.min(95, margin + 10);

  // P4: the API failover (keysmith) — engaged when every account is KNOWN to be over the threshold,
  // released as soon as a Claude account has recovered (or the gateway stops answering).
  // opts.failover = { state, engage, release, check?, markLost?, clearLost? }.
  const fo = opts.failover ? opts.failover.state() : null;
  let limitHit = null;
  if (!fo && !activeDead && opts.limitSignal !== false) {
    const sigFn = typeof opts.limitSignal === 'function' ? opts.limitSignal : _limitsignal.recentLimitHit;
    try {
      const hit = await sigFn(ctx, {
        nowMs: opts.nowMs,
        activeAccount: active.name,
        claudeDir: opts.claudeDir,
        appAccount: opts.appAccount,
      });
      if (hit && hit.at) {
        const ignoredMsg = freshReadingOverrulesHit(activeInfo, eff, hit, threshold);
        if (ignoredMsg) {
          _log.log(ignoredMsg);
          out.limitSignalIgnored = ignoredMsg;
        } else {
          h = 0;
          basis = 'limit-signal';
          limitHit = { at: hit.at, resetsAt: hit.resetsAt || null, kind: hit.kind || 'unknown' };
          if (limitHit.resetsAt) {
            const resetMs = Date.parse(limitHit.resetsAt);
            if (isFinite(resetMs) && resetMs > nowMs) {
              breaker.markCooldown(ctx, active.name, resetMs - nowMs, 'quota', bopts);
            }
          }
        }
      }
    } catch (e) {
      /* broken limitSignal never breaks tick */
    }
  }
  async function releaseFailover(to, why, extra) {
    if (!fo) return false;
    try {
      const r = await opts.failover.release(Object.assign({ to: to, reason: why }, extra || {}));
      return !!(r && r.ok);
    } catch (e) {
      return false;
    }
  }
  async function noCandidate(extra) {
    const base = Object.assign(
      { state: 'no-candidate', active: active, headroom: h, switchedTo: null },
      limitHit ? { basis: basis, limitHit: limitHit } : {},
      extra || {},
    );
    if (!opts.failover) return base;
    if (fo) return Object.assign(base, { state: 'failover', failover: fo });
    let e;
    try {
      e = await opts.failover.engage({
        from: active.name,
        reason: limitHit
          ? _limitsignal.formatLimitHitReason(limitHit, { timeZone: opts.timeZone })
          : activeDead
            ? 'the live login of ' + active.name + ' is rejected and no other account has headroom'
            : 'usage ' + Math.round(100 - h) + '% >= ' + threshold + '% and no other account below it',
        recoverAt: limitHit
          ? limitHit.resetsAt
          : activeDead
            ? null
            : recoverAtOf((activeInfo && (activeInfo.usage || activeInfo.lastGood)) || null, threshold),
      });
    } catch (err) {
      e = { ok: false, reason: (err && err.message) || String(err) };
    }
    if (e && e.ok) return Object.assign(base, { state: 'failover-engaged', failover: e.state || null });
    return Object.assign(base, { failoverError: (e && e.reason) || 'failover unavailable' });
  }

  // While on the failover, the gateway must still be there: Claude Code points at it, so a dead
  // gateway is a dead Claude Code. Retry up to 3 times within the tick (2 s, 5 s, 10 s), then hold
  // the failover in a degraded state for failover.lostGraceSeconds before releasing it.
  if (fo && typeof opts.failover.check === 'function') {
    const existingLostSince = (fo && fo.lostSince) || null;
    const runCheck = async function () {
      try {
        const r = await opts.failover.check();
        return r && typeof r === 'object' ? r : { ok: !!r };
      } catch (e) {
        return { ok: false, reason: (e && e.message) || String(e) };
      }
    };
    const firstPause = opts.failoverRecheckMs !== undefined ? opts.failoverRecheckMs : 2000;
    const pauses = [firstPause, 5000, 10000];
    let ok = await runCheck();
    for (let i = 0; i < pauses.length && (!ok || !ok.ok); i++) {
      await (opts.sleep || sleepMs)(pauses[i]);
      ok = await runCheck();
    }
    if (ok && ok.ok) {
      if (existingLostSince) {
        delete fo.lostSince;
        if (typeof opts.failover.clearLost === 'function') opts.failover.clearLost();
        else _log.log('gateway back');
        out.gatewayBack = true;
      }
    } else {
      const why = 'the failover gateway stopped answering (' + ((ok && ok.reason) || 'no answer') + ')';
      let graceSec = 300;
      if (typeof opts.lostGraceSeconds === 'number' && opts.lostGraceSeconds > 0) {
        graceSec = opts.lostGraceSeconds;
      } else {
        try {
          const cfgGrace = Number(_config.get(ctx, 'failover.lostGraceSeconds'));
          if (isFinite(cfgGrace) && cfgGrace > 0) graceSec = cfgGrace;
        } catch (e) {
          graceSec = 300;
        }
      }
      if (!existingLostSince) {
        const lostSince = new Date(nowMs).toISOString();
        fo.lostSince = lostSince;
        if (typeof opts.failover.markLost === 'function') opts.failover.markLost(lostSince);
        const notifyFn =
          typeof opts.notify === 'function'
            ? opts.notify
            : opts.failover && typeof opts.failover.notify === 'function'
              ? opts.failover.notify
              : null;
        if (notifyFn) {
          const mins = Math.max(1, Math.round(graceSec / 60));
          try {
            await notifyFn(
              'quota',
              'The failover gateway is not answering — holding the failover for up to ' + mins + ' min',
            );
          } catch (e) {
            /* notify never breaks tick */
          }
        }
        return {
          state: 'failover-degraded',
          active: active,
          headroom: h,
          switchedTo: null,
          reason: why,
          lostSince: lostSince,
          failover: fo,
        };
      }
      const lostMs = Date.parse(existingLostSince);
      if (isFinite(lostMs) && nowMs - lostMs >= graceSec * 1000) {
        delete fo.lostSince;
        const rel = await releaseFailover(active.name, why, { lost: true });
        return {
          state: 'failover-lost',
          active: active,
          headroom: h,
          switchedTo: null,
          reason: why,
          failoverReleased: rel,
        };
      }
      return {
        state: 'failover-degraded',
        active: active,
        headroom: h,
        switchedTo: null,
        reason: why,
        lostSince: existingLostSince,
        failover: fo,
      };
    }
  }
  // A manual engage (`keyflip failover on`) never auto-releases: only `keyflip failover off` or a
  // lost gateway past the grace period above ends it.
  if (fo && fo.manual) {
    return { state: 'failover', active: active, headroom: h, switchedTo: null, basis: basis, failover: fo };
  }
  if (fo && typeof h === 'number' && h >= recoveryFloor) {
    await releaseFailover(active.name, active.name + ' recovered (' + Math.round(h) + '% headroom)');
    return { state: 'failback', active: active, headroom: h, switchedTo: null, basis: basis };
  }
  // The window that put the account over has reset: it has headroom now even if its usage cannot be
  // read (on the failover nothing renews the live token, so the read may keep failing).
  if (fo && typeof h !== 'number' && fo.recoverAt && Date.parse(fo.recoverAt) <= nowMs) {
    await releaseFailover(active.name, active.name + "'s usage window reset at " + fo.recoverAt);
    return { state: 'failback', active: active, headroom: null, switchedTo: null, basis: 'window-reset' };
  }

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
          const rel = await releaseFailover(primaryProfile.name, 'primary recovered');
          const back = { state: 'switched-back', active: active, headroom: h, switchedTo: primaryProfile };
          if (rel) back.failoverReleased = true;
          return back;
        }
      }
    }
  }

  const unknownActive = {
    state: 'unknown',
    active: active,
    headroom: null,
    switchedTo: null,
    usageStatus: activeStatus,
    retryAt: retryAt,
  };
  if (typeof h !== 'number') {
    // Not on the failover: never act on a reading we do not have.
    if (!fo) return unknownActive;
    // On the failover with the active account unreadable: a RECOVERED other account still ends it.
  } else {
    // On the failover and recovering, but not past the hysteresis band yet: stay there (no flapping).
    if (fo && h > margin)
      return { state: 'failover', active: active, headroom: h, switchedTo: null, basis: basis, failover: fo };
    if (h > margin) return { state: 'below', active: active, headroom: h, switchedTo: null, basis: basis };
  }

  // Threshold crossed (or failing back) — pick a target in rotation order. Only enabled accounts
  // with a captured CLI credential are candidates: switching to an app-only or disabled profile
  // wouldn't change the live login or would violate user pause. A profile whose stored token the
  // profile endpoint named as ANOTHER account's (P2 damage) is skipped: switching "to" it would put
  // that other account live.
  let candidates = [];
  const skipped = [];
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
    if (!hasCli) continue;
    let wrong = null;
    try {
      wrong = _identity.wrongOwnerOf(ctx, e.name);
    } catch (err) {
      wrong = null;
    }
    if (wrong) {
      skipped.push({ name: e.name, reason: 'its saved login is ' + wrong + "'s token (keyflip login " + e.name + ')' });
      continue;
    }
    candidates.push(e);
  }
  const extraOut = skipped.length ? { skippedCandidates: skipped } : {};
  // Optional group scoping (config autoswitch.group / --group): rotate only within a tagged pool.
  // Applied BEFORE the usage fetch so out-of-group accounts aren't queried. Preserves rotation order.
  if (opts.group) candidates = _groups.filterProfiles(ctx, candidates, opts.group);
  if (!candidates.length) {
    if (typeof h !== 'number') return Object.assign(unknownActive, { state: 'failover', failover: fo }, extraOut);
    return noCandidate(extraOut);
  }

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
  // Leaving the failover takes a RECOVERED account (hysteresis), not one just under the threshold.
  const need = fo ? recoveryFloor - 0.0001 : margin;
  const pool = candidates.filter(function (c) {
    const info = effInfos[c.name];
    return info && typeof info.headroom === 'number' && info.headroom > need && breaker.isAvailable(ctx, c.name, bopts);
  });
  if (!pool.length) {
    if (typeof h !== 'number') return Object.assign(unknownActive, { state: 'failover', failover: fo }, extraOut);
    // "No account has headroom" must be KNOWN, not assumed: an account whose usage cannot be read
    // right now (endpoint throttled, lock busy, offline) may be idle — paying for the API while it
    // sits unused would be the wrong trade. Wait for its reading instead.
    const unknown = candidates.filter(function (c) {
      const info = effInfos[c.name];
      if (!breaker.isAvailable(ctx, c.name, bopts)) return false;
      if (!info) return true;
      if (typeof info.headroom === 'number') return false;
      return ['expired', 'no-creds', 'no-token'].indexOf(info.status) === -1;
    });
    if (unknown.length && !fo) {
      return Object.assign(
        {
          state: 'no-candidate',
          active: active,
          headroom: h,
          switchedTo: null,
          basis: basis,
          unknownCandidates: unknown.map(function (c) {
            return c.name;
          }),
        },
        limitHit ? { limitHit: limitHit } : {},
        opts.failover
          ? {
              failoverDeferred:
                'not engaging the paid failover while the usage of ' +
                unknown
                  .map(function (c) {
                    return c.name;
                  })
                  .join(', ') +
                ' is unknown',
            }
          : {},
        extraOut,
      );
    }
    return noCandidate(Object.assign({ basis: basis }, extraOut));
  }
  const picked = usage.pickByStrategy(pool, effInfos, strategy, { model: opts.model }) || pool[0];
  if (!picked) return noCandidate(extraOut);

  const doSwitch =
    opts.performSwitch ||
    function (name) {
      return core.performSwitch(ctx, name);
    };
  const did = await doSwitch(picked.name);
  // If nothing actually swapped (no CLI credential), report it rather than
  // claiming a switch — prevents the caller from looping on a phantom success.
  if (did && did.cli === false) return noCandidate();
  writeState(ctx, {
    primary: st && st.primary ? st.primary : active.name,
    switchedTo: picked.name,
    at: opts.nowMs !== undefined ? opts.nowMs : Date.now(),
  });
  history.recordEvent(ctx, {
    kind: 'autoswitch',
    from: active.name,
    to: picked.name,
    reason: limitHit
      ? _limitsignal.formatLimitHitHeadline(limitHit, { timeZone: opts.timeZone })
      : activeDead
        ? 'the live login of ' + active.name + ' is rejected by Anthropic (401/403)'
        : typeof h !== 'number'
          ? 'failing back from the API failover: ' + picked.name + ' has headroom'
          : 'usage ' +
            Math.round(100 - h) +
            '% >= threshold ' +
            threshold +
            (basis === 'last-good' ? ' (last good reading; endpoint throttled)' : ''),
  });
  const res = Object.assign(
    { state: 'switched', active: active, headroom: h, switchedTo: picked, basis: basis },
    limitHit ? { limitHit: limitHit } : {},
    extraOut,
  );
  if (await releaseFailover(picked.name, picked.name + ' has headroom')) res.failoverReleased = true;
  return res;
}

// One watch iteration. Injectable deps for tests (fetch, nowMs, performSwitch, repairLabel). Returns
//   { state: 'idle'|'no-active'|'below'|'switched'|'switched-back'|'no-candidate'|'unknown'|
//            'failover-engaged'|'failover'|'failback'|'failover-degraded'|'failover-lost',
//     active, headroom, switchedTo, identityRepair?, failoverReleased?, failoverError?,
//     failoverDeferred?, unknownCandidates?, skippedCandidates?, limitHit?, limitSignalIgnored?,
//     lostSince?, gatewayBack? }
async function tick(ctx, opts) {
  const side = {};
  const r = await tickInner(ctx, opts || {}, side);
  if (side.identityRepair) r.identityRepair = side.identityRepair;
  if (side.gatewayBack) r.gatewayBack = true;
  if (side.limitSignalIgnored) r.limitSignalIgnored = side.limitSignalIgnored;
  return r;
}

export { tick, readState, clearState, recoverAtOf, DEFAULT_THRESHOLD };
