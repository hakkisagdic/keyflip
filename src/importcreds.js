// IMPORT credentials from a .env file or the process ENVIRONMENT into keyflip
// provider profiles (env-import). Two pure steps, then glue:
//   parseEnv(text)  -> a null-prototype { KEY: VALUE } map (dotenv-ish: quotes,
//                      `export ` prefix, comments, blank lines; malformed ignored)
//   detect(vars)    -> draft PROVIDER candidates from known credential shapes
//                      (Anthropic base+token/key, a bare Anthropic key, OpenAI)
//   fromFile/fromEnv-> read a source, return { candidates }
//   apply           -> persist each candidate via provider.add (the only mutation)
// Security: this module writes NOTHING itself and NEVER echoes a key. Every summary
// REDACTS the key; the real key lives ONLY on the candidate object the caller hands
// to provider.add (which routes it into ctx.store, not onto disk/argv/logs).
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import * as _provider from './provider.js';

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

// A dotenv KEY must be a shell-ish identifier; anything else is malformed.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Parse dotenv text into a null-prototype map. A null prototype means a hostile
// `__proto__=…` / `constructor=…` line lands as a plain own key and can NEVER
// pollute Object.prototype. Duplicate keys: last assignment wins. Malformed lines
// (no '=', empty/invalid key, unterminated quote) are silently ignored.
function parseEnv(text) {
  const out = Object.create(null);
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line == null) continue;
    line = line.replace(/^[ \t]+/, ''); // leading whitespace
    if (line === '' || line[0] === '#') continue; // blank / comment line
    line = line.replace(/^export[ \t]+/, ''); // optional `export ` prefix
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no '=' (or empty key before it) -> malformed
    const key = line.slice(0, eq).replace(/[ \t]+$/, '');
    if (!KEY_RE.test(key)) continue; // malformed key
    const parsed = parseValue(line.slice(eq + 1));
    if (parsed === null) continue; // unterminated quote -> malformed
    out[key] = parsed.value;
  }
  return out;
}

// Value after '='. Returns { value } or null (malformed). Double quotes interpret
// \n \r \t \\ \"; single quotes are literal; unquoted values honour an inline
// `<space>#…` comment and a leading '#' means an empty (all-comment) value.
function parseValue(raw) {
  const s = String(raw).replace(/^[ \t]+/, ''); // strip spaces just after '='
  const q = s[0];
  if (q === '"' || q === "'") {
    let buf = '', closed = false;
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (q === '"' && c === '\\' && i + 1 < s.length) {
        const n = s[++i];
        buf += (n === 'n') ? '\n' : (n === 't') ? '\t' : (n === 'r') ? '\r' : n; // \\ \" -> literal char
        continue;
      }
      if (c === q) { closed = true; break; }
      buf += c;
    }
    if (!closed) return null; // unterminated quote
    return { value: buf }; // any trailing text after the closing quote is ignored
  }
  if (s === '' || s[0] === '#') return { value: '' }; // empty / whole-value comment
  const m = s.search(/[ \t]#/); // inline comment starts at first whitespace-then-#
  return { value: (m === -1 ? s : s.slice(0, m)).replace(/[ \t]+$/, '') };
}

// Read one var as a trimmed non-empty string, or null. hasOwnProperty via the
// prototype guards against a null-proto map AND against inherited props on a real
// process.env-like object.
function pick(vars, k) {
  if (!vars || typeof vars !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(vars, k)) return null;
  const v = vars[k];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

// A provider name derived from user input must pass profiles.isValidName (it keys
// <configDir>/providers/<name>.json), else fall back.
function safeName(candidate, fallback) {
  const n = String(candidate || '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-')
    .replace(/^[-.]+/, '').replace(/[.-]+$/, '');
  return profiles.isValidName(n) ? n : fallback;
}
function nameFromUrl(u, fallback) {
  let host = '';
  try { host = new URL(u).hostname; } catch (e) { host = ''; }
  return safeName(host, fallback);
}

// Recognise credential shapes -> draft provider candidates. Each candidate carries
// the REAL key (for the caller to hand to provider.add) plus non-secret provenance
// (vendor, envKeys). Never mutates anything.
function detect(vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];
  const out = [];
  const aBase = pick(vars, 'ANTHROPIC_BASE_URL');
  const aTok = pick(vars, 'ANTHROPIC_AUTH_TOKEN');
  const aKey = pick(vars, 'ANTHROPIC_API_KEY');

  if (aBase && (aTok || aKey)) {
    // Custom Anthropic endpoint: a bearer AUTH_TOKEN wins over a plain API_KEY.
    const bearer = !!aTok;
    out.push({
      kind: 'provider', vendor: 'anthropic',
      name: nameFromUrl(aBase, 'anthropic'),
      baseUrl: aBase,
      authScheme: bearer ? 'bearer' : 'api-key',
      key: bearer ? aTok : aKey,
      envKeys: ['ANTHROPIC_BASE_URL', bearer ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'],
    });
  } else if (aKey || aTok) {
    // A bare Anthropic credential with no custom base -> the official API endpoint.
    const bearer = !aKey && !!aTok; // prefer api-key semantics when a key is present
    out.push({
      kind: 'provider', vendor: 'anthropic',
      name: 'anthropic-key',
      baseUrl: ANTHROPIC_DEFAULT_BASE,
      authScheme: bearer ? 'bearer' : 'api-key',
      key: aKey || aTok,
      envKeys: [aKey ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'],
    });
  }

  const oKey = pick(vars, 'OPENAI_API_KEY');
  if (oKey) {
    const oBase = pick(vars, 'OPENAI_BASE_URL');
    out.push({
      kind: 'provider', vendor: 'openai',
      name: oBase ? nameFromUrl(oBase, 'openai') : 'openai',
      baseUrl: oBase || OPENAI_DEFAULT_BASE,
      authScheme: 'bearer', // OpenAI + OpenAI-compatible gateways use `Authorization: Bearer`
      key: oKey,
      envKeys: oBase ? ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] : ['OPENAI_API_KEY'],
    });
  }
  return out;
}

// A key redacted for display: reveals only its length, never any character. Used
// for EVERY summary so no path from this module can print a secret.
function redactKey(key) {
  if (typeof key !== 'string' || key === '') return '(none)';
  return '••••••••(' + key.length + ' chars)';
}

// Secret-free view of candidates (key redacted) — safe to print or return.
function summarize(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map(function (c) {
    return {
      kind: c.kind, vendor: c.vendor, name: c.name,
      baseUrl: c.baseUrl, authScheme: c.authScheme,
      key: redactKey(c.key), envKeys: c.envKeys || [],
    };
  });
}

// Read a .env file -> { path, candidates }. Throws a clear error if unreadable
// (a missing default ./.env is a user-facing message, not a silent empty import).
// Expands a leading '~/' against ctx.home.
function fromFile(ctx, filePath) {
  let p = filePath || '.env';
  if (p.slice(0, 2) === '~/' && ctx && ctx.home) p = path.join(ctx.home, p.slice(2));
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new Error('no env file at ' + p);
    throw new Error('cannot read env file ' + p + ': ' + e.message);
  }
  return { path: p, candidates: detect(parseEnv(text)) };
}

// Read the environment (defaults to process.env) -> { candidates }.
function fromEnv(ctx, env) {
  return { candidates: detect(env || (typeof process !== 'undefined' ? process.env : {})) };
}

// Persist each candidate as a provider: secret-free meta to <configDir>/providers,
// the key to ctx.store — all via provider.add (the sole mutation). opts.add is
// injectable so tests can drive it without touching the real provider module.
// Returns REDACTED summaries; the raw key never leaves this function.
function apply(ctx, candidates, opts) {
  opts = opts || {};
  const add = opts.add || _provider.add;
  const imported = [];
  (Array.isArray(candidates) ? candidates : []).forEach(function (c) {
    if (!c || c.kind !== 'provider' || !c.name || !c.baseUrl) return;
    add(ctx, c.name, { baseUrl: c.baseUrl, authScheme: c.authScheme, key: c.key });
    imported.push(summarize([c])[0]);
  });
  return { imported: imported };
}

export { parseEnv, detect, fromFile, fromEnv, apply, summarize, redactKey, ANTHROPIC_DEFAULT_BASE, OPENAI_DEFAULT_BASE };