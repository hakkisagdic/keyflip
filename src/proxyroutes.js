// Declarative proxy routing (#4–#8, #19): <configDir>/proxy-routes.json.
//
// The failover proxy already knows WHICH accounts are usable (#9/#11). This
// module decides which one a given REQUEST should prefer, and what the request
// should look like when it leaves:
//
//   * rules    — first match wins; `when` can look at the model, the path, a
//                header, the estimated input size and the conversation's user id.
//   * sticky   — the same conversation (metadata.user_id) keeps its account for
//                a TTL, in-process; a success refreshes the assignment.
//   * custom   — CUSTOM_ROUTER_PATH (or `customRouter` in the file) is an
//                asynchronous helper script that may pick an account itself.
//   * fallback — `off` (never fail over), `retry` (current behaviour) or
//                `model-chain` (degrade to the next model before another account).
//   * transforms — bounded header/body rewrites (set/remove headers, override the
//                model, cap max_tokens). The body is only touched when it parses
//                as JSON; otherwise the request is forwarded unchanged.
//
// The file is user-editable, so validation is strict and every problem is
// returned as a message instead of throwing on the proxy's hot path. A hot
// reload keys off mtime+size: editing the file applies to the NEXT request, no
// restart. This module never stores or logs a secret; it only reads the request.
import fs from 'fs';
import os from 'os';
import path from 'path';
import _child_process from 'child_process';

const FILE_NAME = 'proxy-routes.json';
const STICKY_MAX = 1000;
const HOOK_TIMEOUT_MS = 1500;
const HOOK_MAX_OUTPUT = 64 * 1024;

const FALLBACKS = ['off', 'retry', 'model-chain'];
const TOP_KEYS = ['version', 'fallback', 'sticky', 'modelChain', 'rules', 'transforms', 'customRouter', 'note'];
const WHEN_KEYS = ['model', 'path', 'header', 'tokensGt', 'account', 'user'];
const USE_KEYS = ['account', 'model'];
const TRANSFORM_KEYS = ['setHeaders', 'removeHeaders', 'bodyModel', 'maxTokens'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@-]*$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED = ['__proto__', 'prototype', 'constructor'];

function isModel(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 200 && MODEL_RE.test(s) && RESERVED.indexOf(s) === -1;
}
function isHeaderName(s) {
  return typeof s === 'string' && HEADER_RE.test(s) && RESERVED.indexOf(s.toLowerCase()) === -1;
}

function defaults() {
  return {
    version: 1,
    fallback: 'retry',
    sticky: { enabled: true, ttlSeconds: 1800 },
    modelChain: [],
    rules: [],
    transforms: { setHeaders: {}, removeHeaders: [], bodyModel: null, maxTokens: null },
    customRouter: '',
  };
}

function routesPath(ctx) {
  return path.join(ctx.configDir, FILE_NAME);
}

// Compile a glob ('*' = any run, '?' = one char) into an anchored RegExp. The
// rest is escaped, so a model id or header value can never inject a pattern.
function globRe(pattern) {
  const s = String(pattern);
  let out = '^';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
function asGlob(v) {
  return v instanceof RegExp ? v : globRe(v);
}

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.indexOf('~/') === 0) return path.join(os.homedir(), s.slice(2));
  return s;
}

// Validate a hand-edited file. Every rejected member is named, and the caller
// decides what to do with an invalid file (the proxy ignores it and says so).
function validate(parsed) {
  const errors = [];
  const out = defaults();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { routes: out, errors: ['the file must be a JSON object'] };
  }
  Object.keys(parsed).forEach(function (k) {
    if (TOP_KEYS.indexOf(k) === -1) errors.push('unknown key: ' + k);
  });
  if (parsed.version != null && parsed.version !== 1) errors.push('unsupported version: ' + parsed.version);
  if (parsed.fallback != null) {
    if (FALLBACKS.indexOf(parsed.fallback) === -1)
      errors.push('fallback must be one of ' + FALLBACKS.join('/') + ', got ' + JSON.stringify(parsed.fallback));
    else out.fallback = parsed.fallback;
  }
  if (parsed.sticky != null) {
    if (typeof parsed.sticky !== 'object' || Array.isArray(parsed.sticky)) errors.push('sticky must be an object');
    else {
      if (parsed.sticky.enabled != null) {
        if (typeof parsed.sticky.enabled !== 'boolean') errors.push('sticky.enabled must be true/false');
        else out.sticky.enabled = parsed.sticky.enabled;
      }
      if (parsed.sticky.ttlSeconds != null) {
        const n = parsed.sticky.ttlSeconds;
        if (!Number.isInteger(n) || n < 0 || n > 86400)
          errors.push('sticky.ttlSeconds must be an integer 0–86400 (0 disables it)');
        else out.sticky.ttlSeconds = n;
      }
      Object.keys(parsed.sticky).forEach(function (k) {
        if (['enabled', 'ttlSeconds'].indexOf(k) === -1) errors.push('unknown key: sticky.' + k);
      });
    }
  }
  if (parsed.modelChain != null) {
    if (!Array.isArray(parsed.modelChain)) errors.push('modelChain must be an array of model ids');
    else {
      parsed.modelChain.forEach(function (m, i) {
        if (!isModel(m)) errors.push('modelChain[' + i + '] is not a valid model id');
        else out.modelChain.push(m);
      });
    }
  }
  if (parsed.rules != null) {
    if (!Array.isArray(parsed.rules)) errors.push('rules must be an array');
    else {
      parsed.rules.forEach(function (r, i) {
        const at = 'rules[' + i + ']';
        if (!r || typeof r !== 'object' || Array.isArray(r)) return errors.push(at + ' must be an object');
        Object.keys(r).forEach(function (k) {
          if (['when', 'use', 'name'].indexOf(k) === -1) errors.push('unknown key: ' + at + '.' + k);
        });
        const when = r.when;
        if (!when || typeof when !== 'object' || Array.isArray(when) || !Object.keys(when).length)
          return errors.push(at + '.when must be a non-empty object');
        Object.keys(when).forEach(function (k) {
          if (WHEN_KEYS.indexOf(k) === -1) errors.push('unknown key: ' + at + '.when.' + k);
        });
        if (when.model != null && typeof when.model !== 'string') errors.push(at + '.when.model must be a string');
        if (when.path != null && typeof when.path !== 'string') errors.push(at + '.when.path must be a string');
        if (when.account != null && typeof when.account !== 'string')
          errors.push(at + '.when.account must be a string');
        if (when.user != null && typeof when.user !== 'string') errors.push(at + '.when.user must be a glob string');
        if (when.tokensGt != null && (!Number.isInteger(when.tokensGt) || when.tokensGt < 0))
          errors.push(at + '.when.tokensGt must be a non-negative integer');
        if (when.header != null) {
          if (typeof when.header !== 'object' || Array.isArray(when.header))
            errors.push(at + '.when.header must be an object of name → glob');
          else
            Object.keys(when.header).forEach(function (h) {
              if (!isHeaderName(h)) errors.push(at + '.when.header: invalid header name ' + h);
              else if (typeof when.header[h] !== 'string')
                errors.push(at + '.when.header.' + h + ' must be a glob string');
            });
        }
        const use = r.use;
        if (!use || typeof use !== 'object' || Array.isArray(use)) return errors.push(at + '.use must be an object');
        Object.keys(use).forEach(function (k) {
          if (USE_KEYS.indexOf(k) === -1) errors.push('unknown key: ' + at + '.use.' + k);
        });
        if (use.account == null && use.model == null) errors.push(at + '.use needs an account and/or a model');
        if (use.account != null && (typeof use.account !== 'string' || !use.account))
          errors.push(at + '.use.account must be an account name');
        if (use.model != null && !isModel(use.model)) errors.push(at + '.use.model is not a valid model id');
        if (
          !errors.some(function (e) {
            return e.indexOf(at + '.') === 0;
          })
        )
          out.rules.push({
            name: typeof r.name === 'string' ? r.name : null,
            when: when,
            use: use,
          });
      });
    }
  }
  if (parsed.transforms != null) {
    const t = parsed.transforms;
    if (typeof t !== 'object' || Array.isArray(t)) errors.push('transforms must be an object');
    else {
      Object.keys(t).forEach(function (k) {
        if (TRANSFORM_KEYS.indexOf(k) === -1) errors.push('unknown key: transforms.' + k);
      });
      if (t.setHeaders != null) {
        if (typeof t.setHeaders !== 'object' || Array.isArray(t.setHeaders))
          errors.push('transforms.setHeaders must be an object');
        else
          Object.keys(t.setHeaders).forEach(function (h) {
            if (!isHeaderName(h)) errors.push('transforms.setHeaders: invalid header name ' + h);
            else if (typeof t.setHeaders[h] !== 'string')
              errors.push('transforms.setHeaders.' + h + ' must be a string');
            else out.transforms.setHeaders[h] = t.setHeaders[h];
          });
      }
      if (t.removeHeaders != null) {
        if (!Array.isArray(t.removeHeaders)) errors.push('transforms.removeHeaders must be an array');
        else
          t.removeHeaders.forEach(function (h, i) {
            if (!isHeaderName(h)) errors.push('transforms.removeHeaders[' + i + ']: invalid header name ' + h);
            else out.transforms.removeHeaders.push(h);
          });
      }
      if (t.bodyModel != null) {
        if (!isModel(t.bodyModel)) errors.push('transforms.bodyModel is not a valid model id');
        else out.transforms.bodyModel = t.bodyModel;
      }
      if (t.maxTokens != null) {
        if (!Number.isInteger(t.maxTokens) || t.maxTokens < 1 || t.maxTokens > 200000)
          errors.push('transforms.maxTokens must be an integer 1–200000');
        else out.transforms.maxTokens = t.maxTokens;
      }
    }
  }
  if (parsed.customRouter != null) {
    if (typeof parsed.customRouter !== 'string') errors.push('customRouter must be a path');
    else out.customRouter = parsed.customRouter;
  }
  return { routes: out, errors: errors };
}

// mtime+size cache: an edit is picked up on the next request. A missing file is
// "not configured" (not an error); an unreadable/corrupt one is reported.
let cache = null; // {file, mtimeMs, size, exists, routes, errors, configured}

function load(ctx, opts) {
  opts = opts || {};
  const file = routesPath(ctx);
  let st = null;
  try {
    st = fs.statSync(file);
  } catch (e) {
    st = null;
  }
  if (
    !opts.reload &&
    cache &&
    cache.file === file &&
    ((st && cache.mtimeMs === st.mtimeMs && cache.size === st.size) || (!st && !cache.exists))
  )
    return cache;
  if (!st) {
    cache = { file: file, mtimeMs: null, size: null, exists: false, configured: false, routes: defaults(), errors: [] };
    return cache;
  }
  let parsed = null,
    errors = [];
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors = ['cannot read proxy-routes.json: ' + ((e && e.message) || 'invalid JSON')];
  }
  const v = parsed ? validate(parsed) : { routes: defaults(), errors: errors };
  cache = {
    file: file,
    mtimeMs: st.mtimeMs,
    size: st.size,
    exists: true,
    configured: true,
    routes: v.routes,
    errors: v.errors,
  };
  return cache;
}

// ---------------------------------------------------------------------------
// Request facts: model, size estimate, conversation key
// ---------------------------------------------------------------------------
function bodyJson(body) {
  if (!body || !body.length) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function modelOf(body) {
  const j = bodyJson(body);
  return j && typeof j.model === 'string' ? j.model : null;
}

function headerOf(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  const key = Object.keys(headers).find(function (k) {
    return k.toLowerCase() === want;
  });
  return key ? headers[key] : null;
}

// No-dependency input estimate: every text field we know about, ~4 chars/token,
// plus a small per-message overhead (role framing). Not a tokenizer — it exists
// so a rule can say "only huge requests" without shipping a BPE table.
function estimateTokens(body) {
  const j = bodyJson(body);
  if (!j) return body && body.length ? Math.ceil(body.length / 4) : 0;
  let chars = 0,
    msgs = 0;
  function addText(v) {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v))
      v.forEach(function (x) {
        if (x && typeof x === 'object') addText(x.text != null ? x.text : x.content);
        else addText(x);
      });
    else if (v && typeof v === 'object') {
      if (typeof v.text === 'string') chars += v.text.length;
      if (typeof v.content === 'string') chars += v.content.length;
      else if (Array.isArray(v.content)) addText(v.content);
      if (typeof v.input === 'object' && v.input) chars += JSON.stringify(v.input).length;
    }
  }
  if (j.system != null) addText(j.system);
  if (Array.isArray(j.messages))
    j.messages.forEach(function (m) {
      msgs++;
      if (m) addText(m.content);
    });
  return Math.ceil(chars / 4) + msgs * 4;
}

// A conversation is keyed by the user id Claude Code puts in metadata; a caller
// that does not send one can opt in with the x-keyflip-session header.
function userKeyOf(reqInfo) {
  const j = bodyJson(reqInfo && reqInfo.body);
  const fromBody = j && j.metadata && (j.metadata.user_id || j.metadata.session_id);
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  const h = headerOf(reqInfo && reqInfo.headers, 'x-keyflip-session');
  return typeof h === 'string' && h ? h : null;
}

// ---------------------------------------------------------------------------
// Sticky map (in-process; the proxy is one long-lived process)
// ---------------------------------------------------------------------------
const sticky = new Map(); // key -> { account, at }

function stickyGet(key, ttlMs, nowMs) {
  if (!key) return null;
  const e = sticky.get(key);
  if (!e) return null;
  if (ttlMs <= 0 || nowMs - e.at > ttlMs) {
    sticky.delete(key);
    return null;
  }
  return e.account;
}
function stickySet(key, account, ttlMs, nowMs) {
  if (!key || ttlMs <= 0) return false;
  if (!sticky.has(key) && sticky.size >= STICKY_MAX) {
    // oldest entry out; Map preserves insertion order
    const first = sticky.keys().next();
    if (!first.done) sticky.delete(first.value);
  }
  sticky.set(key, { account: account, at: nowMs });
  return true;
}
function stickyReset() {
  sticky.clear();
}
function stickySize() {
  return sticky.size;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
function matchWhen(when, facts) {
  if (when.model != null && !asGlob(when.model).test(facts.model || '')) return false;
  if (when.path != null && !asGlob(when.path).test(facts.path || '')) return false;
  if (when.account != null && facts.account !== when.account) return false;
  if (when.user != null && !asGlob(when.user).test(facts.user || '')) return false;
  if (when.tokensGt != null && !(facts.tokens > when.tokensGt)) return false;
  if (when.header) {
    const names = Object.keys(when.header);
    for (let i = 0; i < names.length; i++) {
      const v = headerOf(facts.headers, names[i]);
      if (v == null || !asGlob(when.header[names[i]]).test(String(v))) return false;
    }
  }
  return true;
}

function pickRule(routes, facts) {
  for (let i = 0; i < routes.rules.length; i++) {
    const r = routes.rules[i];
    if (matchWhen(r.when, facts)) {
      return {
        account: typeof r.use.account === 'string' ? r.use.account : null,
        model: typeof r.use.model === 'string' ? r.use.model : null,
        reason: 'rule #' + (i + 1) + (r.name ? ' (' + r.name + ')' : ''),
        ruleIndex: i,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transforms (bounded, body only when it is JSON)
// ---------------------------------------------------------------------------
function applyTransforms(reqInfo, routes) {
  const t = routes.transforms;
  const headers = Object.assign({}, reqInfo.headers || {});
  const notes = [];
  Object.keys(t.setHeaders).forEach(function (h) {
    headers[h] = t.setHeaders[h];
  });
  t.removeHeaders.forEach(function (h) {
    Object.keys(headers).forEach(function (k) {
      if (k.toLowerCase() === h.toLowerCase()) delete headers[k];
    });
  });
  let body = reqInfo.body;
  if (t.bodyModel || t.maxTokens) {
    const j = bodyJson(body);
    if (!j) {
      notes.push('body is not JSON — model/max_tokens transform skipped');
    } else {
      if (t.bodyModel) j.model = t.bodyModel;
      if (t.maxTokens && (!Number.isInteger(j.max_tokens) || j.max_tokens > t.maxTokens)) j.max_tokens = t.maxTokens;
      body = Buffer.from(JSON.stringify(j));
    }
  }
  return { info: Object.assign({}, reqInfo, { headers: headers, body: body }), notes: notes };
}

// Rewrite only the model (model-chain / a rule's use.model); keeps the rest of
// the body byte-identical apart from JSON re-serialization.
function withModel(body, model) {
  const j = bodyJson(body);
  if (!j) return null;
  j.model = model;
  return Buffer.from(JSON.stringify(j));
}

// ---------------------------------------------------------------------------
// Custom router hook (#19): async, bounded, cannot throw into the proxy
// ---------------------------------------------------------------------------
function hookCommand(configured) {
  const env = process.env.CUSTOM_ROUTER_PATH;
  if (env) return { cmd: expandHome(env), source: 'env' };
  if (configured) return { cmd: expandHome(configured), source: 'file' };
  return null;
}

function runCustomRouter(cmd, payload, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || HOOK_TIMEOUT_MS;
  const runner = /\.(c|m)?js$/.test(cmd) ? [process.execPath, cmd] : [cmd];
  return new Promise(function (resolve) {
    let done = false;
    let out = '';
    let child;
    function finish(r) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child && !child.killed) child.kill();
      } catch (e) {
        /* */
      }
      resolve(r);
    }
    const timer = setTimeout(function () {
      finish({ error: 'custom router timed out after ' + timeoutMs + 'ms' });
    }, timeoutMs);
    try {
      child = _child_process.spawn(runner[0], runner.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return finish({ error: 'custom router failed to start: ' + ((e && e.message) || e) });
    }
    child.on('error', function (e) {
      finish({ error: 'custom router failed to start: ' + ((e && e.message) || e) });
    });
    child.stdout.on('data', function (c) {
      out += c;
      if (out.length > HOOK_MAX_OUTPUT) finish({ error: 'custom router output too large' });
    });
    child.on('close', function (code) {
      if (code !== 0) return finish({ error: 'custom router exited with code ' + code });
      let j;
      try {
        j = JSON.parse(out);
      } catch (e) {
        return finish({ error: 'custom router printed no JSON' });
      }
      const account = j && typeof j.account === 'string' ? j.account : null;
      const model = j && typeof j.model === 'string' && isModel(j.model) ? j.model : null;
      finish({ account: account, model: model, reason: (j && j.reason) || 'custom router' });
    });
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch (e) {
      /* the close/error handler resolves */
    }
  });
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
// decide(routes, facts, {accounts, skipHook, hookPayload}) -> {
//   account, model, reason, hookError, matched }
// `accounts` is the proxy's usable list: a rule or hook may only name one of
// them. Anything else is reported and ignored (never overrides a cooldown).
async function decide(routes, facts, opts) {
  opts = opts || {};
  const usable = opts.accounts || [];
  const out = { account: null, model: null, reason: 'default order', hookError: null, matched: null };

  const rule = pickRule(routes, facts);
  if (rule) {
    out.matched = rule.reason;
    if (rule.account && usable.indexOf(rule.account) === -1) {
      out.reason = rule.reason + ' names "' + rule.account + '", which is not usable now';
    } else {
      out.account = rule.account;
      out.model = rule.model;
      out.reason = rule.reason;
      return out;
    }
  }

  const ttlMs = routes.sticky.ttlSeconds * 1000;
  const stuck = routes.sticky.enabled ? stickyGet(facts.user, ttlMs, opts.nowMs || Date.now()) : null;
  if (stuck && usable.indexOf(stuck) !== -1) {
    out.account = stuck;
    out.reason = 'sticky conversation -> ' + stuck;
    return out;
  }

  const hook = opts.skipHook ? null : hookCommand(routes.customRouter);
  if (hook) {
    const r = await runCustomRouter(
      hook.cmd,
      opts.hookPayload || {
        model: facts.model,
        path: facts.path,
        user: facts.user,
        tokens: facts.tokens,
        accounts: usable,
      },
      opts.hook,
    );
    if (r.error) out.hookError = r.error;
    else if (r.account && usable.indexOf(r.account) === -1)
      out.hookError = 'custom router chose "' + r.account + '", which is not usable';
    else {
      out.account = r.account;
      out.model = r.model;
      out.reason = r.reason + ' (' + hook.source + ')';
      return out;
    }
  }
  return out;
}

// Read-only description for `proxy routes` / MCP.
function describe(ctx) {
  const l = load(ctx);
  const hook = hookCommand(l.routes.customRouter);
  return {
    path: l.file,
    exists: l.exists,
    mtime: l.mtimeMs ? new Date(l.mtimeMs).toISOString() : null,
    errors: l.errors,
    fallback: l.routes.fallback,
    sticky: l.routes.sticky,
    modelChain: l.routes.modelChain,
    rules: l.routes.rules.map(function (r, i) {
      return { index: i + 1, name: r.name, when: r.when, use: r.use };
    }),
    transforms: l.routes.transforms,
    customRouter: hook ? { command: hook.cmd, source: hook.source } : null,
  };
}

// Re-exported so a caller can clear the mtime cache after a write (tests, CLI).
function resetCache() {
  cache = null;
  stickyReset();
}

export {
  FILE_NAME,
  FALLBACKS,
  routesPath,
  defaults,
  validate,
  load,
  describe,
  estimateTokens,
  userKeyOf,
  modelOf,
  headerOf,
  withModel,
  matchWhen,
  pickRule,
  applyTransforms,
  decide,
  runCustomRouter,
  hookCommand,
  stickyGet,
  stickySet,
  stickyReset,
  stickySize,
  resetCache,
  globRe,
};
