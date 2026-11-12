// How an unattended job (launchd / cron / a status-line hook) runs keyflip itself.
//
// The bug this exists for: `which keyflip` under fnm answers with a per-shell symlink
// (~/.local/state/fnm_multishells/<pid>_<ts>/bin/keyflip) whose target is a `#!/usr/bin/env node`
// script. A launchd job that execs that path dies with 127 — launchd's PATH has no node — and the
// directory itself disappears when that shell exits, so it breaks again later even with a PATH.
// The autoswitch service ran 1016 times that way, silently.
//
// So a job is always written as `<absolute node> <absolute script> <args…>`, both resolved through
// symlinks, and neither may live in an ephemeral shell directory. A real native binary (no node
// shebang) is still executed directly. Runner and fs are injectable so tests never shell out.
import fs from 'fs';
import path from 'path';
import { run } from './exec.js';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_SCRIPT = path.join(__dirname, '..', 'bin', 'keyflip.js');

// Paths that belong to one shell session and vanish with it.
const EPHEMERAL_RE = /[\\/](fnm_multishells|\.nvm[\\/]\.cache|volta[\\/]tmp)[\\/]/;
function isEphemeral(p) {
  return EPHEMERAL_RE.test(String(p || ''));
}

function realpathOr(p, fsx) {
  try {
    return (fsx.realpathSync.native || fsx.realpathSync)(p);
  } catch (e) {
    return p;
  }
}

// A script node must run: a .js/.mjs/.cjs file, or any file whose first line is a node shebang.
function isNodeScript(p, fsx) {
  if (/\.(c|m)?js$/.test(p)) return true;
  let fd = null;
  try {
    fd = fsx.openSync(p, 'r');
    const buf = Buffer.alloc(128);
    const n = fsx.readSync(fd, buf, 0, 128, 0);
    const first = buf.slice(0, n).toString('utf8').split('\n')[0];
    return /^#!.*\bnode\b/.test(first);
  } catch (e) {
    return false;
  } finally {
    if (fd !== null)
      try {
        fsx.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
  }
}

// The node that will run the job: this process's node, resolved through symlinks. fnm and nvm put a
// per-shell symlink first on PATH; process.execPath is already resolved on macOS/Linux, but resolve
// again so an ephemeral shim can never be written into a plist.
function nodePath(opts) {
  opts = opts || {};
  const fsx = opts.fs || fs;
  return realpathOr(opts.execPath || process.execPath, fsx);
}

// The keyflip package a script belongs to: { root, name, version } from the nearest package.json
// (up to three levels up), or null.
function packageOf(script, fsx) {
  let d = path.dirname(script);
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(fsx.readFileSync(path.join(d, 'package.json'), 'utf8'));
      if (j && typeof j === 'object') return { root: d, name: j.name || null, version: j.version || null };
    } catch (e) {
      /* keep walking */
    }
    d = path.dirname(d);
  }
  return null;
}

// -> { exec, args, script, kind: 'node-script'|'binary', from: 'path'|'checkout'|'self', pathCopy? }
// `args` already carries the script for a node script; callers append their subcommand.
//
// When `which keyflip` is ANOTHER keyflip package than the code running this (an older global npm
// copy next to the checkout being installed from), the job runs THIS code — the code that installs
// it is the code that was fixed — and `pathCopy` says what the PATH still runs. (The live service
// once got a stale global copy written back in this way, with none of the fixes it was installed for.)
function resolveSelf(opts) {
  opts = opts || {};
  const runner = opts.run || run;
  const fsx = opts.fs || fs;
  let hit = null;
  const w = runner('which', ['keyflip']);
  if (w && w.code === 0 && String(w.stdout || '').trim())
    hit = String(w.stdout || '')
      .trim()
      .split('\n')[0]
      .trim();
  let from = 'path';
  let target = hit ? realpathOr(hit, fsx) : null;
  // A `which` hit that still points into a per-shell directory after resolution is unusable later.
  if (target && isEphemeral(target)) target = null;
  let pathCopy = null;
  if (target && !opts.preferPath) {
    const self = realpathOr(opts.selfScript || REPO_SCRIPT, fsx);
    const tp = packageOf(target, fsx);
    const sp = packageOf(self, fsx);
    let selfOk = false;
    try {
      fsx.accessSync(self, fs.constants.R_OK);
      selfOk = !isEphemeral(self);
    } catch (e) {
      selfOk = false;
    }
    if (selfOk && tp && sp && tp.name === 'keyflip' && sp.name === 'keyflip' && tp.root !== sp.root) {
      pathCopy = { script: target, root: tp.root, version: tp.version };
      target = self;
      from = 'self';
    }
  }
  if (!target) {
    target = realpathOr(opts.fallbackScript || REPO_SCRIPT, fsx);
    from = 'checkout';
  }
  const extra = pathCopy ? { pathCopy: pathCopy } : {};
  if (from === 'checkout' || from === 'self' || isNodeScript(target, fsx)) {
    return Object.assign(
      { exec: nodePath(opts), args: [target], script: target, kind: 'node-script', from: from },
      extra,
    );
  }
  return Object.assign({ exec: target, args: [], script: null, kind: 'binary', from: from }, extra);
}

// The full argv for a job: { exec, args } with the subcommand appended.
function argvFor(resolved, args) {
  return { exec: resolved.exec, args: resolved.args.concat(args || []) };
}

// PATH for a launchd job: the node that runs it first (child processes keyflip spawns may need
// `node`), then the system directories launchd itself would use.
function jobPath(exec) {
  const dirs = [];
  if (exec && path.isAbsolute(exec)) dirs.push(path.dirname(exec));
  ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].forEach(function (d) {
    if (dirs.indexOf(d) === -1) dirs.push(d);
  });
  return dirs.join(':');
}

// What is wrong with an argv a job would run — so install refuses it and status/doctor flag it.
// [] means runnable. Checks the program and, for a node script, the script.
function problems(c, opts) {
  opts = opts || {};
  const fsx = opts.fs || fs;
  const out = [];
  const argv = [c.exec].concat(c.args || []);
  const prog = argv[0];
  function check(p, what) {
    if (!p || !path.isAbsolute(p)) out.push(what + ' is not an absolute path: ' + (p || '(none)'));
    else if (isEphemeral(p)) out.push(what + ' is a per-shell path that disappears with its shell: ' + p);
    else {
      let ok = false;
      try {
        fsx.accessSync(p, what === 'program' ? fs.constants.X_OK : fs.constants.R_OK);
        ok = true;
      } catch (e) {
        ok = false;
      }
      if (!ok)
        out.push(what + ' does not exist or is not ' + (what === 'program' ? 'executable' : 'readable') + ': ' + p);
    }
  }
  check(prog, 'program');
  // A program that is a node script needs node on PATH — the exact 127 failure.
  if (out.length === 0 && isNodeScript(prog, fsx) && !/\bnode$/.test(path.basename(prog)))
    out.push('program is a node script run without node (launchd has no node on its PATH): ' + prog);
  if (/\bnode$/.test(path.basename(prog || ''))) check(argv[1], 'script');
  return out;
}

export { resolveSelf, argvFor, nodePath, jobPath, problems, isEphemeral, isNodeScript, packageOf, REPO_SCRIPT };
