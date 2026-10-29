// Command-activated failover proxy. NOT a resident daemon — it runs only after
// `keyflip proxy start` (a detached background process) and stops on
// `keyflip proxy stop`. It sits on 127.0.0.1 in front of the Anthropic API,
// routes each request to the active account/provider, and on a retryable failure
// (429/5xx/auth) BEFORE any response byte reached the client, rotates to the next
// healthy account (breaker-aware) and retries the same request. Token usage is
// recorded for `keyflip proxy stats`. Binds localhost only.
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import * as core from './core.js';
import * as usage from './usage.js';
import * as breaker from './breaker.js';
import * as provider from './provider.js';
import * as history from './history.js';
import * as proxyroutes from './proxyroutes.js';
import * as _settings from './settings.js';
import * as _fsutil from './fsutil.js';
import * as _config from './config.js';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 8787;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RETRYABLE = function (s) {
  return s === 401 || s === 403 || s === 408 || s === 429 || (s >= 500 && s <= 599);
};

// Why a response should (or should not) move traffic to the next account (#3):
//   throttled  — 429 rate limit: waiting or another account both help
//   billing    — 429 billing/credit/org-disabled: another account would only MASK
//                a payment problem, so it is surfaced to the client instead
//   auth       — 401/403: this account needs a re-login, park it for a while
//   overloaded — 529: Anthropic's own overload, short park
//   server     — other 5xx: short park
//   none       — everything else (never retried)
const BILLING_RE =
  /billing|credit balance|insufficient (credit|fund|balance)|payment|spend limit|account[^.]{0,40}(disabled|deactivated|suspended)|organi[sz]ation[^.]{0,40}(disabled|deactivated|suspended)|subscription[^.]{0,40}(expired|inactive|disabled)/i;
const COOLDOWN_SUFFIX = {
  billing: 'Quota',
  throttled: 'Throttled',
  overloaded: 'Overloaded',
  auth: 'Auth',
  server: 'Server',
};

function headerOf(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  const key = Object.keys(headers).find(function (k) {
    return k.toLowerCase() === want;
  });
  return key ? headers[key] : null;
}

// Retry-After is either delta-seconds or an HTTP-date (RFC 7231). Unknown or
// malformed values return null so the caller falls back to the kind's TTL.
function retryAfterMs(headers, nowMs) {
  const raw = headerOf(headers, 'retry-after');
  if (raw == null) return null;
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(MAX_COOLDOWN_MS, Math.round(parseFloat(s) * 1000));
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.min(MAX_COOLDOWN_MS, t - (nowMs || Date.now())));
}

function errorText(body) {
  if (body == null) return '';
  const text = Buffer.isBuffer(body) ? body.toString('utf8', 0, Math.min(body.length, 16384)) : String(body);
  try {
    const j = JSON.parse(text);
    const e = j && j.error;
    if (e) return [e.type, e.message, e.code].filter(Boolean).join(' ');
  } catch (e) {
    /* not JSON — fall through to the raw prefix */
  }
  return text.slice(0, 4096);
}

function classify(status, headers, body) {
  if (status === 429) return BILLING_RE.test(errorText(body)) ? 'billing' : 'throttled';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'throttled';
  if (status === 529) return 'overloaded';
  if (status >= 500 && status <= 599) return 'server';
  return 'none';
}

function cfgInt(ctx, key) {
  try {
    return _config.get(ctx, key);
  } catch (e) {
    return 0;
  }
}

function cfgString(ctx, key) {
  try {
    return String(_config.get(ctx, key) || '');
  } catch (e) {
    return '';
  }
}

// How long to park an account for this error kind. An upstream Retry-After that
// is LONGER than our baseline wins (it is authoritative); a shorter one never
// releases an account early. 0 in config disables parking for that kind.
function cooldownMsFor(ctx, kind, retryAfter) {
  const suffix = COOLDOWN_SUFFIX[kind];
  if (!suffix) return 0;
  let ms = cfgInt(ctx, 'proxy.cooldown' + suffix + 'Seconds') * 1000;
  if (retryAfter != null && retryAfter > ms) ms = retryAfter;
  return Math.min(ms, MAX_COOLDOWN_MS);
}

function park(ctx, name, kind, retryAfter) {
  const ms = cooldownMsFor(ctx, kind, retryAfter);
  if (!ms) return 0;
  return breaker.markCooldown(ctx, name, ms, kind);
}

function maxWaitMs(ctx) {
  return cfgInt(ctx, 'proxy.maxWaitSeconds') * 1000;
}

function debugEnabled(ctx, opts) {
  if (opts && opts.debugHeaders !== undefined) return !!opts.debugHeaders;
  try {
    return _config.get(ctx, 'proxy.debugHeaders') !== false;
  } catch (e) {
    return true;
  }
}

function priorityNames(ctx) {
  return cfgString(ctx, 'proxy.priority')
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

function defaultSleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function toBuffer(x) {
  return Buffer.isBuffer(x) ? x : Buffer.from(String(x));
}

// A 429's JSON body is small and decides failover AND cooldown, so read it
// (bounded) instead of blindly draining the stream. Returns '' on timeout.
function peekError(res, opts) {
  opts = opts || {};
  const maxBytes = opts.errorBodyMaxBytes || 16384;
  const budget = opts.errorBodyTimeoutMs || 1500;
  return new Promise(function (resolve) {
    if (!res || typeof res.on !== 'function') return resolve(Buffer.alloc(0));
    const chunks = [];
    let size = 0;
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (res.destroy) res.destroy();
      } catch (e) {
        /* */
      }
      resolve(Buffer.concat(chunks));
    }
    const timer = setTimeout(finish, budget);
    res.on('data', function (c) {
      if (done) return;
      if (size < maxBytes) {
        chunks.push(c);
        size += c.length;
      }
      if (size >= maxBytes) finish();
    });
    res.on('end', finish);
    res.on('error', finish);
  });
}

function drain(resp) {
  try {
    if (resp && resp.res && resp.res.resume) resp.res.resume();
  } catch (e) {
    /* */
  }
}

function metaPath(ctx) {
  return path.join(ctx.configDir, 'proxy.json');
}
function costFile(ctx) {
  return path.join(ctx.configDir, 'proxy-usage.jsonl');
}
function readMeta(ctx) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(ctx), 'utf8'));
  } catch (e) {
    return null;
  }
}

// Ordered accounts to try. Deterministic (#9): the ACTIVE account first, then
// `proxy.priority` names in listed order, then least-recently-used, then name.
// An account that is breaker-open OR inside a cooldown is skipped; if every
// account is parked, the one that frees up soonest comes back with `waitMs` so
// the request can wait it out instead of answering 503.
function candidates(ctx, opts) {
  opts = opts || {};
  const nowMs = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const prio = priorityNames(ctx);
  const all = breaker.readAll(ctx);
  let providerActive = false;
  try {
    providerActive = !!provider.readActive(ctx);
  } catch (e) {
    providerActive = false;
  }
  const rows = [];
  core.listProfiles(ctx).forEach(function (e) {
    let hasKey = providerActive;
    if (!hasKey) {
      try {
        hasKey = !!ctx.store.getProfile(e.name);
      } catch (err) {
        hasKey = false;
      }
    }
    if (!hasKey) return;
    const cd = breaker.cooldownOf(ctx, e.name, { nowMs: nowMs });
    rows.push({
      name: e.name,
      active: !!e.active,
      broken: breaker.state(ctx, e.name, { nowMs: nowMs }) === 'open',
      coolingMs: cd.active ? cd.remainingMs : 0,
      cooldownKind: cd.kind,
      lastUsedAt: (all[e.name] && all[e.name].lastUsedAt) || 0,
      priority: prio.indexOf(e.name),
    });
  });
  function rank(a, b) {
    // A configured priority list wins over "active": if the user names an order,
    // that IS the order. Unlisted accounts fall back to active-first, then LRU.
    const pa = a.priority === -1 ? Number.MAX_SAFE_INTEGER : a.priority;
    const pb = b.priority === -1 ? Number.MAX_SAFE_INTEGER : b.priority;
    if (pa !== pb) return pa - pb;
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }
  const usable = rows.filter(function (r) {
    return !r.broken && !r.coolingMs;
  });
  usable.sort(rank);
  if (usable.length) return usable;
  // Everything parked: offer the soonest-expiring cooldown, with the wait hint.
  const soonest = rows
    .filter(function (r) {
      return !r.broken;
    })
    .sort(function (a, b) {
      return a.coolingMs - b.coolingMs || rank(a, b);
    })[0];
  if (soonest) {
    soonest.waitMs = soonest.coolingMs;
    return [soonest];
  }
  // Every account breaker-open: the configured/active one is still the only
  // sensible last resort (breaker half-open recovery will re-admit it soon).
  const active = rows.filter(function (r) {
    return r.active;
  })[0];
  return active ? [active] : [];
}

// The auth header + upstream base for a given account name. Uses the active
// provider's endpoint/key when one is set; otherwise the account's OAuth token.
function upstreamFor(ctx, name) {
  const active = provider.readActive(ctx);
  if (active) {
    const meta = provider.read(ctx, active.name);
    let key = null;
    try {
      key = ctx.store.getProfile('provider__' + active.name);
    } catch (e) {
      key = null;
    }
    return {
      base: meta.baseUrl.replace(/\/$/, ''),
      authKey: meta.authScheme === 'api-key' ? 'x-api-key' : 'authorization',
      authVal: meta.authScheme === 'api-key' ? key : 'Bearer ' + key,
    };
  }
  let token = null;
  try {
    token = usage.accessTokenOf(ctx.store.getProfile(name) || '');
  } catch (e) {
    token = null;
  }
  return { base: 'https://api.anthropic.com', authKey: 'authorization', authVal: token ? 'Bearer ' + token : null };
}

// Best-effort token accounting from a (possibly SSE) response buffer.
function extractUsage(buf) {
  const text = buf.toString('utf8');
  let input = null,
    output = null,
    model = null;
  try {
    const j = JSON.parse(text);
    if (j.usage) {
      input = j.usage.input_tokens;
      output = j.usage.output_tokens;
    }
    model = j.model || model;
  } catch (e) {
    /* not plain JSON, try SSE */
  }
  if (input == null) {
    const m = /"input_tokens"\s*:\s*(\d+)/.exec(text);
    if (m) input = parseInt(m[1], 10);
  }
  // in SSE the final output count arrives in message_delta usage
  const outs = text.match(/"output_tokens"\s*:\s*(\d+)/g);
  if (outs && outs.length) output = parseInt(/(\d+)/.exec(outs[outs.length - 1])[1], 10);
  if (!model) {
    const mm = /"model"\s*:\s*"([^"]+)"/.exec(text);
    if (mm) model = mm[1];
  }
  return { model: model, inputTokens: input, outputTokens: output };
}

function recordCost(ctx, account, u) {
  try {
    fs.appendFileSync(
      costFile(ctx),
      JSON.stringify({
        at: ctx.now(),
        account: account,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
      }) + '\n',
      { mode: 0o600 },
    );
  } catch (e) {
    /* */
  }
}

// Real upstream forwarder (https). Returns a promise of { status, headers, res }
// where res is the IncomingMessage stream (not yet consumed).
function httpForward(up, reqInfo) {
  return new Promise(function (resolve, reject) {
    const u = new URL(up.base + reqInfo.path);
    const headers = Object.assign({}, reqInfo.headers);
    delete headers['authorization'];
    delete headers['x-api-key'];
    delete headers['host'];
    if (up.authVal) headers[up.authKey] = up.authVal;
    if (up.authKey === 'authorization')
      headers['anthropic-beta'] =
        (headers['anthropic-beta'] ? headers['anthropic-beta'] + ',' : '') + 'oauth-2025-04-20';
    const lib = u.protocol === 'http:' ? http : https;
    const r = lib.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: reqInfo.method, headers: headers },
      function (res) {
        resolve({ status: res.statusCode, headers: res.headers, res: res });
      },
    );
    r.on('error', reject);
    if (reqInfo.body && reqInfo.body.length) r.write(reqInfo.body);
    r.end();
  });
}

// Only printable ASCII is legal in a header value; a rule's name is user text.
function headerSafe(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '-');
}

// Move the preferred account to the front, keeping every other relative order.
// A name that is not usable right now (cooling/breaker-open) changes nothing.
function prefer(list, name) {
  if (!name) return list;
  const idx = list.findIndex(function (r) {
    return r.name === name;
  });
  if (idx <= 0) return list;
  const out = list.slice();
  out.unshift(out.splice(idx, 1)[0]);
  return out;
}

// The next model to degrade to for `model-chain`: the first chain entry that is
// not the model already in use. An unlisted current model starts at chain[0].
function nextChainModel(chain, current) {
  for (let i = 0; i < chain.length; i++) {
    if (chain[i] !== current) return chain[i];
  }
  return null;
}

// Core request handler. opts.forward(up, reqInfo) -> { status, headers, res }
// (res is a readable stream) OR { status, headers, body:Buffer } for tests.
// opts.sleep(ms) is injectable so a Retry-After wait is testable without real time.
// Routing (proxy-routes.json) is decided up front from the ORIGINAL request
// (facts/sticky), then a transformed copy is what actually goes upstream.
async function handleRequest(ctx, reqInfo, clientRes, opts) {
  opts = opts || {};
  const forward = opts.forward || httpForward;
  const sleep = opts.sleep || defaultSleep;
  const clock = opts.now || Date.now;
  const debug = debugEnabled(ctx, opts);

  // Declarative routing (#4–#8, #19): rules / sticky / custom hook pick the
  // account to try FIRST, and may rewrite the model. The usable set decides
  // what a rule or hook is allowed to name — a cooldown is never overridden.
  const live = proxyroutes.load(ctx);
  const routes = live.routes;
  const userKey = proxyroutes.userKeyOf(reqInfo);
  const facts = {
    model: proxyroutes.modelOf(reqInfo.body),
    path: reqInfo.path,
    tokens: proxyroutes.estimateTokens(reqInfo.body),
    headers: reqInfo.headers || {},
    user: userKey,
  };
  const routed = proxyroutes.applyTransforms(reqInfo, routes);
  let upstreamReq = routed.info;

  const list = candidates(ctx, { nowMs: clock() });
  if (!list.length) {
    clientRes.writeHead(503);
    clientRes.end('keyflip proxy: no usable account');
    return { status: 503, route: 'no usable account' };
  }
  const usable = list.map(function (r) {
    return r.name;
  });
  const decision = await proxyroutes.decide(routes, facts, {
    accounts: usable,
    nowMs: clock(),
    skipHook: opts.skipHook === true,
    hook: opts.hook,
  });
  if (decision.model) {
    const rewritten = proxyroutes.withModel(upstreamReq.body, decision.model);
    if (rewritten) upstreamReq = Object.assign({}, upstreamReq, { body: rewritten });
  }
  let currentModel = proxyroutes.modelOf(upstreamReq.body) || facts.model;
  const order = prefer(list, decision.account);
  const fallback = routes.fallback;
  function remember(acct) {
    if (!routes.sticky.enabled || !userKey) return;
    proxyroutes.stickySet(userKey, acct, routes.sticky.ttlSeconds * 1000, clock());
  }
  // All accounts parked but one frees up inside the wait budget: wait it out.
  const waitCap = maxWaitMs(ctx);
  if (order[0].waitMs && order[0].waitMs <= waitCap) await sleep(order[0].waitMs);
  let lastErr = null;
  const failed = [];
  let attempts = 0;
  for (let i = 0; i < order.length; i++) {
    const acct = order[i].name;
    const up = upstreamFor(ctx, acct);
    if (!up.authVal) {
      lastErr = 'no credential for ' + acct;
      continue;
    }
    // Per-account budget for retries that keep the SAME model (one Retry-After
    // wait, plus the model-chain descents); each is otherwise uncounted.
    for (let sameRetry = 0; ;) {
      attempts++;
      let resp;
      try {
        resp = await forward(up, upstreamReq);
      } catch (e) {
        breaker.recordFailure(ctx, acct);
        park(ctx, acct, 'server', null);
        lastErr = (e && e.message) || 'network';
        failed.push(acct);
        break;
      }
      let body = resp.body != null ? toBuffer(resp.body) : null;
      const peeked = body == null && resp.status === 429 && resp.res && typeof resp.res.on === 'function';
      if (peeked) body = await peekError(resp.res, opts);
      const kind = classify(resp.status, resp.headers, body);
      const retryAfter = retryAfterMs(resp.headers, clock());
      const canFailover = fallback !== 'off' && i < order.length - 1;
      // #2: a SHORT authoritative Retry-After is cheaper to wait out than to
      // spend another account's quota on — retry the SAME account once.
      if (
        fallback !== 'off' &&
        kind === 'throttled' &&
        retryAfter != null &&
        retryAfter <= waitCap &&
        sameRetry === 0
      ) {
        drain(resp);
        sameRetry++;
        await sleep(retryAfter);
        continue;
      }
      // #3: billing / credit / org-disabled is NOT a rate limit — failing over
      // would only hide a payment problem behind another account's quota.
      if (kind === 'billing') {
        breaker.recordFailure(ctx, acct);
        park(ctx, acct, kind, retryAfter);
        return commit(ctx, resp, clientRes, {
          acct: acct,
          attempts: attempts,
          failed: failed,
          kind: kind,
          debug: debug,
          bodyOverride: peeked ? body : null,
          model: currentModel,
          route: decision.reason,
        });
      }
      // `model-chain`: degrade the MODEL on this same account before spending
      // another account's quota. A model problem is not the account's fault, so
      // no breaker failure is recorded for a descent that then succeeds; auth
      // and billing are excluded because a cheaper model cannot fix those.
      if (
        fallback === 'model-chain' &&
        sameRetry === 0 &&
        RETRYABLE(resp.status) &&
        kind !== 'auth' &&
        kind !== 'billing'
      ) {
        const next = nextChainModel(routes.modelChain, currentModel);
        const rewritten = next ? proxyroutes.withModel(upstreamReq.body, next) : null;
        if (rewritten) {
          history.recordEvent(ctx, {
            kind: 'proxy-model-chain',
            account: acct,
            from: currentModel,
            to: next,
            reason: 'upstream ' + resp.status + (kind !== 'none' ? ' (' + kind + ')' : ''),
          });
          drain(resp);
          currentModel = next;
          upstreamReq = Object.assign({}, upstreamReq, { body: rewritten });
          sameRetry++;
          continue;
        }
      }
      // Retry to the next account only while nothing has been sent to the client.
      if (RETRYABLE(resp.status) && canFailover) {
        breaker.recordFailure(ctx, acct);
        park(ctx, acct, kind, retryAfter);
        failed.push(acct);
        history.recordEvent(ctx, {
          kind: 'proxy-failover',
          from: acct,
          to: order[i + 1] && order[i + 1].name,
          reason: 'upstream ' + resp.status + (kind !== 'none' ? ' (' + kind + ')' : ''),
        });
        drain(resp);
        break;
      }
      // Commit this response to the client. A retryable status only reaches here
      // when there was no other account to fail over to (or fallback is off) —
      // that is still a FAILURE for this account's breaker (never a success),
      // otherwise a persistently rate-limited/expired sole account could never
      // trip open.
      if (RETRYABLE(resp.status)) {
        breaker.recordFailure(ctx, acct);
        park(ctx, acct, kind, retryAfter);
      } else {
        breaker.recordSuccess(ctx, acct);
        remember(acct);
      }
      return commit(ctx, resp, clientRes, {
        acct: acct,
        attempts: attempts,
        failed: failed,
        kind: kind,
        debug: debug,
        bodyOverride: peeked ? body : null,
        model: currentModel,
        route: decision.reason,
      });
    }
  }
  clientRes.writeHead(502);
  clientRes.end('keyflip proxy: all accounts failed (' + lastErr + ')');
  return { status: 502, error: lastErr, attempts: attempts, route: decision.reason };
}

// Write the upstream response to the client exactly once, adding the route
// debug headers (#10) when enabled. bodyOverride carries a peeked 429 body whose
// stream has already been consumed.
function commit(ctx, resp, clientRes, info) {
  const headers = sanitizeHeaders(resp.headers);
  if (info.debug) {
    headers['x-keyflip-account'] = info.acct;
    headers['x-keyflip-attempts'] = String(info.attempts);
    if (info.failed && info.failed.length) headers['x-keyflip-failover'] = info.failed.join(',');
    if (info.kind && info.kind !== 'none') headers['x-keyflip-error-class'] = info.kind;
    if (info.model) headers['x-keyflip-model'] = headerSafe(info.model);
    if (info.route) headers['x-keyflip-route'] = headerSafe(info.route);
    const cd = breaker.cooldownOf(ctx, info.acct);
    if (cd.active) headers['x-keyflip-cooldown'] = String(Math.ceil(cd.remainingMs / 1000));
  }
  const payload = info.bodyOverride != null ? info.bodyOverride : resp.body;
  clientRes.writeHead(resp.status, headers);
  if (payload != null) {
    // buffered (tests / small JSON / a peeked error body)
    clientRes.end(payload);
    recordCost(ctx, info.acct, extractUsage(toBuffer(payload)));
  } else {
    // stream, teeing for accounting
    const chunks = [];
    const upstream = resp.res;
    // Honor client backpressure so a slow reader can't make us buffer the whole
    // upstream stream in memory; tear down the upstream if the client goes away.
    upstream.on('data', function (c) {
      if (chunks.length < 4096) chunks.push(c);
      if (clientRes.write(c) === false) upstream.pause();
    });
    clientRes.on('drain', function () {
      upstream.resume();
    });
    upstream.on('end', function () {
      clientRes.end();
      recordCost(ctx, info.acct, extractUsage(Buffer.concat(chunks)));
    });
    upstream.on('error', function () {
      try {
        clientRes.end();
      } catch (e) {
        /* */
      }
    });
    clientRes.on('close', function () {
      try {
        upstream.destroy();
      } catch (e) {
        /* */
      }
    });
  }
  const out = { status: resp.status, account: info.acct, attempts: info.attempts, route: info.route || null };
  if (info.model) out.model = info.model;
  if (info.failed && info.failed.length) out.failover = info.failed.slice();
  return out;
}

function sanitizeHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach(function (k) {
    if (['transfer-encoding', 'connection'].indexOf(k.toLowerCase()) === -1) out[k] = h[k];
  });
  return out;
}

// The actual server (run in the detached child by `__proxy-serve`).
function serve(ctx, opts) {
  opts = opts || {};
  // 0 is a valid port (OS picks a free one), so only fall back on a missing/invalid value.
  const port = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : DEFAULT_PORT;
  const MAX_BODY = opts.maxBody || 32 * 1024 * 1024; // cap buffered request body (DoS guard)
  const server = http.createServer(function (req, res) {
    // Identity marker so `stop` can confirm it's really OUR proxy on this port
    // (not a PID-reused stranger) before sending a kill signal.
    if (req.url === '/__keyflip_ping') {
      res.writeHead(200);
      res.end('keyflip-proxy ' + process.pid);
      return;
    }
    const bodyChunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', function (c) {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        try {
          res.writeHead(413);
          res.end('request too large');
        } catch (e) {
          /* */
        }
        req.destroy();
        return;
      }
      bodyChunks.push(c);
    });
    req.on('end', function () {
      if (aborted) return;
      const reqInfo = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(bodyChunks) };
      handleRequest(ctx, reqInfo, res, opts).catch(function () {
        try {
          res.writeHead(500);
          res.end('proxy error');
        } catch (e) {
          /* */
        }
      });
    });
  });
  return new Promise(function (resolve, reject) {
    // e.g. EADDRINUSE: reject instead of crashing the process with an unhandled 'error'.
    server.once('error', reject);
    server.listen(port, '127.0.0.1', function () {
      server.removeListener('error', reject);
      resolve({ server: server, port: server.address().port });
    });
  });
}

// Read the cost log and roll up per account/model.
function stats(ctx) {
  const rows = history.recordUsage ? [] : [];
  let lines = [];
  try {
    lines = fs
      .readFileSync(costFile(ctx), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(function (l) {
        try {
          return JSON.parse(l);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    lines = [];
  }
  const byAccount = {};
  lines.forEach(function (r) {
    const a = byAccount[r.account] || (byAccount[r.account] = { requests: 0, inputTokens: 0, outputTokens: 0 });
    a.requests++;
    a.inputTokens += r.inputTokens || 0;
    a.outputTokens += r.outputTokens || 0;
  });
  return { total: lines.length, byAccount: byAccount };
}

// Read-only view of the current routing decision (#10/#11): the order a request
// would take right now, every eligible account's breaker/cooldown state, and the
// policy that produced it. Backs `keyflip proxy status` and the MCP status tool.
function routeState(ctx) {
  const nowMs = Date.now();
  const prio = priorityNames(ctx);
  const all = breaker.readAll(ctx);
  let providerActive = false;
  try {
    providerActive = !!provider.readActive(ctx);
  } catch (e) {
    providerActive = false;
  }
  const accounts = [];
  core.listProfiles(ctx).forEach(function (e) {
    let hasKey = providerActive;
    if (!hasKey) {
      try {
        hasKey = !!ctx.store.getProfile(e.name);
      } catch (err) {
        hasKey = false;
      }
    }
    if (!hasKey) return;
    const cd = breaker.cooldownOf(ctx, e.name, { nowMs: nowMs });
    accounts.push({
      name: e.name,
      active: !!e.active,
      breaker: breaker.state(ctx, e.name, { nowMs: nowMs }),
      coolingSeconds: cd.active ? Math.ceil(cd.remainingMs / 1000) : 0,
      cooldownKind: cd.kind,
      cooldownUntil: cd.active ? new Date(cd.until).toISOString() : null,
      priority: prio.indexOf(e.name),
      lastUsedAt: (all[e.name] && all[e.name].lastUsedAt) || 0 ? new Date(all[e.name].lastUsedAt).toISOString() : null,
    });
  });
  const cands = candidates(ctx, { nowMs: nowMs });
  return {
    order: cands.map(function (r) {
      return r.name;
    }),
    // >0 means every account is parked and this is the soonest to free up.
    waitSeconds: Math.ceil(((cands[0] && cands[0].waitMs) || 0) / 1000),
    accounts: accounts,
    // The declarative layer (#4–#8, #19): what proxy-routes.json says, or
    // `exists:false` when the file was never written (the proxy then just uses
    // the order above).
    routes: proxyroutes.describe(ctx),
    policy: {
      priority: prio,
      providerActive: providerActive,
      maxWaitSeconds: cfgInt(ctx, 'proxy.maxWaitSeconds'),
      debugHeaders: debugEnabled(ctx),
      cooldownSeconds: {
        quota: cfgInt(ctx, 'proxy.cooldownQuotaSeconds'),
        throttled: cfgInt(ctx, 'proxy.cooldownThrottledSeconds'),
        overloaded: cfgInt(ctx, 'proxy.cooldownOverloadedSeconds'),
        auth: cfgInt(ctx, 'proxy.cooldownAuthSeconds'),
        server: cfgInt(ctx, 'proxy.cooldownServerSeconds'),
      },
    },
  };
}

// Answer "where would THIS request go?" without sending it: the live order, the
// rule/sticky/hook decision and the resulting order. Backs `proxy explain` and
// the MCP equivalent. The hook only runs when opts.runHook is true (a human
// asking), never for the read-only default.
async function explain(ctx, sel, opts) {
  sel = sel || {};
  opts = opts || {};
  const nowMs = opts.nowMs || Date.now();
  const live = proxyroutes.load(ctx);
  const list = candidates(ctx, { nowMs: nowMs });
  const facts = {
    model: sel.model || null,
    path: sel.path || '/v1/messages',
    tokens: Number.isInteger(sel.tokens) && sel.tokens > 0 ? sel.tokens : 0,
    headers: sel.headers || {},
    user: sel.user || null,
  };
  const decision = await proxyroutes.decide(live.routes, facts, {
    accounts: list.map(function (r) {
      return r.name;
    }),
    nowMs: nowMs,
    skipHook: !opts.runHook,
    hook: opts.hook,
  });
  const order = prefer(list, decision.account);
  return {
    input: facts,
    decision: decision,
    order: order.map(function (r) {
      return r.name;
    }),
    defaultOrder: list.map(function (r) {
      return r.name;
    }),
    waitSeconds: Math.ceil(((order[0] && order[0].waitMs) || 0) / 1000),
    routes: proxyroutes.describe(ctx),
  };
}

// Clear cooldowns for one account or all of them (#11 reset). Returns the names
// whose cooldown was actually present.
function clearCooldowns(ctx, name) {
  const names = name
    ? [name]
    : core.listProfiles(ctx).map(function (e) {
        return e.name;
      });
  return names.filter(function (n) {
    try {
      return breaker.clearCooldown(ctx, n);
    } catch (e) {
      return false;
    }
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// Is THIS proxy still the one listening on its recorded port? Guards against PID
// reuse: a bare pidAlive() could match an unrelated process that inherited the
// number after our child died. We probe the recorded port for our health marker.
function verifyAlive(meta, cb) {
  if (!meta || !meta.pid || !pidAlive(meta.pid)) return cb(false);
  const req = http.request(
    { hostname: '127.0.0.1', port: meta.port, path: '/__keyflip_ping', method: 'GET', timeout: 800 },
    function (res) {
      let d = '';
      res.on('data', function (c) {
        d += c;
      });
      res.on('end', function () {
        cb(d.indexOf('keyflip-proxy') !== -1);
      });
    },
  );
  req.on('error', function () {
    cb(false);
  });
  req.on('timeout', function () {
    req.destroy();
    cb(false);
  });
  req.end();
}
function isRunning(ctx) {
  const m = readMeta(ctx);
  return !!(m && m.pid && pidAlive(m.pid));
}

// Set/clear ANTHROPIC_BASE_URL in settings.json (safe: throws on corrupt).
function wireSettings(ctx, url) {
  const settings = _settings;
  const { writeJsonStable } = _fsutil;
  const cfg = settings.read(ctx.claudeSettingsPath);
  cfg.env = cfg.env || {};
  if (url) cfg.env.ANTHROPIC_BASE_URL = url;
  else delete cfg.env.ANTHROPIC_BASE_URL;
  if (!Object.keys(cfg.env).length) delete cfg.env;
  writeJsonStable(ctx.claudeSettingsPath, cfg, 0o600);
}

// Spawn the detached background server and record it. Shared by the CLI and MCP.
function start(ctx, opts) {
  opts = opts || {};
  if (isRunning(ctx)) {
    const m = readMeta(ctx);
    return { already: true, pid: m.pid, port: m.port, url: m.url };
  }
  const port = opts.port || DEFAULT_PORT;
  const bin = path.join(__dirname, '..', 'bin', 'keyflip.js');
  const child = _child_process.spawn(process.execPath, [bin, '__proxy-serve', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const url = 'http://127.0.0.1:' + port;
  _fsutil.writeJsonStable(
    metaPath(ctx),
    { pid: child.pid, port: port, url: url, wired: !!opts.wire, at: ctx.now() },
    0o600,
  );
  let wireError = null;
  if (opts.wire) {
    try {
      wireSettings(ctx, url);
    } catch (e) {
      wireError = e.message;
    }
  }
  return { pid: child.pid, port: port, url: url, wired: !!opts.wire, wireError: wireError };
}

// Async: verifies the process identity (port ping) before killing, so a
// PID-reused stranger is never signalled. Stale meta is cleaned up regardless.
function stop(ctx) {
  return new Promise(function (resolve) {
    const meta = readMeta(ctx);
    if (!meta) return resolve({ running: false });
    verifyAlive(meta, function (ours) {
      if (ours && meta.pid) {
        try {
          process.kill(meta.pid);
        } catch (e) {
          /* */
        }
      }
      if (meta.wired) {
        try {
          wireSettings(ctx, null);
        } catch (e) {
          /* */
        }
      }
      try {
        fs.rmSync(metaPath(ctx), { force: true });
      } catch (e) {
        /* */
      }
      resolve({ stopped: true, wired: !!meta.wired });
    });
  });
}

export {
  serve,
  handleRequest,
  candidates,
  upstreamFor,
  extractUsage,
  stats,
  routeState,
  explain,
  prefer,
  clearCooldowns,
  retryAfterMs,
  classify,
  cooldownMsFor,
  metaPath,
  readMeta,
  costFile,
  start,
  stop,
  isRunning,
  wireSettings,
  pidAlive,
  DEFAULT_PORT,
  RETRYABLE,
};
