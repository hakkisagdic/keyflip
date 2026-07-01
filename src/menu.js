'use strict';
// Interactive, cross-platform menu (readline). The app launcher and `ccswitch`
// with no args both land here.
const readline = require('readline');
const core = require('./core');
const profiles = require('./profiles');
const appctl = require('./platform');

function ask(rl, q) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (a) { if (!done) { done = true; resolve(a); } };
    if (rl.__closed) { finish(null); return; } // already at EOF -> don't touch a closed rl
    const onClose = function () { finish(null); };
    rl.once('close', onClose);
    try {
      rl.question(q, function (a) { rl.removeListener('close', onClose); finish(a); });
    } catch (e) {
      rl.removeListener('close', onClose);
      finish(null); // rl.question can throw if closed between checks
    }
  });
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function switchInteractive(ctx, name, p) {
  const managed = appctl.canManageApp(ctx.platform);
  const running = managed && appctl.isClaudeRunning(ctx.platform);
  if (running) {
    p('  Quitting Claude...');
    appctl.quitClaude(ctx.platform);
    for (let i = 0; i < 40 && appctl.isClaudeRunning(ctx.platform); i++) { await delay(500); } // ~20s max
  }
  core.doSwitch(ctx, name);
  if (running) { p('  Reopening Claude...'); appctl.openClaude(ctx.platform); }
  const em = profiles.email(ctx.configDir, name);
  p('  ✅ Switched to: ' + (em || name));
  if (!managed) p('  ↪ Restart Claude Code to apply.');
}

async function menuAdd(ctx, rl, p) {
  const cur = core.currentEmail(ctx);
  if (!cur) { p(''); p('  No logged-in account detected. Log in in Claude first, then try again.'); return; }
  p('');
  p('  Current account: ' + cur);
  const suggested = profiles.sanitizeName(cur);
  const raw = await ask(rl, '  Save as [' + suggested + ']  (Enter=accept, name, or c=cancel): ');
  if (raw === null) { p('  Cancelled.'); return; } // EOF
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
  if (raw === null) { p('  Cancelled.'); return; } // EOF
  const ans = raw.trim();
  if (ans === '') { p('  Cancelled.'); return; }
  const name = core.resolveProfile(ctx, ans);
  if (!name) { p('  Invalid selection.'); return; }
  core.removeProfile(ctx, name);
  p('  🗑 removed: ' + name);
}

async function runMenu(ctx, io) {
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
      if (!list.length) {
        p('  No saved accounts yet — press [a] to save the current one.');
      } else {
        list.forEach(function (e) {
          p('  ' + (e.active ? '→ ' : '  ') + '[' + e.index + '] ' + (e.email || e.name));
        });
      }
      p('');
      p('  [number] switch   [a] save current   [d] delete   [r] refresh   [q] quit');
      p('════════════════════════════════════════════');
      const raw = await ask(rl, '  Choose: ');
      if (raw === null) { break; } // EOF / closed stdin
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
        await switchInteractive(ctx, name, p);
        p(''); p('  Done — you can close this window.'); p('');
        break;
      }
      p('  Invalid choice.');
    }
  } finally {
    rl.close();
  }
}

module.exports = { runMenu: runMenu };
