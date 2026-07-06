'use strict';
// Connectivity + config diagnostics (#13).
//   probe(url)     — cheap reachability: ANY HTTP status = reachable; only DNS/
//                    connect/TLS/timeout = failure.
//   diagnose(ctx)  — a `keyflip doctor` report over config + providers + creds.
//   test(provider) — one minimal REAL request to a provider endpoint (auth check).
const fs = require('fs');
const path = require('path');
const provider = require('./provider');

async function probe(url, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const clock = opts.clock || function () { return Date.now(); };
  if (!doFetch) return { url: url, ok: null, reason: 'no fetch' };
  const t0 = clock();
  try {
    const res = await doFetch(url, { method: 'GET', signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 8000) : undefined });
    return { url: url, ok: true, ms: clock() - t0, httpStatus: (res && res.status) || null };
  } catch (e) {
    const kind = /timeout|aborted/i.test((e && e.message) || '') ? 'timeout' : 'network';
    return { url: url, ok: false, ms: clock() - t0, reason: kind };
  }
}

// Structured health checks. Returns { checks: [{name, ok, detail}], ok }.
async function diagnose(ctx, opts) {
  opts = opts || {};
  const checks = [];
  // ok: true | false (problem) | 'warn' (advisory). fix: optional remediation hint.
  const add = function (name, ok, detail, fix) { checks.push({ name: name, ok: ok, detail: detail || '', fix: fix || undefined }); };

  add('claude config dir', fs.existsSync(ctx.claudeDir), ctx.claudeDir);
  let hasLogin = false;
  try { hasLogin = !!ctx.store.getLive(); } catch (e) { hasLogin = null; }
  add('claude code login', hasLogin === true, hasLogin === null ? 'credential store unreadable (keychain locked?)' : (hasLogin ? 'present' : 'not logged in'));
  if (ctx.appDataDir) add('desktop app data', fs.existsSync(ctx.appDataDir), ctx.appDataDir);

  // --- state-hygiene checks (local, no network) ---
  secretsInGit(ctx, add);
  versioningState(ctx, add);
  orphanSessions(ctx, add);
  quotaPressure(ctx, add);
  settingsJson(ctx, add);

  const active = provider.readActive(ctx);
  add('active endpoint', true, active ? ('provider "' + active.name + '"') : 'official (subscription)');

  // Reachability of each provider's base URL (skipped when no fetch available).
  const names = provider.list(ctx);
  for (let i = 0; i < names.length; i++) {
    const m = provider.read(ctx, names[i]);
    if (!m) continue;
    const r = await probe(m.baseUrl, opts);
    add('provider ' + names[i], r.ok !== false, r.ok === null ? 'not probed' : (r.ok ? 'reachable (' + r.ms + 'ms, http ' + r.httpStatus + ')' : 'UNREACHABLE (' + r.reason + ')'));
  }
  return { checks: checks, ok: checks.every(function (c) { return c.ok !== false; }) };
}

// Fire one minimal real streaming request against a provider endpoint to verify
// auth + reachability end to end. Returns { ok, httpStatus, ms, category }.
async function testProvider(ctx, name, opts) {
  opts = opts || {};
  const meta = provider.read(ctx, name);
  if (!meta) throw new Error("no such provider: '" + name + "'");
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const clock = opts.clock || function () { return Date.now(); };
  if (!doFetch) return { ok: null, category: 'no-fetch' };
  let key = null;
  try { key = ctx.store.getProfile('provider__' + name); } catch (e) { key = null; }
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (key) headers[meta.authScheme === 'api-key' ? 'x-api-key' : 'authorization'] = meta.authScheme === 'api-key' ? key : ('Bearer ' + key);
  const body = JSON.stringify({ model: (meta.models && meta.models.default) || 'claude-3-5-haiku-latest', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
  const url = meta.baseUrl.replace(/\/$/, '') + '/v1/messages';
  const t0 = clock();
  try {
    const res = await doFetch(url, { method: 'POST', headers: headers, body: body, signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 15000) : undefined });
    const s = (res && res.status) || 0;
    const category = s === 401 || s === 403 ? 'auth' : (s >= 500 ? 'server-5xx' : (s >= 400 ? 'client-4xx' : 'ok'));
    return { ok: s >= 200 && s < 300, httpStatus: s, ms: clock() - t0, category: category };
  } catch (e) {
    return { ok: false, ms: clock() - t0, category: 'network', reason: (e && e.message) || 'error' };
  }
}

// The flagship hygiene check: NO secret-bearing file may be tracked by keyflip's git.
function secretsInGit(ctx, add) {
  const vcs = require('./vcs');
  if (!vcs.isEnabled(ctx) || !vcs.isRepo(ctx)) return; // nothing versioned → no risk to report
  const secretpaths = require('./secretpaths');
  const tracked = vcs.tracked(ctx);
  const leaked = tracked.filter(function (f) {
    const parts = f.split('/');
    return secretpaths.isSecretFile(parts[parts.length - 1]) || secretpaths.SECRET_DIRS.indexOf(parts[0]) !== -1;
  });
  if (leaked.length) add('secrets in git', false, leaked.length + ' secret file(s) tracked: ' + leaked.slice(0, 3).join(', '), 'git -C "' + ctx.configDir + '" rm --cached ' + leaked[0] + ' (then any keyflip cmd re-commits; scrub history if pushed)');
  else add('secrets in git', true, 'none tracked (' + tracked.length + ' non-secret file(s) versioned)');
}

function versioningState(ctx, add) {
  const vcs = require('./vcs');
  const on = vcs.isEnabled(ctx) && vcs.isRepo(ctx);
  add('config versioning', on ? true : 'warn', on ? 'on (undo / history available)' : 'off', on ? undefined : 'keyflip versioning enable  (needs git)');
}

function orphanSessions(ctx, add) {
  let rows; try { rows = require('./sessions').list(ctx, { limit: 2000 }); } catch (e) { return; }
  const n = rows.filter(function (r) { return r.orphan; }).length;
  if (n) add('orphaned sessions', 'warn', n + ' session(s) point at a moved/renamed folder', 'keyflip sessions rebind <old-path> <new-path>');
  else if (rows.length) add('orphaned sessions', true, 'none (' + rows.length + ' session(s), folders present)');
}

function quotaPressure(ctx, add) {
  let cache; try { cache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')) || {}; } catch (e) { return; }
  const hot = Object.keys(cache).filter(function (n) { const u = cache[n] && cache[n].usage; return u && u.fiveHour && typeof u.fiveHour.pct === 'number' && u.fiveHour.pct >= 95; });
  if (hot.length) add('quota headroom', 'warn', hot.join(', ') + ' at ≥95% of the 5h limit', 'keyflip next  (rotate to an account with headroom)');
}

function settingsJson(ctx, add) {
  const p = ctx.claudeSettingsPath || path.join(ctx.home || '', '.claude', 'settings.json');
  let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return; } // absent is fine
  try { JSON.parse(raw); } catch (e) { add('settings.json', false, '~/.claude/settings.json is not valid JSON', 'fix or remove it — Claude Code ignores a broken settings file'); }
}

module.exports = { probe: probe, diagnose: diagnose, testProvider: testProvider };
