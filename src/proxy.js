'use strict';
// Command-activated failover proxy. NOT a resident daemon — it runs only after
// `keyflip proxy start` (a detached background process) and stops on
// `keyflip proxy stop`. It sits on 127.0.0.1 in front of the Anthropic API,
// routes each request to the active account/provider, and on a retryable failure
// (429/5xx/auth) BEFORE any response byte reached the client, rotates to the next
// healthy account (breaker-aware) and retries the same request. Token usage is
// recorded for `keyflip proxy stats`. Binds localhost only.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const core = require('./core');
const usage = require('./usage');
const breaker = require('./breaker');
const provider = require('./provider');
const history = require('./history');

const DEFAULT_PORT = 8787;
const RETRYABLE = function (s) { return s === 401 || s === 403 || s === 408 || s === 429 || (s >= 500 && s <= 599); };

function metaPath(ctx) { return path.join(ctx.configDir, 'proxy.json'); }
function costFile(ctx) { return path.join(ctx.configDir, 'proxy-usage.jsonl'); }
function readMeta(ctx) { try { return JSON.parse(fs.readFileSync(metaPath(ctx), 'utf8')); } catch (e) { return null; } }

// Ordered accounts to try: the active one first, then the other CLI-capable
// accounts (breaker-open ones skipped), in rotation order.
function candidates(ctx) {
  const list = core.listProfiles(ctx);
  let activeIdx = -1;
  list.forEach(function (e, i) { if (e.active) activeIdx = i; });
  const order = [];
  if (activeIdx !== -1) order.push(list[activeIdx]);
  for (let k = 1; k <= list.length; k++) {
    const e = list[(activeIdx + k) % list.length];
    if (!e || e.active) continue;
    let hasCli = false; try { hasCli = !!ctx.store.getProfile(e.name); } catch (err) { hasCli = false; }
    if (hasCli && breaker.isAvailable(ctx, e.name)) order.push(e);
  }
  return order;
}

// The auth header + upstream base for a given account name. Uses the active
// provider's endpoint/key when one is set; otherwise the account's OAuth token.
function upstreamFor(ctx, name) {
  const active = provider.readActive(ctx);
  if (active) {
    const meta = provider.read(ctx, active.name);
    let key = null; try { key = ctx.store.getProfile('provider__' + active.name); } catch (e) { key = null; }
    return { base: meta.baseUrl.replace(/\/$/, ''), authKey: meta.authScheme === 'api-key' ? 'x-api-key' : 'authorization', authVal: meta.authScheme === 'api-key' ? key : ('Bearer ' + key) };
  }
  let token = null;
  try { token = usage.accessTokenOf(ctx.store.getProfile(name) || ''); } catch (e) { token = null; }
  return { base: 'https://api.anthropic.com', authKey: 'authorization', authVal: token ? ('Bearer ' + token) : null };
}

// Best-effort token accounting from a (possibly SSE) response buffer.
function extractUsage(buf) {
  const text = buf.toString('utf8');
  let input = null, output = null, model = null;
  try { const j = JSON.parse(text); if (j.usage) { input = j.usage.input_tokens; output = j.usage.output_tokens; } model = j.model || model; } catch (e) { /* not plain JSON, try SSE */ }
  if (input == null) { const m = /"input_tokens"\s*:\s*(\d+)/.exec(text); if (m) input = parseInt(m[1], 10); }
  // in SSE the final output count arrives in message_delta usage
  const outs = text.match(/"output_tokens"\s*:\s*(\d+)/g);
  if (outs && outs.length) output = parseInt(/(\d+)/.exec(outs[outs.length - 1])[1], 10);
  if (!model) { const mm = /"model"\s*:\s*"([^"]+)"/.exec(text); if (mm) model = mm[1]; }
  return { model: model, inputTokens: input, outputTokens: output };
}

function recordCost(ctx, account, u) {
  try { fs.appendFileSync(costFile(ctx), JSON.stringify({ at: ctx.now(), account: account, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens }) + '\n', { mode: 0o600 }); } catch (e) { /* */ }
}

// Real upstream forwarder (https). Returns a promise of { status, headers, res }
// where res is the IncomingMessage stream (not yet consumed).
function httpForward(up, reqInfo) {
  return new Promise(function (resolve, reject) {
    const u = new URL(up.base + reqInfo.path);
    const headers = Object.assign({}, reqInfo.headers);
    delete headers['authorization']; delete headers['x-api-key']; delete headers['host'];
    if (up.authVal) headers[up.authKey] = up.authVal;
    if (up.authKey === 'authorization') headers['anthropic-beta'] = (headers['anthropic-beta'] ? headers['anthropic-beta'] + ',' : '') + 'oauth-2025-04-20';
    const lib = u.protocol === 'http:' ? http : https;
    const r = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: reqInfo.method, headers: headers }, function (res) {
      resolve({ status: res.statusCode, headers: res.headers, res: res });
    });
    r.on('error', reject);
    if (reqInfo.body && reqInfo.body.length) r.write(reqInfo.body);
    r.end();
  });
}

// Core request handler. opts.forward(up, reqInfo) -> { status, headers, res }
// (res is a readable stream) OR { status, headers, body:Buffer } for tests.
async function handleRequest(ctx, reqInfo, clientRes, opts) {
  opts = opts || {};
  const forward = opts.forward || httpForward;
  const list = candidates(ctx);
  if (!list.length) { clientRes.writeHead(503); clientRes.end('keyflip proxy: no usable account'); return { status: 503 }; }
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const acct = list[i].name;
    const up = upstreamFor(ctx, acct);
    if (!up.authVal) { lastErr = 'no credential for ' + acct; continue; }
    let resp;
    try { resp = await forward(up, reqInfo); }
    catch (e) { breaker.recordFailure(ctx, acct); lastErr = (e && e.message) || 'network'; continue; }
    // Retry to the next account only while nothing has been sent to the client.
    if (RETRYABLE(resp.status) && i < list.length - 1) {
      breaker.recordFailure(ctx, acct);
      history.recordEvent(ctx, { kind: 'proxy-failover', from: acct, to: list[i + 1] && list[i + 1].name, reason: 'upstream ' + resp.status });
      if (resp.res && resp.res.resume) resp.res.resume(); // drain
      continue;
    }
    // Commit this response to the client.
    breaker.recordSuccess(ctx, acct);
    clientRes.writeHead(resp.status, sanitizeHeaders(resp.headers));
    if (resp.body != null) {                       // buffered (tests / small JSON)
      clientRes.end(resp.body);
      recordCost(ctx, acct, extractUsage(Buffer.isBuffer(resp.body) ? resp.body : Buffer.from(String(resp.body))));
    } else {                                        // stream, teeing for accounting
      const chunks = [];
      resp.res.on('data', function (c) { if (chunks.length < 4096) chunks.push(c); clientRes.write(c); });
      resp.res.on('end', function () { clientRes.end(); recordCost(ctx, acct, extractUsage(Buffer.concat(chunks))); });
      resp.res.on('error', function () { try { clientRes.end(); } catch (e) { /* */ } });
    }
    return { status: resp.status, account: acct };
  }
  clientRes.writeHead(502); clientRes.end('keyflip proxy: all accounts failed (' + lastErr + ')');
  return { status: 502, error: lastErr };
}

function sanitizeHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach(function (k) { if (['transfer-encoding', 'connection'].indexOf(k.toLowerCase()) === -1) out[k] = h[k]; });
  return out;
}

// The actual server (run in the detached child by `__proxy-serve`).
function serve(ctx, opts) {
  opts = opts || {};
  const port = opts.port || DEFAULT_PORT;
  const server = http.createServer(function (req, res) {
    const bodyChunks = [];
    req.on('data', function (c) { bodyChunks.push(c); });
    req.on('end', function () {
      const reqInfo = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(bodyChunks) };
      handleRequest(ctx, reqInfo, res, opts).catch(function () { try { res.writeHead(500); res.end('proxy error'); } catch (e) { /* */ } });
    });
  });
  return new Promise(function (resolve) {
    server.listen(port, '127.0.0.1', function () { resolve({ server: server, port: server.address().port }); });
  });
}

// Read the cost log and roll up per account/model.
function stats(ctx) {
  const rows = history.recordUsage ? [] : [];
  let lines = [];
  try { lines = fs.readFileSync(costFile(ctx), 'utf8').split('\n').filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { lines = []; }
  const byAccount = {};
  lines.forEach(function (r) {
    const a = byAccount[r.account] || (byAccount[r.account] = { requests: 0, inputTokens: 0, outputTokens: 0 });
    a.requests++; a.inputTokens += r.inputTokens || 0; a.outputTokens += r.outputTokens || 0;
  });
  return { total: lines.length, byAccount: byAccount };
}

module.exports = {
  serve: serve, handleRequest: handleRequest, candidates: candidates, upstreamFor: upstreamFor,
  extractUsage: extractUsage, stats: stats, metaPath: metaPath, readMeta: readMeta, costFile: costFile,
  DEFAULT_PORT: DEFAULT_PORT, RETRYABLE: RETRYABLE,
};
