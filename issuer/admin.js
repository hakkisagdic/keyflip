'use strict';
// ISSUER / admin.js — the operator's panel: issue, reissue, revoke, look up a
// license, inspect invoices/revenue (TRY & USD), and read the webhook event log.
//
// SHAPE: a zero-dependency node:http handler that serves BOTH
//   * a JSON API under /admin/api/*  (scriptable: curl, CI, your own tooling)
//   * a tiny single-page UI at /admin  (no build step, no framework, no CDN)
//
// SECURITY (load-bearing — read before editing):
//   * EVERY /admin request needs `Authorization: Bearer <token>`. The token
//     comes from KEYFLIP_ISSUER_ADMIN_TOKEN (env) — never argv, never a file in
//     the repo, never a query string. When unset the panel answers 503.
//   * Constant-time comparison via crypto.timingSafeEqual.
//   * A minted license TOKEN is returned in the response EXACTLY ONCE and is
//     never written to disk, never logged, never put in the event/invoice log.

const crypto = require('crypto');
const path = require('path');
const { LicenseStore, InvoiceStore, EventLog, TIERS, normalizeEmail } = require('./store');
const { PLANS_CATALOG } = require('./config');

const MAX_BODY_BYTES = 1 << 16; // 64 KiB
const ADMIN_TOKEN_ENV = 'KEYFLIP_ISSUER_ADMIN_TOKEN';

function tokenMatches(expected, presented) {
  if (!expected) return false;
  if (!presented) return false;
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(presented), 'utf8');
  if (a.length !== b.length) {
    try {
      crypto.timingSafeEqual(a, a);
    } catch {
      /* ignore */
    }
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function bearerFrom(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  return m[1].trim();
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', function (e) {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

// ---- the panel page ------------------------------------------------------------
const PANEL_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>keyflip issuer — admin</title>
<style>
  :root { color-scheme: light dark; --fg:#1b1b1f; --mut:#6b6b76; --line:#d9d9e0; --bg:#fbfbfd; --card:#fff; --accent:#3b5bdb; --bad:#c92a2a; --ok:#2b8a3e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e9e9ef; --mut:#9a9aa6; --line:#2e2e36; --bg:#131317; --card:#1b1b21; --accent:#748ffc; --bad:#ff8787; --ok:#69db7c; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif; font-variant-numeric:tabular-nums; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size:1.35rem; margin:0 0 .25rem; }
  h2 { font-size:1rem; margin:2rem 0 .6rem; letter-spacing:.02em; text-transform:uppercase; color:var(--mut); }
  p.lead { color:var(--mut); margin:0 0 1.5rem; }
  .row { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
  input, select, button { font:inherit; padding:.45rem .6rem; border-radius:.4rem; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  button { cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:transparent; }
  button.danger { color:var(--bad); }
  table { width:100%; border-collapse:collapse; font-size:.9rem; font-variant-numeric:tabular-nums; }
  th, td { text-align:left; padding:.45rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--mut); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em; }
  .pill { display:inline-block; padding:.05rem .45rem; border-radius:99px; font-size:.75rem; border:1px solid var(--line); }
  .s-active { color:var(--ok); border-color:currentColor; }
  .s-revoked { color:var(--bad); border-color:currentColor; }
  .s-superseded { color:var(--mut); }
  #msg { margin:1rem 0; padding:.6rem .8rem; border-radius:.4rem; border:1px solid var(--line); display:none; white-space:pre-wrap; word-break:break-word; }
  #msg.err { display:block; color:var(--bad); border-color:currentColor; }
  #msg.ok { display:block; color:var(--ok); border-color:currentColor; }
  .token-out { user-select:all; }
  .muted { color:var(--mut); }
</style>
</head>
<body>
<main>
  <h1>keyflip issuer — admin</h1>
  <p class="lead">Issue, reissue, revoke and look up licenses. The token is kept in memory only.</p>

  <div class="row">
    <input id="tok" type="password" placeholder="admin token (KEYFLIP_ISSUER_ADMIN_TOKEN)" size="44" autocomplete="off" />
    <button class="primary" id="connect">Connect</button>
  </div>
  <div id="msg"></div>

  <h2>Issue a license</h2>
  <div class="row">
    <input id="email" type="email" placeholder="customer@example.com" size="28" />
    <select id="tier"></select>
    <input id="months" type="number" min="1" max="120" value="12" size="5" />
    <button id="issue">Issue</button>
  </div>
  <p class="muted" id="issued"></p>

  <h2>Licenses</h2>
  <div class="row" style="margin-bottom:.6rem">
    <input id="q" placeholder="filter: email, license id, order id" size="34" />
    <button id="refresh">Refresh</button>
  </div>
  <table>
    <thead><tr><th>License</th><th>Email</th><th>Tier</th><th>Issued</th><th>Expires</th><th>Status</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

  <h2>Events</h2>
  <table>
    <thead><tr><th>When</th><th>Event</th><th>Provider</th><th>Order</th><th>Email</th><th>Note</th></tr></thead>
    <tbody id="events"></tbody>
  </table>
</main>
<script>
(function () {
  var TIERS = __TIERS_JSON__;
  var token = '';
  var $ = function (id) { return document.getElementById(id); };
  function msg(text, kind) {
    var m = $('msg');
    m.textContent = text || '';
    m.className = text ? (kind || 'err') : '';
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch('/admin/api' + path, {
      method: opts.method || 'GET',
      headers: { 'authorization': 'Bearer ' + token, 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function cell(row, text, cls) {
    var td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    if (cls) td.className = cls;
    row.appendChild(td);
    return td;
  }
  TIERS.forEach(function (t) {
    var o = document.createElement('option');
    o.value = t; o.textContent = t;
    $('tier').appendChild(o);
  });
  $('connect').onclick = function () {
    token = $('tok').value.trim();
    if (!token) { msg('paste the admin token first'); return; }
    msg('', '');
    load();
  };
  function load() {
    api('/licenses?q=' + encodeURIComponent($('q').value)).then(function (j) {
      var tb = $('rows');
      tb.textContent = '';
      (j.licenses || []).forEach(function (r) {
        var tr = document.createElement('tr');
        cell(tr, r.licenseId).appendChild(Object.assign(document.createElement('code'), { textContent: '' }));
        cell(tr, r.email);
        cell(tr, r.tier);
        cell(tr, r.issuedAt);
        cell(tr, r.expiry || 'never');
        cell(tr, r.status, 's-' + r.status);
        var acts = document.createElement('td');
        var re = document.createElement('button');
        re.textContent = 'Reissue';
        re.onclick = function () { doReissue(r.licenseId); };
        var rv = document.createElement('button');
        rv.className = 'danger'; rv.textContent = 'Revoke';
        rv.style.marginLeft = '.4rem';
        rv.onclick = function () { doRevoke(r.licenseId); };
        acts.appendChild(re); acts.appendChild(rv);
        tr.appendChild(acts);
        tb.appendChild(tr);
      });
      if (!(j.licenses || []).length) {
        var tr = document.createElement('tr');
        var td = cell(tr, 'no licenses yet');
        td.colSpan = 7; td.className = 'muted';
        tb.appendChild(tr);
      }
    }).catch(function (e) { msg(e.message); });
    api('/events?limit=50').then(function (j) {
      var tb = $('events');
      tb.textContent = '';
      (j.events || []).forEach(function (e) {
        var tr = document.createElement('tr');
        cell(tr, e.ts);
        cell(tr, e.event);
        cell(tr, e.provider);
        cell(tr, e.orderId);
        cell(tr, e.email);
        cell(tr, e.note);
        tb.appendChild(tr);
      });
    }).catch(function () { /* events are secondary */ });
  }
  function showToken(label, j) {
    $('issued').textContent = '';
    var box = document.createElement('div');
    box.className = 'token-out';
    var strong = document.createElement('strong');
    strong.textContent = label + ' — copy this token now, it is not shown again:';
    box.appendChild(strong);
    box.appendChild(document.createElement('br'));
    var code = document.createElement('code');
    code.textContent = j.token;
    box.appendChild(code);
    $('issued').textContent = '';
    $('issued').appendChild(box);
  }
  $('issue').onclick = function () {
    api('/licenses', { method: 'POST', body: { email: $('email').value, tier: $('tier').value, months: Number($('months').value) } })
      .then(function (j) { showToken('issued ' + j.licenseId, j); load(); })
      .catch(function (e) { msg(e.message); });
  };
  function doReissue(id) {
    api('/licenses/' + encodeURIComponent(id) + '/reissue', { method: 'POST', body: {} })
      .then(function (j) { showToken('reissued as ' + j.licenseId, j); load(); })
      .catch(function (e) { msg(e.message); });
  }
  function doRevoke(id) {
    api('/licenses/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: { reason: 'revoked from admin panel' } })
      .then(function () { msg('revoked ' + id + ' — an already-activated copy stays valid until it expires (offline licenses cannot be un-activated remotely)', 'ok'); load(); })
      .catch(function (e) { msg(e.message); });
  }
  $('refresh').onclick = load;
  $('q').onkeydown = function (e) { if (e.key === 'Enter') load(); };
})();
</script>
</body>
</html>
`;

const PANEL_HTML = PANEL_HTML_TEMPLATE.replace('__TIERS_JSON__', function () {
  return JSON.stringify(TIERS);
});

// ---- factory --------------------------------------------------------------------
// createAdmin(deps) -> { handler, store, invoices, events, TOKEN_ENV }
function createAdmin(deps) {
  deps = deps || {};
  const token = deps.token !== undefined ? deps.token : process.env[ADMIN_TOKEN_ENV];
  const now =
    deps.now ||
    function () {
      return new Date().toISOString();
    };
  const store =
    deps.store ||
    new LicenseStore({
      file: deps.storeFile || path.join(__dirname, 'state', 'licenses.json'),
      now: now,
    });
  const events =
    deps.events ||
    new EventLog({
      file: deps.eventLogFile || path.join(__dirname, 'state', 'events.jsonl'),
      now: now,
    });
  const invoices =
    deps.invoices !== undefined
      ? deps.invoices
      : new InvoiceStore({
          file: deps.invoiceFile || null,
          now: now,
        });
  const signLicense =
    deps.signLicense ||
    function (payload) {
      const sign = require('./sign');
      return sign.signLicense(payload, sign.loadPrivateKey());
    };
  const log =
    deps.log ||
    function (obj) {
      try {
        process.stdout.write(JSON.stringify(obj) + '\n');
      } catch {
        /* ignore */
      }
    };

  function authorized(req) {
    return tokenMatches(token, bearerFrom(req));
  }

  function mint(rec) {
    const payload = {
      tier: rec.tier,
      email: rec.email,
      expiry: rec.expiry,
      issued: rec.issuedAt,
    };
    if (rec.seats && rec.seats > 1) payload.seats = rec.seats;
    return signLicense(payload);
  }

  async function handleApi(req, res, pathname, query) {
    // GET  /admin/api/licenses[?email=&tier=&status=&q=&limit=]
    // POST /admin/api/licenses
    // GET  /admin/api/licenses/:id
    // POST /admin/api/licenses/:id/revoke
    // POST /admin/api/licenses/:id/reissue
    // GET  /admin/api/invoices[?provider=&currency=&status=&taxMode=&q=&limit=]
    // GET  /admin/api/plans
    // GET  /admin/api/events?limit=
    if (pathname === '/admin/api/licenses' && req.method === 'GET') {
      const list = store.list({
        email: query.get('email') || undefined,
        tier: query.get('tier') || undefined,
        status: query.get('status') || undefined,
        q: query.get('q') || undefined,
        limit: query.get('limit') || undefined,
      });
      sendJson(res, 200, { licenses: list, count: list.length });
      return;
    }

    if (pathname === '/admin/api/invoices' && req.method === 'GET') {
      const list = invoices
        ? invoices.list({
            provider: query.get('provider') || undefined,
            currency: query.get('currency') || undefined,
            status: query.get('status') || undefined,
            taxMode: query.get('taxMode') || undefined,
            email: query.get('email') || undefined,
            q: query.get('q') || undefined,
            limit: query.get('limit') || undefined,
          })
        : [];
      const summary = invoices ? invoices.revenueSummary() : null;
      sendJson(res, 200, { invoices: list, count: list.length, summary: summary });
      return;
    }

    if (pathname === '/admin/api/plans' && req.method === 'GET') {
      sendJson(res, 200, { plans: PLANS_CATALOG });
      return;
    }

    if (pathname === '/admin/api/licenses' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'bad json body' });
        return;
      }
      const tier = String(body.tier || '');
      if (TIERS.indexOf(tier) === -1) {
        sendJson(res, 400, { error: 'tier must be one of ' + TIERS.join(', ') });
        return;
      }
      const email = normalizeEmail(body.email);
      if (email === null) {
        sendJson(res, 400, { error: 'invalid email' });
        return;
      }
      const months = Number(body.months);
      if (!Number.isFinite(months) || months < 1 || months > 120) {
        sendJson(res, 400, { error: 'months must be between 1 and 120' });
        return;
      }
      const seats = body.seats != null ? Number(body.seats) : 1;
      if (!Number.isInteger(seats) || seats < 1 || seats > 1000) {
        sendJson(res, 400, { error: 'seats must be an integer between 1 and 1000' });
        return;
      }
      const rec = store.create({ email: email, tier: tier, months: months, seats: seats, source: 'admin' });
      let tok;
      try {
        tok = mint(rec);
      } catch {
        store.revoke(rec.licenseId, 'mint failed');
        log({ evt: 'admin.issue', status: 500, licenseId: rec.licenseId, reason: 'sign-failed' });
        sendJson(res, 500, { error: 'minting failed' });
        return;
      }
      if (invoices && body.amount != null && Number.isFinite(Number(body.amount))) {
        invoices.recordPurchase({
          orderId: body.orderId || 'admin_' + rec.licenseId,
          licenseId: rec.licenseId,
          provider: body.provider || 'admin',
          email: rec.email,
          tier: rec.tier,
          seats: rec.seats,
          months: rec.months,
          amount: Number(body.amount),
          currency: body.currency || 'TRY',
          countryCode: body.countryCode || (body.currency === 'USD' ? 'INTL' : 'TR'),
          issuedAt: rec.issuedAt,
        });
      }
      events.append({
        event: 'license.issued',
        source: 'admin',
        licenseId: rec.licenseId,
        email: rec.email,
        tier: rec.tier,
        seats: rec.seats,
        note: 'issued from admin panel',
      });
      log({ evt: 'admin.issue', status: 200, licenseId: rec.licenseId, tier: rec.tier });
      sendJson(res, 201, {
        licenseId: rec.licenseId,
        email: rec.email,
        tier: rec.tier,
        seats: rec.seats,
        issuedAt: rec.issuedAt,
        expiry: rec.expiry,
        token: tok,
      });
      return;
    }

    const one = /^\/admin\/api\/licenses\/([^/]+)$/.exec(pathname);
    if (one && req.method === 'GET') {
      const rec = store.get(decodeURIComponent(one[1]));
      if (!rec) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, rec);
      return;
    }

    const act = /^\/admin\/api\/licenses\/([^/]+)\/(revoke|reissue)$/.exec(pathname);
    if (act && req.method === 'POST') {
      const id = decodeURIComponent(act[1]);
      const rec = store.get(id);
      if (!rec) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      if (act[2] === 'revoke') {
        const r = store.revoke(id, body.reason);
        if (!r.ok) {
          sendJson(res, r.reason === 'not-found' ? 404 : 409, { error: r.reason });
          return;
        }
        events.append({
          event: 'license.revoked',
          licenseId: id,
          email: rec.email,
          tier: rec.tier,
          note: r.record.revokeReason,
        });
        log({ evt: 'admin.revoke', status: 200, licenseId: id });
        sendJson(res, 200, r.record);
        return;
      }
      const fresh = store.create({
        email: rec.email,
        tier: rec.tier,
        seats: rec.seats || 1,
        months: Number.isFinite(Number(body.months)) && Number(body.months) > 0 ? Number(body.months) : rec.months,
        source: 'admin',
        supersedes: id,
      });
      store.supersede(id, fresh);
      let tok;
      try {
        tok = mint(fresh);
      } catch {
        log({ evt: 'admin.reissue', status: 500, licenseId: fresh.licenseId, reason: 'sign-failed' });
        sendJson(res, 500, { error: 'minting failed' });
        return;
      }
      events.append({
        event: 'license.reissued',
        licenseId: fresh.licenseId,
        email: fresh.email,
        tier: fresh.tier,
        note: 'supersedes ' + id,
      });
      log({ evt: 'admin.reissue', status: 200, licenseId: fresh.licenseId, supersedes: id });
      sendJson(res, 201, {
        licenseId: fresh.licenseId,
        email: fresh.email,
        tier: fresh.tier,
        seats: fresh.seats,
        issuedAt: fresh.issuedAt,
        expiry: fresh.expiry,
        supersedes: id,
        token: tok,
      });
      return;
    }

    if (pathname === '/admin/api/events' && req.method === 'GET') {
      const list = events.recent(query.get('limit') || 100);
      sendJson(res, 200, { events: list, count: list.length });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  const handler = function (req, res) {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'bad url' });
      return;
    }
    const pathname = parsed.pathname;

    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
      sendHtml(res, 200, PANEL_HTML);
      return;
    }

    if (!pathname.startsWith('/admin/api')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    if (!token) {
      sendJson(res, 503, { error: 'admin panel disabled (set ' + ADMIN_TOKEN_ENV + ')' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    handleApi(req, res, pathname, parsed.searchParams).catch(function () {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  };

  return {
    handler: handler,
    store: store,
    invoices: invoices,
    events: events,
    TOKEN_ENV: ADMIN_TOKEN_ENV,
    panelHtml: PANEL_HTML,
  };
}

module.exports = {
  createAdmin: createAdmin,
  tokenMatches: tokenMatches,
  bearerFrom: bearerFrom,
  ADMIN_TOKEN_ENV: ADMIN_TOKEN_ENV,
  PANEL_HTML: PANEL_HTML,
};
