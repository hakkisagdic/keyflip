// Session manager: browse/search/resume local Claude Code conversations across
// ALL accounts (transcripts in ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// are account-independent). Read-only; nothing is uploaded.
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { run } from './exec.js';

function projectsDir(ctx) {
  return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects');
}

// Pull the first-line cwd and the first user message text from a transcript,
// reading only the head of the file (transcripts can be large).
//
// "Head" means head of the RECORD STREAM, not a fixed byte window: Claude Code writes one JSON
// object per line, and a record that embeds a big paste can run to megabytes, so the `cwd` of a
// session may sit far past any small window. Reading a fixed 64 KiB and calling a miss "this
// transcript has no cwd" made callers fall back to decoding the project DIR name — which is
// lossy (both '/' and '.' became '-'), so live folders were reported as moved/deleted.
const CHUNK_BYTES = 64 * 1024;
const HEAD_CAP_BYTES = 4 * 1024 * 1024; // bounded: no transcript record we need starts deeper

// Feed `chunk` (raw bytes) through a UTF-8 decoder so a multi-byte character split across a
// read boundary does not corrupt the line. Returns { lines, carry } where carry is the
// trailing incomplete line.
function takeLines(decoder, chunk, carry) {
  const text = carry + decoder.write(chunk);
  const parts = text.split('\n');
  return { lines: parts.slice(0, -1), carry: parts[parts.length - 1] };
}

function parseRecord(j, state) {
  if (!state.cwd && typeof j.cwd === 'string') state.cwd = j.cwd;
  if (!state.preview && j.type === 'user' && j.message && j.message.content) {
    const c = j.message.content;
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? (
              c.filter(function (b) {
                return b && b.type === 'text';
              })[0] || {}
            ).text
          : null;
    if (text) state.preview = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
  }
}

function summarize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return null;
  }
  const state = { cwd: null, preview: null };
  try {
    const dec = new StringDecoder('utf8');
    const buf = Buffer.alloc(CHUNK_BYTES);
    let pos = 0,
      carry = '';
    while (pos < HEAD_CAP_BYTES && (!state.cwd || !state.preview)) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const got = takeLines(dec, buf.slice(0, n), carry);
      carry = got.carry;
      for (let i = 0; i < got.lines.length && (!state.cwd || !state.preview); i++) {
        if (!got.lines[i].trim()) continue;
        let j;
        try {
          j = JSON.parse(got.lines[i]);
        } catch (e) {
          continue;
        }
        parseRecord(j, state);
      }
      // A final line with no trailing newline is still the last record — parse it at EOF.
      if (n < buf.length && carry.trim()) {
        try {
          parseRecord(JSON.parse(carry), state);
        } catch (e) {
          /* partial */
        }
        carry = '';
      }
      // Still no cwd and the record has not ended? It is one enormous line (a multi-MB paste).
      // Do not give up and let the caller guess from the dir name: pull the field straight out
      // of the partial record. `"cwd"` is a top-level key on the opening records of a transcript.
      if (!state.cwd && carry.length) {
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(carry);
        if (m) {
          try {
            state.cwd = JSON.parse('"' + m[1] + '"');
          } catch (e) {
            /* leave it for the full parse */
          }
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return state;
}

// ---- LIVENESS: is a session still in use even though its recorded cwd is gone? ----
//
// `fs.existsSync(cwd)` is NOT proof of a dead session. Observed on a real machine during a
// cleanup pass, in the same minute:
//   * `claude --resume=ec408f26…` was RUNNING in `~/Projects/wa-gateway`, whose recorded cwd
//     pointed at a git worktree that `git worktree prune` had already deleted;
//   * the Claude *desktop app* still lists such a session in Recents (its own registry keeps a
//     `cliSessionId` per session) and resumes it, transcript and all;
//   * a transcript written seconds ago is by definition not abandoned.
// `keyflip sessions`/`doctor` used to call all of these "⚠ folder missing — rebind", and
// `sessions delete` would happily act on that. So `orphan` is now asserted only when no
// liveness signal fires, and a cwd that is gone *while the session is live* is reported as
// `staleCwd` — a cosmetic path mismatch, never a deletion hint.
//
// Both signals are external facts, cheap and read-only; tests inject them via opts.
const RECENT_WRITE_MS = 5 * 60 * 1000;

// Parse `ps` output into the session ids a live process resumed. Both spellings Claude Code
// accepts (`--resume=<id>` and `--resume <id>`), including the separately-quoted form a wrapper
// shell shows in `ps` (`claude "--resume" "<id>"`).
//
// The id is required to be at least 8 chars of id-ish characters: `ps -Ao command` also lists
// the SHELL that is running the probe, so an agent's own grep pattern (`--resume=[0-9a-f-]*`,
// `--resume=var`) shows up in the same output. A bare `grep` for the flag would turn that noise
// into a fake "running" claim and mask a genuine orphan.
function parseResumeIds(psOutput) {
  const ids = new Set();
  [/--resume=["']?([^"'\s]+)["']?/g, /--resume["']?[ \t]+["']?([^"'\s]+)["']?/g].forEach(function (re) {
    let m;
    while ((m = re.exec(String(psOutput)))) {
      const id = m[1];
      if (id && /^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/.test(id)) ids.add(id);
    }
  });
  return ids;
}

// Session ids held by live `claude --resume <id>` processes.
function runningSessionIds(ctx) {
  const ids = new Set();
  try {
    const res = run('ps', ['-Ao', 'command='], null, { timeoutMs: 4000 });
    if (res.code !== 0) return ids;
    return parseResumeIds(res.stdout);
  } catch (e) {
    /* no `ps` (or no child_process) — the other signals still apply */
  }
  return ids;
}

// Session ids the desktop app itself tracks, from its Code-session registry:
//   <appData>/claude-code-sessions/<account>/<org>/local_*.json -> { cliSessionId, … }
// Bounded so a hostile/huge store can't stall a listing.
function appRegistrySessionIds(ctx) {
  const ids = new Set();
  const store = ctx.appDataDir && path.join(ctx.appDataDir, 'claude-code-sessions');
  if (!store || !fs.existsSync(store)) return ids;
  let seen = 0;
  const each = function (p) {
    if (seen++ > 20000) return;
    let txt;
    try {
      txt = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return;
    }
    try {
      const j = JSON.parse(txt);
      if (j && typeof j.cliSessionId === 'string') ids.add(j.cliSessionId);
    } catch (e) {
      /* not JSON we understand */
    }
  };
  const walk = function (dir, depth) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    ents.forEach(function (e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (e.isFile() && e.name.slice(0, 6) === 'local_' && e.name.slice(-5) === '.json') each(p);
    });
  };
  walk(store, 0);
  return ids;
}

// id -> reason, for every session we can prove is still in use.
function liveIds(ctx, opts) {
  opts = opts || {};
  const map = new Map();
  const running = opts.running ? new Set(opts.running) : runningSessionIds(ctx);
  const app = opts.appIds ? new Set(opts.appIds) : appRegistrySessionIds(ctx);
  running.forEach(function (id) {
    map.set(id, 'running');
  });
  app.forEach(function (id) {
    if (!map.has(id)) map.set(id, 'app');
  });
  return map;
}

function list(ctx, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(root);
  } catch (e) {
    return [];
  }
  const rows = [];
  const wantCwd = opts.cwd ? path.resolve(opts.cwd) : null;
  projectDirs = projectDirs.filter(function (pd) {
    // rebind/rebindConfigPaths leave `<dir>.keyflip-bak` rollback copies INSIDE the projects
    // root. They hold the same session ids as their live key, so scanning them double-counts
    // every session and — because the backup still records the OLD cwd — reports a freshly
    // rebound project as orphaned again. They are backups, not projects.
    return pd.slice(-'.keyflip-bak'.length) !== '.keyflip-bak';
  });
  projectDirs.forEach(function (pd) {
    const dir = path.join(root, pd);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    files.forEach(function (f) {
      if (f.slice(-6) !== '.jsonl') return;
      const id = f.slice(0, -6);
      // Must start alphanumeric (a leading '-' would smuggle a flag into
      // `claude --resume <id>`) and contain only safe id chars.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return;
      const file = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch (e) {
        return;
      }
      rows.push({
        sessionId: f.slice(0, -6),
        file: file,
        project: pd,
        mtimeMs: st.mtimeMs,
        mtime: st.mtime.toISOString(),
        sizeBytes: st.size,
      });
    });
  });
  rows.sort(function (a, b) {
    return b.mtimeMs - a.mtimeMs;
  });

  // Enrich (head-read) only as many as we might show — cheap for a listing,
  // bounded for a search. For --search we may need full-content scanning.
  const scanLimit = opts.search ? opts.scanLimit || 800 : (opts.limit || 40) * 3;
  const live = liveIds(ctx, opts);
  const nowMs = opts.nowMs == null ? Date.now() : opts.nowMs;
  const out = [];
  for (let i = 0; i < rows.length && out.length < (opts.limit || 40); i++) {
    if (i >= scanLimit && !opts.search) break;
    const r = rows[i];
    const s = summarize(r.file) || {};
    r.cwd = s.cwd || decodeProjectDir(r.project);
    r.preview = s.preview || '';
    r.recentlyWritten = nowMs - r.mtimeMs < RECENT_WRITE_MS;
    // Live = provable from OUTSIDE the transcript: a process resumed it, or the desktop app lists
    // it. Both are facts about the machine, so they can safely cancel the orphan claim. A recent
    // write is kept as a separate advisory flag (`recentlyWritten`) rather than as liveness: a
    // transcript written seconds ago with a dead cwd could also be a session that just crashed,
    // and making `orphan` depend on the wall clock would make it unreproducible in tests.
    r.liveReason = live.get(r.sessionId) || null;
    r.live = !!r.liveReason;
    // Orphan is a claim about the USER'S disk, so it only goes out on authoritative evidence:
    // the cwd the transcript itself recorded. encodeCwd folds EVERY non-alphanumeric character
    // to '-', so decode is lossy: `Projects/laya-uo-bot` decodes to the non-existent
    // `Projects/laya/uo/bot` — a guess that looks exactly like a moved folder. Missing-cwd rows
    // get `orphan:false`; rebind is
    // still reachable by hand since the real cwd is what the transcript says when present.
    // And a missing cwd on a LIVE session is not an orphan either — it is a stale path record
    // (pruned worktree, renamed folder the app still resolves), so it must never be advertised
    // as something to delete.
    const cwdGone = !!(s.cwd && !fs.existsSync(s.cwd));
    r.orphan = cwdGone && !r.live;
    r.staleCwd = cwdGone && r.live;
    if (wantCwd && path.resolve(r.cwd || '') !== wantCwd) continue;
    if (opts.search) {
      const m = searchRow(r, opts.search);
      if (!m) continue;
      r.match = m;
    }
    out.push(r);
  }
  return out;
}

function decodeProjectDir(name) {
  // best-effort: dashes were slashes; leading dash = root. Not lossless.
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

// A short context snippet around `idx` in `text` (whitespace-collapsed).
function snippet(text, idx, len) {
  const start = Math.max(0, idx - 55);
  const end = Math.min(text.length, idx + len + 65);
  const s = text
    .slice(start, end)
    .replace(/\\[nrt"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (start > 0 ? '…' : '') + s + (end < text.length ? '…' : '');
}

// Stream a transcript in bounded chunks looking for `term`; return a context snippet on
// the first hit (or null). Scans up to 8 MB (a chunk-boundary carry catches split matches)
// so a huge/hostile transcript can't exhaust memory yet we search far deeper than a 1 MB read.
function findMatch(file, term) {
  const t = String(term).toLowerCase();
  const CAP = 8 * 1024 * 1024;
  let read = 0,
    carry = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        read += n;
        const chunk = carry + buf.slice(0, n).toString('utf8');
        const idx = chunk.toLowerCase().indexOf(t);
        if (idx !== -1) return snippet(chunk, idx, term.length);
        carry = chunk.slice(-Math.max(term.length, 220)); // catch a match spanning chunks
        if (read >= CAP) break;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

// Search a row by preview/cwd/id (cheap) then transcript CONTENT. Returns the matching
// snippet (so callers can show WHY it matched), or null.
function searchRow(row, term) {
  const t = String(term).toLowerCase();
  if ((row.preview || '').toLowerCase().indexOf(t) !== -1) return row.preview;
  if ((row.cwd || '').toLowerCase().indexOf(t) !== -1) return row.cwd;
  if (row.sessionId.toLowerCase().indexOf(t) !== -1) return row.sessionId;
  return findMatch(row.file, term);
}
function matchesSearch(row, term) {
  return !!searchRow(row, term);
}

// Find one session by id (full or unique prefix).
function find(ctx, idOrPrefix) {
  const all = list(ctx, { limit: 100000 });
  const exact = all.filter(function (r) {
    return r.sessionId === idOrPrefix;
  })[0];
  if (exact) return exact;
  const pref = all.filter(function (r) {
    return r.sessionId.indexOf(idOrPrefix) === 0;
  });
  if (pref.length === 1) return pref[0];
  if (pref.length > 1)
    throw new Error("'" + idOrPrefix + "' is ambiguous (" + pref.length + ' sessions) — use more of the id');
  return null;
}

// The command that resumes a session in its original directory.
function resumeCommand(row) {
  return { cwd: row.cwd, command: 'claude', args: ['--resume', row.sessionId] };
}

// E4: the headless command that INJECTS a message into a session and prints the reply —
// `claude -p "<message>" --resume <id>` (add --fork-session to branch instead of appending).
function sendCommand(row, message, opts) {
  opts = opts || {};
  const args = ['-p', String(message), '--resume', row.sessionId];
  if (opts.fork) args.push('--fork-session');
  return { cwd: row.cwd, command: 'claude', args: args };
}

// Claude Code keys a project by its cwd with EVERY non-alphanumeric character folded to '-'
// — not just '/' and '.'. Evidence from this machine's own ~/.claude/projects (2026-10-07): the
// key `-Users-hakkisagdic--traycer-worktrees-hakkisagdic--loganalyzer-s05-…` contains the
// transcript whose cwd is `/Users/hakkisagdic/.traycer/worktrees/hakkisagdic__loganalyzer/s05-…`
// — so `.` → '-' AND `__` → '--'. Recomputing every key on disk both ways: the old `/[/.]/` rule
// matched 20 of 22, this rule 21 of 22 (the one exception is a session started with an explicit
// `--cwd`, so its recorded cwd is genuinely not its key).
//
// The same rule is also what makes the sessions feature usable on Windows at all: a directory
// name that still contains ':' or '\' cannot exist there, so the POSIX-only mapping made
// rebind/list die with ENOENT on `…\.claude\projects\C:\Users\…` — the windows-latest CI job
// proved it. Folded this way `C:\Users\name\old\repo` → `C--Users-name-old-repo`, which is the
// spelling Claude documents for Windows (':', '\', '/', space and "'" all become '-').
function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

// Copy a session's sidecar tree (sub-agent runs etc.) to the new project key, rewriting the
// moved path inside text records. Directories recurse; non-text files copy verbatim.
function copyTreeRewritten(src, dest, oldCwd, newCwd) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach(function (name) {
    const s = path.join(src, name),
      d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) return copyTreeRewritten(s, d, oldCwd, newCwd);
    const isText = /\.(jsonl|json|txt|md)$/i.test(name);
    if (!isText) return fs.copyFileSync(s, d);
    let raw;
    try {
      raw = fs.readFileSync(s, 'utf8');
    } catch (e) {
      return fs.copyFileSync(s, d);
    }
    fs.writeFileSync(d, raw.split(oldCwd).join(newCwd));
  });
}

// A project's long-term notes live in `<encoded-cwd>/memory/` (MEMORY.md index + one .md per
// note) — the one thing that is NOT keyed by session id. rebind used to move only transcripts
// and their sidecars, so after a repo move the live key kept whatever memory it already had and
// the old key silently kept the rest. Deleting the "duplicate" old key then destroyed those notes
// for good. Merge the directory instead: never overwrite, never drop.
//   dest missing            → copy it, path-rewritten                  (copied)
//   dest byte-identical     → nothing to do                             (identical)
//   dest exists, differs    → keep dest, stash the incoming copy beside it (conflict)
function mergeMemoryTree(srcRoot, destRoot, oldCwd, newCwd) {
  const res = { copied: 0, identical: 0, conflicts: 0 };
  function walk(s, d) {
    let names;
    try {
      names = fs.readdirSync(s);
    } catch (e) {
      return;
    }
    names.forEach(function (name) {
      const sp = path.join(s, name),
        dp = path.join(d, name);
      let st;
      try {
        st = fs.statSync(sp);
      } catch (e) {
        return;
      }
      if (st.isDirectory()) {
        fs.mkdirSync(dp, { recursive: true });
        return walk(sp, dp);
      }
      if (!st.isFile()) return;
      let raw;
      try {
        raw = fs.readFileSync(sp, 'utf8');
      } catch (e) {
        return;
      }
      const text = /\.(jsonl|json|txt|md)$/i.test(name) ? raw.split(oldCwd).join(newCwd) : raw;
      let destExists = true,
        same = false;
      try {
        const cur = fs.readFileSync(dp);
        same = cur.length === Buffer.byteLength(text) && cur.equals(Buffer.from(text));
      } catch (e) {
        destExists = false;
      }
      if (same) return void res.identical++;
      if (!destExists) {
        try {
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(dp, text);
          res.copied++;
        } catch (e) {
          /* unreadable dest dir: the source key still holds it */
        }
        return;
      }
      // Real collision: keep both. `<name>` stays, the incoming note lands as `<name>.keyflip-conflict`.
      try {
        fs.writeFileSync(dp + '.keyflip-conflict', text);
      } catch (e) {
        /* ignore */
      }
      res.conflicts++;
    });
  }
  walk(srcRoot, destRoot);
  return res;
}

// Rebind a project's transcripts after its folder was RENAMED/MOVED. Claude stores each
// transcript under <encoded-old-cwd>/ and refuses to open a session whose recorded `cwd`
// no longer exists — so a rename orphans the whole history. This copies every
// <sessionId>.jsonl from the OLD encoded dir to the NEW one, rewriting the old cwd string
// to the new one inside each. Backs up the old dir first. Pure fs (cross-platform).
// Returns { ok, moved, skipped, sidecars, memory, oldDir, newDir, backup, reason? }.
function rebind(ctx, oldCwd, newCwd, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  const oldDir = path.join(root, encodeCwd(oldCwd));
  const newDir = path.join(root, encodeCwd(newCwd));
  if (oldDir === newDir) return { ok: false, reason: 'same-path', oldDir: oldDir, newDir: newDir };
  if (!fs.existsSync(oldDir)) return { ok: false, reason: 'no-old-project', oldDir: oldDir, newDir: newDir };
  let files;
  try {
    files = fs.readdirSync(oldDir).filter(function (f) {
      return f.slice(-6) === '.jsonl';
    });
  } catch (e) {
    return { ok: false, reason: 'unreadable', oldDir: oldDir, newDir: newDir };
  }
  // A key can hold ONLY notes: Claude prunes old transcripts, and a previous rebind never carried
  // memory/, so a moved project's notes were stranded at a transcript-less dead key that rebind
  // then refused outright. Treat notes as enough work to do.
  const srcMem = path.join(oldDir, 'memory'),
    destMem = path.join(newDir, 'memory');
  const hasMemory = fs.existsSync(srcMem) && fs.statSync(srcMem).isDirectory();
  if (!files.length && !hasMemory) return { ok: false, reason: 'no-transcripts', oldDir: oldDir, newDir: newDir };

  let backup = null;
  if (files.length) {
    try {
      backup = oldDir + '.keyflip-bak';
      fs.mkdirSync(backup, { recursive: true });
      files.forEach(function (f) {
        fs.copyFileSync(path.join(oldDir, f), path.join(backup, f));
        // back up the sidecar too, or a rollback restores the transcript but not its sub-agents
        const sub = path.join(oldDir, f.slice(0, -6));
        if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
          try {
            fs.cpSync(sub, path.join(backup, f.slice(0, -6)), { recursive: true });
          } catch {
            /* best-effort */
          }
        }
      });
    } catch (e) {
      backup = null;
    }
  }

  fs.mkdirSync(newDir, { recursive: true });
  let moved = 0,
    skipped = 0,
    sidecars = 0;
  files.forEach(function (f) {
    const dest = path.join(newDir, f);
    if (fs.existsSync(dest) && !opts.force) {
      skipped++;
      return;
    }
    let content;
    try {
      content = fs.readFileSync(path.join(oldDir, f), 'utf8');
    } catch (e) {
      skipped++;
      return;
    }
    const rewritten = content.split(oldCwd).join(newCwd); // rewrite cwd refs so Claude accepts it
    try {
      fs.writeFileSync(dest, rewritten);
      moved++;
      // Claude Code also keeps a per-session DIRECTORY beside the transcript —
      // `<encoded-cwd>/<sessionId>/subagents/agent-*.jsonl` holds the sub-agent runs a session
      // spawned. The old copy loop only looked at top-level `.jsonl`, so a rebind silently
      // left that sidecar behind at the dead key: the rebound session resumed with its
      // sub-agent history unreachable (and on a big repo that is megabytes per session).
      // Carry it too, rewriting the moved path inside so nothing points at the old folder.
      const srcSub = path.join(oldDir, f.slice(0, -6));
      if (fs.existsSync(srcSub) && fs.statSync(srcSub).isDirectory()) {
        try {
          copyTreeRewritten(srcSub, path.join(newDir, f.slice(0, -6)), oldCwd, newCwd);
          sidecars++;
        } catch {
          /* sidecar is optional detail; the transcript itself already moved */
        }
      }
    } catch (e) {
      skipped++;
    }
  });
  // Carry the project's notes too — they sit beside the transcripts, not inside them, so the
  // session loop above never sees them. Runs even when every transcript already existed at the
  // new key: memory is merged, and a merged-away note is unrecoverable from any backup rebind
  // takes (the .keyflip-bak only ever held .jsonl + sidecars).
  const mem = { copied: 0, identical: 0, conflicts: 0 };
  if (hasMemory) {
    try {
      const r = mergeMemoryTree(srcMem, destMem, oldCwd, newCwd);
      mem.copied = r.copied;
      mem.identical = r.identical;
      mem.conflicts = r.conflicts;
    } catch (e) {
      /* best-effort: a failed note merge must not undo the transcript move */
    }
  }

  // Disable the old copies so the app doesn't show stale duplicates (reversible: .disabled).
  if (opts.purgeOld && moved) {
    files.forEach(function (f) {
      try {
        fs.renameSync(path.join(oldDir, f), path.join(oldDir, f + '.disabled'));
      } catch (e) {
        /* ignore */
      }
    });
  }
  return {
    ok: moved > 0 || mem.copied > 0,
    moved: moved,
    skipped: skipped,
    sidecars: sidecars,
    memory: mem,
    oldDir: oldDir,
    newDir: newDir,
    backup: backup,
  };
}

// Streaming file equality: cheap size check first, then a 1 MiB chunk-by-chunk compare, so a
// 100 MB transcript is never fully loaded into memory by a duplication proof.
function sameFile(a, b) {
  let sa, sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch (e) {
    return false;
  }
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  if (sa.size === 0) return true;
  let fa, fb;
  try {
    fa = fs.openSync(a, 'r');
    fb = fs.openSync(b, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    const buf2 = Buffer.alloc(1024 * 1024);
    for (let pos = 0; pos < sa.size; pos += buf.length) {
      const na = fs.readSync(fa, buf, 0, buf.length, pos);
      const nb = fs.readSync(fb, buf2, 0, buf2.length, pos);
      if (na !== nb) return false;
      if (na > 0 && buf.compare(buf2, 0, na, 0, na) !== 0) return false;
      if (na <= 0) break;
    }
    return true;
  } catch (e) {
    return false;
  } finally {
    if (typeof fa === 'number') fs.closeSync(fa);
    if (typeof fb === 'number') fs.closeSync(fb);
  }
}

// Every file under `dir`, as { rel, abs, size }.
function walkFiles(dir, base) {
  base = base || dir;
  const out = [];
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  ents.forEach(function (e) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push.apply(out, walkFiles(p, base));
    else if (e.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        /* unreadable size still counts as a file that exists */
      }
      out.push({ rel: path.relative(base, p), abs: p, size: size });
    }
  });
  return out;
}

// ---- Reclaim the backups rebind leaves behind ----
//
// rebind COPIES (never moves) and snapshots the old key into `<encoded-old-cwd>.keyflip-bak`
// first. Both copies then sit in the projects root, and `list()` deliberately filters `.keyflip-bak`
// out of every scan — so the backup is invisible to `sessions`, invisible to `doctor`, and nothing
// ever reclaims it. Measured on a real machine after one rebinding pass: 1 807 duplicate files,
// 657 MiB, that no keyflip command would show the user.
//
// A backup file is proven redundant when BOTH hold:
//   1. the live old key (`<enc>` without the suffix) still holds a byte-identical copy — so
//      deleting the backup loses nothing that is not already on disk twice; and
//   2. the same session id also exists under some OTHER project key — i.e. the rebind actually
//      landed, which is the only reason the backup was taken.
// Anything unproven is KEPT and named. Removal is opt-in (`opts.apply`), and like every keyflip
// mutation it sits behind the config-dir git snapshot, so `keyflip undo` still gets it back.
const BAK_SUFFIX = '.keyflip-bak';

function backupKeys(ctx) {
  const root = projectsDir(ctx);
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  return ents
    .filter(function (e) {
      return e.isDirectory() && e.name.slice(-BAK_SUFFIX.length) === BAK_SUFFIX;
    })
    .map(function (e) {
      return e.name.slice(0, -BAK_SUFFIX.length);
    });
}

// Which other project keys hold `<sessionId>.jsonl` (the rebind landing proof).
function landedElsewhere(root, keyName, sessionId) {
  const fname = sessionId + '.jsonl';
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return false;
  }
  return ents.some(function (e) {
    if (!e.isDirectory() || e.name === keyName || e.name.slice(-BAK_SUFFIX.length) === BAK_SUFFIX) return false;
    return fs.existsSync(path.join(root, e.name, fname));
  });
}

function pruneBackups(ctx, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  const res = { dryRun: !opts.apply, keys: [], removable: 0, removableBytes: 0, removed: 0, kept: 0 };
  backupKeys(ctx).forEach(function (keyName) {
    const bakDir = path.join(root, keyName + BAK_SUFFIX);
    const liveDir = path.join(root, keyName);
    const files = walkFiles(bakDir);
    const entry = { key: keyName + BAK_SUFFIX, files: files.length, bytes: 0, blockers: [] };
    files.forEach(function (f) {
      entry.bytes += f.size;
      const twin = path.join(liveDir, f.rel);
      if (!fs.existsSync(liveDir)) {
        if (entry.blockers.indexOf('source-key-gone') === -1) entry.blockers.push('source-key-gone');
        return;
      }
      if (!sameFile(f.abs, twin)) {
        if (entry.blockers.indexOf('differs-from-live-copy') === -1) entry.blockers.push('differs-from-live-copy');
        return;
      }
      // The session id is the top-level name (or the first segment of a sidecar path).
      const sessionId = (f.rel.split(path.sep)[0] || '').replace(/\.jsonl$/, '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
        if (entry.blockers.indexOf('unrecognized-name') === -1) entry.blockers.push('unrecognized-name');
        return;
      }
      if (!landedElsewhere(root, keyName, sessionId)) {
        if (entry.blockers.indexOf('rebind-not-landed') === -1) entry.blockers.push('rebind-not-landed');
      }
    });
    if (!files.length || entry.blockers.length) {
      res.kept++;
      entry.status = files.length ? 'kept' : 'empty';
      res.keys.push(entry);
      return;
    }
    entry.status = 'redundant';
    res.removable++;
    res.removableBytes += entry.bytes;
    res.keys.push(entry);
    if (opts.apply) {
      try {
        fs.rmSync(bakDir, { recursive: true, force: true });
        res.removed++;
      } catch (e) {
        entry.status = 'kept';
        entry.blockers = ['unlink-failed'];
        res.removable--;
        res.removableBytes -= entry.bytes;
        res.kept++;
      }
    }
  });
  return res;
}

// ---- Empty / half-empty project keys ----
//
// Claude prunes transcripts but never removes the folder, and a rebind that ran with
// `--purge-old` leaves the key behind, emptied. Such dirs are pure clutter (the sweep found 80 of
// them) yet they also make `ls ~/.claude/projects` look like lost history. Only a key with
// ZERO files anywhere inside is removed — a key holding just `memory/` notes or just a sub-agent
// sidecar does hold content, so it is reported by kind and left alone.
function emptyProjects(ctx, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  const res = { dryRun: !opts.apply, empty: 0, emptyBytes: 0, removed: 0, notesOnly: [], sidecarsOnly: [] };
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return res;
  }
  ents.forEach(function (e) {
    if (!e.isDirectory()) return;
    if (e.name.slice(-BAK_SUFFIX.length) === BAK_SUFFIX) return; // handled by pruneBackups
    const dir = path.join(root, e.name);
    const files = walkFiles(dir);
    if (!files.length) {
      res.empty++;
      if (opts.apply) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          res.removed++;
        } catch {
          /* still counted as a candidate; the next run retries */
        }
      }
      return;
    }
    const hasTranscript = files.some(function (f) {
      return f.rel.indexOf(path.sep) === -1 && f.rel.slice(-6) === '.jsonl';
    });
    if (hasTranscript) return;
    const bytes = files.reduce(function (n, f) {
      return n + f.size;
    }, 0);
    const row = { key: e.name, files: files.length, bytes: bytes };
    if (files.every(isMemoryFile)) res.notesOnly.push(row);
    else res.sidecarsOnly.push(row);
  });
  return res;
}

function isMemoryFile(f) {
  const seg = f.rel.split(path.sep);
  return seg[0] === 'memory';
}

// Best-effort (macOS): the desktop app also keeps a session REGISTRY that records each
// session's cwd/originCwd; a rename leaves those pointing at the gone path (and the app
// flags `transcriptUnavailable`). Rewrite the old cwd -> new cwd in those records and, when
// the transcript now exists, clear the unavailable flag. Only safe while the app is closed.
function rebindAppRegistry(ctx, oldCwd, newCwd) {
  if (!ctx.appDataDir) return { patched: 0 };
  const store = path.join(ctx.appDataDir, 'claude-code-sessions');
  // The transcripts now live under the NEW encoded key. When the desktop app lost the folder it
  // DROPPED the record's cliSessionId (the link to the .jsonl) and set transcriptUnavailable — so
  // besides rewriting cwd we must RECONNECT that link, else the Code session still won't open.
  let newSessionIds = [];
  try {
    newSessionIds = fs
      .readdirSync(path.join(projectsDir(ctx), encodeCwd(newCwd)))
      .filter(function (f) {
        return f.slice(-6) === '.jsonl';
      })
      .map(function (f) {
        return f.slice(0, -6);
      });
  } catch (e) {
    newSessionIds = [];
  }
  let patched = 0,
    relinked = 0;
  let accts;
  try {
    accts = fs.readdirSync(store);
  } catch (e) {
    return { patched: 0, relinked: 0 };
  }
  accts.forEach(function (a) {
    let orgs;
    try {
      orgs = fs.readdirSync(path.join(store, a));
    } catch (e) {
      return;
    }
    orgs.forEach(function (o) {
      const dir = path.join(store, a, o);
      let recs;
      try {
        recs = fs.readdirSync(dir);
      } catch (e) {
        return;
      }
      recs.forEach(function (rf) {
        if (rf.slice(-5) !== '.json') return;
        const p = path.join(dir, rf);
        let txt;
        try {
          txt = fs.readFileSync(p, 'utf8');
        } catch (e) {
          return;
        }
        if (txt.indexOf(oldCwd) === -1) return;
        let obj;
        try {
          obj = JSON.parse(txt);
        } catch (e) {
          return;
        }
        const before = JSON.stringify(obj);
        ['cwd', 'originCwd'].forEach(function (k) {
          if (typeof obj[k] === 'string') obj[k] = obj[k].split(oldCwd).join(newCwd);
        });
        // Restore the dropped transcript link: if cliSessionId is missing or points at a .jsonl not
        // present under the new key, and the new key has exactly one transcript, adopt it.
        if (newSessionIds.length && (!obj.cliSessionId || newSessionIds.indexOf(obj.cliSessionId) === -1)) {
          if (newSessionIds.length === 1) {
            obj.cliSessionId = newSessionIds[0];
            relinked++;
          }
        }
        if (obj.transcriptUnavailable) delete obj.transcriptUnavailable;
        if (JSON.stringify(obj) !== before) {
          try {
            fs.writeFileSync(p, JSON.stringify(obj, null, 2));
            patched++;
          } catch (e) {
            /* ignore */
          }
        }
      });
    });
  });
  return { patched: patched, relinked: relinked };
}

// After a project's folder is renamed/moved, its ABSOLUTE path is also baked into config
// surfaces that transcripts/app-registry don't cover, and a rename leaves every one of them
// pointing at the gone path:
//   • ~/.claude.json      — the `projects` map keys, `githubRepoPaths`, and any stdio MCP
//                           server whose command/args point INTO the folder (e.g. a local binary).
//   • ~/.claude/settings.json + settings.local.json — permission rules that name a path.
//   • ~/.claude/commands/* — slash-command scripts (*.md/*.json/*.sh) with hard-coded paths.
//   • <appData>/claude_desktop_config.json, git-worktrees.json — desktop-app config.
// This rewrites oldCwd -> newCwd across them with a raw substring replace (so nested paths like
// <old>/apps/x are fixed too — same semantics as transcript rebind), backing up each touched
// file as <file>.keyflip-bak first. Pass opts.extraFiles to include app-specific configs the
// caller knows about (e.g. a tool's own config). opts.dryRun reports without writing.
// Returns { files: [{path, hits}], patched, backedUp }.
function rebindConfigPaths(ctx, oldCwd, newCwd, opts) {
  opts = opts || {};
  if (!oldCwd || !newCwd || oldCwd === newCwd) return { files: [], patched: 0, backedUp: 0 };
  const claudeDir = ctx.claudeDir || path.join(ctx.home, '.claude');
  const claudeConfig =
    ctx.claudeConfigPath ||
    path.join(path.basename(claudeDir) === '.claude' ? path.dirname(claudeDir) : claudeDir, '.claude.json');
  const settings = ctx.claudeSettingsPath || path.join(claudeDir, 'settings.json');
  const targets = [claudeConfig, settings, path.join(claudeDir, 'settings.local.json')];
  // slash-command scripts under commands/
  const cmdDir = path.join(claudeDir, 'commands');
  try {
    fs.readdirSync(cmdDir).forEach(function (f) {
      if (/\.(md|json|sh|js|ts)$/.test(f)) targets.push(path.join(cmdDir, f));
    });
  } catch (e) {
    /* no commands dir */
  }
  // desktop-app config surfaces
  if (ctx.appDataDir) {
    targets.push(path.join(ctx.appDataDir, 'claude_desktop_config.json'));
    targets.push(path.join(ctx.appDataDir, 'git-worktrees.json'));
  }
  if (Array.isArray(opts.extraFiles))
    opts.extraFiles.forEach(function (f) {
      targets.push(f);
    });

  const seen = {},
    results = [];
  let patched = 0,
    backedUp = 0;
  targets.forEach(function (f) {
    if (seen[f]) return;
    seen[f] = true;
    let txt;
    try {
      txt = fs.readFileSync(f, 'utf8');
    } catch (e) {
      return;
    } // missing/unreadable -> skip
    if (txt.indexOf(oldCwd) === -1) return;
    const hits = txt.split(oldCwd).length - 1;
    const rewritten = txt.split(oldCwd).join(newCwd);
    if (rewritten === txt) return;
    if (!opts.dryRun) {
      try {
        fs.copyFileSync(f, f + '.keyflip-bak');
        backedUp++;
      } catch {
        /* best-effort */
      }
      try {
        fs.writeFileSync(f, rewritten);
      } catch (e) {
        return;
      }
    }
    results.push({ path: f, hits: hits });
    patched++;
  });
  return { files: results, patched: patched, backedUp: backedUp };
}

// B3: compact a transcript by eliding bulky TOOL OUTPUT (file reads, command output,
// images) while keeping the conversation text intact and the JSONL still valid/resumable.
// Long strings are truncated ONLY inside tool-result/tool-use contexts (or stdout/stderr/
// toolUseResult keys) — message text is never touched. Returns { compacted, before, after, elided }.
function shortenStr(s, threshold) {
  const b = Buffer.byteLength(s);
  if (b <= threshold) return null;
  return s.slice(0, 400) + '\n…[' + (b - 600) + ' bytes elided by keyflip compact]…\n' + s.slice(-200);
}
function truncateToolStrings(node, threshold, changed, inTool) {
  if (!node || typeof node !== 'object') return;
  const here =
    inTool ||
    node.type === 'tool_result' ||
    node.type === 'tool_use' ||
    Object.prototype.hasOwnProperty.call(node, 'tool_use_id') ||
    Object.prototype.hasOwnProperty.call(node, 'toolUseResult');
  Object.keys(node).forEach(function (k) {
    const v = node[k];
    if (typeof v === 'string') {
      if (here || k === 'stdout' || k === 'stderr' || k === 'toolUseResult' || k === 'output') {
        const sh = shortenStr(v, threshold);
        if (sh !== null) {
          node[k] = sh;
          changed.n++;
        }
      }
    } else if (v && typeof v === 'object') {
      truncateToolStrings(v, threshold, changed, here);
    }
  });
}
function compactTranscript(content, opts) {
  opts = opts || {};
  const threshold = opts.threshold || 2000;
  const before = Buffer.byteLength(content);
  let elided = 0;
  const out = String(content)
    .split('\n')
    .map(function (line) {
      if (!line.trim()) return line;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        return line;
      } // keep un-parseable lines verbatim
      const changed = { n: 0 };
      truncateToolStrings(obj, threshold, changed, false);
      if (!changed.n) return line;
      elided += changed.n;
      try {
        return JSON.stringify(obj);
      } catch (e) {
        return line;
      }
    })
    .join('\n');
  return { compacted: out, before: before, after: Buffer.byteLength(out), elided: elided };
}

export {
  projectsDir,
  list,
  find,
  summarize,
  resumeCommand,
  sendCommand,
  decodeProjectDir,
  encodeCwd,
  rebind,
  rebindAppRegistry,
  rebindConfigPaths,
  searchRow,
  findMatch,
  matchesSearch,
  compactTranscript,
  liveIds,
  parseResumeIds,
  runningSessionIds,
  appRegistrySessionIds,
  pruneBackups,
  emptyProjects,
  backupKeys,
  walkFiles,
  sameFile,
};
