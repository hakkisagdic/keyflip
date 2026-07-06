'use strict';
// Best-effort control of the Claude desktop app, per platform. Only used by the
// CLI/menu (never by core), so the core stays hermetically testable.
//
// Test hook: set KEYFLIP_TEST_CLAUDE=running|stopped to control detection and make
// quit/open no-ops (so tests never touch a real app). quit flips state to stopped.
const { run } = require('./exec');

let _testStopped = false;

function plat(p) { return p || process.platform; }
function testMode() { return process.env.KEYFLIP_TEST_CLAUDE; }

function isClaudeRunning(p) {
  const t = testMode();
  if (t) return t === 'running' && !_testStopped;
  p = plat(p);
  if (p === 'darwin') {
    // Include "Claude Helper" processes: the network service may outlive the main
    // binary by a moment while flushing the cookie DB — never write during that.
    const r = run('sh', ['-c',
      "ps -Axo command | grep -v grep | grep -Ec 'Claude\\.app/Contents/MacOS/Claude|Claude Helper|/claude-code/[^ ]*/claude|(^|/)claude( |$)'"]);
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

// Is the Claude DESKTOP APP (not the CLI) running? The app — unlike a Claude Code
// CLI process — can rewrite the shared login after a switch, so callers use this to
// warn about a desktop↔CLI tug-of-war. macOS only (the only managed desktop app).
function isDesktopAppRunning(p) {
  const t = testMode();
  if (t) return t === 'running' && !_testStopped;
  p = plat(p);
  if (p !== 'darwin') return false;
  const r = run('sh', ['-c',
    "ps -Axo command | grep -v grep | grep -Ec 'Claude\\.app/Contents/MacOS/Claude|Claude Helper'"]);
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}

function quitClaude(p) {
  if (testMode()) { _testStopped = true; return true; }
  p = plat(p);
  if (p === 'darwin') { run('osascript', ['-e', 'tell application "Claude" to quit']); return true; }
  if (p === 'win32') { run('taskkill', ['/IM', 'Claude.exe', '/F']); return true; }
  return false; // no managed desktop app elsewhere
}

function openClaude(p) {
  if (testMode()) { return true; }
  p = plat(p);
  if (p === 'darwin') { run('open', ['-a', 'Claude']); return true; }
  if (p === 'win32') { run('cmd', ['/c', 'start', '', 'Claude']); return true; }
  return false;
}

// Structured detection of live Claude Code sessions from the PID files Claude
// itself writes (~/.claude/sessions/<pid>.json) — tells us WHICH instances are
// running (pid, cwd, entrypoint) with real liveness, unlike ps|grep.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}
function claudeInstances(home) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(home, '.claude', 'sessions');
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  files.forEach(function (f) {
    if (!/^[0-9]+\.json$/.test(f)) return;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.pid && pidAlive(j.pid)) {
        out.push({ pid: j.pid, cwd: j.cwd || null, entrypoint: j.entrypoint || 'cli', kind: j.kind || null });
      }
    } catch (e) { /* skip unreadable */ }
  });
  return out;
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
  isDesktopAppRunning: isDesktopAppRunning,
  quitClaude: quitClaude,
  openClaude: openClaude,
  canManageApp: canManageApp,
  claudeInstances: claudeInstances,
};
