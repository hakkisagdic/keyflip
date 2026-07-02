'use strict';
// Cross-process advisory lock so two ccswitch invocations can't interleave a
// switch (e.g. double-fired alias, the launcher app racing a terminal). The lock
// is <configDir>/.lock holding {pid, at, token}. A lock is reclaimed only when
// its owner is provably gone (dead pid) or absurdly old (a safety net against a
// crashed process whose pid was later reused). release() removes the file ONLY
// if it still carries our token, so a holder whose lock was reclaimed can never
// delete the new owner's lock.
const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; } // EPERM = alive but not ours
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function makeToken() {
  return process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

// Acquire the mutation lock. Resolves to { release() }. Throws Error with
// code 'ELOCKED' if another live ccswitch holds it past timeoutMs.
async function acquire(configDir, opts) {
  opts = opts || {};
  const file = path.join(configDir, '.lock');
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 10000;
  // Only reclaim a *live* holder's lock after this long (a stuck/crashed-but-pid-
  // reused process). Real mutations finish in seconds; 5 min avoids ever stealing
  // a lock from a legitimately slow switch (app quit/reopen + token refresh).
  const staleMs = opts.staleMs !== undefined ? opts.staleMs : 5 * 60 * 1000;
  const token = makeToken();
  const start = Date.now();
  fs.mkdirSync(configDir, { recursive: true });

  function released() {
    // Remove the lock file only if it is still ours (token match). Never deletes
    // a lock a different process now holds.
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (info && info.token === token) fs.rmSync(file, { force: true });
    } catch (e) { /* gone, or unreadable — leave it for stale-reclaim */ }
  }

  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token: token }));
      fs.closeSync(fd);
      return { release: released };
    } catch (e) {
      // Clean up a partially-created lock (fd left open / zero-byte file) if the
      // write, not the exclusive-create, is what failed (e.g. ENOSPC).
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
        try { fs.rmSync(file, { force: true }); } catch (e2) { /* ignore */ }
        throw e; // this was our own file op failing, not contention
      }
      if (!e || e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e2) { /* unreadable = stale */ }
      const dead = !info || !info.pid || !pidAlive(info.pid);
      const ancient = info && (Date.now() - (info.at || 0) > staleMs);
      if (dead || ancient) {
        try { fs.rmSync(file, { force: true }); } catch (e2) { /* raced */ }
        continue;
      }
      if (Date.now() - start >= timeoutMs) {
        const err = new Error('another ccswitch is running (lock held by pid ' + (info && info.pid) + ') — try again in a moment');
        err.code = 'ELOCKED';
        throw err;
      }
      await delay(120);
    }
  }
}

module.exports = { acquire: acquire, _pidAlive: pidAlive };
