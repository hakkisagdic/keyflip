'use strict';
// Auto-switch on usage threshold (adopted from claude-swap PR #76 / issues #38,
// #50): watch the ACTIVE account's utilization and, when it crosses the
// threshold, swap the CLI credential to another account chosen by strategy.
// Only the CLI credential is swapped (Claude Code picks it up on its next
// request; the file backend re-reads immediately, the macOS keychain cache is
// ~30s) — the desktop app is never closed from under the user.
const core = require('./core');
const usage = require('./usage');

// One watch iteration. Injectable deps for tests. Returns
//   { state: 'idle'|'no-active'|'below'|'switched'|'no-candidate'|'unknown',
//     active, headroom, switchedTo }
async function tick(ctx, opts) {
  opts = opts || {};
  const threshold = opts.threshold !== undefined ? opts.threshold : 90; // switch at >= N% utilization
  const strategy = opts.strategy || 'next-available';
  const list = core.listProfiles(ctx);
  let activeIdx = -1;
  list.forEach(function (e, i) { if (e.active) activeIdx = i; });
  if (activeIdx === -1) return { state: 'no-active', active: null, headroom: null, switchedTo: null };
  const active = list[activeIdx];

  const infos = await usage.usageForProfiles(ctx, [active.name], {
    fetch: opts.fetch, nowMs: opts.nowMs, cacheTtlMs: opts.cacheTtlMs, liveFor: active.name,
  });
  const h = infos[active.name] ? infos[active.name].headroom : null;
  if (typeof h !== 'number') return { state: 'unknown', active: active, headroom: null, switchedTo: null };
  if (h > 100 - threshold) return { state: 'below', active: active, headroom: h, switchedTo: null };

  // Threshold crossed — pick a target in rotation order. Only accounts with a
  // captured CLI credential are candidates: switching to an app-only profile
  // wouldn't change the live login, so every tick would re-pick it forever.
  const candidates = [];
  for (let k = 1; k <= list.length; k++) {
    const e = list[(activeIdx + k) % list.length];
    if (e.active) continue;
    let hasCli = false;
    try { hasCli = !!ctx.store.getProfile(e.name); } catch (err) { hasCli = false; }
    if (hasCli) candidates.push(e);
  }
  if (!candidates.length) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };

  const cinfos = await usage.usageForProfiles(ctx, candidates.map(function (e) { return e.name; }), {
    fetch: opts.fetch, nowMs: opts.nowMs, cacheTtlMs: opts.cacheTtlMs,
  });
  // Only rotate to an account that is itself BELOW the threshold (headroom greater
  // than the switch margin). Without this, two accounts both near the limit would
  // ping-pong every interval. Unknown-usage candidates are eligible only when NO
  // known-good account exists (better to try than to stay stuck at the limit).
  // Only rotate to an account we KNOW is below the threshold — never to one whose
  // usage is unknown (would risk switching to an equally-exhausted account and
  // thrashing back next tick). If none qualifies, wait rather than switch blind.
  const margin = 100 - threshold;
  const pool = candidates.filter(function (c) {
    const info = cinfos[c.name];
    return info && typeof info.headroom === 'number' && info.headroom > margin;
  });
  if (!pool.length) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };
  const picked = usage.pickByStrategy(pool, cinfos, strategy) || pool[0];
  if (!picked) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };

  const doSwitch = opts.performSwitch || function (name) { return core.performSwitch(ctx, name); };
  const did = await doSwitch(picked.name);
  // If nothing actually swapped (no CLI credential), report it rather than
  // claiming a switch — prevents the caller from looping on a phantom success.
  if (did && did.cli === false) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };
  return { state: 'switched', active: active, headroom: h, switchedTo: picked };
}

module.exports = { tick: tick };
