'use strict';
// Interactive menu. Two modes:
//   • keys mode  — a real TTY: arrow-key navigation (↑/↓, Enter), number shortcuts.
//   • line mode  — piped/non-TTY (tests, CI): type a number/letter + Enter.
const readline = require('readline');
const core = require('./core');
const profiles = require('./profiles');
const appctl = require('./platform');
const appsessions = require('./appsessions');
const appauth = require('./appauth');

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Only merge into the app store while the app is actually closed.
function consolidateSilent(ctx) {
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false, merged: 0 };
  return appsessions.consolidate(ctx);
}

// Swap the desktop app's own login (config.json), only while it's closed.
function switchDesktopSilent(ctx, name) {
  if (appctl.isClaudeRunning(ctx.platform)) return { ok: false };
  return appauth.applyFromProfile(ctx, name);
}

// Default the highlight to the first NON-active account (the one you'd switch to).
function firstNonActiveIndex(ctx) {
  const list = core.listProfiles(ctx);
  for (let i = 0; i < list.length; i++) { if (!list[i].active) return i; }
  return 0;
}

// -------------------------------------------------------------------------
// line mode (readline question loop) — used for piped stdin / tests
// -------------------------------------------------------------------------
function ask(rl, q) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (a) { if (!done) { done = true; resolve(a); } };
    if (rl.__closed) { finish(null); return; }
    const onClose = function () { finish(null); };
    rl.once('close', onClose);
    try {
      rl.question(q, function (a) { rl.removeListener('close', onClose); finish(a); });
    } catch (e) {
      rl.removeListener('close', onClose);
      finish(null);
    }
  });
}

async function switchInteractive(ctx, name, p, rl) {
  const managed = appctl.canManageApp(ctx.platform);
  const running = managed && appctl.isClaudeRunning(ctx.platform);
  if (running) {
    const ans = await ask(rl, '  Claude / Claude Code is open and will be closed to switch. Continue? [y/N] ');
    if (ans === null || !/^y(es)?$/i.test(ans.trim())) { p('  Cancelled — nothing was changed.'); return false; }
    p('  Quitting Claude...');
    appctl.quitClaude(ctx.platform);
    for (let i = 0; i < 40 && appctl.isClaudeRunning(ctx.platform); i++) { await delay(500); }
  }
  const did = core.performSwitch(ctx, name);
  if (!did.cli) p("  ↳ CLI login for this profile isn't captured — switching the desktop app only.");
  const appl = switchDesktopSilent(ctx, name);
  if (appl.ok) p('  ↳ switched the Claude desktop-app login too.');
  const cons = consolidateSilent(ctx);
  if (cons.ok && cons.merged) p('  ↳ shared ' + cons.merged + ' session pointer(s) so every account shows them all.');
  if (running) { p('  Reopening Claude...'); appctl.openClaude(ctx.platform); }
  const em = profiles.email(ctx.configDir, name);
  p('  ✅ Switched to: ' + (em || name));
  if (!managed) p('  ↪ Restart Claude Code to apply.');
  return true;
}

async function menuAdd(ctx, rl, p) {
  const cur = core.currentEmail(ctx);
  if (!cur) { p(''); p('  No logged-in account detected. Log in in Claude first, then try again.'); return; }
  p('');
  p('  Current account: ' + cur);
  const suggested = profiles.sanitizeName(cur);
  const raw = await ask(rl, '  Save as [' + suggested + ']  (Enter=accept, name, or c=cancel): ');
  if (raw === null) { p('  Cancelled.'); return; }
  const ans = raw.trim();
  if (ans === 'c' || ans === 'C') { p('  Cancelled.'); return; }
  const r = core.addCurrent(ctx, ans === '' ? undefined : ans);
  p(r.refreshed ? "  ↻ '" + r.email + "' already saved as '" + r.name + "' — refreshed."
                : "  💾 saved '" + r.email + "' as '" + r.name + "'.");
}

async function menuRemove(ctx, rl, p) {
  const list = core.listProfiles(ctx);
  if (!list.length) { p('  Nothing to remove.'); return; }
  list.forEach(function (e) { p('    [' + e.index + '] ' + (e.email || e.name) + '  (' + e.name + ')'); });
  const raw = await ask(rl, '  Remove which?  (number, Enter=cancel): ');
  if (raw === null) { p('  Cancelled.'); return; }
  const ans = raw.trim();
  if (ans === '') { p('  Cancelled.'); return; }
  const name = core.resolveProfile(ctx, ans);
  if (!name) { p('  Invalid selection.'); return; }
  core.removeProfile(ctx, name);
  p('  🗑 removed: ' + name);
}

async function runMenuLine(ctx, io) {
  io = io || {};
  const out = io.out || process.stdout;
  const rl = readline.createInterface({ input: io.input || process.stdin, output: out, terminal: false });
  rl.on('close', function () { rl.__closed = true; });
  const p = function (s) { out.write((s == null ? '' : s) + '\n'); };
  try {
    for (;;) {
      const cur = core.currentEmail(ctx);
      const list = core.listProfiles(ctx);
      p('════════════════════════════════════════════');
      p('        Claude Account Switcher (ccswitch)');
      p('════════════════════════════════════════════');
      p('  Active: ' + (cur || 'not logged in'));
      p('');
      if (!list.length) p('  No saved accounts yet — press [a] to save the current one.');
      else list.forEach(function (e) { p('  ' + (e.active ? '● ' : '  ') + '[' + e.index + '] ' + (e.email || e.name)); });
      p('');
      p('  [number] switch   [a] save current   [d] delete   [r] refresh   [q] quit');
      p('════════════════════════════════════════════');
      const raw = await ask(rl, '  Choose: ');
      if (raw === null) { break; }
      const c = raw.trim();
      if (c === '' || c === 'q' || c === 'Q') { p(''); p('  Bye.'); break; }
      if (c === 'a' || c === 'A') { await menuAdd(ctx, rl, p); continue; }
      if (c === 'd' || c === 'D') { await menuRemove(ctx, rl, p); continue; }
      if (c === 'r' || c === 'R') { continue; }
      if (/^[0-9]+$/.test(c)) {
        const name = core.resolveProfile(ctx, c);
        if (!name) { p('  Invalid choice.'); continue; }
        const em = profiles.email(ctx.configDir, name);
        if (em && em === cur) { p("  '" + em + "' is already active."); continue; }
        const did = await switchInteractive(ctx, name, p, rl);
        if (!did) { continue; }
        p(''); p('  Done — you can close this window.'); p('');
        break;
      }
      p('  Invalid choice.');
    }
  } finally {
    rl.close();
  }
}

// -------------------------------------------------------------------------
// keys mode (raw keypress) — used on a real TTY
// -------------------------------------------------------------------------
function runMenuKeys(ctx, io) {
  io = io || {};
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const write = function (s) { output.write(s); };

  readline.emitKeypressEvents(input);
  if (input.isTTY && input.setRawMode) { try { input.setRawMode(true); } catch (e) { /* ignore */ } }
  if (input.resume) input.resume();

  let sel = firstNonActiveIndex(ctx);

  return new Promise(function (resolve) {
    let finished = false;
    let cleanupConfirm = null; // set while a [y/N] prompt is pending
    function finish() {
      if (finished) return;
      finished = true;
      if (cleanupConfirm) { const c = cleanupConfirm; cleanupConfirm = null; c(); }
      if (input.isTTY && input.setRawMode) { try { input.setRawMode(false); } catch (e) { /* ignore */ } }
      if (input.pause) input.pause();
      input.removeListener('keypress', onKey);
      input.removeListener('end', finish);
      resolve();
    }
    input.once('end', finish); // stdin closed -> exit cleanly instead of hanging

    function render() {
      const list = core.listProfiles(ctx);
      const cur = core.currentEmail(ctx);
      if (sel > list.length - 1) sel = list.length ? list.length - 1 : 0;
      if (sel < 0) sel = 0;
      write('\x1b[2J\x1b[3J\x1b[H');
      write('════════════════════════════════════════════\n');
      write('        Claude Account Switcher (ccswitch)\n');
      write('════════════════════════════════════════════\n');
      write('  Active: ' + (cur || 'not logged in') + '\n\n');
      if (!list.length) {
        write('  No saved accounts yet — press [a] to save the current one.\n');
      } else {
        list.forEach(function (e, i) {
          const label = ' [' + e.index + '] ' + (e.email || e.name) + (e.active ? '  ● active' : '');
          if (i === sel) write('\x1b[7m❯' + label + '\x1b[0m\n');
          else write('  ' + label + '\n');
        });
      }
      write('\n  ↑/↓ move · Enter switch · [a] add · [d] delete · [r] refresh · [q] quit\n');
    }

    function askYesNoKey(question) {
      return new Promise(function (res) {
        write('\n' + question);
        function h(str, key) {
          input.removeListener('keypress', h);
          cleanupConfirm = null;
          write('\n');
          res(/^y/i.test(str || '') || (key && key.name === 'y'));
        }
        cleanupConfirm = function () { input.removeListener('keypress', h); res(false); }; // on stdin close
        input.on('keypress', h);
      });
    }

    async function keysSwitch(name) {
      const managed = appctl.canManageApp(ctx.platform);
      const running = managed && appctl.isClaudeRunning(ctx.platform);
      if (running) {
        const yes = await askYesNoKey('  Claude / Claude Code is open and will be closed to switch. Continue? [y/N] ');
        if (!yes) { write('  Cancelled — nothing was changed.\n'); return false; }
        write('  Quitting Claude...\n');
        appctl.quitClaude(ctx.platform);
        for (let i = 0; i < 40 && appctl.isClaudeRunning(ctx.platform); i++) { await delay(500); }
      }
      const did = core.performSwitch(ctx, name);
      if (!did.cli) write("  ↳ CLI login for this profile isn't captured — switching the desktop app only.\n");
      const appl = switchDesktopSilent(ctx, name);
      if (appl.ok) write('  ↳ switched the Claude desktop-app login too.\n');
      const cons = consolidateSilent(ctx);
      if (cons.ok && cons.merged) write('  ↳ shared ' + cons.merged + ' session pointer(s) so every account shows them all.\n');
      if (running) { write('  Reopening Claude...\n'); appctl.openClaude(ctx.platform); }
      const em = profiles.email(ctx.configDir, name);
      write('  ✅ Switched to: ' + (em || name) + '\n');
      if (!managed) write('  ↪ Restart Claude Code to apply.\n');
      return true;
    }

    async function switchSel() {
      const list = core.listProfiles(ctx);
      if (!list.length) return;
      const e = list[sel];
      if (e.active) { render(); return; }
      input.removeListener('keypress', onKey);
      let ok = false;
      try { ok = await keysSwitch(e.name); } catch (err) { write('  ❌ ' + (err && err.message ? err.message : err) + '\n'); }
      if (ok) { write('\n  Done — you can close this window.\n'); finish(); }
      else if (!finished) { input.on('keypress', onKey); render(); }
    }

    async function lineAction(fn) {
      input.removeListener('keypress', onKey);
      if (input.isTTY && input.setRawMode) { try { input.setRawMode(false); } catch (e) { /* ignore */ } }
      const rl = readline.createInterface({ input: input, output: output });
      const p = function (s) { write((s == null ? '' : s) + '\n'); };
      try { await fn(ctx, rl, p); } catch (err) { p('  ❌ ' + (err && err.message ? err.message : err)); } finally { rl.close(); }
      if (finished) return; // stdin closed during the sub-prompt
      if (input.isTTY && input.setRawMode) { try { input.setRawMode(true); } catch (e) { /* ignore */ } }
      if (input.resume) input.resume();
      input.on('keypress', onKey);
      render();
    }

    async function onKey(str, key) {
      key = key || {};
      // Exit: q, Esc, Ctrl-C, Ctrl-D (terminal EOF).
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
        write('\n  Bye.\n'); finish(); return;
      }
      if (key.ctrl || key.meta) return; // ignore all other Ctrl-/Alt- chords (Ctrl-A, Ctrl-K, ...)
      if (key.name === 'up' || key.name === 'k') { sel -= 1; render(); return; }
      if (key.name === 'down' || key.name === 'j') { sel += 1; render(); return; }
      if (key.name === 'r') { render(); return; }
      if (key.name === 'return') { await switchSel(); return; } // CR only, not Ctrl-J/LF
      if (str && /^[0-9]$/.test(str)) {
        const list = core.listProfiles(ctx);
        const i = parseInt(str, 10);
        if (i >= 1 && i <= list.length) { sel = i - 1; await switchSel(); }
        return;
      }
      if (key.name === 'a') { await lineAction(menuAdd); return; }
      if (key.name === 'd') { await lineAction(menuRemove); return; }
    }

    input.on('keypress', onKey);
    render();
  });
}

function runMenu(ctx, io) {
  if (io && io.input) return runMenuLine(ctx, io);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') return runMenuKeys(ctx);
  return runMenuLine(ctx, io);
}

module.exports = {
  runMenu: runMenu,
  runMenuLine: runMenuLine,
  runMenuKeys: runMenuKeys,
  firstNonActiveIndex: firstNonActiveIndex,
};
