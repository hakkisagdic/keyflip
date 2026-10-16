// Interactive menu. Two modes:
//   • keys mode  — a real TTY: arrow-key navigation (↑/↓, Enter), number shortcuts.
//   • line mode  — piped/non-TTY (tests, CI): type a number/letter + Enter.
import readline from 'readline';
import * as core from './core.js';
import * as profiles from './profiles.js';
import * as appctl from './platform.js';
import * as appsessions from './appsessions.js';
import * as appauth from './appauth.js';
import * as lock from './lock.js';
import * as threads from './threads.js';
import * as config from './config.js';
import * as styleModule from './style.js';

// Styling is bound to the stream the menu actually writes to, so a piped / test output stays plain
// text (style.make disables color on a non-TTY) and a real terminal gets dim hints. `ui.color=false`
// is honoured the same way the CLI honours it, and an unknown key must never turn a render into a crash.
function stylesFor(out, ctx) {
  let off = false;
  try {
    off = config.get(ctx, 'ui.color') === false;
  } catch (e) {
    off = false;
  }
  return styleModule.make(out, { color: !off });
}

function delay(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

// Serialize menu mutations with any other keyflip process.
async function withLock(ctx, onErr, fn) {
  let l;
  try {
    l = await lock.acquire(ctx.configDir, { timeoutMs: 5000 });
  } catch (e) {
    onErr('  ❌ ' + e.message);
    return null;
  }
  try {
    return await fn();
  } finally {
    l.release();
  }
}

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
  for (let i = 0; i < list.length; i++) {
    if (!list[i].active) return i;
  }
  return 0;
}

// -------------------------------------------------------------------------
// line mode (readline question loop) — used for piped stdin / tests
// -------------------------------------------------------------------------
// Why this is not `rl.question`: readline fires a 'line' event the moment it parses a newline, and a
// question that is not yet pending would simply DROP it. Piping `printf 't\n1\n\nq\n' | keyflip menu`
// sends every answer in one chunk, so the second and later answers vanished and the menu acted on stale
// or missing input. A queue attached to the interface keeps them, in order, for whoever asks next.
function queueFor(rl) {
  if (rl.__kfQueue) return rl.__kfQueue;
  const q = { lines: [], waiter: null };
  rl.on('line', function (line) {
    if (q.waiter) {
      const w = q.waiter;
      q.waiter = null;
      w(line);
      return;
    }
    q.lines.push(line);
  });
  rl.on('close', function () {
    rl.__closed = true;
    if (q.waiter) {
      const w = q.waiter;
      q.waiter = null;
      w(null);
    }
  });
  rl.__kfQueue = q;
  return q;
}

function ask(rl, q) {
  const queue = queueFor(rl);
  if (q && rl.output && rl.output.write) rl.output.write(q);
  return new Promise(function (resolve) {
    if (queue.lines.length) {
      resolve(queue.lines.shift());
      return;
    }
    if (rl.__closed) {
      resolve(null);
      return;
    }
    queue.waiter = resolve;
  });
}

async function switchInteractive(ctx, name, p, rl) {
  const managed = appctl.canManageApp(ctx.platform);
  const running = managed && appctl.isClaudeRunning(ctx.platform);
  if (running) {
    const ans = await ask(rl, '  Claude / Claude Code is open and will be closed to switch. Continue? [y/N] ');
    if (ans === null || !/^y(es)?$/i.test(ans.trim())) {
      p('  Cancelled — nothing was changed.');
      return false;
    }
    p('  Quitting Claude...');
    appctl.quitClaude(ctx.platform);
    for (let i = 0; i < 40 && appctl.isClaudeRunning(ctx.platform); i++) {
      await delay(500);
    }
  }
  const done = await withLock(ctx, p, async function () {
    const did = core.performSwitch(ctx, name);
    if (!did.cli) p("  ↳ CLI login for this profile isn't captured — switching the desktop app only.");
    const appl = switchDesktopSilent(ctx, name);
    if (appl.ok) p('  ↳ switched the Claude desktop-app login too.');
    else if (appl.reason && appl.reason !== 'no saved desktop login for this profile')
      p('  ⚠️ desktop app NOT switched: ' + appl.reason);
    const cons = consolidateSilent(ctx);
    if (cons.ok && cons.merged) p('  ↳ shared ' + cons.merged + ' session pointer(s) so every account shows them all.');
    return true;
  });
  if (done === null) {
    if (running) {
      p('  Reopening Claude...');
      appctl.openClaude(ctx.platform);
    }
    return false;
  }
  if (running) {
    p('  Reopening Claude...');
    appctl.openClaude(ctx.platform);
  }
  const em = profiles.email(ctx.configDir, name);
  p('  ✅ Switched to: ' + (em || name));
  if (!managed) p('  ↪ Restart Claude Code to apply.');
  return true;
}

async function menuAdd(ctx, rl, p) {
  const cur = core.currentEmail(ctx);
  if (!cur) {
    p('');
    p('  No logged-in account detected. Log in in Claude first, then try again.');
    return;
  }
  p('');
  p('  Current account: ' + cur);
  const suggested = profiles.sanitizeName(cur);
  const raw = await ask(rl, '  Save as [' + suggested + ']  (Enter=accept, name, or c=cancel): ');
  if (raw === null) {
    p('  Cancelled.');
    return;
  }
  const ans = raw.trim();
  if (ans === 'c' || ans === 'C') {
    p('  Cancelled.');
    return;
  }
  await withLock(ctx, p, async function () {
    const r = core.addCurrent(ctx, ans === '' ? undefined : ans);
    p(
      r.refreshed
        ? "  ↻ '" + r.email + "' already saved as '" + r.name + "' — refreshed."
        : "  💾 saved '" + r.email + "' as '" + r.name + "'.",
    );
  });
}

async function menuRemove(ctx, rl, p) {
  const list = core.listProfiles(ctx);
  if (!list.length) {
    p('  Nothing to remove.');
    return;
  }
  list.forEach(function (e) {
    p('    [' + e.index + '] ' + (e.email || e.name) + '  (' + e.name + ')');
  });
  const raw = await ask(rl, '  Remove which?  (number, Enter=cancel): ');
  if (raw === null) {
    p('  Cancelled.');
    return;
  }
  const ans = raw.trim();
  if (ans === '') {
    p('  Cancelled.');
    return;
  }
  const name = core.resolveProfile(ctx, ans);
  if (!name) {
    p('  Invalid selection.');
    return;
  }
  await withLock(ctx, p, async function () {
    core.removeProfile(ctx, name);
    p('  🗑 removed: ' + name);
  });
}

// -------------------------------------------------------------------------
// threads screen (#42) — READ-ONLY on purpose
// -------------------------------------------------------------------------
// A thread is the one thing an account switch threatens: the same task, named, spread over two
// accounts' sessions. So the screen that shows it lives in the menu that performs the switch.
// It lists POINTERS (id, account, where the transcript is) and prints the CLI command that would
// change anything; it never reads a transcript body, never writes, and never spends quota.
function whenStamp(iso) {
  const s = String(iso || '');
  if (!s) return 'never';
  const ms = Date.parse(s);
  if (isNaN(ms)) return s.slice(0, 10);
  const diff = Date.now() - ms;
  if (diff < 90 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return Math.round(diff / 60000) + 'm ago';
  if (diff < 36 * 60 * 60 * 1000) return Math.round(diff / 3600000) + 'h ago';
  if (diff < 7 * 24 * 3600 * 1000) return Math.round(diff / 86400000) + 'd ago';
  return s.slice(0, 10);
}

// One thread's members, each with what is true about it ON THIS MACHINE right now.
function threadDetail(ctx, row, p, style) {
  const dim = style.dim;
  let t;
  try {
    t = threads.read(ctx, row.slug);
  } catch (e) {
    p('  ⚠ ' + e.message);
    return;
  }
  if (!t) {
    p('  "' + row.slug + '" is gone — it was deleted while this screen was open.');
    return;
  }
  let exp;
  try {
    // index + assignments are computed once and passed in: N members must not each re-scan the store.
    exp = threads.expand(ctx, t, { index: threads.index(ctx), assigned: threads.assignments(ctx) });
  } catch (e) {
    p('  ⚠ could not resolve its members: ' + e.message);
    return;
  }
  p('');
  p('  ' + row.slug + (t.title && threads.slugify(t.title) !== row.slug ? '  — ' + t.title : ''));
  Object.keys(exp.accounts)
    .sort()
    .forEach(function (a) {
      p('    ' + (a === 'unassigned' ? '⚠ no account' : a) + ': ' + exp.accounts[a] + ' member(s)');
    });
  exp.rows.forEach(function (m) {
    const tag = m.kind === 'chat' ? 'chat' : 'sess';
    p(
      '    [' +
        tag +
        '] ' +
        String(m.id).slice(0, 8) +
        (m.account ? '' : '  ⚠ unassigned') +
        (m.label ? '  ' + clip(m.label, 48) : ''),
    );
    if (!m.resolved) {
      p('           ' + dim(m.reason || 'not reachable from here'));
      return;
    }
    p('           ' + dim(clip(m.cwd || m.project || '', 70) + (m.cwdGone ? '   (folder is gone)' : '')));
    p('           ' + dim(whenStamp(m.mtime) + ' · ' + resumeLine(m)));
  });
  // Only a SESSION pointer can be missing "here" — a cloud chat is server-side by nature and its own
  // reason line already says how to read it, so counting it as unresolved would be a false alarm.
  const gone = exp.rows.filter(function (m) {
    return m.kind === 'session' && !m.resolved;
  }).length;
  if (gone)
    p(
      '    ' +
        dim(
          gone +
            ' session pointer(s) resolve to nothing on this machine; the thread still names them, so a re-capture or a `threads add` fixes it',
        ),
    );
  p('');
  p(
    '  ' +
      dim(
        'merged read: keyflip threads show ' +
          row.slug +
          ' --timeline   ·   continue: keyflip threads open ' +
          row.slug,
      ),
  );
}

// "Finds the fragmentation instead of asking for it" — the CLI's rule: only a folder whose sessions are
// assigned to TWO OR MORE NAMED accounts is evidence of a switch. Reporting a thread is NOT done here:
// naming a task is the user's call, so this screen prints the command and stops.
function threadSuggest(ctx, p, style) {
  const dim = style.dim;
  let rows;
  try {
    rows = threads.candidates(ctx, {});
  } catch (e) {
    p('  ⚠ ' + e.message);
    return;
  }
  p('');
  if (!rows.length) {
    p('  ✓ Nothing looks fragmented: no project folder holds sessions assigned to two or more named accounts.');
    p(
      dim(
        '    (checked the newest 400; an UNASSIGNED session is not evidence of a switch — assign first:' +
          ' keyflip sessions assign <session-id> <account>)',
      ),
    );
    return;
  }
  rows.forEach(function (g) {
    p('  ' + clip(g.cwd || g.project, 70));
    p('    ' + g.accounts.join(' + ') + ' · ' + g.sessions + ' session(s), ' + g.unthreaded + ' not in any thread yet');
    p(
      '    ' +
        dim('keyflip threads create ' + g.suggestedSlug + ' --title "…"   then add its ' + g.open.length + ' id(s)'),
    );
  });
  p('');
  p('  ' + dim('This screen does not create threads — naming one is your call.'));
}

function clip(s, n) {
  const v = String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

// `expand()` hands back resumeCommand()'s {cwd, command, args}; the menu shows what the user would paste,
// so it renders it the way `keyflip threads show` does — the cd matters, a transcript resumes in its folder.
function resumeLine(m) {
  const r = m.resume || {};
  return 'cd ' + (r.cwd || m.cwd || '.') + ' && ' + r.command + ' ' + (r.args || []).join(' ');
}

async function menuThreads(ctx, rl, p, style) {
  const dim = style.dim;
  for (;;) {
    const rows = threads.summaries(ctx);
    const st = threads.stats(ctx);
    p('');
    p(
      '  ══ Threads ══  ' +
        st.threads +
        ' thread(s), ' +
        st.members +
        ' member(s): ' +
        st.sessions +
        ' session(s), ' +
        st.chats +
        ' cloud chat(s)',
    );
    if (!rows.length) {
      p('  None yet. A thread gives one task a single name across accounts, so switching does not');
      p('  fragment it into separate chats:');
      p('    keyflip threads create <slug> --title "…"');
      p('    keyflip threads add <slug> <session-id>');
      p('    keyflip threads suggest   ' + dim('finds work two or more accounts already touched'));
      p('');
      p('  ' + dim('[s] look for split work · Enter back to accounts'));
    } else {
      rows.forEach(function (r, i) {
        p(
          '  [' +
            (i + 1) +
            '] ' +
            r.slug +
            '  ' +
            r.members +
            ' member(s): ' +
            r.sessions +
            ' session(s)' +
            (r.chats ? ', ' + r.chats + ' chat(s)' : '') +
            '  ' +
            dim(whenStamp(r.updatedAt)),
        );
        if (r.title && threads.slugify(r.title) !== r.slug) p('        ' + dim('“' + clip(r.title, 72) + '”'));
        p(
          '        ' +
            dim(
              (r.accounts.length ? 'accounts: ' + r.accounts.join(', ') : 'no account attributed yet') +
                (r.noAccount ? '  · ' + r.noAccount + ' member(s) unassigned' : ''),
            ),
        );
        if (r.corrupt) p('        ⚠ unreadable thread file: ' + clip(r.file, 60));
        else if (r.droppedMembers)
          p('        ⚠ ' + r.droppedMembers + ' invalid member(s) ignored in ' + clip(r.file, 60));
      });
      p('');
      if (st.spanning.length)
        p('  ✓ ' + st.spanning.length + ' thread(s) span more than one account: ' + st.spanning.slice(0, 6).join(', '));
      if (st.noAccount)
        p(
          '  ⚠ ' +
            st.noAccount +
            ' member(s) would resume as the CURRENT account (' +
            st.noAccountSlugs.slice(0, 6).join(', ') +
            ')  ' +
            dim('fix: keyflip sessions assign <session-id> <account>'),
        );
      if (st.corrupt && st.corrupt.length) p('  ⚠ unreadable thread file(s): ' + st.corrupt.join(', '));
      if (st.mirrorFiles)
        p(
          '  ' +
            dim(
              st.mirrorFiles +
                ' markdown mirror(s) for other agents · mirroring ' +
                (st.mirrorEnabled ? 'is on' : 'is off'),
            ),
        );
      p('');
      p('  ' + dim('[number] members · [s] look for split work · Enter back to accounts'));
    }
    const raw = await ask(rl, '  Threads: ');
    if (raw === null) return;
    const c = raw.trim();
    if (c === '' || c === 'q' || c === 'b' || c === 'back') return;
    if (c === 's' || c === 'S') {
      threadSuggest(ctx, p, style);
      continue;
    }
    if (/^[0-9]+$/.test(c)) {
      const r = rows[parseInt(c, 10) - 1];
      if (!r) {
        p('  Invalid choice.');
        continue;
      }
      threadDetail(ctx, r, p, style);
      continue;
    }
    p('  Invalid choice.');
  }
}

async function runMenuLine(ctx, io) {
  io = io || {};
  const out = io.out || process.stdout;
  const rl = readline.createInterface({ input: io.input || process.stdin, output: out, terminal: false });
  rl.on('close', function () {
    rl.__closed = true;
  });
  const p = function (s) {
    out.write((s == null ? '' : s) + '\n');
  };
  const style = stylesFor(out, ctx);
  let appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
  try {
    for (;;) {
      const cur = core.currentEmail(ctx);
      const list = core.listProfiles(ctx);
      p('════════════════════════════════════════════');
      p('        Keyflip (keyflip)');
      p('════════════════════════════════════════════');
      p(
        '  Claude Code: ' +
          (cur || 'not logged in') +
          (ctx.appDataDir
            ? '   ·   Desktop app: ' + (appActive ? profiles.email(ctx.configDir, appActive) || appActive : 'unknown')
            : ''),
      );
      p('');
      if (!list.length) p('  No saved accounts yet — press [a] to save the current one.');
      else
        list.forEach(function (e) {
          const now = (e.active ? 'cli' : '') + (e.name === appActive ? (e.active ? '+app' : 'app') : '');
          p('  ' + (now ? '● ' : '  ') + '[' + e.index + '] ' + (e.email || e.name) + (now ? '   (' + now + ')' : ''));
        });
      p('');
      p('  [number] switch   [a] save current   [d] delete   [t] threads   [r] refresh   [q] quit');
      p('════════════════════════════════════════════');
      const raw = await ask(rl, '  Choose: ');
      if (raw === null) {
        break;
      }
      const c = raw.trim();
      if (c === '' || c === 'q' || c === 'Q') {
        p('');
        p('  Bye.');
        break;
      }
      if (c === 'a' || c === 'A') {
        await menuAdd(ctx, rl, p);
        appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
        continue;
      }
      if (c === 'd' || c === 'D') {
        await menuRemove(ctx, rl, p);
        continue;
      }
      if (c === 't' || c === 'T') {
        await menuThreads(ctx, rl, p, style);
        continue;
      }
      if (c === 'r' || c === 'R') {
        appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
        continue;
      }
      if (/^[0-9]+$/.test(c)) {
        const name = core.resolveProfile(ctx, c);
        if (!name) {
          p('  Invalid choice.');
          continue;
        }
        const em = profiles.email(ctx.configDir, name);
        if (em && em === cur) {
          p("  '" + em + "' is already active.");
          continue;
        }
        const did = await switchInteractive(ctx, name, p, rl);
        if (!did) {
          continue;
        }
        p('');
        p('  Done — you can close this window.');
        p('');
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
  const write = function (s) {
    output.write(s);
  };

  readline.emitKeypressEvents(input);
  if (input.isTTY && input.setRawMode) {
    try {
      input.setRawMode(true);
    } catch (e) {
      /* ignore */
    }
  }
  if (input.resume) input.resume();

  let sel = firstNonActiveIndex(ctx);
  let appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;

  return new Promise(function (resolve) {
    let finished = false;
    let cleanupConfirm = null; // set while a [y/N] prompt is pending
    function finish() {
      if (finished) return;
      finished = true;
      if (cleanupConfirm) {
        const c = cleanupConfirm;
        cleanupConfirm = null;
        c();
      }
      if (input.isTTY && input.setRawMode) {
        try {
          input.setRawMode(false);
        } catch (e) {
          /* ignore */
        }
      }
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
      write('        Keyflip (keyflip)\n');
      write('════════════════════════════════════════════\n');
      write(
        '  Claude Code: ' +
          (cur || 'not logged in') +
          (ctx.appDataDir
            ? '\n  Desktop app: ' + (appActive ? profiles.email(ctx.configDir, appActive) || appActive : 'unknown')
            : '') +
          '\n\n',
      );
      if (!list.length) {
        write('  No saved accounts yet — press [a] to save the current one.\n');
      } else {
        list.forEach(function (e, i) {
          const now = (e.active ? 'cli' : '') + (e.name === appActive ? (e.active ? '+app' : 'app') : '');
          const label = ' [' + e.index + '] ' + (e.email || e.name) + (now ? '  ● ' + now : '');
          if (i === sel) write('\x1b[7m❯' + label + '\x1b[0m\n');
          else write('  ' + label + '\n');
        });
      }
      write('\n  ↑/↓ move · Enter switch · [a] add · [d] delete · [t] threads · [r] refresh · [q] quit\n');
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
        cleanupConfirm = function () {
          input.removeListener('keypress', h);
          res(false);
        }; // on stdin close
        input.on('keypress', h);
      });
    }

    async function keysSwitch(name) {
      const managed = appctl.canManageApp(ctx.platform);
      const running = managed && appctl.isClaudeRunning(ctx.platform);
      if (running) {
        const yes = await askYesNoKey('  Claude / Claude Code is open and will be closed to switch. Continue? [y/N] ');
        if (!yes) {
          write('  Cancelled — nothing was changed.\n');
          return false;
        }
        write('  Quitting Claude...\n');
        appctl.quitClaude(ctx.platform);
        for (let i = 0; i < 40 && appctl.isClaudeRunning(ctx.platform); i++) {
          await delay(500);
        }
      }
      const done = await withLock(
        ctx,
        function (m) {
          write(m + '\n');
        },
        async function () {
          const did = core.performSwitch(ctx, name);
          if (!did.cli) write("  ↳ CLI login for this profile isn't captured — switching the desktop app only.\n");
          const appl = switchDesktopSilent(ctx, name);
          if (appl.ok) write('  ↳ switched the Claude desktop-app login too.\n');
          else if (appl.reason && appl.reason !== 'no saved desktop login for this profile')
            write('  ⚠️ desktop app NOT switched: ' + appl.reason + '\n');
          const cons = consolidateSilent(ctx);
          if (cons.ok && cons.merged)
            write('  ↳ shared ' + cons.merged + ' session pointer(s) so every account shows them all.\n');
          return true;
        },
      );
      if (running) {
        write('  Reopening Claude...\n');
        appctl.openClaude(ctx.platform);
      }
      if (done === null) return false;
      const em = profiles.email(ctx.configDir, name);
      write('  ✅ Switched to: ' + (em || name) + '\n');
      if (!managed) write('  ↪ Restart Claude Code to apply.\n');
      return true;
    }

    async function switchSel() {
      const list = core.listProfiles(ctx);
      if (!list.length) return;
      const e = list[sel];
      if (e.active) {
        render();
        return;
      }
      input.removeListener('keypress', onKey);
      let ok = false;
      try {
        ok = await keysSwitch(e.name);
      } catch (err) {
        write('  ❌ ' + (err && err.message ? err.message : err) + '\n');
      }
      if (ok) {
        write('\n  Done — you can close this window.\n');
        finish();
      } else if (!finished) {
        input.on('keypress', onKey);
        render();
      }
    }

    async function lineAction(fn) {
      input.removeListener('keypress', onKey);
      if (input.isTTY && input.setRawMode) {
        try {
          input.setRawMode(false);
        } catch (e) {
          /* ignore */
        }
      }
      const rl = readline.createInterface({ input: input, output: output });
      const p = function (s) {
        write((s == null ? '' : s) + '\n');
      };
      const style = stylesFor(output, ctx);
      try {
        await fn(ctx, rl, p, style);
      } catch (err) {
        p('  ❌ ' + (err && err.message ? err.message : err));
      } finally {
        rl.close();
      }
      if (finished) return; // stdin closed during the sub-prompt
      if (input.isTTY && input.setRawMode) {
        try {
          input.setRawMode(true);
        } catch (e) {
          /* ignore */
        }
      }
      if (input.resume) input.resume();
      input.on('keypress', onKey);
      render();
    }

    async function onKey(str, key) {
      key = key || {};
      // Exit: q, Esc, Ctrl-C, Ctrl-D (terminal EOF).
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && (key.name === 'c' || key.name === 'd'))) {
        write('\n  Bye.\n');
        finish();
        return;
      }
      if (key.ctrl || key.meta) return; // ignore all other Ctrl-/Alt- chords (Ctrl-A, Ctrl-K, ...)
      if (key.name === 'up' || key.name === 'k') {
        sel -= 1;
        render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        sel += 1;
        render();
        return;
      }
      if (key.name === 'r') {
        appActive = ctx.appDataDir ? appauth.activeProfileName(ctx) : null;
        render();
        return;
      }
      if (key.name === 'return') {
        await switchSel();
        return;
      } // CR only, not Ctrl-J/LF
      if (str && /^[0-9]$/.test(str)) {
        const list = core.listProfiles(ctx);
        const i = parseInt(str, 10);
        if (i >= 1 && i <= list.length) {
          sel = i - 1;
          await switchSel();
        }
        return;
      }
      if (key.name === 'a') {
        await lineAction(menuAdd);
        return;
      }
      if (key.name === 'd') {
        await lineAction(menuRemove);
        return;
      }
      if (key.name === 't') {
        await lineAction(menuThreads);
        return;
      }
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

export { runMenu, runMenuLine, runMenuKeys, firstNonActiveIndex };
