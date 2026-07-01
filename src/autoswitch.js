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

  // Threshold crossed — pick a target in rotation order.
  const candidates = [];
  for (let k = 1; k <= list.length; k++) {
    const e = list[(activeIdx + k) % list.length];
    if (!e.active) candidates.push(e);
  }
  const cinfos = await usage.usageForProfiles(ctx, candidates.map(function (e) { return e.name; }), {
    fetch: opts.fetch, nowMs: opts.nowMs, cacheTtlMs: opts.cacheTtlMs,
  });
  const picked = usage.pickByStrategy(candidates, cinfos, strategy) ||
    (strategy === 'best' ? null : null);
  if (!picked) return { state: 'no-candidate', active: active, headroom: h, switchedTo: null };

  const doSwitch = opts.performSwitch || function (name) { return core.performSwitch(ctx, name); };
  await doSwitch(picked.name);
  return { state: 'switched', active: active, headroom: h, switchedTo: picked };
}

module.exports = { tick: tick };
