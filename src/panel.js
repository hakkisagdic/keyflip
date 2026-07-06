'use strict';
// G1: `keyflip panel` — a command-activated LOCAL web dashboard (loopback only, never a
// daemon; the user starts/stops it). Read-only v1: it aggregates keyflip state (accounts +
// cached quota, providers, recent sessions, keepsakes) and renders it. Zero-dep (Node http +
// inline HTML/CSS/JS). No mutation surface → nothing dangerous is exposed over HTTP.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Aggregate the dashboard state. FAST — reads the cached usage (no network fetch) and bounds
// the session/keepsake lists. Never throws (a panel must not crash on partial data).
function buildState(ctx) {
  const core = require('./core');
  const provider = require('./provider');
  const sessions = require('./sessions');
  const memory = require('./memory');

  let usageCache = {};
  try { usageCache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')) || {}; } catch (e) { usageCache = {}; }

  // G5: per-account 5h utilization trend (chronological) from the usage-history log.
  const trendByAccount = {};
  safe(function () {
    require('./history').readUsage(ctx, 1000).forEach(function (s) {
      if (s && s.account != null && typeof s.fiveHour === 'number') { (trendByAccount[s.account] = trendByAccount[s.account] || []).push(s.fiveHour); }
    });
  }, null);

  const accounts = safe(function () {
    return core.listProfiles(ctx).map(function (p) {
      const u = usageCache[p.name] && usageCache[p.name].usage;
      let fiveHour = null, sevenDay = null;
      if (u) {
        if (u.fiveHour && typeof u.fiveHour.pct === 'number') fiveHour = u.fiveHour.pct;
        if (u.sevenDay && typeof u.sevenDay.pct === 'number') sevenDay = u.sevenDay.pct;
      }
      return { name: p.name, email: p.email || null, active: !!p.active, fiveHourPct: fiveHour, sevenDayPct: sevenDay, trend: (trendByAccount[p.name] || []).slice(-24) };
    });
  }, []);

  const active = safe(function () { return provider.readActive(ctx); }, null);
  const providers = safe(function () {
    return provider.list(ctx).map(function (n) { const m = provider.read(ctx, n) || {}; return { name: n, baseUrl: m.baseUrl || null, active: !!(active && active.name === n) }; });
  }, []);

  // One enumeration feeds both the recent list AND the activity calendar (G5).
  const allSessions = safe(function () { return sessions.list(ctx, { limit: 1500 }); }, []);
  const recent = allSessions.slice(0, 12).map(function (r) { return { sessionId: r.sessionId, cwd: r.cwd || null, mtime: r.mtime, preview: r.preview || '', orphan: !!r.orphan }; });

  const keepsakes = safe(function () {
    return memory.list(ctx).slice(0, 12).map(function (m) { return { key: m.key, mtime: m.mtime, bytes: m.bytes }; });
  }, []);

  return {
    activeEmail: safe(function () { return core.currentEmail(ctx); }, null),
    activeProvider: active && active.name,
    accounts: accounts,
    providers: providers,
    sessions: recent,
    keepsakes: keepsakes,
    activity: safe(function () { return buildActivity(ctx, allSessions); }, { days: [], max: 0, total: 0, weeks: 26 }),
    memoryGraph: safe(function () { return buildMemoryGraph(ctx); }, { nodes: [], edges: [] }),
  };
}
function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }

// G5: GitHub-style session-activity calendar — session counts per UTC day over the last
// ~26 weeks, Sunday-aligned so the client can chunk the days array into 7-row week columns.
function buildActivity(ctx, sessionRows) {
  const DAY = 86400000, WEEKS = 26;
  const counts = {};
  (sessionRows || []).forEach(function (r) {
    if (!r || !r.mtime) return;
    const t = Date.parse(r.mtime);
    if (isNaN(t)) return;
    const k = new Date(t).toISOString().slice(0, 10);
    counts[k] = (counts[k] || 0) + 1;
  });
  let today = new Date(Date.parse(ctx.now()));
  if (isNaN(today.getTime())) today = new Date();
  today = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let start = new Date(today.getTime() - (WEEKS * 7 - 1) * DAY);
  start = new Date(start.getTime() - start.getUTCDay() * DAY); // back up to Sunday
  const days = [];
  let max = 0, total = 0; // total = sessions WITHIN the shown window (matches the label)
  for (let t = start.getTime(); t <= today.getTime(); t += DAY) {
    const k = new Date(t).toISOString().slice(0, 10);
    const c = counts[k] || 0;
    if (c > max) max = c;
    total += c;
    days.push({ date: k, count: c });
  }
  return { days: days, max: max, total: total, weeks: WEEKS };
}

// G5: memory "constellation" — keepsakes are nodes; an edge joins two keepsakes that share
// >=2 of their top terms (ties into dreaming/distillation). Bounded + zero-dep (reuses the
// recall tokenizer). Layout (circle) is done client-side.
function buildMemoryGraph(ctx) {
  const memory = require('./memory');
  const recall = require('./recall');
  let list; try { list = memory.list(ctx).slice(0, 24); } catch (e) { return { nodes: [], edges: [] }; }
  const nodes = list.map(function (m) {
    let text = ''; try { text = memory.read(ctx, m.key) || ''; } catch (e) { text = ''; }
    const freq = {};
    recall.tokenize(text).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    const top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 6);
    return { key: m.key, terms: top };
  });
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[i].terms.filter(function (t) { return t && nodes[j].terms.indexOf(t) !== -1; });
      if (shared.length >= 2) edges.push({ a: i, b: j, weight: shared.length });
    }
  }
  return { nodes: nodes, edges: edges };
}

// G8: a SHARE-SAFE snapshot of the dashboard — accounts + quota + activity + providers ONLY.
// Deliberately EXCLUDES anything that carries private content (session cwds/previews,
// keepsakes, the memory constellation's terms). `anon` masks emails + account/provider names.
function buildSnapshot(ctx, opts) {
  opts = opts || {};
  const s = buildState(ctx);
  const maskEmail = function (e, i) {
    if (!e) return 'account ' + (i + 1);
    if (!opts.anon) return e;
    const at = e.indexOf('@');
    return at > 0 ? e[0] + '…@' + e.slice(at + 1).split('.')[0][0] + '…' : e[0] + '…';
  };
  return {
    generatedAt: safe(function () { return ctx.now(); }, null),
    activeEmail: opts.anon ? null : s.activeEmail,
    accounts: (s.accounts || []).map(function (a, i) {
      return { label: maskEmail(a.email || a.name, i), active: a.active, fiveHourPct: a.fiveHourPct, sevenDayPct: a.sevenDayPct, trend: a.trend };
    }),
    providers: (s.providers || []).map(function (p, i) { return { name: opts.anon ? 'provider ' + (i + 1) : p.name, active: p.active }; }),
    activity: s.activity,
    anon: !!opts.anon,
  };
}

// Render the snapshot as a FULLY STATIC, self-contained HTML file — no server, no client JS,
// no network. Everything (quota bars, sparklines, activity calendar) is rendered server-side
// as inline SVG, so the file works offline and reveals nothing beyond what's baked in.
function renderSnapshot(snap) {
  const esc = function (s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
  const pct = function (p) { return p == null ? '—' : Math.round(p) + '%'; };
  const barCls = function (p) { return p == null ? 'bar' : p >= 90 ? 'bar crit' : p >= 70 ? 'bar hi' : 'bar'; };
  const cards = (snap.accounts || []).map(function (a) {
    const w = a.fiveHourPct == null ? 0 : Math.min(100, a.fiveHourPct);
    return '<div class="card' + (a.active ? ' active' : '') + '"><div class="email">' + esc(a.label) + (a.active ? ' ✓' : '') + '</div>' +
      '<div class="' + barCls(a.fiveHourPct) + '"><i style="width:' + w + '%"></i></div>' +
      '<div class="barlabel"><span>5h ' + pct(a.fiveHourPct) + '</span><span>7d ' + pct(a.sevenDayPct) + '</span></div>' + sparkSvg(a.trend) + '</div>';
  }).join('') || '<span class="muted">No saved accounts.</span>';
  const chips = (snap.providers || []).map(function (p) { return '<span class="chip' + (p.active ? ' active' : '') + '">' + esc(p.name) + (p.active ? ' ●' : '') + '</span>'; }).join('') || '<span class="muted">No providers.</span>';
  const act = snap.activity || { days: [], total: 0, weeks: 26 };
  const when = snap.generatedAt ? String(snap.generatedAt).slice(0, 16).replace('T', ' ') : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>keyflip snapshot</title>' +
    '<style>' + STYLE + '</style></head><body>' +
    '<header><h1>⚡ keyflip</h1><span class="muted">shared snapshot' + (when ? ' · ' + esc(when) : '') + (snap.anon ? ' · anonymized' : '') + '</span></header>' +
    '<main>' +
    '<section><h2>Accounts</h2><div class="grid">' + cards + '</div></section>' +
    '<section><h2>Session activity <span class="muted">' + (act.total ? '· ' + act.total + ' session' + (act.total === 1 ? '' : 's') + ', last ' + (act.weeks || 26) + ' weeks' : '') + '</span></h2>' + calendarSvg(act) + '</section>' +
    '<section><h2>Providers</h2><div class="chips">' + chips + '</div></section>' +
    '</main><footer class="muted">Read-only static snapshot · no session content, no secrets.</footer>' +
    '</body></html>';
}

// Server-side inline SVG builders (mirror the panel client so the static file needs no JS).
function sparkSvg(v) {
  if (!v || v.length < 2) return '';
  const w = 200, h = 26, n = v.length;
  const pts = v.map(function (x, i) { const px = (i / (n - 1)) * w; const py = h - (Math.max(0, Math.min(100, x)) / 100) * (h - 2) - 1; return px.toFixed(1) + ',' + py.toFixed(1); }).join(' ');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><polyline points="' + pts + '" /></svg>';
}
function calendarSvg(a) {
  const d = (a && a.days) || [];
  if (!d.length) return '<span class="muted">No session activity yet.</span>';
  const S = 13, cols = Math.ceil(d.length / 7);
  const lvl = function (c, max) { if (!c) return 0; if (max <= 1) return 4; const r = c / max; return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1; };
  const esc = function (s) { return String(s).replace(/[<>&]/g, ''); };
  const cells = d.map(function (x, i) { const col = Math.floor(i / 7), row = i % 7; return '<rect class="l' + lvl(x.count, a.max) + '" x="' + (col * S) + '" y="' + (row * S) + '" width="11" height="11"><title>' + esc(x.date) + ': ' + x.count + '</title></rect>'; }).join('');
  return '<svg class="cal" viewBox="0 0 ' + (cols * S) + ' ' + (7 * S) + '" preserveAspectRatio="xMinYMin meet">' + cells + '</svg>';
}

// The single-page dashboard. Self-contained (inline CSS/JS); fetches /api/state and renders.
function renderPage() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>keyflip panel</title>' +
    '<style>' + STYLE + '</style></head><body>' +
    '<header><h1>⚡ keyflip</h1><span id="active" class="muted"></span><button id="refresh">↻</button></header>' +
    '<main>' +
    '<section><h2>Accounts</h2><div id="accounts" class="grid"></div></section>' +
    '<section><h2>Session activity <span id="activity-total" class="muted"></span></h2><div id="activity"></div></section>' +
    '<section><h2>Providers</h2><div id="providers" class="chips"></div></section>' +
    '<section><h2>Recent sessions</h2><ul id="sessions" class="list"></ul></section>' +
    '<section><h2>Keepsakes</h2><ul id="keepsakes" class="list"></ul></section>' +
    '<section><h2>Memory constellation</h2><div id="memgraph"></div></section>' +
    '</main><footer class="muted">Read-only · loopback only · <code>Ctrl-C</code> in the terminal to stop.</footer>' +
    '<script>' + SCRIPT + '</script></body></html>';
}

const STYLE = [
  ':root{--bg:#0f1115;--card:#1a1d24;--fg:#e6e8ec;--muted:#8b909a;--accent:#7aa2f7;--ok:#6ccf8e;--warn:#e0af68;--bad:#f7768e;--bar:#2a2e37}',
  '@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--fg:#1a1d24;--muted:#6b7280;--bar:#e5e7eb}}',
  '*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}',
  'header{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:1px solid var(--bar);position:sticky;top:0;background:var(--bg)}',
  'header h1{font-size:18px;margin:0}#refresh{margin-left:auto;background:var(--card);color:var(--fg);border:1px solid var(--bar);border-radius:8px;padding:4px 10px;cursor:pointer}',
  'main{padding:18px 22px;max-width:1000px;margin:0 auto}section{margin-bottom:26px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 10px}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}',
  '.card{background:var(--card);border:1px solid var(--bar);border-radius:12px;padding:14px}',
  '.card.active{border-color:var(--accent)}.card .email{font-weight:600;word-break:break-all}.card .name{color:var(--muted);font-size:12px}',
  '.bar{height:6px;background:var(--bar);border-radius:4px;margin-top:8px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--ok)}',
  '.spark{width:100%;height:26px;margin-top:8px;display:block}.spark polyline{fill:none;stroke:var(--accent);stroke-width:1.5;vector-effect:non-scaling-stroke}',
  '.bar.hi>i{background:var(--warn)}.bar.crit>i{background:var(--bad)}.barlabel{font-size:11px;color:var(--muted);display:flex;justify-content:space-between;margin-top:6px}',
  '.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{background:var(--card);border:1px solid var(--bar);border-radius:20px;padding:5px 12px;font-size:13px}.chip.active{border-color:var(--accent);color:var(--accent)}',
  '.list{list-style:none;margin:0;padding:0}.list li{background:var(--card);border:1px solid var(--bar);border-radius:10px;padding:10px 12px;margin-bottom:8px}',
  '.list .meta{color:var(--muted);font-size:12px}.badge{font-size:11px;color:var(--bad)}.muted{color:var(--muted)}code{background:var(--bar);padding:1px 5px;border-radius:4px}',
  '.cal{width:100%;max-width:100%;height:auto;display:block;overflow:visible}.cal rect{rx:2}',
  '.cal .l0{fill:var(--bar)}.cal .l1{fill:#0e4429}.cal .l2{fill:#26a641}.cal .l3{fill:#39d353}.cal .l4{fill:#57ff6b}',
  '@media(prefers-color-scheme:light){.cal .l1{fill:#9be9a8}.cal .l2{fill:#40c463}.cal .l3{fill:#30a14e}.cal .l4{fill:#216e39}}',
  '.callegend{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:4px;justify-content:flex-end;margin-top:6px}',
  '.mg{width:100%;max-width:440px;height:auto;display:block;margin:0 auto}.mg line{stroke:var(--accent);stroke-opacity:.35}.mg circle{fill:var(--accent);stroke:var(--card);stroke-width:1.5}.mg text{fill:var(--muted);font-size:10px}',
  'footer{padding:14px 22px;border-top:1px solid var(--bar);font-size:12px}',
].join('');

const SCRIPT = [
  'function pct(p){return p==null?"—":Math.round(p)+"%"}',
  'function barClass(p){return p==null?"":p>=90?"bar crit":p>=70?"bar hi":"bar"}',
  'function spark(v){if(!v||v.length<2)return "";var w=200,h=26,n=v.length;var pts=v.map(function(x,i){var px=(i/(n-1))*w;var py=h-(Math.max(0,Math.min(100,x))/100)*(h-2)-1;return px.toFixed(1)+","+py.toFixed(1);}).join(" ");return "<svg class=spark viewBox=\\"0 0 "+w+" "+h+"\\" preserveAspectRatio=none><polyline points=\\""+pts+"\\"/></svg>";}',
  'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;"}[c]})}',
  'function calLevel(c,max){if(!c)return 0;if(max<=1)return 4;var r=c/max;return r>0.75?4:r>0.5?3:r>0.25?2:1;}',
  'function calendar(a){var d=(a&&a.days)||[];if(!d.length)return "<span class=muted>No session activity yet.</span>";var S=13,cols=Math.ceil(d.length/7);var cells=d.map(function(x,i){var col=Math.floor(i/7),row=i%7,lv=calLevel(x.count,a.max);return "<rect class=l"+lv+" x="+(col*S)+" y="+(row*S)+" width=11 height=11><title>"+esc(x.date)+": "+x.count+" session"+(x.count===1?"":"s")+"</title></rect>";}).join("");var leg="<div class=callegend><span>Less</span><svg class=cal width=68 height=11 viewBox=\\"0 0 65 11\\" style=\\"width:65px\\"><rect class=l0 x=0 y=0 width=11 height=11 /><rect class=l1 x=13 y=0 width=11 height=11 /><rect class=l2 x=26 y=0 width=11 height=11 /><rect class=l3 x=39 y=0 width=11 height=11 /><rect class=l4 x=52 y=0 width=11 height=11 /></svg><span>More</span></div>";return "<svg class=cal viewBox=\\"0 0 "+(cols*S)+" "+(7*S)+"\\" preserveAspectRatio=\\"xMinYMin meet\\">"+cells+"</svg>"+leg;}',
  'function memgraph(g){var ns=(g&&g.nodes)||[],es=(g&&g.edges)||[];if(!ns.length)return "<span class=muted>No keepsakes yet — try <code>keyflip dream --apply</code>.</span>";var W=360,H=320,cx=W/2,cy=H/2,R=118,n=ns.length;var pos=ns.map(function(_,i){var ang=-Math.PI/2+2*Math.PI*i/n;return {x:cx+R*Math.cos(ang),y:cy+R*Math.sin(ang),ang:ang};});var lines=es.map(function(e){var p=pos[e.a],q=pos[e.b];return "<line x1="+p.x.toFixed(1)+" y1="+p.y.toFixed(1)+" x2="+q.x.toFixed(1)+" y2="+q.y.toFixed(1)+" stroke-width="+Math.min(3,e.weight)+" />";}).join("");var dots=ns.map(function(nd,i){var p=pos[i],lx=cx+(R+12)*Math.cos(p.ang),ly=cy+(R+12)*Math.sin(p.ang),anchor=Math.cos(p.ang)<-0.3?"end":Math.cos(p.ang)>0.3?"start":"middle";return "<circle cx="+p.x.toFixed(1)+" cy="+p.y.toFixed(1)+" r=5><title>"+esc(nd.key)+" — "+esc((nd.terms||[]).join(", "))+"</title></circle><text x="+lx.toFixed(1)+" y="+ly.toFixed(1)+" text-anchor="+anchor+" dominant-baseline=middle>"+esc(String(nd.key).slice(0,6))+"</text>";}).join("");return "<svg class=mg viewBox=\\"0 0 "+W+" "+H+"\\">"+lines+dots+"</svg>";}',
  'async function load(){',
  ' const s=await (await fetch("/api/state")).json();',
  ' document.getElementById("active").textContent=(s.activeEmail||"not logged in")+(s.activeProvider?" → "+s.activeProvider:"");',
  ' document.getElementById("accounts").innerHTML=(s.accounts||[]).map(function(a){',
  '  var use=a.fiveHourPct; var bl=barClass(use); var w=(use==null?0:Math.min(100,use));',
  '  return "<div class=\\"card"+(a.active?" active":"")+"\\"><div class=\\"email\\">"+esc(a.email||a.name)+(a.active?" ✓":"")+"</div><div class=\\"name\\">"+esc(a.name)+"</div>"+',
  '   "<div class=\\""+bl+"\\"><i style=\\"width:"+w+"%\\"></i></div><div class=\\"barlabel\\"><span>5h "+pct(a.fiveHourPct)+"</span><span>7d "+pct(a.sevenDayPct)+"</span></div>"+spark(a.trend)+"</div>";',
  ' }).join("")||"<span class=muted>No saved accounts.</span>";',
  ' document.getElementById("providers").innerHTML=(s.providers||[]).map(function(p){return "<span class=\\"chip"+(p.active?" active":"")+"\\">"+esc(p.name)+(p.active?" ●":"")+"</span>";}).join("")||"<span class=muted>No providers.</span>";',
  ' document.getElementById("sessions").innerHTML=(s.sessions||[]).map(function(r){return "<li><div>"+esc((r.sessionId||"").slice(0,8))+" <span class=meta>"+esc(r.cwd||"")+"</span>"+(r.orphan?" <span class=badge>⚠ folder gone</span>":"")+"</div>"+(r.preview?"<div class=meta>"+esc(r.preview)+"</div>":"")+"</li>";}).join("")||"<li class=muted>No sessions.</li>";',
  ' document.getElementById("keepsakes").innerHTML=(s.keepsakes||[]).map(function(k){return "<li>"+esc(k.key.slice(0,8))+" <span class=meta>"+esc((k.mtime||"").slice(0,16).replace("T"," "))+"</span></li>";}).join("")||"<li class=muted>No keepsakes yet — try <code>keyflip dream --apply</code>.</li>";',
  ' var a=s.activity||{};document.getElementById("activity-total").textContent=a.total?("· "+a.total+" session"+(a.total===1?"":"s")+", last "+(a.weeks||26)+" weeks"):"";',
  ' document.getElementById("activity").innerHTML=calendar(a);',
  ' document.getElementById("memgraph").innerHTML=memgraph(s.memoryGraph);',
  '}',
  'document.getElementById("refresh").onclick=load;load();',
].join('\n');

// Command-activated server — loopback only, read-only. Returns { server, port, url }.
function serve(ctx, opts) {
  opts = opts || {};
  const host = opts.host || '127.0.0.1';
  const server = http.createServer(function (req, res) {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const urlPath = String(req.url || '').split('?')[0]; // ignore any query string
    if (urlPath === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(buildState(ctx)));
      return;
    }
    if (urlPath === '/' || urlPath === '/index.html') {
      // no-store so a reopened panel never renders a stale page against fresh /api/state.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderPage());
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise(function (resolve, reject) {
    server.on('error', reject);
    server.listen(opts.port != null ? opts.port : 8899, host, function () {
      const port = server.address() && server.address().port;
      resolve({ server: server, port: port, url: 'http://' + host + ':' + port });
    });
  });
}

module.exports = { buildState: buildState, buildActivity: buildActivity, buildMemoryGraph: buildMemoryGraph, buildSnapshot: buildSnapshot, renderSnapshot: renderSnapshot, renderPage: renderPage, serve: serve };
