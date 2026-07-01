'use strict';
// Best-effort control of the Claude desktop app, per platform. Only used by the
// CLI/menu (never by core), so the core stays hermetically testable.
const { run } = require('./exec');

function plat(p) { return p || process.platform; }

function isClaudeRunning(p) {
  p = plat(p);
  if (p === 'darwin') {
    const r = run('sh', ['-c',
      "ps -Axo command | grep -v grep | grep -Ec 'Claude\\.app/Contents/MacOS/Claude|/claude-code/[^ ]*/claude|(^|/)claude( |$)'"]);
    return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
  }
  if (p === 'win32') {
    const r = run('tasklist', []);
    return /(^|\s)Claude(\.exe)?/i.test(r.stdout || '');
  }
  // linux and others
  const r = run('sh', ['-c', "ps -e -o comm= 2>/dev/null | grep -Ei 'claude'"]);
  return !!(r.stdout || '').trim();
}

function quitClaude(p) {
  p = plat(p);
  if (p === 'darwin') { run('osascript', ['-e', 'tell application "Claude" to quit']); return true; }
  if (p === 'win32') { run('taskkill', ['/IM', 'Claude.exe', '/F']); return true; }
  return false; // no managed desktop app elsewhere
}

function openClaude(p) {
  p = plat(p);
  if (p === 'darwin') { run('open', ['-a', 'Claude']); return true; }
  if (p === 'win32') { run('cmd', ['/c', 'start', '', 'Claude']); return true; }
  return false;
}

// Can we reliably quit AND relaunch the desktop app automatically?
// macOS only: `osascript quit` + `open -a Claude` are dependable. On Windows the
// relaunch (`start "" Claude`) is not reliable, and on Linux there is no managed
// desktop app — there we just swap and ask the user to restart Claude.
function canManageApp(p) {
  p = plat(p);
  return p === 'darwin';
}

module.exports = {
  isClaudeRunning: isClaudeRunning,
  quitClaude: quitClaude,
  openClaude: openClaude,
  canManageApp: canManageApp,
};
