// Connectivity + config diagnostics (#13).
//   probe(url)     — cheap reachability: ANY HTTP status = reachable; only DNS/
//                    connect/TLS/timeout = failure.
//   diagnose(ctx)  — a `keyflip doctor` report over config + providers + creds.
//   test(provider) — one minimal REAL request to a provider endpoint (auth check).
import fs from 'fs';
import path from 'path';
import * as provider from './provider.js';
import * as _vcs from './vcs.js';
import * as _secretpaths from './secretpaths.js';
import * as _sessions from './sessions.js';
import * as _appauth from './appauth.js';
import * as _llm from './llm.js';
import * as _schedule from './schedule.js';
import * as _leakscan from './leakscan.js';
import * as _chains from './chains.js';
import * as _memory from './memory.js';
import * as _profiles from './profiles.js';
import * as _threads from './threads.js';

async function probe(url, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const clock =
    opts.clock ||
    function () {
      return Date.now();
    };
  if (!doFetch) return { url: url, ok: null, reason: 'no fetch' };
  const t0 = clock();
  try {
    const res = await doFetch(url, {
      method: 'GET',
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 8000)
          : undefined,
    });
    return { url: url, ok: true, ms: clock() - t0, httpStatus: (res && res.status) || null };
  } catch (e) {
    const kind = /timeout|aborted/i.test((e && e.message) || '') ? 'timeout' : 'network';
    return { url: url, ok: false, ms: clock() - t0, reason: kind };
  }
}

// Structured health checks. Returns { checks: [{name, ok, detail}], ok }.
async function diagnose(ctx, opts) {
  opts = opts || {};
  const checks = [];
  // ok: true | false (problem) | 'warn' (advisory). fix: optional remediation hint.
  const add = function (name, ok, detail, fix) {
    checks.push({ name: name, ok: ok, detail: detail || '', fix: fix || undefined });
  };

  add('claude config dir', fs.existsSync(ctx.claudeDir), ctx.claudeDir);
  let hasLogin = false;
  try {
    hasLogin = !!ctx.store.getLive();
  } catch (e) {
    hasLogin = null;
  }
  add(
    'claude code login',
    hasLogin === true,
    hasLogin === null ? 'credential store unreadable (keychain locked?)' : hasLogin ? 'present' : 'not logged in',
  );
  if (ctx.appDataDir) add('desktop app data', fs.existsSync(ctx.appDataDir), ctx.appDataDir);

  // --- state-hygiene checks (local, no network) ---
  secretsInGit(ctx, add);
  versioningState(ctx, add);
  appSession(ctx, add, opts);
  orphanSessions(ctx, add);
  rebindBackups(ctx, add);
  threadsCheck(ctx, add);
  keepsakeCopiesCheck(ctx, add);
  chainsCheck(ctx, add);
  emptyProjectsCheck(ctx, add);
  quotaPressure(ctx, add);
  choreProvider(ctx, add);
  tokenRenewalCheck(ctx, add);
  settingsJson(ctx, add);

  const active = provider.readActive(ctx);
  add('active endpoint', true, active ? 'provider "' + active.name + '"' : 'official (subscription)');

  // Reachability of each provider's base URL (skipped when no fetch available).
  const names = provider.list(ctx);
  for (let i = 0; i < names.length; i++) {
    const m = provider.read(ctx, names[i]);
    if (!m) continue;
    const r = await probe(m.baseUrl, opts);
    add(
      'provider ' + names[i],
      r.ok !== false,
      r.ok === null
        ? 'not probed'
        : r.ok
          ? 'reachable (' + r.ms + 'ms, http ' + r.httpStatus + ')'
          : 'UNREACHABLE (' + r.reason + ')',
    );
  }
  return {
    checks: checks,
    ok: checks.every(function (c) {
      return c.ok !== false;
    }),
  };
}

// Fire one minimal real streaming request against a provider endpoint to verify
// auth + reachability end to end. Returns { ok, httpStatus, ms, category }.
async function testProvider(ctx, name, opts) {
  opts = opts || {};
  const meta = provider.read(ctx, name);
  if (!meta) throw new Error("no such provider: '" + name + "'");
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const clock =
    opts.clock ||
    function () {
      return Date.now();
    };
  if (!doFetch) return { ok: null, category: 'no-fetch' };
  let key = null;
  try {
    key = ctx.store.getProfile('provider__' + name);
  } catch (e) {
    key = null;
  }
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (key)
    headers[meta.authScheme === 'api-key' ? 'x-api-key' : 'authorization'] =
      meta.authScheme === 'api-key' ? key : 'Bearer ' + key;
  const body = JSON.stringify({
    model: (meta.models && meta.models.default) || 'claude-3-5-haiku-latest',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const url = meta.baseUrl.replace(/\/$/, '') + '/v1/messages';
  const t0 = clock();
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: headers,
      body: body,
      signal:
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || 15000)
          : undefined,
    });
    const s = (res && res.status) || 0;
    const category = s === 401 || s === 403 ? 'auth' : s >= 500 ? 'server-5xx' : s >= 400 ? 'client-4xx' : 'ok';
    return { ok: s >= 200 && s < 300, httpStatus: s, ms: clock() - t0, category: category };
  } catch (e) {
    return { ok: false, ms: clock() - t0, category: 'network', reason: (e && e.message) || 'error' };
  }
}

// The flagship hygiene check: NO secret-bearing file may be tracked by keyflip's git.
function secretsInGit(ctx, add) {
  const vcs = _vcs;
  if (!vcs.isEnabled(ctx) || !vcs.isRepo(ctx)) return; // nothing versioned → no risk to report
  const secretpaths = _secretpaths;
  const tracked = vcs.tracked(ctx);
  const leaked = tracked.filter(function (f) {
    const parts = f.split('/');
    return secretpaths.isSecretFile(parts[parts.length - 1]) || secretpaths.SECRET_DIRS.indexOf(parts[0]) !== -1;
  });
  if (leaked.length)
    add(
      'secrets in git',
      false,
      leaked.length + ' secret file(s) tracked: ' + leaked.slice(0, 3).join(', '),
      'git -C "' +
        ctx.configDir +
        '" rm --cached ' +
        leaked[0] +
        ' (then any keyflip cmd re-commits; scrub history if pushed)',
    );
  else add('secrets in git', true, 'none tracked (' + tracked.length + ' non-secret file(s) versioned)');
}

function versioningState(ctx, add) {
  const vcs = _vcs;
  const on = vcs.isEnabled(ctx) && vcs.isRepo(ctx);
  add(
    'config versioning',
    on ? true : 'warn',
    on ? 'on (undo / history available)' : 'off',
    on ? undefined : 'keyflip versioning enable  (needs git)',
  );
}

// The desktop app's REAL login is a claude.ai session cookie in its own jar, not the
// token cache in config.json — the app re-mints that cache from the cookie at launch.
// So a jar with no session cookie means the app will sit on its sign-in screen while
// every keyflip capture still reads "app ✓". Advisory only: it costs nothing to be
// signed out of the app while the CLI and browser work fine.
function appSession(ctx, add, opts) {
  if (!ctx.appDataDir) return; // no desktop app on this platform
  let s;
  try {
    s = _appauth.liveAppSession(ctx, opts || {});
  } catch (e) {
    return;
  }
  if (s.signedIn) {
    add(
      'desktop app session',
      true,
      'signed in' + (s.expiresAt ? ' (session cookie valid to ' + s.expiresAt.slice(0, 10) + ')' : ''),
    );
    return;
  }
  if (s.reason === 'no-cookie-db') return; // the app has never written a cookie jar — nothing to report
  add(
    'desktop app session',
    'warn',
    "the app's cookie jar has no claude.ai session cookie — it opens on its sign-in screen " +
      'even though the saved capture is intact',
    'sign in once in Claude (a restore cannot mint that cookie), then `keyflip add` to refresh the capture',
  );
}

function orphanSessions(ctx, add) {
  let rows;
  try {
    rows = _sessions.list(ctx, { limit: 2000 });
  } catch (e) {
    return;
  }
  const n = rows.filter(function (r) {
    return r.orphan;
  }).length;
  if (n)
    add(
      'orphaned sessions',
      'warn',
      n + ' session(s) point at a moved/renamed folder',
      'keyflip sessions rebind <old-path> <new-path>',
    );
  else if (rows.length) add('orphaned sessions', true, 'none (' + rows.length + ' session(s), folders present)');
  // A gone cwd on a session that a live process / the desktop app is still using is a path
  // mismatch, NOT an orphan. Reporting it separately keeps `doctor` from recommending deletion of
  // a conversation someone is in right now.
  const stale = rows.filter(function (r) {
    return r.staleCwd;
  });
  if (stale.length)
    add(
      'live sessions with a stale cwd',
      'warn',
      stale.length +
        ' session(s) record a folder that is gone but are still in use (' +
        stale
          .slice(0, 3)
          .map(function (r) {
            return r.sessionId.slice(0, 8) + ':' + r.liveReason;
          })
          .join(', ') +
        (stale.length > 3 ? ', …' : '') +
        ')',
      'not orphans — do not delete; rebind only if you want the path tidy',
    );
}

// rebind snapshots the old key into `<key>.keyflip-bak` and `sessions list` deliberately hides
// those backups — so before `sessions backups` existed they were invisible AND permanent (657 MiB
// of duplicates on a real machine). `doctor` surfaces them; the prune only removes proven duplicates.
function rebindBackups(ctx, add) {
  let r;
  try {
    r = _sessions.pruneBackups(ctx, {});
  } catch (e) {
    return;
  }
  if (!r.keys.length) return add('rebind backups', true, 'none');
  const mb = function (n) {
    return (n / 1048576).toFixed(1) + ' MB';
  };
  add(
    'rebind backups',
    r.removable ? 'warn' : true,
    r.keys.length +
      ' backup folder(s) — ' +
      r.removable +
      ' provably redundant, ' +
      mb(r.removableBytes) +
      (r.kept ? '; ' + r.kept + ' still holding unique content' : ''),
    r.removable ? 'keyflip sessions backups --apply' : undefined,
  );
}

// #35: a thread is a NAME over sessions, so a broken thread can never lose a conversation — but it can
// silently stop being useful. Three ways that happen: a file that no longer parses (`threads open`
// would throw), a member no account can be resolved for (the resume would run under whatever happens
// to be active — the exact wrong-account bug threads exist to prevent), and the opt-in mirror, which
// is the one place keyflip writes conversation TEXT into the state dir. stats() reads the threads dir
// and the session map only: no subprocess, no transcript scan, so it stays cheap on every `doctor`.
function threadsCheck(ctx, add) {
  let st;
  try {
    st = _threads.stats(ctx);
  } catch (e) {
    return add('threads', 'warn', 'could not be read (' + String((e && e.message) || e) + ')');
  }
  if (!st.threads)
    return add('threads', true, 'none named yet — keyflip threads suggest finds work already split over accounts');
  const bad = [];
  const fixes = [];
  if (st.corrupt.length) {
    bad.push(
      st.corrupt.length +
        ' file(s) unreadable or holding invalid members (' +
        st.corrupt.slice(0, 3).join(', ') +
        (st.corrupt.length > 3 ? ', …' : '') +
        ')',
    );
    fixes.push('keyflip threads show <slug> prints the path; the name is expendable: keyflip threads drop <slug>');
  }
  if (st.noAccount) {
    bad.push(
      st.noAccount +
        ' member(s) have no account (' +
        st.noAccountSlugs.slice(0, 3).join(', ') +
        (st.noAccountSlugs.length > 3 ? ', …' : '') +
        ')',
    );
    fixes.push('keyflip sessions assign <session-id> <account>');
  }
  if (bad.length)
    return add(
      'threads',
      'warn',
      // The mirror clause rides on the warning too: "you have conversation text on disk" is worth
      // saying whether or not something else is broken, and a warning that hides it is a leak the
      // user stops seeing.
      bad.join('; ') + mirrorClause(st, ctx),
      fixes.join('   ·   '),
    );
  add(
    'threads',
    true,
    st.threads +
      ' named task(s), ' +
      st.members +
      ' member(s) (' +
      st.sessions +
      ' session(s)' +
      (st.chats ? ', ' + st.chats + ' chat(s)' : '') +
      ')' +
      (st.spanning.length ? ', ' + st.spanning.length + ' spanning 2+ accounts' : '') +
      mirrorClause(st, ctx),
  );
}

// Spelled in dir NAMES, never absolute paths: these rows also reach `keyflip doctor --json` and the
// MCP tool, and a keyflip state path is a home path.
function mirrorClause(st, ctx) {
  return st.mirrorEnabled
    ? '; mirror ON — ' +
        st.mirrorFiles +
        ' text file(s) in ' +
        _threads.MIRROR_DIR_NAME +
        '/ (0600, never versioned or backed up)'
    : '; pointers only (mirror off)';
}

// #39: every state-hygiene row above looks at ONE thing (is a secret tracked? is this session an
// orphan?). None of them can see the RELATIONSHIPS between the pieces of a login: a capture older
// than the store it was copied from, four accounts sharing one browser cookie jar, a captured cookie
// DB sitting at mode 644. Stat-only and offline, so it is cheap enough to run on every `doctor`.
function chainsCheck(ctx, add) {
  let c;
  try {
    c = _chains.chains(ctx, {});
  } catch (e) {
    return add('credential chains', 'warn', 'could not be mapped (' + String((e && e.message) || e) + ')');
  }
  const counts = Object.create(null);
  c.risks.forEach(function (r) {
    counts[r.kind] = (counts[r.kind] || 0) + 1;
  });
  if (!c.risks.length)
    return add(
      'credential chains',
      true,
      c.summary.present +
        ' credential(s) mapped over ' +
        c.accounts.length +
        ' account(s); every capture is at least as fresh as what it was taken from',
    );
  const parts = Object.keys(counts)
    .sort()
    .map(function (k) {
      return counts[k] + ' ' + k;
    });
  // Only the FIXABLE exposure makes the report red: a world-readable secret in keyflip's own state
  // repo is one command away. An account sharing a browser profile with three others is structural
  // reality — a permanent ✗ over it would train the user to ignore the ✗.
  const fixable = counts['loose-mode'] || 0;
  add(
    'credential chains',
    fixable ? false : 'warn',
    parts.join(', ') + ' (' + c.summary.nodes + ' node(s), ' + c.summary.unprobed + ' in the Keychain unprobed)',
    fixable
      ? 'keyflip chains --tighten --apply   (chmod the state-repo secrets to 600); keyflip chains for the whole map'
      : 'keyflip chains                     — the per-account map, and why each capture can or cannot be renewed',
  );
}

// #41: `memory audit --apply` keeps each un-redacted original as `<key>.md.pre-scrub` so the edit is
// reversible — and `keyflip memory` deliberately lists only *.md, so nothing would ever show that a
// secret is still sitting on disk in plain sight. Same lesson as the rebind backups: an invisible
// leftover is a permanent leftover. Read-only fs scan; no subprocess.
function keepsakeCopiesCheck(ctx, add) {
  let r;
  try {
    r = _leakscan.keepsakeCopies(ctx, _memory);
  } catch (e) {
    return;
  }
  if (!r.files.length) return add('keepsake originals', true, 'none');
  const bytes = r.files.reduce(function (n, f) {
    return n + (f.bytes || 0);
  }, 0);
  add(
    'keepsake originals',
    'warn',
    r.files.length +
      ' redacted keepsake(s) still hold their UNREDACTED original as .pre-scrub (' +
      bytes +
      ' bytes, 0600, never versioned)',
    'read them once to confirm the redaction lost nothing you needed, then: keyflip memory audit --drop-copies',
  );
}

// Project keys with no files anywhere inside: clutter that makes the store look like lost history.
function emptyProjectsCheck(ctx, add) {
  let r;
  try {
    r = _sessions.emptyProjects(ctx, {});
  } catch (e) {
    return;
  }
  if (r.empty)
    return add(
      'empty project folders',
      'warn',
      r.empty + ' folder(s) hold no files at all',
      'keyflip sessions empty --apply',
    );
  if (r.notesOnly.length || r.sidecarsOnly.length)
    return add(
      'empty project folders',
      true,
      'none (' +
        r.notesOnly.length +
        ' memory-only, ' +
        r.sidecarsOnly.length +
        ' sidecar-only key(s) kept — they hold content)',
    );
}

function quotaPressure(ctx, add) {
  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')) || {};
  } catch (e) {
    return;
  }
  const hot = Object.keys(cache).filter(function (n) {
    const u = cache[n] && cache[n].usage;
    return u && u.fiveHour && typeof u.fiveHour.pct === 'number' && u.fiveHour.pct >= 95;
  });
  if (hot.length)
    add(
      'quota headroom',
      'warn',
      hot.join(', ') + ' at ≥95% of the 5h limit',
      'keyflip next  (rotate to an account with headroom)',
    );
}

// A background chore's cost is invisible at the moment it is chosen, which is exactly when it goes
// wrong: a nightly `dream` on the subscription burns quota nobody decided to spend, and rerouting it
// later leaves a schedule that says one thing and does another. Both are pure config reads — no
// subprocess, because `keyflip doctor` must stay offline-safe (and never spawns `claude --version`).
function choreProvider(ctx, add) {
  const prov = _llm.resolve(ctx);
  let rec = null;
  try {
    rec = _schedule.readRecord(ctx);
  } catch (e) {
    rec = null;
  }
  const line = prov.display + ' — ' + prov.cost;
  if (rec && rec.provider && rec.provider !== prov.provider)
    return add(
      'chore provider',
      'warn',
      'now ' + line + ', but the nightly job was scheduled on "' + rec.provider + '"',
      'keyflip dream schedule <time> again so the receipt matches, or `keyflip llm set` it back',
    );
  if (rec && prov.provider === 'claude')
    return add(
      'chore provider',
      'warn',
      'the nightly dream distills via ' + line,
      'an unattended job need not spend the subscription: keyflip llm set --provider ollama',
    );
  add('chore provider', true, line + (rec ? ' (nightly job scheduled)' : ' (on demand only)'));
}

// #36: a stored OAuth token dies on the CALENDAR, not on the day you happen to switch — and the
// proof is a switch that "succeeds" and opens an onboarding screen. `keyflip refresh --all` fixes
// that, but only if it runs while the tokens are still alive, which is precisely the moment nobody
// thinks about. So the honest diagnosis is "is anything renewing them?", asked of the install
// RECEIPT (written by `install`, inside the state dir) rather than of ~/Library — doctor must stay
// offline, hermetic and reproducible in a test, and a receipt-free schedule is not a schedule keyflip
// agreed to anyway.
function tokenRenewalCheck(ctx, add) {
  let accounts = [];
  try {
    accounts = _profiles.list(ctx.configDir);
  } catch (e) {
    accounts = [];
  }
  if (!accounts.length) return; // nothing stored, nothing to renew
  let rec = null;
  try {
    rec = _schedule.readRecord(ctx, { job: 'refresh' });
  } catch (e) {
    rec = null;
  }
  if (rec) {
    const at = rec.at;
    return add(
      'token renewal',
      true,
      accounts.length +
        ' account(s), renewed nightly' +
        (at ? ' at ' + String(at.h).padStart(2, '0') + ':' + String(at.m).padStart(2, '0') : '') +
        ' (' +
        rec.kind +
        ')',
    );
  }
  add(
    'token renewal',
    'warn',
    accounts.length + ' saved account(s) and nothing renews their tokens',
    'keyflip refresh --schedule — an unused token expires (~6 days) and only a human sign-in revives it; `keyflip verify` shows which are already dead',
  );
}

function settingsJson(ctx, add) {
  const p = ctx.claudeSettingsPath || path.join(ctx.home || '', '.claude', 'settings.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return;
  } // absent is fine
  try {
    JSON.parse(raw);
  } catch (e) {
    add(
      'settings.json',
      false,
      '~/.claude/settings.json is not valid JSON',
      'fix or remove it — Claude Code ignores a broken settings file',
    );
  }
}

export { probe, diagnose, testProvider };
