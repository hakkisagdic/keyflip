'use strict';
// Roadmap: self-hostable ZERO-KNOWLEDGE blob relay for the internet RELAY transfer
// path. A keyflip user who has no Nextcloud/WebDAV host can run THIS on one machine or
// a VPS and point keyflip's WebDAV client (sync.davPut/davGet/davDelete) at it. It is a
// flat, namespaced blob store speaking exactly the PUT/GET/DELETE/HEAD/OPTIONS subset
// that client needs — no Docker, no npm, pure node:http.
//
// SECURITY MODEL (why this is safe to expose):
//   * ZERO-KNOWLEDGE: the relay only ever stores/serves CIPHERTEXT. The transfer CODE
//     (the AES passphrase) NEVER reaches here — the slot id is a one-way sha256 prefix of
//     the code, a non-secret lookup handle, not the key. So a full store dump reveals
//     nothing without the out-of-band code.
//   * ANTI-TRAVERSAL: a slot is a SINGLE path segment matching /^[A-Za-z0-9._-]{1,128}$/,
//     with '..' rejected anywhere, and the resolved path is re-verified to sit directly
//     inside the storage dir (defense in depth). A slot can never escape `dir`.
//   * BOUNDED: per-blob size cap (destroy the socket on overflow), a live-blob count cap
//     (507 when full), and a TTL sweeper so abandoned transfers don't accumulate.
//   * AUTH: optional HTTP Basic compared in constant time (sha256 + timingSafeEqual, no
//     length oracle). An OPEN, writable store on a PUBLIC interface is an abuse vector, so
//     we REFUSE to bind a non-loopback host with no auth unless the caller passes an
//     explicit allowUnauthenticated:true and owns that choice.
//   * QUIET: never logs blob contents, auth values, or slot->content.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PREFIX = '/kf';
const SLOT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE';

function resolveOpts(opts) {
  opts = opts || {};
  if (!opts.dir) throw new Error('relay: opts.dir (storage directory) is required');
  fs.mkdirSync(opts.dir, { recursive: true });
  const base = fs.realpathSync(opts.dir); // canonical root; symlinks resolved once
  const prefix = normPrefix(opts.prefix || DEFAULT_PREFIX);
  const auth = opts.auth || null;
  return {
    dir: base,
    host: opts.host || '127.0.0.1',
    port: opts.port != null ? opts.port : 8788, // 0 = ephemeral
    prefix: prefix,
    auth: auth && auth.user != null ? { user: String(auth.user), pass: String(auth.pass || '') } : null,
    maxBlobBytes: opts.maxBlobBytes != null ? opts.maxBlobBytes : 64 * 1024 * 1024,
    maxBlobs: opts.maxBlobs != null ? opts.maxBlobs : 256,
    ttlMs: opts.ttlMs != null ? opts.ttlMs : 24 * 60 * 60 * 1000,
    now: typeof opts.now === 'function' ? opts.now : function () { return Date.now(); },
    allowUnauthenticated: !!opts.allowUnauthenticated
  };
}

function normPrefix(p) {
  p = String(p || '');
  if (p[0] !== '/') p = '/' + p;
  if (p.length > 1 && p[p.length - 1] === '/') p = p.slice(0, -1); // no trailing slash
  return p;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1';
}

// --- constant-time HTTP Basic check (no length oracle) ---
function sha(b) { return crypto.createHash('sha256').update(b).digest(); }
function checkAuth(cfg, req) {
  if (!cfg.auth) return true;
  const got = req.headers['authorization'] || '';
  const want = 'Basic ' + Buffer.from(cfg.auth.user + ':' + cfg.auth.pass).toString('base64');
  // Hash both to fixed 32 bytes so timingSafeEqual never sees a length mismatch — a
  // mismatched raw length would otherwise throw and leak length via the code path.
  return crypto.timingSafeEqual(sha(Buffer.from(got)), sha(Buffer.from(want)));
}

// Extract + validate the slot from the request path. Returns { slot } or { error, code }.
// Anti-traversal is layered: raw single-segment check -> decode -> reject '..'/separators ->
// strict regex -> filesystem re-verification against the canonical root.
function resolveSlot(cfg, req) {
  const q = req.url.indexOf('?');
  const pathname = q === -1 ? req.url : req.url.slice(0, q);
  const p = cfg.prefix + '/';
  if (pathname.slice(0, p.length) !== p) return { error: 'not found', code: 404 };
  const raw = pathname.slice(p.length);
  if (raw.length === 0 || raw.indexOf('/') !== -1) return { error: 'bad slot', code: 400 };
  let slot;
  try { slot = decodeURIComponent(raw); } catch (e) { return { error: 'bad slot', code: 400 }; }
  if (slot.indexOf('/') !== -1 || slot.indexOf('\\') !== -1) return { error: 'bad slot', code: 400 };
  if (slot.indexOf('\0') !== -1) return { error: 'bad slot', code: 400 };
  if (slot.indexOf('..') !== -1) return { error: 'bad slot', code: 400 };
  if (!SLOT_RE.test(slot)) return { error: 'bad slot', code: 400 };
  // Reject leading-dot slots: they are counted/swept differently from ordinary blobs
  // (countBlobs skips dotfiles; sweep only reaps '.tmp.*'), so a client could otherwise PUT
  // unlimited never-counted, never-expiring '.x' blobs and exhaust the disk. The internal
  // temp namespace ('.tmp.*') stays disjoint from anything a client can name.
  if (slot[0] === '.') return { error: 'bad slot', code: 400 };
  const target = path.join(cfg.dir, slot);
  // Defense in depth: the file must sit DIRECTLY in the canonical root, nowhere else.
  if (path.dirname(target) !== cfg.dir) return { error: 'bad slot', code: 400 };
  return { slot: slot, target: target };
}

// Remove blobs whose mtime is older than ttlMs. Best-effort; never throws.
function sweep(cfg) {
  let names;
  try { names = fs.readdirSync(cfg.dir); } catch (e) { return; }
  const cutoff = cfg.now() - cfg.ttlMs;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (n[0] === '.') { // stale temp files: reap old ones too
      if (n.indexOf('.tmp.') === 0) {
        try { if (fs.statSync(path.join(cfg.dir, n)).mtimeMs < cutoff) fs.unlinkSync(path.join(cfg.dir, n)); } catch (e) { /* ignore */ }
      }
      continue;
    }
    try {
      const st = fs.statSync(path.join(cfg.dir, n));
      if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(path.join(cfg.dir, n));
    } catch (e) { /* ignore */ }
  }
}

// Count live (non-temp, non-dot) blob files currently in the store.
function countBlobs(cfg) {
  let names;
  try { names = fs.readdirSync(cfg.dir); } catch (e) { return 0; }
  let n = 0;
  for (let i = 0; i < names.length; i++) if (names[i][0] !== '.') n++;
  return n;
}

function send(res, code, headers, body) {
  if (res.headersSent) return;
  res.writeHead(code, headers || {});
  res.end(body);
}

function handlePut(cfg, req, res, r) {
  // Fast reject when the declared size already blows the cap.
  const declared = parseInt(req.headers['content-length'], 10);
  if (!isNaN(declared) && declared > cfg.maxBlobBytes) {
    send(res, 413, { 'content-type': 'text/plain' }, 'blob too large\n');
    try { req.destroy(); } catch (e) { /* ignore */ }
    return;
  }
  sweep(cfg);
  let existed = false;
  try { existed = fs.statSync(r.target).isFile(); } catch (e) { existed = false; }
  if (!existed && countBlobs(cfg) >= cfg.maxBlobs) {
    send(res, 507, { 'content-type': 'text/plain' }, 'store full\n');
    // Drain the request body so the connection can be reused/closed cleanly.
    req.resume();
    return;
  }

  const tmp = path.join(cfg.dir, '.tmp.' + crypto.randomBytes(12).toString('hex'));
  let received = 0, aborted = false, finished = false;
  const ws = fs.createWriteStream(tmp, { mode: 0o600 });
  function cleanup() { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
  function abort(code, msg) {
    if (aborted || finished) return; aborted = true;
    try { ws.destroy(); } catch (e) { /* ignore */ }
    cleanup();
    if (code && !res.headersSent) send(res, code, { 'content-type': 'text/plain' }, msg);
    try { req.destroy(); } catch (e) { /* ignore */ } // hard-stop the socket on overflow
  }

  ws.on('error', function () { abort(500, 'write error\n'); });
  req.on('error', function () { abort(0); });
  req.on('aborted', function () { abort(0); });

  req.on('data', function (chunk) {
    if (aborted) return;
    received += chunk.length;
    if (received > cfg.maxBlobBytes) { abort(413, 'blob too large\n'); return; }
    if (!ws.write(chunk)) { req.pause(); ws.once('drain', function () { if (!aborted) req.resume(); }); }
  });
  req.on('end', function () {
    if (aborted) return;
    ws.end(function () {
      if (aborted) return;
      finished = true;
      try {
        fs.renameSync(tmp, r.target); // atomic publish
        fs.chmodSync(r.target, 0o600);
      } catch (e) { cleanup(); send(res, 500, { 'content-type': 'text/plain' }, 'write error\n'); return; }
      send(res, existed ? 204 : 201, existed ? {} : { 'content-type': 'text/plain' }, existed ? undefined : 'created\n');
    });
  });
}

function handleGet(cfg, req, res, r, headOnly) {
  let st;
  try { st = fs.statSync(r.target); } catch (e) { send(res, 404, { 'content-type': 'text/plain' }, headOnly ? undefined : 'not found\n'); return; }
  if (!st.isFile()) { send(res, 404, {}, undefined); return; }
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(st.size) };
  if (headOnly) { send(res, 200, headers, undefined); return; }
  res.writeHead(200, headers);
  const rs = fs.createReadStream(r.target);
  rs.on('error', function () { try { res.destroy(); } catch (e) { /* ignore */ } });
  rs.pipe(res);
}

function handleDelete(cfg, req, res, r) {
  try { fs.unlinkSync(r.target); } catch (e) { /* ENOENT => idempotent success */ }
  send(res, 204, {}, undefined);
}

// The pure, injectable request handler. Testable without a live socket.
function createHandler(opts) {
  const cfg = resolveOpts(opts);
  const handler = function (req, res) {
    req.on('error', function () { /* client abort — never crash the server */ });

    // OPTIONS is answered globally (any path) so a WebDAV client's discovery probe is
    // satisfied even before it knows a slot.
    if (req.method === 'OPTIONS') {
      if (!checkAuth(cfg, req)) return send(res, 401, { 'www-authenticate': 'Basic realm="keyflip-relay"' }, undefined);
      return send(res, 200, { 'DAV': '1', 'Allow': ALLOW, 'MS-Author-Via': 'DAV', 'content-length': '0' }, undefined);
    }

    if (['GET', 'HEAD', 'PUT', 'DELETE'].indexOf(req.method) === -1) {
      return send(res, 405, { 'Allow': ALLOW, 'content-type': 'text/plain' }, 'method not allowed\n');
    }
    if (!checkAuth(cfg, req)) {
      return send(res, 401, { 'www-authenticate': 'Basic realm="keyflip-relay"', 'content-type': 'text/plain' }, 'unauthorized\n');
    }

    const r = resolveSlot(cfg, req);
    if (r.error) return send(res, r.code, { 'content-type': 'text/plain' }, r.error + '\n');

    switch (req.method) {
      case 'PUT': return handlePut(cfg, req, res, r);
      case 'GET': return handleGet(cfg, req, res, r, false);
      case 'HEAD': return handleGet(cfg, req, res, r, true);
      case 'DELETE': return handleDelete(cfg, req, res, r);
    }
  };
  handler.cfg = cfg;
  return handler;
}

// Build an http.Server wired to the handler, NOT yet listening. Enforces the
// no-open-writable-store-on-a-public-interface rule up front so a misconfig can't bind.
function createRelayServer(opts) {
  const handler = createHandler(opts);
  const cfg = handler.cfg;
  if (!cfg.auth && !isLoopbackHost(cfg.host) && !cfg.allowUnauthenticated) {
    throw new Error('relay: refusing to expose an unauthenticated, writable blob store on ' +
      cfg.host + ' — set opts.auth {user,pass}, bind 127.0.0.1, or pass allowUnauthenticated:true to own the risk');
  }
  const server = http.createServer(handler);
  server.on('clientError', function (err, socket) { try { socket.destroy(); } catch (e) { /* ignore */ } });
  return { server: server, handler: handler, cfg: cfg };
}

// Start listening. Resolves to a handle with the ACTUAL bound port + a Promise close().
function start(opts) {
  return new Promise(function (resolve, reject) {
    let built;
    try { built = createRelayServer(opts); } catch (e) { reject(e); return; }
    const server = built.server, cfg = built.cfg;

    sweep(cfg); // reap stale blobs at startup
    const timer = setInterval(function () { sweep(cfg); }, Math.max(1000, Math.min(cfg.ttlMs, 60 * 60 * 1000)));
    if (timer.unref) timer.unref(); // never keep the event loop alive on our account

    function close() {
      clearInterval(timer);
      return new Promise(function (res) { server.close(function () { res(); }); });
    }
    server.on('error', function (e) { clearInterval(timer); reject(e); });
    server.listen(cfg.port, cfg.host, function () {
      const addr = server.address();
      resolve({ server: server, handler: built.handler, cfg: cfg, host: cfg.host, port: (addr && addr.port) || cfg.port, close: close });
    });
  });
}

module.exports = {
  DEFAULT_PREFIX: DEFAULT_PREFIX,
  SLOT_RE: SLOT_RE,
  createHandler: createHandler,
  createRelayServer: createRelayServer,
  start: start,
  isLoopbackHost: isLoopbackHost,
  _sweep: sweep,
  _countBlobs: countBlobs
};
