'use strict';
// Secret SCANNER / REDACTOR — the "never carry a secret" net that every outbound
// or versioned surface runs text through (router prompts, checkpoints, rules,
// project context, brain/Gemini payloads, agent config carry, ctx sync, codexbar).
//
// Two complementary strategies:
//   1. SHAPE  — SECRET_PATTERNS match known token formats (sk-ant-…, AKIA…, JWTs,
//      PEM private-key blocks, …) anywhere in free text.
//   2. KEY    — isCredentialKey() flags a config KEY name (password/token/secret/…)
//      so its value is dropped even when the value itself has no tell-tale shape.
//      isEnvRefOrEmpty() spares placeholders (`${FOO}`, "", <your-key>) from redaction.
//
// Redaction always errs BROAD: a false-positive redaction is harmless, a missed
// secret is a leak. Paths to secret FILES live in secretpaths.js — different concern.

const REDACTED = '«REDACTED»';

// Known secret SHAPES. Each entry is { re }, consumed as new RegExp(re.source, 'g').
const SECRET_PATTERNS = [
  { re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ }, // PEM private key block
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/ },                 // Anthropic API key (incl. sk-ant-api03-…, admin)
  { re: /sk-(?:proj|live|test)?-?[A-Za-z0-9]{20,}/ },  // OpenAI / Stripe-ish sk- keys
  { re: /rk_(?:live|test)_[A-Za-z0-9]{16,}/ },         // Stripe restricted key
  { re: /AKIA[0-9A-Z]{16}/ },                          // AWS access key id
  { re: /ASIA[0-9A-Z]{16}/ },                          // AWS temp access key id
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/ },                // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  { re: /github_pat_[A-Za-z0-9_]{40,}/ },              // GitHub fine-grained PAT
  { re: /glpat-[A-Za-z0-9_-]{18,}/ },                  // GitLab PAT
  { re: /AIza[0-9A-Za-z_-]{35}/ },                     // Google API key
  { re: /ya29\.[0-9A-Za-z_-]{20,}/ },                  // Google OAuth access token
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },              // Slack token
  { re: /npm_[A-Za-z0-9]{36}/ },                       // npm token
  { re: /dop_v1_[a-f0-9]{64}/ },                       // DigitalOcean token
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ }, // JWT (header.payload.sig)
  { re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/ },    // Authorization: Bearer <token>
  { re: /\b[0-9a-fA-F]{40,}\b/ },                      // long hex secret (sha/hmac/hex token)
];

const CRED_KEY = /(pass(word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key|auth(oriz\w*)?|bearer|credential|priv(ate)?[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?(key|token|id)|cookie|otp|mfa|signing[_-]?key)/i;
// Names that LOOK credential-ish but are safe (public material / identifiers).
const CRED_KEY_ALLOW = /^(public[_-]?key|pub[_-]?key|key[_-]?id|token[_-]?type|token[_-]?url|auth[_-]?url|secret[_-]?name|key[_-]?name)$/i;

function isCredentialKey(key) {
  if (key == null) return false;
  const k = String(key).trim().replace(/^["'\[]+|["'\]]+$/g, '');
  if (CRED_KEY_ALLOW.test(k)) return false;
  return CRED_KEY.test(k);
}

// A value that is empty, a placeholder, or an env-var reference — NOT a real secret.
function isEnvRefOrEmpty(val) {
  if (val == null) return true;
  const v = String(val).trim().replace(/^["']|["']$/g, '').trim();
  if (v === '') return true;
  if (v === REDACTED) return true;
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) return true;   // $FOO / ${FOO}
  if (/^%[A-Za-z0-9_]+%$/.test(v)) return true;                    // %FOO% (windows)
  if (/^process\.env\.[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true;
  if (/^<[^>]*>$/.test(v)) return true;                            // <your-key-here>
  if (/^(null|undefined|none|changeme|todo|x{3,}|\*{3,}|\.{3,})$/i.test(v)) return true;
  return false;
}

// Does a raw VALUE look like a secret? (shape match, or a long high-entropy token)
function looksSecret(val) {
  if (typeof val !== 'string') return false;
  const v = val.trim();
  if (v.length < 12) return false;
  if (isEnvRefOrEmpty(v)) return false;
  for (const p of SECRET_PATTERNS) { if (new RegExp(p.re.source).test(v)) return true; }
  // entropy heuristic: one unbroken token, long, mixed classes or clearly base64/hex.
  if (/\s/.test(v)) return false;
  if (/^[A-Za-z0-9_\-+/=.]{24,}$/.test(v)) {
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_\-+/=.]/].filter(function (r) { return r.test(v); }).length;
    if (classes >= 3) return true;
    if (/^[A-Fa-f0-9]{32,}$/.test(v)) return true;          // pure hex
    if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(v)) return true;  // pure base64
  }
  return false;
}

// Replace every known secret SHAPE in a string. Returns { text, count }.
function redactShapes(s) {
  let out = String(s == null ? '' : s);
  let count = 0;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(new RegExp(p.re.source, 'g'), function () { count++; return REDACTED; });
  }
  return { text: out, count: count };
}

// Line-oriented KEY redaction: `key: value` / `key = value` where the key is
// credential-shaped and the value is a real (non-placeholder) secret.
function redactLines(s) {
  const src = String(s == null ? '' : s);
  let count = 0;
  const lines = src.split('\n').map(function (line) {
    const m = line.match(/^(\s*[-*]?\s*)(["']?[A-Za-z0-9_.\-\[\]]+["']?)(\s*[:=]\s*)(.+?)(\s*,?\s*)$/);
    if (!m) return line;
    const key = m[2].replace(/^["']|["']$/g, '');
    const rawVal = m[4];
    if (isCredentialKey(key) && !isEnvRefOrEmpty(rawVal)) {
      count++;
      const q = /^["']/.test(rawVal) ? rawVal.slice(0, 1) : '';
      return m[1] + m[2] + m[3] + q + REDACTED + q + m[5];
    }
    return line;
  });
  return { text: lines.join('\n'), count: count };
}

// Redact a single value in the context of its (optional) key.
function redactValue(key, val) {
  if (typeof val !== 'string') return val;
  if (key != null && isCredentialKey(key) && !isEnvRefOrEmpty(val)) return REDACTED;
  if (looksSecret(val)) return REDACTED;
  return redactShapes(val).text;
}

// Deep-redact a parsed JS value; mutates counter.n. Returns the redacted COPY.
function deepRedact(value, key, counter) {
  if (Array.isArray(value)) return value.map(function (v) { return deepRedact(v, null, counter); });
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepRedact(value[k], k, counter);
    return out;
  }
  if (typeof value === 'string') {
    if (key != null && isCredentialKey(key) && !isEnvRefOrEmpty(value)) { counter.n++; return REDACTED; }
    if (looksSecret(value)) { counter.n++; return REDACTED; }
    const r = redactShapes(value); counter.n += r.count; return r.text;
  }
  return value;
}

// Redact a JSON STRING. Returns { text, count } or null if not parseable JSON.
function redactJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return null; }
  const counter = { n: 0 };
  const red = deepRedact(parsed, null, counter);
  return { text: JSON.stringify(red, null, 2), count: counter.n };
}

// Redact arbitrary config TEXT: JSON if it parses, else `key=value`/`key: value`
// lines plus a shape sweep. Returns { text, count }.
function redactConfig(text) {
  const s = String(text == null ? '' : text);
  const trimmed = s.trim();
  if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
    const j = redactJson(s);
    if (j) return j;
  }
  const lined = redactLines(s);
  const shaped = redactShapes(lined.text);
  return { text: shaped.text, count: lined.count + shaped.count };
}

module.exports = {
  REDACTED: REDACTED,
  SECRET_PATTERNS: SECRET_PATTERNS,
  isCredentialKey: isCredentialKey,
  isEnvRefOrEmpty: isEnvRefOrEmpty,
  looksSecret: looksSecret,
  redactValue: redactValue,
  redactLines: redactLines,
  redactJson: redactJson,
  redactConfig: redactConfig,
};
