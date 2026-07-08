'use strict';
// E5: `keyflip ui` — a self-contained full-screen TUI dashboard (zero-dep ANSI). The design
// SPLITS pure logic from IO so the whole surface is unit-testable without a TTY: render(state)
// -> a STRING frame, reducer(state,key) -> the next state (navigation/filter/effects), and
// buildState(ctx,opts) -> the display state (accounts + 5h/7d usage bars, providers, fleet
// summary), reusing core.listProfiles + a PASSED-IN usage snapshot so tests need no network.
// run() is a thin interactive loop: raw-mode stdin, alt-screen, SIGWINCH, render each frame,
// and Enter performs a switch via an injected opts.onSwitch (default core.performSwitch, which
// the CLI wraps in its lock). All escape/cleanup is restored on exit.
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJsonForWrite } = require('./fsutil');

const BARW = 12;           // width of a usage bar
const CSI = '\x1b[';       // ANSI Control Sequence Introducer

// ---- keymap (the keys the reducer understands, for the footer + docs) ----
const KEYMAP = [
  { keys: ['↑', '↓'], label: 'move' },
  { keys: ['enter'], label: 'switch' },
  { keys: ['r'], label: 'refresh' },
  { keys: ['f'], label: 'fleet' },
  { keys: ['/'], label: 'filter' },
  { keys: ['q'], label: 'quit' },
];

// ---- small pure helpers ----
function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
function clamp(i, len) { if (!len || len <= 0) return 0; return Math.max(0, Math.min(i, len - 1)); }
// Strip control chars (incl. NUL/ESC/newline) so a semi-trusted string (a peer machine name, a
// crafted email) can never inject ANSI, spill onto a new row, or corrupt the frame geometry.
// eslint-disable-next-line no-control-regex
function scrub(s) { return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, ' '); }
// Unicode-aware truncate/pad to an exact column count (block glyphs are BMP, but be surrogate-safe).
function clip(s, width) { const a = Array.from(String(s)); return a.length <= width ? String(s) : a.slice(0, width).join(''); }
function padEnd(s, width) { const n = Array.from(String(s)).length; return n >= width ? String(s) : s + ' '.repeat(width - n); }
function inv(s) { return CSI + '7m' + s + CSI + '0m'; }
function dimc(s) { return CSI + '2m' + s + CSI + '0m'; }

function pctOf(u, win) { const w = u && u.usage && u.usage[win]; return (w && typeof w.pct === 'number') ? w.pct : null; }
function pctLbl(pct) { return pct == null ? '  ?' : String(Math.round(Math.max(0, Math.min(100, pct)))).padStart(3) + '%'; }
function bar(pct, w) {
  if (pct == null) return '[' + '·'.repeat(w) + ']';
  const p = Math.max(0, Math.min(100, pct));
  const f = Math.round((p / 100) * w);
  return '[' + '█'.repeat(f) + '░'.repeat(w - f) + ']';
}

// Filtered account list (name/email substring, case-insensitive). Pure over state.
function visible(state) {
  const list = (state && state.accounts) || [];
  const f = String((state && state.filter) || '').trim().toLowerCase();
  if (!f) return list;
  return list.filter(function (a) {
    return String(a.name || '').toLowerCase().indexOf(f) !== -1 ||
           String(a.email || '').toLowerCase().indexOf(f) !== -1;
  });
}
function selectedName(state) { const a = visible(state)[state ? state.sel : 0]; return (a && a.name) || null; }
function firstNonActive(accounts) { for (let i = 0; i < accounts.length; i++) { if (!accounts[i].active) return i; } return 0; }

// ---- UI preferences (persisted as <configDir>/.tui.json, dot-prefixed so profiles.list() never
// mistakes it for an account — keyflip has no daemon, so this is the only cross-run TUI state) ----
function prefsPath(ctx) { return path.join(ctx.configDir, '.tui.json'); }
function sanitizePrefs(p) { const out = {}; if (p && typeof p === 'object' && !Array.isArray(p)) { if (p.view === 'fleet' || p.view === 'accounts') out.view = p.view; } return out; }
function loadPrefs(ctx) { try { return sanitizePrefs(readJsonForWrite(prefsPath(ctx))); } catch (e) { return {}; } }
function savePrefs(ctx, prefs) { try { atomicWrite(prefsPath(ctx), JSON.stringify(sanitizePrefs(prefs), null, 2), 0o600); return true; } catch (e) { return false; } }

// A local, side-effect-free fleet summary. We read the rendezvous config file DIRECTLY (never
// fleet.identity(), which would lazily create files + generate keys) so buildState stays cheap and
// hermetic. Peer detail requires the fleet passphrase, so callers can inject opts.fleet instead.
function fleetSummary(ctx) {
  let id = {};
  try { id = JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'fleet.json'), 'utf8')) || {}; } catch (e) { id = {}; }
  return { configured: !!id.dir, name: id.name || null, machineId: id.machineId || null, peers: [] };
}

// ---- buildState: gather the display + initial navigation state ----
// Reuses core.listProfiles + provider.*; the usage snapshot is INJECTED (opts.usage, in the
// shape usage.usageForProfiles returns: name -> { status, usage:{fiveHour:{pct},sevenDay:{pct}} }),
// falling back to the on-disk .usage-cache.json (no network). Tests inject and need nothing live.
function buildState(ctx, opts) {
  opts = opts || {};
  const core = require('./core');
  const provider = require('./provider');
  const snap = usageLookup(opts.usage != null ? opts.usage : readUsageCache(ctx));

  const accounts = safe(function () {
    return core.listProfiles(ctx).map(function (p) {
      const u = snap[p.name];
      return {
        name: p.name, email: p.email || null, active: !!p.active,
        fiveHourPct: pctOf(u, 'fiveHour'), sevenDayPct: pctOf(u, 'sevenDay'),
        status: (u && u.status) || 'unknown',
      };
    });
  }, []);

  const active = safe(function () { return provider.readActive(ctx); }, null);
  const providers = safe(function () {
    return provider.list(ctx).map(function (n) { const m = provider.read(ctx, n) || {}; return { name: n, baseUrl: m.baseUrl || null, active: !!(active && active.name === n) }; });
  }, []);

  const prefs = loadPrefs(ctx);
  const view = (opts.view || prefs.view) === 'fleet' ? 'fleet' : 'accounts';

  return {
    now: safe(function () { return ctx.now(); }, null),
    activeEmail: safe(function () { return core.currentEmail(ctx); }, null),
    activeProvider: (active && active.name) || null,
    accounts: accounts,
    providers: providers,
    fleet: opts.fleet || fleetSummary(ctx),
    // navigation state (mutated only through reducer)
    sel: firstNonActive(accounts),
    view: view,
    filter: '',
    filtering: false,
    pending: null,   // an effect for run() to perform: {type:'switch',name} | {type:'refresh'}
    message: null,   // transient status line
    quit: false,
  };
}

// Proto-safe copy of a name-keyed map (a profile name could be '__proto__'/'constructor').
function usageLookup(map) {
  const out = Object.create(null);
  if (map && typeof map === 'object' && !Array.isArray(map)) Object.keys(map).forEach(function (k) { out[k] = map[k]; });
  return out;
}
function readUsageCache(ctx) {
  try { const c = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')); return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {}; }
  catch (e) { return {}; }
}

// ---- reducer: pure navigation. (state, key) -> next state. Never mutates the input. ----
// `key` is a STRING: a multi-char name for specials ('up','down','enter','escape','backspace',
// 'quit') or a single character for literal input ('r','f','/','q','1',...). Meaning depends on
// mode: in filter mode single chars are TYPED into the filter, so 'q' does not quit there.
function reducer(state, key) {
  const s = Object.assign({}, state);
  s.pending = null;   // effects are consumed each tick
  s.message = null;   // transient
  return state && state.filtering ? reduceFilter(s, key) : reduceNormal(s, key);
}
function reduceNormal(s, key) {
  const max = visible(s).length;
  if (key === 'quit' || key === 'q' || key === 'escape') { s.quit = true; return s; }
  if (key === 'up' || key === 'k') { s.sel = clamp(s.sel - 1, max); return s; }
  if (key === 'down' || key === 'j') { s.sel = clamp(s.sel + 1, max); return s; }
  if (key === 'r') { s.pending = { type: 'refresh' }; return s; }
  if (key === 'f') { s.view = s.view === 'fleet' ? 'accounts' : 'fleet'; s.sel = 0; return s; }
  if (key === '/') { s.filtering = true; return s; }
  if (key === 'enter') {
    if (s.view !== 'accounts') return s;
    const a = visible(s)[s.sel];
    if (!a) return s;
    if (a.active) { s.message = "'" + (a.email || a.name) + "' is already active."; return s; }
    s.pending = { type: 'switch', name: a.name };
    return s;
  }
  if (typeof key === 'string' && /^[0-9]$/.test(key)) { const i = parseInt(key, 10); if (i >= 1 && i <= max) s.sel = i - 1; return s; }
  return s;
}
function reduceFilter(s, key) {
  if (key === 'quit') { s.quit = true; return s; }
  if (key === 'escape') { s.filtering = false; s.filter = ''; s.sel = 0; return s; }
  if (key === 'enter') { s.filtering = false; s.sel = clamp(s.sel, visible(s).length); return s; }
  if (key === 'backspace') { s.filter = String(s.filter || '').slice(0, -1); s.sel = 0; return s; }
  if (key === 'up') { s.sel = clamp(s.sel - 1, visible(s).length); return s; }
  if (key === 'down') { s.sel = clamp(s.sel + 1, visible(s).length); return s; }
  if (typeof key === 'string' && key.length === 1) { s.filter = String(s.filter || '') + key; s.sel = 0; return s; }
  return s;
}

// ---- render: pure. (state, {width,height,color}) -> a STRING frame of exactly `height` rows. ----
function render(state, dims) {
  state = state || {};
  dims = dims || {};
  const width = Math.max(24, dims.width || 80);
  const height = Math.max(8, dims.height || 24);
  const color = !!dims.color;

  const body = [];
  const foot = [];
  const push = function (arr, sText, hl) { arr.push({ s: sText == null ? '' : sText, hl: hl || null }); };

  push(body, '⚡ keyflip ui   ·   ' + (state.activeEmail || 'not logged in'));
  push(body, '');
  if (state.view === 'fleet') renderFleet(state, body, push);
  else renderAccounts(state, body, push);
  push(body, '');
  push(body, providersLine(state), 'dim');
  if (state.view !== 'fleet') push(body, fleetSummaryLine(state), 'dim');

  if (state.message) push(foot, state.message, 'dim');
  push(foot, footerLine(state), 'dim');

  return assemble(body, foot, width, height, color);
}

function renderAccounts(state, arr, push) {
  const vis = visible(state);
  if (!vis.length) {
    push(arr, state.filter ? '  No accounts match "' + state.filter + '".' : '  No saved accounts yet — run `keyflip add`.');
    return;
  }
  vis.forEach(function (a, i) {
    const selected = i === state.sel;
    const arrow = selected ? '❯' : ' ';
    const dot = a.active ? '●' : ' ';
    const label = (a.email || a.name) + (a.active ? '  (active)' : '');
    push(arr, arrow + ' ' + dot + ' ' + label, selected ? 'sel' : null);
    push(arr, '     5h ' + bar(a.fiveHourPct, BARW) + ' ' + pctLbl(a.fiveHourPct) +
              '   7d ' + bar(a.sevenDayPct, BARW) + ' ' + pctLbl(a.sevenDayPct), 'dim');
  });
}

function renderFleet(state, arr, push) {
  const f = state.fleet || {};
  push(arr, 'Fleet');
  push(arr, '  This machine: ' + (f.name || '(unnamed)') + (f.machineId ? '  [' + f.machineId + ']' : ''), 'dim');
  push(arr, '  Rendezvous:   ' + (f.configured ? 'configured' : 'not configured — run `keyflip fleet init --dir <shared-folder>`'), 'dim');
  const peers = (f.peers || []);
  if (!peers.length) { push(arr, '  Peers:        none visible (run `keyflip fleet push` / `collect`)', 'dim'); return; }
  push(arr, '  Peers:', 'dim');
  peers.forEach(function (p) {
    push(arr, '    • ' + (p.name || p.machineId || '?') + (p.activeEmail ? '  (' + p.activeEmail + ')' : '') + (p.accounts != null ? '  ' + p.accounts + ' acct' : ''), 'dim');
  });
}

function providersLine(state) {
  const ps = state.providers || [];
  if (!ps.length) return 'Providers: none';
  return 'Providers: ' + ps.map(function (p) { return (p.active ? '●' : '○') + ' ' + p.name; }).join('   ');
}
function fleetSummaryLine(state) {
  const f = state.fleet || {};
  if (!f.configured) return 'Fleet: not configured — run `keyflip fleet init --dir <shared-folder>`';
  const peers = (f.peers && f.peers.length) || 0;
  return 'Fleet: ' + (f.name || 'configured') + ' · ' + (peers ? peers + ' peer(s)' : 'no peers seen yet');
}
function footerLine(state) {
  if (state.filtering) return 'filter: ' + (state.filter || '') + '▏   (enter apply · esc cancel)';
  return KEYMAP.map(function (k) { return k.keys.join('/') + ' ' + k.label; }).join(' · ');
}

// Body pinned to the top, footer pinned to the bottom, blank rows between — exactly `height` rows.
function assemble(body, foot, width, height, color) {
  const line = function (l) {
    let s = clip(scrub(l.s), width);
    if (color && l.hl === 'sel') return inv(padEnd(s, width));
    if (color && l.hl === 'dim') return dimc(s);
    return s;
  };
  const bodyLines = body.map(line);
  const footLines = foot.map(line);
  const avail = Math.max(0, height - footLines.length);
  const out = [];
  for (let i = 0; i < avail; i++) out.push(i < bodyLines.length ? bodyLines[i] : '');
  for (let j = 0; j < footLines.length; j++) out.push(footLines[j]);
  return out.slice(0, height).join('\n');
}

// ---- key normalization (readline keypress -> a reducer token). Pure + testable. ----
function normalizeKey(str, key) {
  key = key || {};
  if (key.ctrl && (key.name === 'c' || key.name === 'd')) return 'quit';
  if (key.name === 'up') return 'up';
  if (key.name === 'down') return 'down';
  if (key.name === 'return' || key.name === 'enter') return 'enter';
  if (key.name === 'escape') return 'escape';
  if (key.name === 'backspace') return 'backspace';
  if (key.ctrl || key.meta) return null;          // ignore other chords
  if (typeof str === 'string' && Array.from(str).length === 1) return str; // literal char
  return null;
}

// ---- run: the thin interactive loop. All decisions live in the pure fns above. ----
function run(ctx, opts) {
  opts = opts || {};
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const write = function (s) { try { output.write(s); } catch (e) { /* stream gone */ } };

  // No TTY (piped/CI): a full-screen UI is impossible — say so and bail, don't hang on raw mode.
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    write('keyflip ui needs an interactive terminal (a TTY).\n' +
          'Run it directly in your terminal, or try `keyflip menu` / `keyflip list`.\n');
    return Promise.resolve({ tty: false });
  }

  const core = require('./core');
  const readline = require('readline');
  const onSwitch = opts.onSwitch || function (name) { return core.performSwitch(ctx, name); };
  let state = buildState(ctx, opts);

  return new Promise(function (resolve) {
    let finished = false, busy = false;

    const size = function () { return { width: output.columns || 80, height: output.rows || 24, color: true }; };
    const draw = function () { write(CSI + 'H' + render(state, size())); };
    const mergeOpts = function () { return Object.assign({}, opts, { view: state.view }); };
    const mergeNav = function (disp) {
      disp.view = state.view; disp.filter = state.filter; disp.filtering = state.filtering;
      disp.sel = clamp(state.sel, visible(disp).length); disp.pending = null; disp.quit = false; disp.message = state.message;
      return disp;
    };

    function cleanup() {
      if (finished) return; finished = true;
      try { input.setRawMode(false); } catch (e) { /* ignore */ }
      if (input.pause) input.pause();
      input.removeListener('keypress', onKey);
      input.removeListener('end', cleanup);
      try { process.removeListener('SIGWINCH', onResize); } catch (e) { /* ignore */ }
      savePrefs(ctx, { view: state.view });
      write(CSI + '?25h' + CSI + '?1049l'); // show cursor, leave alt-screen
      resolve({ tty: true });
    }
    function onResize() { if (!finished) draw(); }

    async function handleEffect() {
      const eff = state.pending; state.pending = null;
      if (!eff) return;
      busy = true;
      if (eff.type === 'switch') {
        state.message = 'Switching to ' + eff.name + '…'; draw();
        try { await onSwitch(eff.name); state = mergeNav(buildState(ctx, mergeOpts())); state.message = '✅ Switched to ' + eff.name; }
        catch (e) { state.message = '❌ ' + ((e && e.message) || e); }
      } else if (eff.type === 'refresh') {
        state.message = 'Refreshing…'; draw();
        try { const disp = opts.onRefresh ? await opts.onRefresh(ctx, state) : buildState(ctx, mergeOpts()); state = mergeNav(disp); state.message = '↻ refreshed'; }
        catch (e) { state.message = '❌ ' + ((e && e.message) || e); }
      }
      busy = false; draw();
    }

    async function onKey(str, key) {
      if (finished || busy) return;
      const tok = normalizeKey(str, key);
      if (tok == null) return;
      state = reducer(state, tok);
      if (state.quit) { cleanup(); return; }
      draw();
      if (state.pending) await handleEffect();
    }

    try { readline.emitKeypressEvents(input); } catch (e) { /* fake stream in tests */ }
    try { input.setRawMode(true); } catch (e) { /* ignore */ }
    if (input.resume) input.resume();
    input.on('keypress', onKey);
    input.once('end', cleanup);           // stdin closed -> exit cleanly
    try { process.on('SIGWINCH', onResize); } catch (e) { /* ignore */ }
    write(CSI + '?1049h' + CSI + '?25l'); // enter alt-screen, hide cursor
    draw();
  });
}

module.exports = {
  buildState: buildState,
  render: render,
  reducer: reducer,
  run: run,
  keymap: KEYMAP,
  // exported for tests / reuse:
  visible: visible,
  selectedName: selectedName,
  normalizeKey: normalizeKey,
  loadPrefs: loadPrefs,
  savePrefs: savePrefs,
  fleetSummary: fleetSummary,
};
