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
import * as _settings from './settings.js';
import * as _fsutil from './fsutil.js';
import _child_process from 'child_process';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 8787;
const RETRYABLE = function (s) {
  return s === 401 || s === 403 || s === 408 || s === 429 || (s >= 500 && s <= 599);
};

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

// Ordered accounts to try: the active one first, then the other CLI-capable
// accounts (breaker-open ones skipped), in rotation order.
function candidates(ctx) {
  const list = core.listProfiles(ctx);
  let activeIdx = -1;
  list.forEach(function (e, i) {
    if (e.active) activeIdx = i;
  });
  const order = [];
  if (activeIdx !== -1) order.push(list[activeIdx]);
  for (let k = 1; k <= list.length; k++) {
    const e = list[(activeIdx + k) % list.length];
    if (!e || e.active) continue;
    let hasCli = false;
    try {
      hasCli = !!ctx.store.getProfile(e.name);
    } catch (err) {
      hasCli = false;
    }
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

// Core request handler. opts.forward(up, reqInfo) -> { status, headers, res }
// (res is a readable stream) OR { status, headers, body:Buffer } for tests.
async function handleRequest(ctx, reqInfo, clientRes, opts) {
  opts = opts || {};
  const forward = opts.forward || httpForward;
  const list = candidates(ctx);
  if (!list.length) {
    clientRes.writeHead(503);
    clientRes.end('keyflip proxy: no usable account');
    return { status: 503 };
  }
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const acct = list[i].name;
    const up = upstreamFor(ctx, acct);
    if (!up.authVal) {
      lastErr = 'no credential for ' + acct;
      continue;
    }
    let resp;
    try {
      resp = await forward(up, reqInfo);
    } catch (e) {
      breaker.recordFailure(ctx, acct);
      lastErr = (e && e.message) || 'network';
      continue;
    }
    // Retry to the next account only while nothing has been sent to the client.
    if (RETRYABLE(resp.status) && i < list.length - 1) {
      breaker.recordFailure(ctx, acct);
      history.recordEvent(ctx, {
        kind: 'proxy-failover',
        from: acct,
        to: list[i + 1] && list[i + 1].name,
        reason: 'upstream ' + resp.status,
      });
      if (resp.res && resp.res.resume) resp.res.resume(); // drain
      continue;
    }
    // Commit this response to the client. A retryable status only reaches here
    // when there was no other account to fail over to — that is still a FAILURE
    // for this account's breaker (never a success), otherwise a persistently
    // rate-limited/expired sole account could never trip open.
    if (RETRYABLE(resp.status)) breaker.recordFailure(ctx, acct);
    else breaker.recordSuccess(ctx, acct);
    clientRes.writeHead(resp.status, sanitizeHeaders(resp.headers));
    if (resp.body != null) {
      // buffered (tests / small JSON)
      clientRes.end(resp.body);
      recordCost(ctx, acct, extractUsage(Buffer.isBuffer(resp.body) ? resp.body : Buffer.from(String(resp.body))));
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
        recordCost(ctx, acct, extractUsage(Buffer.concat(chunks)));
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
    return { status: resp.status, account: acct };
  }
  clientRes.writeHead(502);
  clientRes.end('keyflip proxy: all accounts failed (' + lastErr + ')');
  return { status: 502, error: lastErr };
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
  const port = opts.port || DEFAULT_PORT;
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
  return new Promise(function (resolve) {
    server.listen(port, '127.0.0.1', function () {
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
