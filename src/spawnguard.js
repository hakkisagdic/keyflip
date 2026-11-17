// Test-run guard: a test run must never reach the developer's real desktop or network.
//
// Active when the process runs under the Node test runner (it sets NODE_TEST_CONTEXT in every test
// process, e.g. "child-v8") or KEYFLIP_TEST_OFFLINE is 1 (npm test sets it for the whole suite and
// every CLI a test spawns inherits it). While active, a REAL call to osascript, open, say or
// terminal-notifier (exec.run), any `claude auth ...` of the real binary (logout and login change the owner's real
// Claude Code session through the machine-wide keychain, status reads it) and a REAL webhook POST
// (notify.send without an injected fetch; a loopback sink is allowed) are refused and counted.
// A test that injects its own runner or fetch never reaches this module.
//
// Keychain class: `security` (bare name AND absolute path) and the kfkc helper are refused unless the call
// names an explicit keychain FILE under the temp dir (a throwaway one the test created; the helper takes it
// from KFKC_KEYCHAIN), so no test path can reach the login Keychain and make macOS ask for the owner's password.
// A refusal is logged as `keychain ...`, which fails the suite's final check. Changing the search list or the
// default keychain is refused even for a temp file.
//
// Every refusal is appended as one line to the file named by KEYFLIP_SPAWN_LOG (when set), so the
// suite's final check sees refusals made in child processes too.
import fs from 'fs';
import os from 'os';
import path from 'path';

const GUARDED = new Set(['osascript', 'open', 'say', 'terminal-notifier']);
let refused = 0;

function active() {
  return process.env.KEYFLIP_TEST_OFFLINE === '1' || !!process.env.NODE_TEST_CONTEXT;
}

// A keychain file under the (real) temp dir, e.g. created by the test itself.
function isTempKeychainFile(p) {
  try {
    const s = String(p || '');
    if (!/\.keychain(-db)?$/.test(s) || !path.isAbsolute(s)) return false;
    const tmp = fs.realpathSync(os.tmpdir());
    const dir = fs.realpathSync(path.dirname(s));
    return dir === tmp || dir.startsWith(tmp + path.sep);
  } catch {
    return false;
  }
}

function isKeychainTool(cmd) {
  const base = path.basename(String(cmd || '')).toLowerCase();
  return base === 'security' || base === 'kfkc';
}

// True when a security/kfkc call stays inside an explicit throwaway keychain file.
function keychainCallAllowed(cmd, args, input, opts) {
  const base = path.basename(String(cmd || '')).toLowerCase();
  const a = Array.isArray(args) ? args.map(String) : [];
  if (base === 'kfkc') {
    const env = (opts && opts.env) || process.env;
    return isTempKeychainFile(env.KFKC_KEYCHAIN);
  }
  if (a[0] === 'default-keychain' || a[0] === 'login-keychain') return false;
  if (a[0] === 'list-keychains' && (a.includes('-s') || a.includes('-S'))) return false;
  const words = a.slice();
  if (a[0] === '-i' && typeof input === 'string') {
    input.split(/\r?\n/).forEach(function (line) {
      const m = line.match(/"((?:[^"\\]|\\.)*)"|\S+/g) || [];
      m.forEach(function (w) {
        words.push(w.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'));
      });
    });
  }
  return words.some(isTempKeychainFile);
}

function isGuarded(cmd, args) {
  const base = path.basename(String(cmd || '')).toLowerCase();
  if (GUARDED.has(base) || isKeychainTool(cmd)) return true;
  // `claude auth ...` talks to the machine-wide keychain whatever HOME the test uses: logout and login
  // change the owner's real session, status reads it. A stand-in `claude` a test put under the
  // temp dir is fine; the real one is not.
  return /^claude(\.exe|\.cmd)?$/.test(base) && Array.isArray(args) && args[0] === 'auth' && !isTempBinary(cmd);
}

function isTempBinary(cmd) {
  try {
    let file = String(cmd);
    if (!file.includes(path.sep)) {
      file = '';
      for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (dir && fs.existsSync(path.join(dir, String(cmd)))) {
          file = path.join(dir, String(cmd));
          break;
        }
      }
    }
    if (!file) return false;
    const tmp = fs.realpathSync(os.tmpdir());
    return fs.realpathSync(file).startsWith(tmp + path.sep);
  } catch {
    return false;
  }
}

function isLoopback(url) {
  try {
    const h = new URL(String(url)).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

function record(kind, detail) {
  refused += 1;
  const file = process.env.KEYFLIP_SPAWN_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, kind + ' ' + String(detail == null ? '' : detail).slice(0, 120) + '\n');
  } catch {
    /* best effort */
  }
}

// Returns a refusal result for exec.run when `cmd` must not really run now, else null.
function refuseCommand(cmd, args, input, opts) {
  if (!active() || !isGuarded(cmd, args)) return null;
  if (isKeychainTool(cmd)) {
    if (keychainCallAllowed(cmd, args, input, opts)) return null;
    // Never log argv: it may carry a service name or a value.
    record('keychain', path.basename(String(cmd)) + ' ' + (Array.isArray(args) ? String(args[0] || '') : ''));
    const e = new Error(
      'keyflip test guard: refused ' + path.basename(String(cmd)) + ' without an explicit temp keychain file',
    );
    e.code = 'KEYFLIP_TEST_GUARD';
    return { code: 1, stdout: '', stderr: e.message, error: e, timedOut: false, refused: true };
  }
  if (GUARDED.has(path.basename(String(cmd)).toLowerCase())) {
    record('spawn', path.basename(String(cmd)) + ' ' + (Array.isArray(args) ? args.join(' ') : ''));
  } else {
    // `claude auth ...` is something the reset/uninstall/status tests exercise on purpose: refused and
    // counted, but not a failure of the final check (the guard is what makes them safe to run).
    refused += 1;
  }
  const err = new Error('keyflip test guard: refused to run ' + path.basename(String(cmd)) + ' during a test run');
  err.code = 'KEYFLIP_TEST_GUARD';
  return { code: 1, stdout: '', stderr: err.message, error: err, timedOut: false, refused: true };
}

// True when a real webhook POST must be refused (the caller passes whether a fetch was injected).
function refuseFetch(injected, url) {
  if (injected || !active() || isLoopback(url)) return false;
  record('fetch', url);
  return true;
}

// For code that would build/run the kfkc helper itself: true when that is allowed now (guard off, or an
// explicit temp keychain file is named). When it is not, the attempt is logged as a keychain refusal.
function helperAllowed(env) {
  if (!active()) return true;
  if (isTempKeychainFile((env || process.env).KFKC_KEYCHAIN || (env || process.env).KEYFLIP_KEYCHAIN_FILE)) return true;
  record('keychain', 'kfkc helper');
  return false;
}

function refusedCount() {
  return refused;
}

export { active, isGuarded, refuseCommand, refuseFetch, refusedCount, helperAllowed, isTempKeychainFile, GUARDED };
