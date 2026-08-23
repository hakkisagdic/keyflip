// Provider profiles (#1, #14): switch Claude Code to a third-party endpoint
// (relay / gateway / Bedrock / OpenRouter) by patching the `env` block of
// ~/.claude/settings.json, which Claude Code hot-reloads — no restart.
//
// Security: the API key is a secret, so it lives in the OS credential store
// (like OAuth tokens), NOT in the provider's metadata file. It is only ever
// written into settings.json (which Claude itself requires in plaintext to
// authenticate), and never printed.
//
// Ownership marker (#8): the exact env keys we injected are recorded in
// providers/.active.json, so switching back to 'official' removes precisely
// those keys (evidence on disk, not an in-memory flag) and the user's own env
// entries survive.
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import * as settings from './settings.js';
import * as txn from './txn.js';
import { writeJsonStable, atomicWrite } from './fsutil.js';

// env keys keyflip manages for a provider (everything else in env is the user's)
const MODEL_KEYS = {
  default: 'ANTHROPIC_MODEL',
  smallFast: 'ANTHROPIC_SMALL_FAST_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
};
const BASE_URL_KEY = 'ANTHROPIC_BASE_URL';
const AUTH_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];

function providersDir(ctx) { return path.join(ctx.configDir, 'providers'); }
function metaPath(ctx, name) { return path.join(providersDir(ctx), name + '.json'); }
function activePath(ctx) { return path.join(providersDir(ctx), '.active.json'); }
function keyStoreName(name) { return 'provider__' + name; }

function list(ctx) {
  let files;
  try { files = fs.readdirSync(providersDir(ctx)); } catch (e) { return []; }
  return files.filter(function (f) { return f.length > 5 && f.slice(-5) === '.json' && f[0] !== '.'; })
    .map(function (f) { return f.slice(0, -5); }).sort();
}
function read(ctx, name) {
  try { return JSON.parse(fs.readFileSync(metaPath(ctx, name), 'utf8')); } catch (e) { return null; }
}
function exists(ctx, name) { try { return fs.existsSync(metaPath(ctx, name)); } catch (e) { return false; } }

function readActive(ctx) {
  try { return JSON.parse(fs.readFileSync(activePath(ctx), 'utf8')); } catch (e) { return null; }
}

// Create/update a provider profile. `key` goes to the credential store; meta
// (secret-free) to disk. authScheme: 'bearer' (ANTHROPIC_AUTH_TOKEN) | 'api-key'.
function add(ctx, name, opts) {
  if (!profiles.isValidName(name)) throw new Error("invalid provider name: '" + name + "'");
  opts = opts || {};
  if (!opts.baseUrl) throw new Error('a provider needs --base-url');
  fs.mkdirSync(providersDir(ctx), { recursive: true });
  const meta = {
    name: name,
    baseUrl: opts.baseUrl,
    authScheme: opts.authScheme === 'api-key' ? 'api-key' : 'bearer',
    models: opts.models || {},
    endpointCandidates: opts.endpointCandidates && opts.endpointCandidates.length ? opts.endpointCandidates : [opts.baseUrl],
    savedAt: ctx.now(),
    schemaVersion: 1,
  };
  writeJsonStable(metaPath(ctx, name), meta, 0o600);
  if (opts.key) ctx.store.setProfile(keyStoreName(name), opts.key);
  return meta;
}

function remove(ctx, name) {
  try { fs.rmSync(metaPath(ctx, name), { force: true }); } catch (e) { /* ignore */ }
  try { ctx.store.delProfile(keyStoreName(name)); } catch (e) { /* ignore */ }
  const a = readActive(ctx);
  if (a && a.name === name) { try { fs.rmSync(activePath(ctx), { force: true }); } catch (e) { /* ignore */ } }
}

// Build the managed env block for a provider (with its stored key).
function envFor(ctx, meta) {
  const env = {};
  env[BASE_URL_KEY] = meta.baseUrl;
  let key = null;
  try { key = ctx.store.getProfile(keyStoreName(meta.name)); } catch (e) { key = null; }
  if (key) env[meta.authScheme === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'] = key;
  Object.keys(MODEL_KEYS).forEach(function (m) {
    if (meta.models && meta.models[m]) env[MODEL_KEYS[m]] = meta.models[m];
  });
  return env;
}

const ALL_MANAGED = [BASE_URL_KEY].concat(AUTH_KEYS).concat(Object.keys(MODEL_KEYS).map(function (m) { return MODEL_KEYS[m]; }));

// Switch Claude Code to provider <name>: inject the managed env keys into
// settings.json (preserving every other key), record what we injected.
function use(ctx, name) {
  const meta = read(ctx, name);
  if (!meta) throw new Error("no such provider: '" + name + "' (see: keyflip provider list)");
  const file = ctx.claudeSettingsPath;
  return txn.withRollback([file, activePath(ctx)], function () {
    const cfg = settings.read(file); // throws (rolled back) if settings.json is corrupt
    const prevEnv = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
    // Start from the user's env minus ALL previously-managed keys (clean slate
    // for the managed set), then layer this provider's managed env on top.
    const userEnv = {};
    Object.keys(prevEnv).forEach(function (k) { if (ALL_MANAGED.indexOf(k) === -1) userEnv[k] = prevEnv[k]; });
    const managed = envFor(ctx, meta);
    cfg.env = Object.assign(userEnv, managed);
    writeJsonStable(file, cfg, 0o600);
    writeJsonStable(activePath(ctx), { name: name, envKeys: Object.keys(managed), at: ctx.now() }, 0o600);
    return { name: name, baseUrl: meta.baseUrl, injected: Object.keys(managed) };
  });
}

// Back to the built-in Anthropic OAuth login: remove exactly the env keys we
// injected (so the OAuth credential applies again). No restart needed.
function useOfficial(ctx) {
  const active = readActive(ctx);
  const file = ctx.claudeSettingsPath;
  return txn.withRollback([file, activePath(ctx)], function () {
    const cfg = settings.read(file);
    if (cfg.env && typeof cfg.env === 'object') {
      // Remove our recorded keys; fall back to the full managed set if no record.
      const toRemove = (active && active.envKeys) ? active.envKeys : ALL_MANAGED;
      toRemove.forEach(function (k) { delete cfg.env[k]; });
      if (!Object.keys(cfg.env).length) delete cfg.env;
      writeJsonStable(file, cfg, 0o600);
    }
    try { fs.rmSync(activePath(ctx), { force: true }); } catch (e) { /* ignore */ }
    return { name: 'official' };
  });
}

// #14 speedtest: time an HTTPS request to each candidate; set the fastest as the
// active baseUrl. Buckets: <500 good / <1000 fair / else slow. Injectable clock+fetch.
async function speedtest(ctx, name, opts) {
  opts = opts || {};
  const meta = read(ctx, name);
  if (!meta) throw new Error("no such provider: '" + name + "'");
  const candidates = (meta.endpointCandidates && meta.endpointCandidates.length) ? meta.endpointCandidates : [meta.baseUrl];
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const clock = opts.clock || function () { return Date.now(); };
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    let ms = null, ok = false;
    if (doFetch) {
      const t0 = clock();
      try {
        // ANY HTTP response = reachable (even 401/404); only network errors fail.
        await doFetch(url, { method: 'GET', signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 8000) : undefined });
        ms = clock() - t0; ok = true;
      } catch (e) { ms = null; ok = false; }
    }
    results.push({ url: url, ms: ms, ok: ok, bucket: ms == null ? 'unreachable' : (ms < 500 ? 'good' : (ms < 1000 ? 'fair' : 'slow')) });
  }
  const reachable = results.filter(function (r) { return r.ok; }).sort(function (a, b) { return a.ms - b.ms; });
  const fastest = reachable.length ? reachable[0].url : null;
  let chosen = null, persisted = false;
  // opts.noPersist = rank only, never mutate meta.baseUrl (the read-only MCP diagnostic uses this).
  if (reachable.length && fastest !== meta.baseUrl && !opts.noPersist) {
    meta.baseUrl = fastest;
    writeJsonStable(metaPath(ctx, name), meta, 0o600);
    chosen = fastest; persisted = true;
    // if this provider is active, re-apply so the new base_url takes effect
    const active = readActive(ctx);
    if (active && active.name === name) use(ctx, name);
  } else if (reachable.length) {
    chosen = fastest;
  }
  return { results: results, chosen: chosen, fastest: fastest, persisted: persisted };
}

export { providersDir, metaPath, activePath, list, read, exists, readActive, add, remove, use, useOfficial, envFor, speedtest, MODEL_KEYS, ALL_MANAGED };