'use strict';
// #16 WSL helpers for a Windows-side keyflip managing a WSL-resident Claude
// install (config dir pointed at \\wsl$\<distro>\...\.claude or \\wsl.localhost\...).
// Port cc-switch's rules: detect WSL UNC prefixes, case-insensitive lexical
// compare on Windows, and run tool commands through wsl.exe rather than assuming
// a shell. keyflip never trusts %HOME% on Windows (Git/MSYS injects it) — the
// context already uses os.homedir() (USERPROFILE on Windows).

// Is this path a WSL UNC path? \\wsl$\Ubuntu\... or \\wsl.localhost\Ubuntu\...
function isWslPath(p) {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(String(p || ''));
}

// Extract the distro name from a WSL UNC path, or null.
function distroOf(p) {
  const m = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\/i.exec(String(p || ''));
  return m ? m[1] : null;
}

// Lexical normalization for comparison: on Windows compares are case-insensitive
// and separators are unified; elsewhere case-sensitive.
function normalizeForCompare(p, platform) {
  let s = String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  if ((platform || process.platform) === 'win32') s = s.toLowerCase();
  return s;
}
function samePath(a, b, platform) { return normalizeForCompare(a, platform) === normalizeForCompare(b, platform); }

// Wrap a tool command to run inside the given WSL distro. Never assumes bash.
//   wrapExec('claude', ['--version'], 'Ubuntu')
//   -> { command: 'wsl.exe', args: ['-d','Ubuntu','--','sh','-lc','claude --version'] }
function wrapExec(command, args, distro) {
  const line = [command].concat(args || []).map(function (a) {
    return /[^A-Za-z0-9_./:=-]/.test(a) ? "'" + String(a).replace(/'/g, "'\\''") + "'" : a;
  }).join(' ');
  return { command: 'wsl.exe', args: ['-d', distro, '--', 'sh', '-lc', line] };
}

module.exports = { isWslPath: isWslPath, distroOf: distroOf, normalizeForCompare: normalizeForCompare, samePath: samePath, wrapExec: wrapExec };
