// CodexBar bridge (ALIGN, don't depend). CodexBar (github.com/steipete/CodexBar, MIT) is a macOS
// menu-bar usage monitor with a JSON config at ~/.config/codexbar/config.json. keyflip does NOT
// require, spawn, or link against it — this module only READS the config that CodexBar left on disk
// so we can tell the user which providers each tool knows about. The two are complementary:
// CodexBar *monitors* usage, keyflip *manages* accounts. Everything here is best-effort and
// hermetic (home/env/readers injected via ctx) and NEVER surfaces a secret value: we scrub any
// api-key/token-shaped field before returning, and only ever expose provider IDs + non-secret bits.
import fs from 'fs';
import path from 'path';
import os from 'os';

// A key name that looks like it holds a credential. We drop these wholesale rather than trust
// CodexBar's schema — better to lose a harmless field than to leak a token.
// Credential-shaped field NAMES — note the bare canonical names (key/value/pin/pwd), the single
// most common way a per-provider token is stored, which a substring list would miss.
const SECRET_KEY_RE = /(api[-_ ]?key|secret|token|password|passwd|bearer|credential|auth|cookie|session[-_ ]?id|private[-_ ]?key|access[-_ ]?key|^key$|^val(?:ue)?$|^pin$|^pwd$)/i;
import * as secretscan from './secretscan.js';
import * as _provusage from './provusage.js';
import * as _surface from './surface.js';
// Refuse absurdly large configs (defends against reading a mis-pointed file into memory).
const MAX_BYTES = 1024 * 1024; // 1 MiB

// Env source is injectable so tests never touch the real process env.
function envOf(ctx) {
  return (ctx && ctx.env) || process.env || {};
}

// ~/.config/codexbar/config.json, honouring XDG_CONFIG_HOME (from ctx.env or process.env).
function configPath(ctx) {
  ctx = ctx || {};
  const env = envOf(ctx);
  const xdg = env.XDG_CONFIG_HOME;
  const base = (typeof xdg === 'string' && xdg) ? xdg : path.join(ctx.home || os.homedir(), '.config');
  return path.join(base, 'codexbar', 'config.json');
}

// Which OS are we on? Prefer the ctx-supplied platform so tests stay hermetic.
function platformOf(ctx) {
  return (ctx && ctx.platform) || os.platform();
}

// Best-effort, never-throws existence check.
function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

// detect -> { present, configPath, hasApp? }. `present` iff the config file exists. `hasApp` is a
// macOS-only best-effort check for the app bundle (omitted on other platforms).
function detect(ctx) {
  ctx = ctx || {};
  const cp = configPath(ctx);
  const out = { present: exists(cp), configPath: cp };
  if (platformOf(ctx) === 'darwin') {
    out.hasApp = exists('/Applications/CodexBar.app');
  }
  return out;
}

// Recursively copy `val`, dropping any secret-shaped key entirely. Depth-limited so a pathological
// config can't blow the stack. Returns a fresh, secret-free structure.
function scrub(val, depth) {
  if (depth > 8) return null;
  if (Array.isArray(val)) {
    return val.map(function (v) { return scrub(v, depth + 1); });
  }
  if (val && typeof val === 'object') {
    const out = {};
    const keys = Object.keys(val);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (SECRET_KEY_RE.test(k)) continue; // never carry a credential-shaped field forward
      out[k] = scrub(val[k], depth + 1);
    }
    return out;
  }
  // Defence in depth: mask any string VALUE that LOOKS like a real secret (a token under an
  // innocuous key, or a secret embedded in an array string) — catches what the key denylist can't.
  if (typeof val === 'string' && secretscan.looksSecret(val)) return secretscan.REDACTED;
  return val; // other primitives pass through
}

// readConfig -> the parsed, secret-scrubbed config object, or null. NEVER throws; a corrupt, huge,
// or missing file yields null. Any api-key/token-shaped field is stripped before returning.
function readConfig(ctx) {
  ctx = ctx || {};
  const cp = configPath(ctx);
  try {
    const st = fs.statSync(cp);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const raw = fs.readFileSync(cp, 'utf8');
    if (raw.length > MAX_BYTES) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return scrub(parsed, 0);
  } catch (e) {
    return null;
  }
}

// Normalize a provider entry into an id string (or null). Accepts a bare string id or an object
// with an id/name/provider field. Ignores anything else.
function idOf(entry) {
  if (typeof entry === 'string') { const s = entry.trim(); return s || null; }
  if (entry && typeof entry === 'object') {
    const cand = entry.id || entry.name || entry.provider || entry.slug;
    if (typeof cand === 'string' && cand.trim()) return cand.trim();
  }
  return null;
}

// True unless the entry is explicitly disabled (enabled:false / tracked:false / disabled:true).
function isEnabled(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (entry.enabled === false || entry.tracked === false || entry.disabled === true) return false;
  return true;
}

// Collect ids from a variety of container shapes: array of strings, array of objects, or an
// object map (id -> settings). Respects the enabled/tracked flag for object entries.
function collect(container) {
  const ids = [];
  if (Array.isArray(container)) {
    for (let i = 0; i < container.length; i++) {
      if (!isEnabled(container[i])) continue;
      const id = idOf(container[i]);
      if (id) ids.push(id);
    }
  } else if (container && typeof container === 'object') {
    const keys = Object.keys(container);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = container[k];
      if (v === false) continue;                 // { openai: false }
      if (!isEnabled(v)) continue;               // { openai: { enabled: false } }
      const s = String(k).trim();
      if (s) ids.push(s);
    }
  }
  return ids;
}

// trackedProviders -> array of provider id strings CodexBar is configured to watch. Best-effort
// across unknown shapes; returns [] on junk. Reads only the scrubbed config, so no secrets involved.
function trackedProviders(ctx) {
  const cfg = readConfig(ctx);
  if (!cfg || typeof cfg !== 'object') return [];
  // Look at the common places a monitor might list what it tracks, in priority order.
  const containers = [
    cfg.trackedProviders, cfg.tracked, cfg.enabledProviders,
    cfg.providers, cfg.services, cfg.monitors, cfg.usage,
  ];
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < containers.length; i++) {
    const ids = collect(containers[i]);
    for (let j = 0; j < ids.length; j++) {
      const id = ids[j];
      if (!seen[id]) { seen[id] = true; out.push(id); }
    }
  }
  return out;
}

// Pull provider ids out of a keyflip registry (provusage.PROVIDERS / surface.SURFACES): each is an
// array of specs carrying an `.id`.
function registryIds(mod, listKey) {
  const list = mod && mod[listKey];
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const id = list[i] && list[i].id;
    if (typeof id === 'string' && id) out.push(id);
  }
  return out;
}

// align -> an informational comparison of what CodexBar tracks vs what keyflip can read. keyflip's
// side is the union of provider ids from the provusage registry and the surface registry (both
// injectable via deps for tests). This is purely to show which providers each tool knows about.
function align(ctx, deps) {
  deps = deps || {};
  const provusage = deps.provusage || _provusage;
  const surface = deps.surface || _surface;

  const cbList = trackedProviders(ctx);
  const kfSet = Object.create(null);
  const kf = [];
  registryIds(provusage, 'PROVIDERS').concat(registryIds(surface, 'SURFACES')).forEach(function (id) {
    if (!kfSet[id]) { kfSet[id] = true; kf.push(id); }
  });

  const cbSet = Object.create(null);
  cbList.forEach(function (id) { cbSet[id] = true; });

  const both = [];
  const onlyCodexbar = [];
  const onlyKeyflip = [];
  cbList.forEach(function (id) { (kfSet[id] ? both : onlyCodexbar).push(id); });
  kf.forEach(function (id) { if (!cbSet[id]) onlyKeyflip.push(id); });

  return {
    codexbar: cbList,
    keyflip: kf,
    both: both,
    onlyCodexbar: onlyCodexbar,
    onlyKeyflip: onlyKeyflip,
  };
}

export { configPath, detect, readConfig, trackedProviders, align };