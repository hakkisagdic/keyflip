// SETTINGS store (E4): one validated home for the toggles that were scattered
// across modules. State lives in <configDir>/config.json as a FLAT, namespaced
// key/value map (e.g. 'autoswitch.threshold'=90, 'notify.desktop'=true). A SCHEMA
// declares every KNOWN key — its type, default, bounds and help — so `set` can
// coerce CLI string input to a typed value and REJECT unknown keys, bad types and
// out-of-range values before anything touches disk. Other modules read their
// toggle through get(ctx, key) instead of re-reading raw files, so config.js is a
// single seam. A tampered/hand-edited file can never inject an unknown key, a
// dangerous type, or a prototype-polluting key: every map is Object.create(null)
// and every stored value is re-validated against the SCHEMA on read.
import path from 'path';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

const NAME = 'config'; // <configDir>/config.json — also profiles.RESERVED_FILES
const MAX_STRING = 1024; // cap a string value (anti-DoS / anti-garbage)
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/; // control chars (incl. ANSI ESC / newline) — refused in string values

// ---- SCHEMA: the set of KNOWN keys. Object.create(null) so a key can never
// collide with an inherited prototype property during a `key in SCHEMA` lookup.
// Each entry: { type:'int'|'bool'|'string'|'enum', default, min?, max?, values?, help }.
const SCHEMA = Object.create(null);
SCHEMA['autoswitch.threshold'] = {
  type: 'int',
  default: 90,
  min: 0,
  max: 100,
  help: 'Utilization % at/above which autoswitch rotates to another account.',
};
SCHEMA['autoswitch.strategy'] = {
  type: 'enum',
  values: ['best', 'next-available'],
  default: 'best',
  help: 'How autoswitch chooses the next account (most headroom vs. first available).',
};
SCHEMA['autoswitch.group'] = {
  type: 'string',
  default: '',
  help: 'Restrict autoswitch/rotation to accounts in this group tag (empty = all accounts).',
};
SCHEMA['notify.desktop'] = { type: 'bool', default: false, help: 'Show desktop banners on notable events (macOS).' };
// #35 threads. A thread is normally just POINTERS (session ids, chat uuids) — non-secret metadata that
// is git-versioned like the rest of keyflip's state. `threads.mirror` is the one switch that puts
// CONVERSATION TEXT on disk, which is why it defaults to off and why the mirror directory is
// registered in secretpaths.SECRET_DIRS (0600, never versioned, never backed up, never synced).
SCHEMA['threads.mirror'] = {
  type: 'bool',
  default: false,
  help: 'Let `keyflip threads mirror` write the merged conversation text to disk (off = pointers only).',
};
// Merging is the expensive part: real transcripts here run to 24 MB and a thread reads several at
// once, so the per-member read is capped. Bounded, because a "just read it all" knob invites an
// out-of-memory on a 2 GB paste.
SCHEMA['threads.mergeMaxMiB'] = {
  type: 'int',
  default: 8,
  min: 1,
  max: 512,
  help: 'Per-member transcript read cap (MiB) when merging a thread into one timeline.',
};
SCHEMA['ui.color'] = { type: 'bool', default: true, help: 'Colorize CLI output.' };
SCHEMA['usage.cacheTtlSeconds'] = {
  type: 'int',
  default: 60,
  min: 0,
  max: 3600,
  help: 'How long to cache per-account usage before refetching.',
};
// Where the BACKGROUND chores (dream / distill / recall --answer) compute their summaries. The
// default keeps `claude -p`, i.e. the subscription; the point of these keys is that a chore does NOT
// have to be paid for with plan quota. llm.key_env is the NAME of an env var, never a secret value.
SCHEMA['llm.provider'] = {
  type: 'enum',
  values: ['claude', 'ollama', 'openai'],
  default: 'claude',
  help: 'What runs headless summaries: claude -p (subscription quota), ollama (local), openai (any OpenAI-compatible endpoint).',
};
SCHEMA['llm.model'] = {
  type: 'string',
  default: '',
  help: 'Model name for llm.provider (empty = the provider default).',
};
SCHEMA['llm.base_url'] = {
  type: 'string',
  default: '',
  help: 'Endpoint base URL for llm.provider, e.g. http://127.0.0.1:11434/v1 or https://gateway/v1 (empty = provider default).',
};
SCHEMA['llm.key_env'] = {
  type: 'string',
  default: '',
  help: 'NAME of the environment variable holding the endpoint API key. keyflip stores the name only — never the key.',
};
// Failover proxy routing (#9/#10/#11). Cooldowns are per error KIND, so a brief
// overload parks an account for seconds while a billing block parks it for
// minutes; 0 disables that kind's cooldown. priority is a comma-separated list
// of account names tried before the LRU order.
SCHEMA['proxy.priority'] = {
  type: 'string',
  default: '',
  help: 'Comma-separated account names to try first in the failover proxy (empty = active, then least-recently-used).',
};
SCHEMA['proxy.maxWaitSeconds'] = {
  type: 'int',
  default: 10,
  min: 0,
  max: 120,
  help: 'Longest Retry-After the proxy will WAIT out and retry the same account before failing over (0 = always fail over).',
};
SCHEMA['proxy.debugHeaders'] = {
  type: 'bool',
  default: true,
  help: 'Add x-keyflip-account / x-keyflip-attempts / x-keyflip-failover headers to proxied responses.',
};
SCHEMA['proxy.cooldownQuotaSeconds'] = {
  type: 'int',
  default: 300,
  min: 0,
  max: 86400,
  help: 'Park a billing/quota-blocked account this long (seconds; 0 = no cooldown).',
};
SCHEMA['proxy.cooldownThrottledSeconds'] = {
  type: 'int',
  default: 60,
  min: 0,
  max: 3600,
  help: 'Park a rate-limited (429) account this long when upstream sends no Retry-After.',
};
SCHEMA['proxy.cooldownOverloadedSeconds'] = {
  type: 'int',
  default: 30,
  min: 0,
  max: 3600,
  help: 'Park an account after a 529 overloaded response this long.',
};
SCHEMA['proxy.cooldownAuthSeconds'] = {
  type: 'int',
  default: 900,
  min: 0,
  max: 86400,
  help: 'Park an account after a 401/403 auth failure this long (it needs a re-login).',
};
SCHEMA['proxy.cooldownServerSeconds'] = {
  type: 'int',
  default: 60,
  min: 0,
  max: 3600,
  help: 'Park an account after a 5xx server error this long.',
};

function configPath(ctx) {
  return path.join(ctx.configDir, NAME + '.json');
}
function hasKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(SCHEMA, key);
}
function schemaFor(key) {
  if (!hasKey(key)) throw new Error("unknown config key: '" + key + "' (see: keyflip config list)");
  return SCHEMA[key];
}

// Coerce a raw CLI STRING (or a native scalar) to the schema's typed value, or
// throw a human message. This is the single validation gate every write passes.
function coerce(schema, raw) {
  if (raw === null || raw === undefined) throw new Error('a value is required');
  const s = String(raw);
  if (schema.type === 'bool') {
    const t = s.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return true;
    if (t === 'false' || t === '0' || t === 'no' || t === 'off') return false;
    throw new Error("expected a boolean (true/false), got '" + s + "'");
  }
  if (schema.type === 'int') {
    const t = s.trim();
    if (!/^-?\d+$/.test(t)) throw new Error("expected an integer, got '" + s + "'");
    const n = parseInt(t, 10);
    if (!Number.isSafeInteger(n)) throw new Error("integer out of range: '" + s + "'");
    if (typeof schema.min === 'number' && n < schema.min)
      throw new Error('must be >= ' + schema.min + ' (got ' + n + ')');
    if (typeof schema.max === 'number' && n > schema.max)
      throw new Error('must be <= ' + schema.max + ' (got ' + n + ')');
    return n;
  }
  if (schema.type === 'enum') {
    const vals = schema.values || [];
    if (vals.indexOf(s) === -1) throw new Error('must be one of: ' + vals.join(', '));
    return s;
  }
  // string
  if (s.length > MAX_STRING) throw new Error('value too long (max ' + MAX_STRING + ' chars)');
  if (CTRL.test(s)) throw new Error('value contains control characters');
  return s;
}

// Is a NATIVE value read back from a (possibly tampered/hand-edited) file valid
// for its schema? Used by normalize() to DROP any stored override that no longer
// matches — so an out-of-range or wrong-typed value silently falls back to the
// default rather than poisoning a read.
function isValidStored(schema, value) {
  if (schema.type === 'bool') return typeof value === 'boolean';
  if (schema.type === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    if (typeof schema.min === 'number' && value < schema.min) return false;
    if (typeof schema.max === 'number' && value > schema.max) return false;
    return true;
  }
  if (schema.type === 'enum') return typeof value === 'string' && (schema.values || []).indexOf(value) !== -1;
  return typeof value === 'string' && value.length <= MAX_STRING && !CTRL.test(value);
}

// Coerce parsed JSON into a null-prototype { knownKey: validValue } map: unknown
// keys ('__proto__', typos, files' stray keys) and invalid values are dropped.
function normalize(parsed) {
  const out = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  Object.keys(parsed).forEach(function (key) {
    if (!hasKey(key)) return; // unknown key — never trusted
    if (isValidStored(SCHEMA[key], parsed[key])) out[key] = parsed[key];
  });
  return out;
}

// Guarded read (never throws): missing OR corrupt -> empty overrides. Returns the
// null-prototype map of STORED overrides only (not merged with defaults).
function readAll(ctx) {
  let parsed;
  try {
    parsed = readJsonForWrite(configPath(ctx));
  } catch (e) {
    return Object.create(null);
  }
  return normalize(parsed);
}

// Read-for-write: a MISSING file is empty, but a CORRUPT file THROWS so a
// read-modify-write never silently clobbers the user's real config.
function loadForWrite(ctx) {
  return normalize(readJsonForWrite(configPath(ctx)));
}

function save(ctx, map) {
  const out = {}; // key-sorted for stable diffs
  Object.keys(map)
    .sort()
    .forEach(function (k) {
      out[k] = map[k];
    });
  atomicWrite(configPath(ctx), JSON.stringify(out, null, 2), 0o600);
}

// get(ctx, key) -> the stored value if present (and valid), else the schema default.
function get(ctx, key) {
  const schema = schemaFor(key);
  const map = readAll(ctx);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : schema.default;
}

// getAll(ctx) -> the merged EFFECTIVE map: every known key with its stored value
// or its default. Null-prototype.
function getAll(ctx) {
  const map = readAll(ctx);
  const out = Object.create(null);
  Object.keys(SCHEMA).forEach(function (key) {
    out[key] = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : SCHEMA[key].default;
  });
  return out;
}

// set(ctx, key, rawValue) -> validate + coerce against the SCHEMA, persist, and
// return the coerced typed value. Rejects unknown key / bad type / out-of-range.
function set(ctx, key, rawValue) {
  const schema = schemaFor(key);
  const value = coerce(schema, rawValue);
  const map = loadForWrite(ctx); // throws (no write) if the file is corrupt
  map[key] = value;
  save(ctx, map);
  return value;
}

// unset(ctx, key) -> remove the override so the key reverts to its default.
// Returns whether an override was actually present. Rejects unknown key.
function unset(ctx, key) {
  schemaFor(key);
  const map = loadForWrite(ctx);
  const had = Object.prototype.hasOwnProperty.call(map, key);
  if (had) {
    delete map[key];
    save(ctx, map);
  }
  return had;
}

// describe() -> a fresh, safe COPY of the schema for help/introspection (mutating
// the result never touches the live SCHEMA). Null-prototype.
function describe() {
  const out = Object.create(null);
  Object.keys(SCHEMA).forEach(function (key) {
    const s = SCHEMA[key];
    const d = { type: s.type, default: s.default, help: s.help };
    if (typeof s.min === 'number') d.min = s.min;
    if (typeof s.max === 'number') d.max = s.max;
    if (s.values) d.values = s.values.slice();
    out[key] = d;
  });
  return out;
}

export { NAME, configPath, hasKey, coerce, get, getAll, set, unset, describe, readAll };
