// Phase 2/3: Chromium browser claude.ai session inspection + reset + snapshot/restore.
// The native-messaging bridge rejects the connection ("Invalid token or user
// mismatch") when the browser's claude.ai account != the active CLI/desktop
// account. So keyflip must see, and be able to reset, the browser session too.
//
// Cookie decryption reuses chat.js's polymorphic decryptCookie:
//   • macOS: Keychain `<Browser> Safe Storage` password → PBKDF2 + AES-128-CBC (`v10`).
//   • Windows: `<User Data>\Local State` `os_crypt.encrypted_key` → DPAPI + AES-256-GCM (`v10`/`v11`).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { run } from './exec.js';
import { decryptCookie, sqliteRoArg } from './chat.js';
import * as _win from './wincrypt.js';

function supported(platform) {
  return platform === 'darwin' || platform === 'win32';
}

function winLocalAppData(home, opts) {
  if (opts && opts.localAppData) return opts.localAppData;
  if (process.env.LOCALAPPDATA) {
    try {
      if (!home || path.resolve(home) === path.resolve(os.homedir())) return process.env.LOCALAPPDATA;
    } catch (e) {
      /* fall back to home-relative path */
    }
  }
  return path.join(home, 'AppData', 'Local');
}

// Known Chromium browsers: default-profile Cookies DB, OS key source, and process name.
//
// One Chromium profile holds exactly ONE claude.ai account, so a user who wants two
// accounts live at once needs two profiles. `catalog` therefore expands each browser
// into one entry per profile it finds in Local State (`Default` keeps the bare id,
// so existing captures and tests are untouched); the REST of keyflip (snapshot
// store, switch leg, chat reads) already keys everything by browser id.
//
// `opts` defaults `platform` to `'darwin'` when omitted so existing unit tests calling
// `catalog('/Users/x')` behave identically on macOS, Linux, and Windows CI runners;
// runtime callers pass `{ platform: ctx.platform }`.
function catalog(home, opts) {
  const o = typeof opts === 'string' ? { platform: opts } : opts || {};
  const platform = o.platform || 'darwin';
  const exists = o.exists || fs.existsSync;
  let base;
  if (platform === 'win32') {
    const LA = winLocalAppData(home, o);
    const msixArc = path.join(
      LA,
      'Packages',
      'TheBrowserCompany.Arc_ttt1ap7aakyb4',
      'LocalCache',
      'Local',
      'Arc',
      'User Data',
    );
    const plainArc = path.join(LA, 'Arc', 'User Data');
    base = {
      chrome: {
        id: 'chrome',
        name: 'Chrome',
        dataDir: path.join(LA, 'Google', 'Chrome', 'User Data'),
        proc: 'chrome.exe',
      },
      brave: {
        id: 'brave',
        name: 'Brave',
        dataDir: path.join(LA, 'BraveSoftware', 'Brave-Browser', 'User Data'),
        proc: 'brave.exe',
      },
      edge: {
        id: 'edge',
        name: 'Edge',
        dataDir: path.join(LA, 'Microsoft', 'Edge', 'User Data'),
        proc: 'msedge.exe',
      },
      arc: {
        id: 'arc',
        name: 'Arc',
        dataDir: exists(msixArc) ? msixArc : plainArc,
        proc: 'Arc.exe',
      },
    };
  } else {
    const AS = path.join(home, 'Library', 'Application Support');
    base = {
      chrome: {
        id: 'chrome',
        name: 'Chrome',
        dataDir: path.join(AS, 'Google', 'Chrome'),
        service: 'Chrome Safe Storage',
        account: 'Chrome',
        proc: 'Google Chrome',
      },
      brave: {
        id: 'brave',
        name: 'Brave',
        dataDir: path.join(AS, 'BraveSoftware', 'Brave-Browser'),
        service: 'Brave Safe Storage',
        account: 'Brave',
        proc: 'Brave Browser',
      },
      edge: {
        id: 'edge',
        name: 'Edge',
        dataDir: path.join(AS, 'Microsoft Edge'),
        service: 'Microsoft Edge Safe Storage',
        account: 'Microsoft Edge',
        proc: 'Microsoft Edge',
      },
      arc: {
        id: 'arc',
        name: 'Arc',
        dataDir: path.join(AS, 'Arc', 'User Data'),
        service: 'Arc Safe Storage',
        account: 'Arc',
        proc: 'Arc',
      },
    };
  }
  const out = {};
  Object.keys(base).forEach(function (k) {
    withProfiles(base[k], platform, exists).forEach(function (entry) {
      out[entry.id] = entry;
    });
  });
  return out;
}

// The local profile directories a Chromium browser has (from Local State's info_cache),
// `Default` first. A missing/unreadable Local State degrades to `Default` alone — the
// pre-profile behaviour — so this can never hide a browser that used to be found.
function withProfiles(b, platform, exists) {
  let labels = {};
  const localState = path.join(b.dataDir, 'Local State');
  try {
    const st = JSON.parse(fs.readFileSync(localState, 'utf8'));
    labels = (st && st.profile && st.profile.info_cache) || {};
  } catch (e) {
    labels = {}; /* no Local State → just Default */
  }
  const profiles = ['Default'].concat(
    Object.keys(labels)
      .filter(function (p) {
        return p !== 'Default';
      })
      .sort(),
  );
  return profiles.map(function (p, i) {
    // The id becomes part of snapshot file names (`<account>__<id>.sql`), so it must stay
    // filesystem-safe: `chrome` for the default profile, `chrome-Profile-2` for a named one.
    const id = i === 0 ? b.id : b.id + '-' + String(p).replace(/[^A-Za-z0-9]+/g, '-');
    // `Default` is commonly named "Person 1"; the human label only disambiguates the others.
    const label = labels[p] && labels[p].name ? labels[p].name : p;
    const profileDir = path.join(b.dataDir, p);
    let cookies = path.join(profileDir, 'Cookies');
    if (platform === 'win32') {
      const netCookies = path.join(profileDir, 'Network', 'Cookies');
      // Modern Chromium on Windows keeps Cookies under `<Profile>\Network\Cookies`; fall back to
      // `<Profile>\Cookies` only when a legacy/flat fixture exists without `Network\Cookies`.
      cookies = !exists(netCookies) && exists(cookies) ? cookies : netCookies;
    }
    return {
      id: id,
      name: i === 0 ? b.name : b.name + ' (' + label + ')',
      platform: platform,
      profile: p,
      profileDir: profileDir,
      dataDir: b.dataDir,
      localState: localState,
      cookies: cookies,
      service: b.service, // every profile of a browser shares its Safe Storage / Local State key
      account: b.account,
      proc: b.proc,
    };
  });
}

// Chromium browsers actually present on this machine (a Cookies DB exists).
function installed(home, opts) {
  opts = opts || {};
  const exists = opts.exists || fs.existsSync;
  const all = catalog(home, opts);
  return Object.keys(all)
    .map(function (k) {
      return all[k];
    })
    .filter(function (b) {
      return exists(b.cookies);
    });
}

// The browser's cookie-encryption key:
//   • macOS: login Keychain string password (`security find-generic-password`)
//   • Windows: 32-byte AES-256 master key Buffer from `<dataDir>\Local State` via DPAPI
// Second argument accepts either a `runner` function (legacy callers) or `{ run, unprotect }`.
function safeKey(b, runnerOrOpts) {
  const opts = typeof runnerOrOpts === 'function' ? { run: runnerOrOpts } : runnerOrOpts || {};
  const runner = opts.run || run;
  if (b && b.platform === 'win32') {
    const lsPath = b.localState || (b.dataDir ? path.join(b.dataDir, 'Local State') : null);
    return _win.masterKeyFromFile(lsPath, { run: runner, unprotect: opts.unprotect });
  }
  const r = runner('/usr/bin/security', ['find-generic-password', '-s', b.service, '-a', b.account, '-w']);
  return r && r.code === 0 ? String(r.stdout).replace(/\r?\n$/, '') : null;
}

// Is the browser running? Writing its on-disk Cookies DB while it runs is unsafe
// (Chromium keeps cookies in memory and rewrites on exit), so callers guard on it.
function isRunning(b, runner) {
  const execRun = runner || run;
  if (b && b.platform === 'win32') {
    const r = execRun('tasklist', ['/FI', 'IMAGENAME eq ' + b.proc, '/NH']);
    return !!(
      r &&
      r.code === 0 &&
      String(r.stdout || '')
        .toLowerCase()
        .indexOf(String(b.proc).toLowerCase()) !== -1
    );
  }
  const r = execRun('/usr/bin/pgrep', ['-x', b.proc]);
  return !!(r && r.code === 0 && String(r.stdout).trim());
}

// Gracefully quit the browser so its Cookies DB unlocks and we can clear/restore it.
function quit(b, runner) {
  const execRun = runner || run;
  if (b && b.platform === 'win32') {
    // Graceful WM_CLOSE (no `/F`) so Chromium flushes cookies and preserves session state.
    return execRun('taskkill', ['/IM', b.proc]);
  }
  return execRun('/usr/bin/osascript', ['-e', 'tell application "' + b.proc + '" to quit']);
}

// Relaunch a browser after a cookie sync.
function reopen(b, runner) {
  const execRun = runner || run;
  if (b && b.platform === 'win32') {
    return execRun('cmd', ['/c', 'start', '', b.proc]);
  }
  return execRun('open', ['-a', b.proc]);
}

// True if any sqlite `name\x01X'hex'` row carries a Windows `v20` App-Bound Encryption prefix.
function hasAppBoundRows(stdout) {
  return String(stdout || '')
    .trim()
    .split('\n')
    .some(function (line) {
      const i = line.indexOf('\x01');
      if (i === -1) return false;
      const hex = line.slice(i + 1).replace(/^X'|'$/g, '');
      try {
        return _win.isAppBoundCookie(Buffer.from(hex, 'hex'));
      } catch (e) {
        return false;
      }
    });
}

// Read + decrypt this browser's claude.ai cookies. Returns { cookie, org } | null,
// where `org` is the lastActiveOrg cookie (the account's org uuid) if present.
function readClaudeCookies(b, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const key = opts.key || safeKey(b, { run: runner, unprotect: opts.unprotect });
  if (!key) return null;
  const tmp = path.join(os.tmpdir(), 'keyflip-bck-' + process.pid + '-' + b.id + '.db');
  try {
    fs.copyFileSync(b.cookies, tmp);
  } catch (e) {
    return null;
  }
  try {
    const r = runner('sqlite3', [
      '-separator',
      '\x01',
      sqliteRoArg(tmp),
      "SELECT name,quote(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai';",
    ]);
    if (!r || r.code !== 0) return null;
    const parsed = parseCookieRows(r.stdout, key);
    if (!parsed && opts.onAppBound && hasAppBoundRows(r.stdout)) opts.onAppBound(b);
    return parsed;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

// Parse the sqlite `name\x01X'hex'` rows and decrypt each. Split out for testing.
function parseCookieRows(stdout, key) {
  const pairs = [];
  let org = null;
  String(stdout || '')
    .trim()
    .split('\n')
    .forEach(function (line) {
      const i = line.indexOf('\x01');
      if (i === -1) return;
      const name = line.slice(0, i);
      const hex = line.slice(i + 1).replace(/^X'|'$/g, '');
      let val = null;
      try {
        val = decryptCookie(Buffer.from(hex, 'hex'), key);
      } catch (e) {
        val = null;
      }
      if (val == null) return;
      pairs.push(name + '=' + val);
      if (name === 'lastActiveOrg') org = val;
    });
  if (!pairs.length) return null;
  return { cookie: pairs.join('; '), org: org };
}

// Snapshot this browser's claude.ai cookie ROWS as portable INSERT statements
// (encrypted_value bytes preserved verbatim — no decrypt, so it works even for
// app-bound v20 cookies as long as it's the same browser+machine). Returns the SQL
// string, or null. Used to save an account's browser session for later restore.
function snapshotClaudeCookies(b, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const tmp = path.join(os.tmpdir(), 'keyflip-snap-' + process.pid + '-' + b.id + '.db');
  try {
    fs.copyFileSync(b.cookies, tmp);
  } catch (e) {
    return null;
  }
  try {
    const r = runner('sqlite3', [
      '-cmd',
      '.mode insert cookies',
      sqliteRoArg(tmp),
      "SELECT * FROM cookies WHERE host_key LIKE '%claude.ai';",
    ]);
    if (!r || r.code !== 0) return null;
    const sql = String(r.stdout || '').trim();
    return sql || null;
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (e) {
      /* ignore */
    }
  }
}

// Restore a saved claude.ai session (from snapshotClaudeCookies) into this browser:
// drop the current claude.ai cookies, re-insert the saved rows. REFUSES while the
// browser runs (unless force) and backs up the Cookies DB first.
function restoreClaudeCookies(b, sql, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (!sql) return { ok: false, reason: 'no-snapshot' };
  if (!opts.force && isRunning(b, runner)) return { ok: false, reason: 'browser-running' };
  let backup;
  try {
    backup = b.cookies + '.keyflip-bak';
    fs.copyFileSync(b.cookies, backup);
  } catch (e) {
    return { ok: false, reason: 'no-cookies-db' };
  }
  const script = "DELETE FROM cookies WHERE host_key LIKE '%claude.ai';\n" + sql + '\n';
  const r = runner('sqlite3', [b.cookies], script);
  if (!r || r.code !== 0) return { ok: false, reason: 'sqlite-failed', detail: r && r.stderr, backup: backup };
  return { ok: true, backup: backup };
}

// Phase 3 (conservative): clear this browser's claude.ai cookies so the next
// visit prompts a fresh login as the right account. Backs up the Cookies DB
// first and REFUSES while the browser is running (unless force). Reversible via
// the returned backup path.
function clearClaudeCookies(b, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (!opts.force && isRunning(b, runner)) return { ok: false, reason: 'browser-running' };
  let backup;
  try {
    backup = b.cookies + '.keyflip-bak';
    fs.copyFileSync(b.cookies, backup);
  } catch (e) {
    return { ok: false, reason: 'no-cookies-db' };
  }
  const r = runner('sqlite3', [b.cookies, "DELETE FROM cookies WHERE host_key LIKE '%claude.ai';"]);
  if (!r || r.code !== 0) return { ok: false, reason: 'sqlite-failed', detail: r && r.stderr, backup: backup };
  return { ok: true, backup: backup };
}

// Where keyflip stores a saved browser (claude.ai) session per account+browser.
function sessionStorePath(configDir, name, browserId) {
  return path.join(configDir, 'browser-sessions', name + '__' + browserId + '.sql');
}
// Snapshot the account's current browser session and stash it (best-effort).
function saveSession(configDir, name, b, opts) {
  const sql = snapshotClaudeCookies(b, opts);
  if (!sql) return false;
  const p = sessionStorePath(configDir, name, b.id);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, sql, { mode: 0o600 });
    try {
      fs.chmodSync(p, 0o600);
    } catch (e) {
      /* non-POSIX FS */
    } // tighten a pre-existing loose file
    return true;
  } catch (e) {
    return false;
  }
}
function loadSession(configDir, name, b) {
  try {
    return fs.readFileSync(sessionStorePath(configDir, name, b.id), 'utf8');
  } catch (e) {
    return null;
  }
}

export {
  supported,
  catalog,
  installed,
  sessionStorePath,
  saveSession,
  loadSession,
  safeKey,
  isRunning,
  quit,
  reopen,
  hasAppBoundRows,
  readClaudeCookies,
  parseCookieRows,
  clearClaudeCookies,
  snapshotClaudeCookies,
  restoreClaudeCookies,
};
