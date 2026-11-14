// R6 (§9): central secret redaction across logs, history events, notifications,
// CLI errors and failover probe reasons. Combines token-shape regexes with a
// process-local Set of currently loaded secrets registered at credential-store
// read/write time.
import { isCredentialKey, isEnvRefOrEmpty } from './secretscan.js';

const REDACTED = '[REDACTED]';
const MIN_REGISTERED_LEN = 6;
const loadedSecrets = new Set();
let sortedSecretsCache = null;

const STRICT_SECRET_FIELD =
  /^(access_?token|refresh_?token|api_?key|auth_?token|session_?key|authorization|password|passphrase|secret|bearer|cookie|credential)$/i;

function addLiteralSecret(val) {
  if (typeof val !== 'string') return;
  const s = val.trim();
  if (s.length < MIN_REGISTERED_LEN || s === REDACTED || isEnvRefOrEmpty(s)) return;
  if (!loadedSecrets.has(s)) {
    loadedSecrets.add(s);
    sortedSecretsCache = null;
  }
}

function collectSecretsFromObject(node, depth) {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length && i < 500; i++) {
      const item = node[i];
      if (item && typeof item === 'object' && typeof item.name === 'string' && typeof item.value === 'string') {
        if (isCredentialKey(item.name)) addLiteralSecret(item.value);
      }
      collectSecretsFromObject(item, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') return;
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length && i < 500; i++) {
    const k = keys[i];
    const v = node[k];
    if (typeof v === 'string') {
      if (isCredentialKey(k) || /^(sk-ant-|ks_|sessionKey[-_])/.test(v.trim())) {
        addLiteralSecret(v);
      }
    } else if (v && typeof v === 'object') {
      collectSecretsFromObject(v, depth + 1);
    }
  }
}

// Register a store value (raw token or JSON credential blob) in the process-local
// Set and return `raw` unchanged so callers can wrap reads inline.
function registerSecret(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const first = trimmed[0];
  if (first === '{' || first === '[') {
    try {
      const parsed = JSON.parse(trimmed);
      collectSecretsFromObject(parsed, 0);
      return raw;
    } catch {
      // Not valid JSON; treat as plain secret string below.
    }
  }
  addLiteralSecret(trimmed);
  return raw;
}

function getSortedSecrets() {
  if (!sortedSecretsCache) {
    sortedSecretsCache = Array.from(loadedSecrets).sort(function (a, b) {
      return b.length - a.length;
    });
  }
  return sortedSecretsCache;
}

function clearSecrets() {
  loadedSecrets.clear();
  sortedSecretsCache = null;
}

// Redact secrets in a string. Non-string values pass through unchanged.
function redact(input) {
  if (typeof input !== 'string' || !input) return input;
  let s = input;

  // 1) Exact match against any secret currently loaded from a credential store.
  const secrets = getSortedSecrets();
  for (let i = 0; i < secrets.length; i++) {
    const sec = secrets[i];
    if (s.indexOf(sec) !== -1) s = s.split(sec).join(REDACTED);
  }

  // 2) Authorization header / JSON field values.
  s = s.replace(/("authorization"\s*:\s*")([^"]*)(")/gi, '$1' + REDACTED + '$3');
  s = s.replace(
    /(\bAuthorization\s*:\s*)(?:(?:Bearer|Basic|Token)\s+)?(?!\[REDACTED\])([^\s"',;}\]\r\n]+)/gi,
    '$1' + REDACTED,
  );

  // 3) Bearer <token> (preserve plain English prose like "Bearer token" / "bearer from").
  s = s.replace(
    /\bBearer\s+(?!\[REDACTED\])(?!(?:tokens?|auth(?:entication)?|schemes?|headers?|keys?|credentials?|from)\b)([A-Za-z0-9._~+/=-]{3,})/g,
    'Bearer ' + REDACTED,
  );
  s = s.replace(
    /\bbearer\s+(?!\[REDACTED\])([A-Za-z0-9._~+/=-]*[0-9_-][A-Za-z0-9._~+/=-]{2,}|[A-Za-z0-9._~+/=-]{16,})/gi,
    'Bearer ' + REDACTED,
  );

  // 4) Anthropic keys (`sk-ant-...`), keysmith keys (`ks_...`), OpenAI-style keys, JWTs.
  s = s.replace(/\bsk-ant-[A-Za-z0-9_-]{3,}/g, REDACTED);
  s = s.replace(/\bks_[A-Za-z0-9_-]{3,}/g, REDACTED);
  s = s.replace(/\bsk-(?:proj|live|test)-[A-Za-z0-9_-]{12,}/g, REDACTED);
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED);

  // 5) sessionKey cookies, JSON fields, key=value pairs, and fixture tokens (`sessionKey-...`).
  s = s.replace(/("sessionKey"\s*:\s*")([^"]*)(")/gi, '$1' + REDACTED + '$3');
  s = s.replace(/(\bsessionKey\s*=\s*)(?!\[REDACTED\])([^\s;"',}&\]\r\n]+)/gi, '$1' + REDACTED);
  s = s.replace(/(\bsessionKey\s*:\s*)(?!\[REDACTED\])([^\s;"',}\]\r\n]+)/gi, '$1' + REDACTED);
  s = s.replace(/\bsessionKey[-_][A-Za-z0-9._-]+/g, REDACTED);

  return s;
}

// Recursively redact strings inside plain objects/arrays without mutating caller data.
function redactDeep(value, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redact(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return undefined;
  if (d >= 6) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const arr = [];
    const lim = Math.min(value.length, 1000);
    for (let i = 0; i < lim; i++) {
      arr.push(redactDeep(value[i], d + 1));
    }
    return arr;
  }
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    const rawVal = value[k];
    if (STRICT_SECRET_FIELD.test(k) && typeof rawVal === 'string' && rawVal) {
      out[k] = REDACTED;
      continue;
    }
    const c = redactDeep(rawVal, d + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export { redact, redactDeep, registerSecret, clearSecrets, REDACTED };
