// #41 — "is a secret still readable in the past?" keyflip versions its state dir with git, and
// `doctor`'s existing check only looks at what is TRACKED NOW. Untracking a file (`git rm --cached`)
// stops future commits from carrying it; it does not remove the blobs that earlier commits already
// hold. That is the residual risk after any capture that predated a .gitignore rule, and it is what
// has to be provably clean before keyflip starts mirroring transcripts (which are full of pasted
// keys). Two questions, answered separately:
//
//   historyLeaks()  — SCAN (read-only): walk every blob ever committed, run it through the same
//                     shape scanner every outbound surface uses, report file + secret KIND + the
//                     commits that still hold it. Never a value.
//   planScrub()/applyScrub() — REMOVE: `git filter-repo --invert-paths` over exactly the leaked
//                     paths. Refuses without git-filter-repo installed (a half rewrite is worse
//                     than none), and always writes a `git bundle` first, because rewriting history
//                     destroys the very evidence the user may want back.
//
//   keepsakeAudit() — the same scan over keyflip's distilled keepsakes (plain files, no git), since
//                     a distilled "Gotchas: my key is sk-ant-…" is a secret in a *readable* file that
//                     recall and migrate both carry.
import fs from 'fs';
import path from 'path';
import { run } from './exec.js';
import * as vcs from './vcs.js';
import * as secretpaths from './secretpaths.js';
import * as secretscan from './secretscan.js';
import * as secretpolicy from './secretpolicy.js';

const MAX_BLOBS = 5000; // a state repo has hundreds of objects; this is a guard, not a limit in practice
const MAX_BLOB_BYTES = 1024 * 1024; // a 1 MB keepsake of prose is not worth streaming through regexes

// Only the SHAPE-BASED catch-all patterns (no key name, no vendor prefix — just "long hex") fire on
// identifiers too: a 64-hex userID or a git sha looks exactly like a hex secret. A leak whose ONLY
// evidence is one of these is reported as low confidence, which matters because scrubbing a path that
// is still tracked today also deletes the live file — that trade needs a real secret behind it.
const GENERIC_KINDS = ['long-hex-secret'];

function gitx(ctx, args, input, runner) {
  const r = runner || run;
  try {
    return r('git', ['-C', ctx.configDir].concat(args), input, { timeoutMs: 30000 });
  } catch (e) {
    return { code: 1, stdout: '', stderr: String((e && e.message) || e) };
  }
}

// "<sha> <path>" per object. Paths can contain spaces, so the sha is the first token and the path is
// everything after the first space.
function listObjects(ctx, runner) {
  const r = gitx(ctx, ['rev-list', '--objects', '--all'], undefined, runner);
  if (!r || r.code !== 0) return { error: String(r && (r.stderr || r.code)) };
  const out = [];
  String(r.stdout || '')
    .split('\n')
    .forEach(function (line) {
      if (!line.trim()) return;
      const i = line.indexOf(' ');
      if (i === -1) return; // a root commit with no path is normal
      out.push({ sha: line.slice(0, i), file: line.slice(i + 1).trim() });
    });
  return { objects: out };
}

// Line-oriented sizes (no content, so byte/char offsets can't desync the parse).
function blobSizes(ctx, shas, runner) {
  const sizes = new Map();
  if (!shas.length) return sizes;
  const r = gitx(ctx, ['cat-file', '--batch-check'], shas.join('\n') + '\n', runner);
  if (!r || r.code !== 0) return sizes;
  String(r.stdout || '')
    .split('\n')
    .forEach(function (line) {
      const p = line.split(' ');
      if (p.length >= 3 && p[1] === 'blob') sizes[p[0]] = parseInt(p[2], 10);
    });
  return sizes;
}

// One blob per spawn: correct for any encoding, and cheap at the scale of a config repo.
function readBlob(ctx, sha, runner) {
  const r = gitx(ctx, ['cat-file', 'blob', sha], undefined, runner);
  if (!r || r.code !== 0) return null;
  return String(r.stdout || '');
}

// How many commits still hold this path? (`git log` per leaked file — leaks are few.)
function commitCount(ctx, file, runner) {
  const r = gitx(ctx, ['log', '--all', '--oneline', '--', file], undefined, runner);
  if (!r || r.code !== 0) return 0;
  return String(r.stdout || '')
    .split('\n')
    .filter(Boolean).length;
}

// Is git-filter-repo present? It ships as `git filter-repo` (on PATH as a git subcommand) or as the
// standalone `git-filter-repo` script.
function filterRepoAvailable(runner) {
  const r = runner || run;
  try {
    const a = r('git', ['filter-repo', '--version']);
    if (a && a.code === 0) return true;
  } catch (e) {
    /* try the standalone name */
  }
  try {
    const b = r('git-filter-repo', ['--version']);
    return !!(b && b.code === 0);
  } catch (e) {
    return false;
  }
}

// Which paths exist in HEAD right now? Line-oriented (no content), fetched ONCE per scan.
// A path that is still tracked is live state: dropping it from history also drops it from the
// working tree, so the scrub must say so rather than do it silently.
function trackedFiles(ctx, runner) {
  const r = gitx(ctx, ['ls-tree', '-r', '--name-only', 'HEAD'], undefined, runner);
  if (!r || r.code !== 0) return new Set();
  return new Set(
    String(r.stdout || '')
      .split('\n')
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean),
  );
}

function isHighConfidence(labels, secretPath) {
  if (secretPath) return true;
  if (!labels.length) return false;
  return labels.some(function (k) {
    return GENERIC_KINDS.indexOf(k) === -1;
  });
}

/**
 * Scan every blob in the state repo's history for secret shapes.
 * @param {object} ctx - keyflip context (needs configDir).
 * @param {object} [opts] - { run, maxBlobs, maxBlobBytes, tracked } for tests and tuning.
 * @returns {{ok:boolean, reason?:string, leaks:Array, scanned:number, skipped:number, truncated:boolean}}
 *          Leaks carry file + secret KIND + blob sha + commit count + confidence + trackedNow —
 *          never a value.
 */
function historyLeaks(ctx, opts) {
  opts = opts || {};
  const runner = opts.run;
  if (!vcs.isRepo(ctx)) return { ok: false, reason: 'no-repo', leaks: [], scanned: 0, skipped: 0, truncated: false };
  const listed = listObjects(ctx, runner);
  if (listed.error) return { ok: false, reason: 'git-failed', leaks: [], scanned: 0, skipped: 0, truncated: false };

  // Only BLOBS carry content; commits/trees are listed too, but --batch-check will not size them.
  const objs = listed.objects || [];
  const sizes = blobSizes(
    ctx,
    objs.map(function (o) {
      return o.sha;
    }),
    runner,
  );
  const cap = opts.maxBlobs || MAX_BLOBS;
  const maxBytes = opts.maxBlobBytes || MAX_BLOB_BYTES;
  const tracked = opts.tracked || trackedFiles(ctx, runner);

  const leaks = [];
  let scanned = 0;
  let skipped = 0;
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    const size = sizes[o.sha];
    if (size == null) continue; // not a blob (tree/commit)
    if (size > maxBytes) {
      skipped++;
      continue;
    }
    if (scanned >= cap) {
      skipped += objs.length - i;
      return { ok: true, leaks: leaks, scanned: scanned, skipped: skipped, truncated: true };
    }
    const content = readBlob(ctx, o.sha, runner);
    if (content == null) {
      skipped++;
      continue;
    }
    scanned++;
    const labels = secretscan.scanLabeled(content);
    // A file keyflip itself calls secret counts as a leak even when its content matches no shape:
    // a capture whose format the scanner does not know is still a capture in history.
    const base = (o.file || '').split('/').pop();
    const secretPath =
      secretpaths.isSecretFile(base) || secretpaths.SECRET_DIRS.indexOf((o.file || '').split('/')[0]) !== -1;
    if (!labels.length && !secretPath) continue;
    leaks.push({
      file: o.file,
      blob: o.sha,
      bytes: size,
      kinds: labels,
      secretPath: secretPath,
      confidence: isHighConfidence(labels, secretPath) ? 'high' : 'low',
      trackedNow: tracked.has(o.file),
      commits: commitCount(ctx, o.file, runner),
    });
  }
  return { ok: true, leaks: leaks, scanned: scanned, skipped: skipped, truncated: false };
}

/**
 * What a scrub WOULD do, and what it cannot promise. Pure — writes nothing.
 *
 * #44: a path can be TOLERATED by the secrets policy — the user decided that secret is expected and not
 * worth an alarm. That changes the ADVICE, never the plan: tolerating a key does not make its old blob
 * unreadable, so a tolerated path stays in `paths` and is scrubbed like any other. What drops out is the
 * "rotate the credential anyway" line, because telling someone to rotate a free-tier key they knowingly
 * left in a capture is exactly the noise that makes `doctor` get ignored.
 * @param {object} ctx - keyflip context.
 * @param {Array} leaks - historyLeaks().leaks
 * @param {object} [opts] - { run, now, home, includeTracked, policy }
 * @returns {{mode:string, paths:string[], skippedTracked:string[], bundle:string, blockers:string[], warns:string[]}}
 */
function planScrub(ctx, leaks, opts) {
  opts = opts || {};
  leaks = leaks || [];
  const includeTracked = !!opts.includeTracked;
  // `policy` lets a caller that already loaded it (CLI/MCP) pass it in; loading it here keeps the
  // function correct for every other caller, incl. the tests that never had a policy file.
  const classified = secretpolicy.classify(ctx, leaks, { policy: opts.policy });
  // Per FILE, not per blob: one path can hold a tolerated blob and an alarming one across commits, and
  // the plan must only go quiet when EVERY finding on that path is silenced.
  const alarmed = {};
  const silencedBy = {};
  classified.findings.forEach(function (f) {
    if (f.tolerated) {
      if (!silencedBy[f.file]) silencedBy[f.file] = f.by;
      return;
    }
    alarmed[f.file] = true;
  });
  const paths = [];
  const toleratedPaths = [];
  const alarmPaths = [];
  const skippedTracked = [];
  leaks.forEach(function (l) {
    if (!l.file) return;
    // A path still tracked in HEAD is LIVE state: filter-repo would remove it from every commit,
    // working tree included. Never do that unasked — history-only leaks are the safe default.
    if (l.trackedNow && !includeTracked) {
      if (skippedTracked.indexOf(l.file) === -1) skippedTracked.push(l.file);
      return;
    }
    if (paths.indexOf(l.file) === -1) {
      paths.push(l.file);
      if (alarmed[l.file]) alarmPaths.push(l.file);
      else if (silencedBy[l.file]) toleratedPaths.push(l.file);
    }
  });
  // Outside the repo, or the backup of the leak would itself be a tracked file.
  const bundle = path.join(
    path.dirname(ctx.configDir),
    'keyflip-history-backup-' +
      String(opts.now ? opts.now() : new Date().toISOString()).replace(/[:.]/g, '-') +
      '.bundle',
  );
  const blockers = [];
  if (!paths.length)
    blockers.push(
      skippedTracked.length
        ? 'every leaked path is still tracked today — nothing can be scrubbed without --include-tracked'
        : 'nothing to scrub — the history scan found no secret',
    );
  if (!filterRepoAvailable(opts.run))
    blockers.push(
      'git-filter-repo is not installed — refusing to rewrite history by hand (a partial rewrite can corrupt the repo). Install it (brew install git-filter-repo / pipx install git-filter-repo), then re-run.',
    );
  const warns = [
    // A bundle is the ONLY thing that makes this reversible — and it contains the secrets.
    'a git bundle of the CURRENT history is written to ' +
      bundle +
      ' (0600) — it contains the secrets, so move it off the machine or delete it once the scrub is confirmed',
    'rewriting history changes every commit id; if this state repo was ever PUSHED, the remote still holds the old blobs until you force-push and the remote drops them',
  ];
  // #44: rotation advice is what an alarm COSTS the user. A tolerated finding is scrubbed like any
  // other — history cleanup is free and wanted — but "rotate the credential" is only said about the
  // paths that are still alarms. Saying it about a knowingly-kept free-tier key is how the whole report
  // gets ignored.
  if (alarmPaths.length)
    warns.push(
      'the credentials themselves must be rotated anyway — a removed secret that is still valid is not a fixed secret' +
        (toleratedPaths.length
          ? ' (' +
            alarmPaths.length +
            ' path(s) here still warrant that; ' +
            toleratedPaths.length +
            ' tolerated by policy do not)'
          : ''),
    );
  else if (toleratedPaths.length)
    warns.push(
      toleratedPaths.length +
        ' path(s) in this plan are TOLERATED by the secrets policy: they are still removed from history, and no rotation is advised — keyflip secrets list shows the rule',
    );
  if (skippedTracked.length)
    warns.push(
      skippedTracked.length +
        ' leaked path(s) are still TRACKED today and were left alone (' +
        skippedTracked.join(', ') +
        '). A tracked path is live state: scrubbing it deletes the working file too. Decide first whether it belongs in the state repo at all — and pass --include-tracked only when you mean to lose that file.',
    );
  return {
    mode: blockers.length ? 'refuse' : 'filter-repo',
    paths: paths,
    skippedTracked: skippedTracked,
    // #44: which of `paths` is silenced by policy and which still warrants an alarm. BOTH are scrubbed.
    toleratedPaths: toleratedPaths,
    alarmPaths: alarmPaths,
    bundle: bundle,
    warns: warns,
    blockers: blockers,
  };
}

/**
 * Back up, then remove the leaked paths from history. Destructive by design: needs --apply at the
 * CLI and a real git-filter-repo on PATH.
 * @returns {{ok:boolean, reason?:string, bundle?:string, removed?:string[], bundleFailed?:boolean}}
 */
function applyScrub(ctx, leaks, opts) {
  opts = opts || {};
  const plan = planScrub(ctx, leaks, opts);
  if (plan.mode !== 'filter-repo') return { ok: false, reason: plan.blockers[0], plan: plan };
  // 1. The escape hatch FIRST. A bundle failure must not be survivable-by-ignoring: without it a
  //    rewrite is irreversible, so refuse rather than proceed.
  const b = gitx(ctx, ['bundle', 'create', plan.bundle, '--all'], undefined, opts.run);
  if (!b || b.code !== 0 || !fs.existsSync(plan.bundle))
    return {
      ok: false,
      reason:
        'could not write the history bundle (' +
        String((b && b.stderr) || 'git bundle failed') +
        ') — refusing to rewrite without a backup',
    };
  try {
    fs.chmodSync(plan.bundle, 0o600);
  } catch (e) {
    /* best-effort: the bundle is already outside the repo */
  }
  // 1b. A backup that cannot be read back is not a backup. Prove it before destroying the original.
  try {
    const v = gitx(ctx, ['bundle', 'verify', plan.bundle], undefined, opts.run);
    if (!v || v.code !== 0)
      return {
        ok: false,
        reason:
          'the history bundle was written but did not verify (' +
          String((v && v.stderr) || 'git bundle verify failed') +
          ') — refusing to rewrite history against a backup we cannot read back',
      };
  } catch (e) {
    return { ok: false, reason: 'could not verify the history bundle (' + String((e && e.message) || e) + ')' };
  }
  // 2. Drop the leaked paths from every commit.
  const args = ['filter-repo', '--invert-paths', '--force'];
  plan.paths.forEach(function (p) {
    args.push('--path', p);
  });
  const r = (opts.run || run)('git', ['-C', ctx.configDir].concat(args), undefined, { timeoutMs: 300000 });
  if (!r || r.code !== 0)
    return {
      ok: false,
      reason: 'git-filter-repo failed: ' + String((r && (r.stderr || r.code)) || 'error'),
      bundle: plan.bundle,
      restored: 'the repo is untouched; the backup is at ' + plan.bundle,
    };
  // 3. filter-repo leaves the objects loose until gc; the old blobs must actually leave the disk.
  gitx(ctx, ['reflog', 'expire', '--all', '--expire=now'], undefined, opts.run);
  gitx(ctx, ['gc', '--prune=now'], undefined, opts.run);
  return { ok: true, removed: plan.paths, bundle: plan.bundle };
}

/**
 * Scan keyflip's own keepsakes for secret shapes (plain files under configDir/memory).
 * @param {object} ctx - keyflip context.
 * @param {object} memory - the memory module (injected so tests stay hermetic).
 * @returns {{audited:number, leaks:Array<{key:string, file:string, kinds:string[], hits:number}>}}
 */
function keepsakeAudit(ctx, memory) {
  const rows = memory.list(ctx);
  const leaks = [];
  rows.forEach(function (r) {
    let raw;
    try {
      raw = fs.readFileSync(r.file, 'utf8');
    } catch (e) {
      return;
    }
    const kinds = secretscan.scanLabeled(raw);
    if (!kinds.length) return;
    leaks.push({ key: r.key, file: r.file, kinds: kinds, hits: secretscan.scanText(raw).length, bytes: r.bytes });
  });
  return { audited: rows.length, leaks: leaks };
}

/**
 * Redact the secrets out of the keepsakes that hold them. Keeps a .pre-scrub copy beside the file so
 * the edit is provably reversible, and reports counts only.
 * @returns {{redacted:number, files:string[], total:number}}
 */
function keepsakeScrub(ctx, memory) {
  const audit = keepsakeAudit(ctx, memory);
  const files = [];
  let total = 0;
  audit.leaks.forEach(function (l) {
    let raw;
    try {
      raw = fs.readFileSync(l.file, 'utf8');
    } catch (e) {
      return;
    }
    const shaped = secretscan.redactShapes(raw);
    const lined = secretscan.redactLines(shaped.text);
    try {
      fs.writeFileSync(l.file + '.pre-scrub', raw, { mode: 0o600 });
      fs.writeFileSync(l.file, lined.text, { mode: 0o600 });
    } catch (e) {
      return;
    }
    files.push(l.key);
    total += shaped.count + lined.count;
  });
  return { redacted: files.length, files: files, total: total };
}

const COPYSUFFIX = '.md.pre-scrub'; // keepsakeScrub's reversible-copy suffix

/**
 * The `.pre-scrub` originals `keepsakeScrub` leaves behind: invisible to `keyflip memory` (which lists
 * only *.md) and deliberately secret-bearing, so nothing else would ever point at them. Read-only.
 * @returns {{dir:string, files:Array<{key:string, keepsake:string, copy:string, bytes:number}>}}
 */
function keepsakeCopies(ctx, memory) {
  const dir = memory.store(ctx);
  const files = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { dir: dir, files: files };
  }
  names
    .filter(function (f) {
      return f.slice(-COPYSUFFIX.length) === COPYSUFFIX;
    })
    .forEach(function (f) {
      const key = f.slice(0, -COPYSUFFIX.length);
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(dir, f)).size;
      } catch (e) {
        /* keep 0 */
      }
      files.push({ key: key, keepsake: path.join(dir, key + '.md'), copy: path.join(dir, f), bytes: bytes });
    });
  return { dir: dir, files: files };
}

/**
 * Delete the un-redacted originals — but ONLY for a keepsake that is provably clean now. A `.pre-scrub`
 * is the last copy of that text, so dropping it is the point (it holds the secret) and the risk (it is
 * the only copy of anything else). Refuses per-key rather than all-or-nothing.
 * @returns {{dropped:string[], kept:Array<{key:string, reason:string}>, bytes:number}}
 */
function dropKeepsakeCopies(ctx, memory) {
  const all = keepsakeCopies(ctx, memory);
  const dropped = [];
  const kept = [];
  let bytes = 0;
  all.files.forEach(function (f) {
    let redacted;
    try {
      redacted = fs.readFileSync(f.keepsake, 'utf8');
    } catch (e) {
      kept.push({ key: f.key, reason: 'the keepsake itself is gone — the copy is the only version left' });
      return;
    }
    if (secretscan.scanLabeled(redacted).length) {
      kept.push({
        key: f.key,
        reason: 'the redacted keepsake STILL matches a secret shape — audit it before dropping the original',
      });
      return;
    }
    try {
      fs.rmSync(f.copy, { force: true });
      dropped.push(f.key);
      bytes += f.bytes;
    } catch (e) {
      kept.push({ key: f.key, reason: 'could not remove it (' + String((e && e.message) || e) + ')' });
    }
  });
  return { dropped: dropped, kept: kept, bytes: bytes };
}

export {
  MAX_BLOBS,
  MAX_BLOB_BYTES,
  historyLeaks,
  planScrub,
  applyScrub,
  filterRepoAvailable,
  keepsakeAudit,
  keepsakeScrub,
  keepsakeCopies,
  dropKeepsakeCopies,
};
