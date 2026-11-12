// P5: Claude Desktop only picks up a new account (or a gateway) when it restarts — an in-place
// switch leaves it on the old login. This restarts it, but ONLY while it is idle: never in the
// middle of a streaming turn, never while a Desktop-hosted Claude Code session is working, and
// always with a notification. A restart that cannot happen now is remembered (one pending record)
// and retried by every autoswitch tick until the app is idle.
//
// The busy/idle decision is an interface — { name, check(ctx) -> { busy, reason } } — so tests (and
// other platforms) inject their own; the default composite reads three local signals:
//   sessions — ~/.claude/sessions/<pid>.json of Desktop-hosted Claude Code sessions (status 'busy'
//              or 'waiting', pid alive) — the strongest signal there is
//   activity — files under the app's agent-session dirs written in the last quietMs
//   cpu      — the app's process tree above cpuBusyPct (a claude.ai chat streams in the renderer)
import fs from 'fs';
import path from 'path';
import { run as _run } from './exec.js';
import { atomicWrite } from './fsutil.js';
import * as _appctl from './platform.js';
import * as _appauth from './appauth.js';
import * as _sessionage from './sessionage.js';
import * as _notify from './notify.js';
import * as _desktopgw from './desktopgw.js';
import * as _config from './config.js';
import * as _log from './log.js';
import * as _core from './core.js';
import * as _profiles from './profiles.js';

const PENDING_FILE = '.desktop-restart.json';
const DEFAULT_QUIET_MS = 60 * 1000;
const DEFAULT_CPU_BUSY_PCT = 20;
// A Desktop that refused to quit (an unsaved-changes dialog, a hung renderer) is not asked again
// every tick: once per this long, and the user is told once.
const QUIT_RETRY_MS = 30 * 60 * 1000;

// ---- which Claude Desktop processes are up (macOS) -------------------------------------------
// The MAIN app only: its own executable, not a `Claude Helper`, not a keyflip instance clone
// (~/.keyflip-instances/claude/<slug>/Claude.app, or anything started with --user-data-dir). Counting
// helpers or clones as "the app is still running" left a quit Desktop closed and retried forever.
const MAIN_EXE_RE = /(^|\s)(\S*\/Claude\.app)\/Contents\/MacOS\/Claude(\s|$)/;
function desktopProcesses(ctx, runner) {
  const out = { main: [], instances: [] };
  if (ctx.platform !== 'darwin') return out;
  const r = (runner || _run)('ps', ['-Axo', 'pid=,command=']);
  if (!r || r.code !== 0) return null;
  const inst = ctx.instancesBase ? String(ctx.instancesBase) : null;
  String(r.stdout || '')
    .split('\n')
    .forEach(function (l) {
      const m = /^\s*([0-9]+)\s+(.*)$/.exec(l);
      if (!m) return;
      const cmd = m[2];
      const exe = MAIN_EXE_RE.exec(cmd);
      if (!exe) return;
      const isClone =
        /--user-data-dir/.test(cmd) ||
        /[\\/]\.keyflip-instances[\\/]/.test(exe[2]) ||
        (inst && exe[2].indexOf(inst) === 0);
      (isClone ? out.instances : out.main).push(parseInt(m[1], 10));
    });
  return out;
}
function testMode() {
  return process.env.KEYFLIP_TEST_CLAUDE;
}

function cfg(ctx, key, dflt) {
  try {
    const v = _config.get(ctx, key);
    return v === undefined || v === null ? dflt : v;
  } catch (e) {
    return dflt;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

// ---- detectors -------------------------------------------------------------------------------

function sessionsDetector(opts) {
  opts = opts || {};
  const alive = opts.pidAlive || pidAlive;
  return {
    name: 'sessions',
    check: function (ctx) {
      const dir = path.join(opts.claudeHome || ctx.home, '.claude', 'sessions');
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch (e) {
        return { busy: false, reason: 'no Claude Code sessions' };
      }
      const busy = [];
      files.forEach(function (f) {
        if (!/^[0-9]+\.json$/.test(f)) return;
        let j = null;
        try {
          j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (e) {
          return;
        }
        if (!j || j.entrypoint !== 'claude-desktop' || !j.pid || !alive(j.pid)) return;
        // 'busy' = a turn is running; 'waiting' = it is asking the user something. Both would be
        // cut off by a restart. Only an explicit 'idle' is idle.
        if (j.status && j.status !== 'idle') busy.push((j.name || 'session ' + j.pid) + ' (' + j.status + ')');
      });
      return busy.length
        ? { busy: true, reason: 'Desktop Claude Code session(s) working: ' + busy.slice(0, 3).join(', ') }
        : { busy: false, reason: 'no Desktop session is working' };
    },
  };
}

// Newest mtime under `dir`, bounded (depth 4, 4000 entries) so a big tree never stalls a tick.
function newestMtime(dir, depth, budget) {
  let best = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (let i = 0; i < entries.length && budget.n > 0; i++) {
    budget.n--;
    const p = path.join(dir, entries[i].name);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs > best) best = st.mtimeMs;
      if (entries[i].isDirectory() && depth > 0) {
        const sub = newestMtime(p, depth - 1, budget);
        if (sub > best) best = sub;
      }
    } catch (e) {
      /* raced */
    }
  }
  return best;
}
function activityDetector(opts) {
  opts = opts || {};
  return {
    name: 'activity',
    check: function (ctx) {
      if (!ctx.appDataDir) return { busy: false, reason: 'no desktop data dir' };
      const quiet = opts.quietMs !== undefined ? opts.quietMs : DEFAULT_QUIET_MS;
      const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
      const dirs = ['local-agent-mode-sessions', 'claude-code-sessions'].map(function (d) {
        return path.join(ctx.appDataDir, d);
      });
      let newest = 0;
      dirs.forEach(function (d) {
        const m = newestMtime(d, 4, { n: 4000 });
        if (m > newest) newest = m;
      });
      if (newest && now - newest < quiet)
        return { busy: true, reason: 'a Desktop agent session wrote ' + Math.round((now - newest) / 1000) + 's ago' };
      return { busy: false, reason: 'no recent Desktop agent activity' };
    },
  };
}
function cpuDetector(opts) {
  opts = opts || {};
  const runner = opts.run || _run;
  return {
    name: 'cpu',
    check: function (ctx) {
      if (ctx.platform !== 'darwin') return { busy: false, reason: 'cpu check is macOS-only' };
      const r = runner('ps', ['-Axo', '%cpu=,command=']);
      if (!r || r.code !== 0) return { busy: false, reason: 'ps unavailable' };
      let sum = 0;
      String(r.stdout || '')
        .split('\n')
        .forEach(function (l) {
          const m = /^\s*([0-9.]+)\s+(.*)$/.exec(l);
          if (m && /Claude\.app\/Contents\//.test(m[2]) && !/claude-code|\/claude( |$)/.test(m[2]))
            sum += parseFloat(m[1]) || 0;
        });
      const lim = opts.cpuBusyPct !== undefined ? opts.cpuBusyPct : DEFAULT_CPU_BUSY_PCT;
      return sum >= lim
        ? { busy: true, reason: 'Claude Desktop is using ' + Math.round(sum) + '% CPU (a reply is probably streaming)' }
        : { busy: false, reason: 'Claude Desktop CPU ' + Math.round(sum) + '%' };
    },
  };
}
function composite(detectors) {
  return {
    name: 'composite',
    check: function (ctx) {
      const reasons = [];
      for (let i = 0; i < detectors.length; i++) {
        let r;
        try {
          r = detectors[i].check(ctx);
        } catch (e) {
          // A detector that cannot read its signal must not green-light a restart.
          r = { busy: true, reason: detectors[i].name + ' check failed: ' + ((e && e.message) || e) };
        }
        if (r && r.busy) return { busy: true, reason: r.reason, by: detectors[i].name };
        if (r && r.reason) reasons.push(r.reason);
      }
      return { busy: false, reason: reasons.join('; ') };
    },
  };
}
function defaultDetector(ctx, opts) {
  opts = opts || {};
  return composite([
    sessionsDetector(opts),
    activityDetector({ quietMs: cfg(ctx, 'desktop.idleQuietSeconds', 60) * 1000, nowMs: opts.nowMs }),
    cpuDetector({ run: opts.run, cpuBusyPct: cfg(ctx, 'desktop.cpuBusyPercent', DEFAULT_CPU_BUSY_PCT) }),
  ]);
}

// ---- the pending record ------------------------------------------------------------------------

function pendingPath(ctx) {
  return path.join(ctx.configDir, PENDING_FILE);
}
function readPending(ctx) {
  try {
    const j = JSON.parse(fs.readFileSync(pendingPath(ctx), 'utf8'));
    return j && typeof j === 'object' && Array.isArray(j.actions) && j.actions.length ? j : null;
  } catch (e) {
    return null;
  }
}
function writePending(ctx, rec) {
  atomicWrite(pendingPath(ctx), JSON.stringify(rec, null, 2) + '\n', 0o600);
}
function clearPending(ctx) {
  try {
    fs.unlinkSync(pendingPath(ctx));
  } catch (e) {
    /* none */
  }
}

// What a restart is FOR. Each action's apply() runs while the app is CLOSED, in order:
//   gateway-on  -> desktop third-party mode pointed at provider `target` (P4 failover)
//   gateway-off -> back to first-party mode
//   account     -> the desktop login of profile `target` (the outgoing login is preserved first)
// One restart carries every pending action: the gateway leg and the account leg are separate
// GROUPS, and a newer request replaces only the action of its own group.
const KINDS = {
  account: function (ctx, target) {
    // Nothing to restore -> touch nothing (not even the outgoing login's token cache).
    if (!_appauth.hasProfile(ctx, target)) return { ok: false, reason: 'no saved desktop login for this profile' };
    try {
      const det = _appauth.detectAppAccount(ctx);
      const cur = det && det.org ? _sessionage.profileForOrg(ctx.configDir, det.org) : null;
      if (cur && cur !== target) _appauth.snapshotToProfile(ctx, cur);
    } catch (e) {
      /* preserving the outgoing login is best effort */
    }
    return _appauth.applyFromProfile(ctx, target);
  },
  'gateway-on': function (ctx, target) {
    _desktopgw.use(ctx, target);
    return { ok: true };
  },
  'gateway-off': function (ctx) {
    _desktopgw.restore(ctx);
    return { ok: true };
  },
};
function groupOf(kind) {
  return kind === 'gateway-on' || kind === 'gateway-off' ? 'gateway' : kind;
}
const ORDER = { gateway: 1, account: 2 };
function describeAction(a) {
  if (a.kind === 'account') return 'switch to ' + (a.email || a.target);
  if (a.kind === 'gateway-on') return 'use the API failover gateway';
  if (a.kind === 'gateway-off') return 'leave the API failover gateway';
  return a.kind;
}
function describe(rec) {
  return rec.actions.map(describeAction).join(' and ');
}

async function defaultNotify(ctx, event, message, opts) {
  opts = opts || {};
  let r = null;
  try {
    r = await _notify.send(ctx, event, { message: message }, { force: true, run: opts.run });
  } catch (e) {
    r = null;
  }
  if (r && r.sent) return r;
  // Quitting someone's app is never silent: when no sink is configured, a plain macOS banner.
  if (ctx.platform === 'darwin') {
    const runner = opts.run || _run;
    const esc = String(message)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .slice(0, 180);
    try {
      runner('/usr/bin/osascript', ['-e', 'display notification "' + esc + '" with title "keyflip"'], undefined, {
        timeoutMs: 5000,
      });
    } catch (e) {
      /* best effort */
    }
  }
  return r;
}

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

// Record that Claude Desktop must restart for `action` ({ kind, target, email?, reason }). It joins
// the pending restart, replacing an older action of the same group (newest wins per group).
function request(ctx, action, opts) {
  opts = opts || {};
  const prev = readPending(ctx);
  const now = opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const actions = (prev ? prev.actions : []).filter(function (a) {
    return groupOf(a.kind) !== groupOf(action.kind);
  });
  // gateway-off with nothing to turn off is a no-op only if no gateway-on is pending: then they cancel.
  const cancelled =
    action.kind === 'gateway-off' &&
    prev &&
    prev.actions.some(function (a) {
      return a.kind === 'gateway-on';
    });
  if (!cancelled) actions.push(Object.assign({}, action));
  actions.sort(function (a, b) {
    return (ORDER[groupOf(a.kind)] || 9) - (ORDER[groupOf(b.kind)] || 9);
  });
  if (!actions.length) {
    clearPending(ctx);
    return null;
  }
  const same = prev && JSON.stringify(prev.actions) === JSON.stringify(actions);
  const next = { actions: actions, since: same ? prev.since : now, notified: same ? !!prev.notified : false };
  writePending(ctx, next);
  return next;
}

// Try the pending restart now. deps (all injectable): detector, isRunning, quit, open, notify,
// waitMs, pollMs, kinds, enabled. -> { state: 'none'|'disabled'|'applied'|'deferred'|'quit-failed'|
// 'apply-failed'|'restarted', reason?, pending? }
// The CLI account right now (the account Desktop is meant to follow), by its token. null = unknown.
function currentCliAccount(ctx) {
  try {
    const a = _core.listProfiles(ctx).find(function (e) {
      return e.active;
    });
    return a ? a.name : null;
  } catch (e) {
    return null;
  }
}
// The saved profile the desktop app is signed into right now (may read the app's token cache).
function desktopAccountNow(ctx) {
  try {
    const det = _appauth.detectAppAccount(ctx);
    return det && det.org ? _sessionage.profileForOrg(ctx.configDir, det.org) : null;
  } catch (e) {
    return null;
  }
}

// A pending record is a promise to make Desktop follow the CLI. Before acting on it, re-check what
// it promises: it expires; an account action follows the CLI's CURRENT account (a later manual
// switch retargets it, or drops it when that account has no desktop login). -> rec | null.
function revalidate(ctx, rec, deps, now) {
  const maxAgeMs = deps.maxAgeMs !== undefined ? deps.maxAgeMs : cfg(ctx, 'desktop.pendingMaxHours', 12) * 3600 * 1000;
  if (maxAgeMs > 0 && typeof rec.since === 'number' && now - rec.since > maxAgeMs) {
    clearPending(ctx);
    _log.log(
      'desktop: dropped a pending restart older than ' + Math.round(maxAgeMs / 3600000) + 'h (' + describe(rec) + ')',
    );
    return null;
  }
  const cli = deps.currentCli ? deps.currentCli(ctx) : currentCliAccount(ctx);
  let changed = false;
  const actions = [];
  rec.actions.forEach(function (a) {
    if (a.kind !== 'account' || !cli || cli === a.target) {
      actions.push(a);
      return;
    }
    changed = true;
    const has = deps.hasDesktopLogin ? deps.hasDesktopLogin(ctx, cli) : _appauth.hasProfile(ctx, cli);
    if (has) actions.push(Object.assign({}, a, { target: cli, email: _profiles.email(ctx.configDir, cli) || null }));
  });
  if (!changed) return rec;
  if (!actions.length) {
    clearPending(ctx);
    _log.log('desktop: dropped a pending account restart (the CLI moved to ' + cli + ', which has no desktop login)');
    return null;
  }
  const next = Object.assign({}, rec, { actions: actions, notified: false });
  writePending(ctx, next);
  return next;
}

async function processPending(ctx, deps) {
  deps = deps || {};
  const now = deps.nowMs !== undefined ? deps.nowMs : Date.now();
  let rec = readPending(ctx);
  if (!rec) return { state: 'none' };
  rec = revalidate(ctx, rec, deps, now);
  if (!rec) return { state: 'none', dropped: true };
  const enabled = deps.enabled !== undefined ? deps.enabled : cfg(ctx, 'desktop.autoRestart', true);
  // Live process view (macOS, not under test): the main app vs keyflip clones of it.
  const procs = function () {
    if (deps.isRunning || testMode()) return null;
    return desktopProcesses(ctx, deps.run);
  };
  const isRunning =
    deps.isRunning ||
    function () {
      if (testMode() || ctx.platform !== 'darwin') return _appctl.isDesktopAppRunning(ctx.platform);
      const p = desktopProcesses(ctx, deps.run);
      return p ? p.main.length > 0 : true; // ps unreadable: assume running, never apply under it
    };
  const quit =
    deps.quit ||
    function () {
      return _appctl.quitClaude(ctx.platform);
    };
  const open =
    deps.open ||
    function () {
      return _appctl.openClaude(ctx.platform);
    };
  const notify =
    deps.notify ||
    function (event, message) {
      return defaultNotify(ctx, event, message, { run: deps.run });
    };
  const kinds = deps.kinds || KINDS;
  const what = describe(rec);
  // Every action, in order; the first failure stops the rest (a half-applied state is reported).
  async function apply() {
    for (let i = 0; i < rec.actions.length; i++) {
      const a = rec.actions[i];
      const fn = kinds[a.kind];
      if (!fn) return { ok: false, reason: 'unknown restart action ' + a.kind };
      let r;
      try {
        r = await fn(ctx, a.target);
      } catch (e) {
        r = { ok: false, reason: (e && e.message) || String(e) };
      }
      if (r && r.ok === false) return { ok: false, reason: describeAction(a) + ': ' + (r.reason || 'failed') };
    }
    return { ok: true };
  }

  // Closed app: nothing to interrupt — apply now, it starts on the new state.
  if (!isRunning()) {
    const a = await apply();
    if (a && a.ok === false) {
      clearPending(ctx);
      return { state: 'apply-failed', reason: a.reason || 'apply failed' };
    }
    clearPending(ctx);
    _log.log('desktop: ' + what + ' (app was closed, no restart needed)');
    return { state: 'applied' };
  }
  if (!enabled) {
    if (!rec.notified) {
      await notify('desktop-restart', 'Claude Desktop needs a restart to ' + what + ' (auto-restart is off).');
      writePending(ctx, Object.assign({}, rec, { notified: true }));
    }
    return { state: 'disabled', pending: rec };
  }
  // It refused to quit recently: do not ask again (and do not notify again) before QUIT_RETRY_MS.
  if (rec.quitFailedAt && now - rec.quitFailedAt < (deps.quitRetryMs !== undefined ? deps.quitRetryMs : QUIT_RETRY_MS))
    return { state: 'deferred', reason: 'Claude Desktop did not quit last time; retrying later', pending: rec };
  // A keyflip clone of the app is running: `quit` addresses the app by name and could hit the
  // clone (another account's window), and the process check could never see "closed". Wait.
  const pv = procs();
  const d0 =
    pv && pv.instances.length
      ? { busy: true, reason: 'a keyflip Claude instance is running (pid ' + pv.instances.join(', ') + ')' }
      : null;
  const detector = deps.detector || defaultDetector(ctx, { run: deps.run });
  const d = d0 || detector.check(ctx);
  if (d.busy) {
    if (!rec.notified) {
      await notify(
        'desktop-restart',
        'Claude Desktop will restart to ' + what + ' as soon as it is idle (' + d.reason + ').',
      );
      writePending(ctx, Object.assign({}, rec, { notified: true }));
    }
    return { state: 'deferred', reason: d.reason, pending: rec };
  }

  // Already where it should be (a manual switch moved the app too): no restart for that action.
  const onDesktop = deps.desktopAccount
    ? deps.desktopAccount(ctx)
    : ctx.platform === 'darwin' && !testMode()
      ? desktopAccountNow(ctx)
      : null;
  if (onDesktop) {
    const rest = rec.actions.filter(function (a) {
      return !(a.kind === 'account' && a.target === onDesktop);
    });
    if (rest.length !== rec.actions.length) {
      if (!rest.length) {
        clearPending(ctx);
        _log.log('desktop: already on ' + onDesktop + ' — no restart needed');
        return { state: 'none', dropped: true };
      }
      rec = Object.assign({}, rec, { actions: rest });
      writePending(ctx, rec);
    }
  }
  const what2 = describe(rec);
  await notify('desktop-restart', 'Restarting Claude Desktop to ' + what2 + '.');
  quit();
  const waitMs = deps.waitMs !== undefined ? deps.waitMs : 20000;
  const pollMs = deps.pollMs !== undefined ? deps.pollMs : 500;
  let waited = 0;
  while (isRunning() && waited < waitMs) {
    await sleep(pollMs);
    waited += pollMs;
  }
  if (isRunning()) {
    // It refused to quit (an unsaved-changes dialog, a hung renderer): leave it alone, keep pending,
    // say so ONCE, and do not try again for a while.
    const failed = Object.assign({}, rec, { quitFailedAt: now, notified: true });
    try {
      writePending(ctx, failed);
    } catch (e) {
      /* best effort */
    }
    await notify(
      'desktop-restart',
      'Claude Desktop did not quit — ' +
        what2 +
        ' is still pending (next try in 30 min). Quit it with Cmd+Q to apply now.',
    );
    return { state: 'quit-failed', pending: failed };
  }
  const a = await apply();
  open(); // reopen whatever happened: the user had it open
  if (a && a.ok === false) {
    await notify(
      'desktop-restart',
      'Claude Desktop restarted, but could not ' + what2 + ': ' + (a.reason || 'failed') + '.',
    );
    clearPending(ctx); // retrying a failing apply every tick would restart the app every tick
    return { state: 'apply-failed', reason: a.reason || 'apply failed' };
  }
  clearPending(ctx);
  _log.log('desktop: restarted to ' + what2 + ' (idle: ' + d.reason + ')');
  return { state: 'restarted' };
}

export {
  sessionsDetector,
  activityDetector,
  cpuDetector,
  composite,
  defaultDetector,
  request,
  processPending,
  readPending,
  clearPending,
  desktopProcesses,
  KINDS,
  PENDING_FILE,
  defaultNotify as notifyLoud,
};
