'use strict';
// Roadmap #10(a): LIVE device-to-device transfer over the LAN, zero-dependency.
// The source runs `transfer serve`: it builds the same encrypted migrate bundle,
// shows a short ONE-TIME CODE, and streams the bundle over HTTP only to a peer that
// presents that code. The target runs `transfer pull <host> --code XXXX`, which
// (optionally) discovers the peer via a UDP multicast beacon, fetches the bundle,
// decrypts it with the code, and MERGES it (via migrate.applyBundle).
//
// Security model (defense in depth for a one-time LAN move):
//   * The bundle is encrypted with the code (AES-256-GCM, scrypt-derived) — the
//     code IS the shared secret; nothing sensitive crosses the wire in the clear.
//   * The code is 40 bits of base32 (8 chars, no confusable 0/O/1/I) — enough that
//     an offline guess against scrypt is impractical for a short-lived transfer.
//   * Single-shot: the listener shuts down after ONE successful transfer.
//   * Rate-limited: a few bad codes shut it down (blunts online guessing).
//   * Auto-expires after a TTL. Binds the LAN; never advertises the code.
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const migrate = require('./migrate');
const sync = require('./sync');

const DEFAULT_PORT = 8787;
const MCAST_ADDR = '239.255.41.42';
const MCAST_PORT = 41234;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // base32, no 0/O/1/I

// base32-encode a Buffer using CODE_ALPHABET.
function b32(buf) {
  let bits = 0, val = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    val = (val << 8) | buf[i]; bits += 8;
    while (bits >= 5) { out += CODE_ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CODE_ALPHABET[(val << (5 - bits)) & 31];
  return out;
}
function genCode() { return b32(crypto.randomBytes(5)).slice(0, 8); } // 40 bits -> 8 chars
// Normalize user-typed codes: uppercase, drop spaces/dashes/confusables handling.
function normCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z2-9]/g, ''); }
function codeEqual(a, b) {
  const x = Buffer.from(normCode(a)), y = Buffer.from(normCode(b));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}
// A short non-secret fingerprint of the code, so the user can confirm the peer.
function fingerprint(code) { return crypto.createHash('sha256').update(normCode(code)).digest('hex').slice(0, 4).toUpperCase(); }

// This machine's non-internal IPv4 addresses (what a peer would dial).
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) { if (a.family === 'IPv4' && !a.internal) out.push(a.address); });
  });
  return out;
}

// Serve the bundle to whoever presents the code. Returns a handle:
//   { code, fingerprint, port, addresses, wait: Promise<{reason}>, close(reason) }
function serve(ctx, opts) {
  opts = opts || {};
  const code = opts.code || genCode();
  const port = opts.port != null ? opts.port : DEFAULT_PORT; // allow 0 (ephemeral)
  const host = opts.host || '0.0.0.0';
  const maxAttempts = opts.maxAttempts || 5;
  const built = migrate.buildBundle(ctx, opts);
  if (!built.counts.accounts && !built.counts.transcripts && !built.counts.providers && !built.counts.memory && !built.counts.config && !built.counts.agents && !built.counts.agentConfig) {
    throw new Error('nothing to transfer (no accounts, providers, transcripts, or memory found)');
  }
  const enc = sync.encrypt(JSON.stringify(built.bundle), code); // encrypted with the code
  // Display fingerprint for the human to confirm the right peer. It is a RANDOM
  // per-serve nonce — NOT derived from the code — so advertising it (on /ping and the
  // beacon) leaks nothing about the code's keyspace.
  const fp = opts.fp || b32(crypto.randomBytes(3)).slice(0, 4);

  let attempts = 0;
  let resolveWait;
  const wait = new Promise(function (r) { resolveWait = r; });
  let beacon = null, ttlTimer = null, closed = false;

  const server = http.createServer(function (req, res) {
    req.on('error', function () { /* client abort / socket error — ignore, don't crash */ });
    if (req.method === 'GET' && req.url === '/ping') {
      // Liveness only — do NOT leak counts or anything account-identifying to a LAN prober.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keyflip: 'transfer', fp: fp }));
      return;
    }
    if (req.method === 'POST' && req.url === '/pull') {
      let body = '';
      req.on('data', function (d) { body += d; if (body.length > 8192) req.destroy(); });
      req.on('end', function () {
        let j = {}; try { j = JSON.parse(body); } catch (e) { j = {}; }
        if (!codeEqual(j.code, code)) {
          attempts++;
          res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad code' }));
          if (attempts >= maxAttempts) close('too many bad codes');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(enc);
        // one-shot: close after the successful transfer flushes
        res.on('finish', function () { close('transferred'); });
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  function close(reason) {
    if (closed) return; closed = true;
    if (ttlTimer) clearTimeout(ttlTimer);
    if (beacon) { try { beacon.stop(); } catch (e) { /* ignore */ } }
    try { server.close(); } catch (e) { /* ignore */ }
    resolveWait({ reason: reason });
  }

  server.on('error', function (e) { close('server error: ' + (e && e.message)); });
  server.listen(port, host, function () {
    const actualPort = server.address() && server.address().port;
    handle.port = actualPort || port;
    if (opts.discovery !== false && host !== '127.0.0.1') {
      try { beacon = startBeacon(handle.port, fp, opts.name || os.hostname()); } catch (e) { beacon = null; }
    }
    const ttl = opts.ttlMs || 120000;
    ttlTimer = setTimeout(function () { close('expired'); }, ttl);
    if (ttlTimer.unref) ttlTimer.unref();
  });

  const handle = { code: code, fingerprint: fp, port: port, addresses: lanAddresses(), counts: built.counts, wait: wait, close: close };
  return handle;
}

// E3: RECEIVE mode — this machine waits for a peer to PUSH a bundle to it (the reverse of
// serve/pull). It shows a code, and on POST /receive decrypts the payload with that code and
// hands the bundle to opts.onBundle(bundle) (which merges it). Single-shot, rate-limited,
// auto-expiring — same guards as serve().
function serveReceive(ctx, opts) {
  opts = opts || {};
  const code = opts.code || genCode();
  const port = opts.port != null ? opts.port : DEFAULT_PORT;
  const host = opts.host || '0.0.0.0';
  const maxAttempts = opts.maxAttempts || 5;
  const fp = opts.fp || b32(crypto.randomBytes(3)).slice(0, 4);
  const onBundle = opts.onBundle || function () { return {}; };

  let attempts = 0, resolveWait, beacon = null, ttlTimer = null, closed = false;
  const wait = new Promise(function (r) { resolveWait = r; });

  const server = http.createServer(function (req, res) {
    req.on('error', function () { /* client abort — ignore */ });
    if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keyflip: 'transfer-receive', fp: fp })); return; }
    if (req.method === 'POST' && req.url === '/receive') {
      let body = ''; const capB = opts.maxBytes || (1 << 30);
      req.on('data', function (d) { body += d; if (body.length > capB) req.destroy(); });
      req.on('end', function () {
        let j = {}; try { j = JSON.parse(body); } catch (e) { j = {}; }
        let bundle = null;
        try { bundle = JSON.parse(sync.decrypt(String(j.enc || ''), code)); } catch (e) { bundle = null; }
        if (!bundle) {
          attempts++;
          res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'bad code or payload' }));
          if (attempts >= maxAttempts) close('too many bad attempts');
          return;
        }
        let summary;
        try { summary = onBundle(bundle); }
        catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'apply failed' })); close('apply-failed'); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, summary: summary }));
        res.on('finish', function () { close('received'); });
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  function close(reason) { if (closed) return; closed = true; if (ttlTimer) clearTimeout(ttlTimer); if (beacon) { try { beacon.stop(); } catch (e) { /* ignore */ } } try { server.close(); } catch (e) { /* ignore */ } resolveWait({ reason: reason }); }
  server.on('error', function (e) { close('server error: ' + (e && e.message)); });
  server.listen(port, host, function () {
    handle.port = (server.address() && server.address().port) || port;
    if (opts.discovery !== false && host !== '127.0.0.1') { try { beacon = startBeacon(handle.port, fp, opts.name || os.hostname()); } catch (e) { beacon = null; } }
    ttlTimer = setTimeout(function () { close('expired'); }, opts.ttlMs || 120000);
    if (ttlTimer.unref) ttlTimer.unref();
  });
  const handle = { code: code, fingerprint: fp, port: port, addresses: lanAddresses(), wait: wait, close: close };
  return handle;
}

// E3: PUSH a bundle to a peer that is in RECEIVE mode. Encrypts with the code, POSTs it,
// returns the peer's merge summary. `opts.bundle` is the plain bundle object.
function push(opts) {
  opts = opts || {};
  const hp = splitHostPort(opts.host, opts.port);
  const code = normCode(opts.code);
  const payload = JSON.stringify({ enc: sync.encrypt(JSON.stringify(opts.bundle), code) });
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: hp.host, port: hp.port, path: '/receive', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: opts.timeoutMs || 30000 },
      function (res) {
        let body = ''; const cap = 4 * 1024 * 1024;
        res.on('data', function (d) { body += d; if (body.length > cap) req.destroy(new Error('oversized response')); });
        res.on('end', function () {
          if (res.statusCode === 403) return reject(new Error('the code was rejected by the peer'));
          if (res.statusCode !== 200) return reject(new Error('peer returned http ' + res.statusCode));
          let j; try { j = JSON.parse(body); } catch (e) { j = { ok: true }; }
          resolve(j);
        });
      });
    req.on('timeout', function () { req.destroy(new Error('timed out contacting the peer')); });
    req.on('error', function (e) { reject(new Error('could not reach the peer: ' + (e && e.message))); });
    req.end(payload);
  });
}

// G6: the pairing URL a QR encodes so the other machine gets host+port+code+fingerprint in
// one scan. It DOES carry the one-time code — the QR is shown only in the serving terminal,
// same trust boundary as printing the code as text.
function pairingUrl(host, port, code, fp) {
  return 'keyflip://transfer?host=' + host + ':' + port + '&code=' + code + (fp ? '&fp=' + fp : '');
}

// Periodically multicast a beacon so a peer's `discover()` can find host+port.
// Advertises ONLY host/port/fingerprint/name — never the code.
function startBeacon(port, fp, name) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const msg = Buffer.from(JSON.stringify({ keyflip: 'transfer', port: port, fp: fp, name: name }));
  let timer = null;
  // Without this, an async socket error (network down mid-serve) is an unhandled
  // 'error' event that would CRASH the foreground `transfer serve` process.
  sock.on('error', function () { if (timer) clearInterval(timer); try { sock.close(); } catch (e) { /* ignore */ } });
  sock.bind(function () {
    try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
    const tick = function () { try { sock.send(msg, 0, msg.length, MCAST_PORT, MCAST_ADDR); } catch (e) { /* ignore */ } };
    tick();
    timer = setInterval(tick, 1000);
    if (timer.unref) timer.unref();
  });
  return { stop: function () { if (timer) clearInterval(timer); try { sock.close(); } catch (e) { /* ignore */ } } };
}

// Listen for beacons for `timeoutMs`, return the peers seen (deduped host:port).
function discover(timeoutMs) {
  return new Promise(function (resolve) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const peers = {};
    sock.on('message', function (buf, rinfo) {
      try { const j = JSON.parse(buf); if (j && j.keyflip === 'transfer' && j.port) peers[rinfo.address + ':' + j.port] = { host: rinfo.address, port: j.port, fp: j.fp || null, name: j.name || null }; }
      catch (e) { /* ignore */ }
    });
    sock.on('error', function () { try { sock.close(); } catch (e) {} resolve([]); });
    try {
      sock.bind(MCAST_PORT, function () { try { sock.addMembership(MCAST_ADDR); } catch (e) { /* multicast may be unavailable */ } });
    } catch (e) { resolve([]); return; }
    setTimeout(function () { try { sock.close(); } catch (e) { /* ignore */ } resolve(Object.keys(peers).map(function (k) { return peers[k]; })); }, timeoutMs || 3000);
  });
}

// host may be "1.2.3.4" or "1.2.3.4:9000".
function splitHostPort(host, dflt) {
  const s = String(host || '');
  const i = s.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i), port: parseInt(s.slice(i + 1), 10) };
  return { host: s, port: dflt || DEFAULT_PORT };
}

// Fetch the encrypted bundle from a serving peer and decrypt it with the code.
function pull(opts) {
  opts = opts || {};
  const hp = splitHostPort(opts.host, opts.port);
  const code = normCode(opts.code);
  const payload = JSON.stringify({ code: code });
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: hp.host, port: hp.port, path: '/pull', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: opts.timeoutMs || 15000 },
      function (res) {
        let body = '';
        const cap = opts.maxBytes || (1 << 30); // 1 GiB — generous for any real bundle, bounds a rogue peer
        res.on('data', function (d) { body += d; if (body.length > cap) { req.destroy(new Error('peer response exceeded ' + cap + ' bytes')); } });
        res.on('end', function () {
          if (res.statusCode === 403) return reject(new Error('the code was rejected by the peer'));
          if (res.statusCode !== 200) return reject(new Error('peer returned http ' + res.statusCode));
          let bundle;
          try { bundle = JSON.parse(sync.decrypt(body, code)); }
          catch (e) { return reject(new Error('could not decrypt the bundle — wrong code?')); }
          resolve(bundle);
        });
      });
    req.on('timeout', function () { req.destroy(new Error('timed out contacting the peer')); });
    req.on('error', function (e) { reject(new Error('could not reach the peer: ' + (e && e.message))); });
    req.end(payload);
  });
}

module.exports = {
  DEFAULT_PORT: DEFAULT_PORT,
  pairingUrl: pairingUrl,
  serve: serve,
  serveReceive: serveReceive,
  pull: pull,
  push: push,
  discover: discover,
  genCode: genCode,
  normCode: normCode,
  codeEqual: codeEqual,
  fingerprint: fingerprint,
  splitHostPort: splitHostPort,
  lanAddresses: lanAddresses,
};
