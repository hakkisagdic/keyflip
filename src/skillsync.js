// Cross-agent skill distribution: install ONE skill into every agent on this machine that can read
// one. The target table is adapted from RoleCraft's agent registry (MIT — see CREDITS.md) and
// reduced to the HOME-level skill directories; a tool that only reads skills from a PROJECT dir
// (Copilot, Devin, …) is deliberately absent, because keyflip cannot know your repos.
//
// Rules this module holds itself to:
//  - only write under a tool's own home (never invent ~/.foo for a tool that is not installed),
//  - never install a skill whose text carries a credential (the scan runs before any write),
//  - a manifest records what keyflip put where, with a SHA-256 per target, so `sync` can tell an
//    untouched copy from one the user edited and `remove` never deletes something it did not write.
import fs from 'fs';
import path from 'path';
import * as fsutil from './fsutil.js';
import * as skill from './skill.js';
import * as _secretscan from './secretscan.js';
import * as _skillstore from './skillstore.js';

// dir: HOME-relative skills dir. ids: the tools that read it. level: RoleCraft's own support
// label — "verified" there, not a promise from keyflip.
const TARGETS = [
  { dir: '.adal/skills', ids: ['adal'], level: 'verified' },
  {
    dir: '.agents/skills',
    ids: ['agents', 'codex', 'warp', 'goose', 'openhands', 'chatgpt', 'deepagents', 'dexto', 'loaf', 'zed'],
    level: 'verified',
  },
  { dir: '.aider-desk/skills', ids: ['aider-desk'], level: 'verified' },
  { dir: '.aider/skills', ids: ['aider'], level: 'legacy' },
  { dir: '.astrbot/data/skills', ids: ['astrbot'], level: 'experimental' },
  { dir: '.augment/skills', ids: ['augment'], level: 'verified' },
  { dir: '.autohand/skills', ids: ['autohand-code'], level: 'verified' },
  { dir: '.bob/skills', ids: ['bob'], level: 'verified' },
  { dir: '.claude/skills', ids: ['claude'], level: 'verified' },
  { dir: '.cline/skills', ids: ['cline'], level: 'verified' },
  { dir: '.codeartsdoer/skills', ids: ['code-arts-doer', 'codearts-agent'], level: 'verified' },
  { dir: '.codebuddy/skills', ids: ['codebuddy'], level: 'verified' },
  { dir: '.codeep/skills', ids: ['codeep'], level: 'verified' },
  { dir: '.codeium/windsurf/skills', ids: ['windsurf', 'codeium'], level: 'verified' },
  { dir: '.codemaker/skills', ids: ['code-maker'], level: 'experimental' },
  { dir: '.codestudio/skills', ids: ['code-studio'], level: 'verified' },
  { dir: '.cody/skills', ids: ['cody'], level: 'legacy' },
  { dir: '.commandcode/skills', ids: ['command-code'], level: 'verified' },
  { dir: '.config/agents/skills', ids: ['universal', 'amp'], level: 'verified' },
  { dir: '.config/muse/skills', ids: ['muse'], level: 'verified' },
  { dir: '.continue/skills', ids: ['continue'], level: 'verified' },
  { dir: '.crush/skills', ids: ['crush'], level: 'community' },
  { dir: '.cursor/skills', ids: ['cursor'], level: 'verified' },
  { dir: '.droid/skills', ids: ['droid'], level: 'experimental' },
  { dir: '.fabric/skills', ids: ['fabric'], level: 'experimental' },
  { dir: '.factory/skills', ids: ['factory'], level: 'verified' },
  { dir: '.firebender/skills', ids: ['firebender'], level: 'verified' },
  { dir: '.gemini/antigravity-cli/skills', ids: ['antigravity-cli'], level: 'verified' },
  { dir: '.gemini/config/skills', ids: ['antigravity'], level: 'verified' },
  { dir: '.gemini/skills', ids: ['gemini'], level: 'verified' },
  { dir: '.grok/skills', ids: ['grok'], level: 'verified' },
  { dir: '.hermes/skills', ids: ['hermes'], level: 'verified' },
  { dir: '.iflow/skills', ids: ['iflow'], level: 'legacy' },
  { dir: '.inferencesh/skills', ids: ['inference-sh'], level: 'experimental' },
  { dir: '.jazz/skills', ids: ['jazz'], level: 'verified' },
  { dir: '.junie/skills', ids: ['junie'], level: 'verified' },
  { dir: '.kilo/skills', ids: ['kilo'], level: 'verified' },
  { dir: '.kilocode/skills', ids: ['kilo-code'], level: 'experimental' },
  { dir: '.kimi-code/skills', ids: ['kimi-code'], level: 'verified' },
  { dir: '.kiro/skills', ids: ['kiro'], level: 'verified' },
  { dir: '.kode/skills', ids: ['kode'], level: 'verified' },
  { dir: '.lingma/skills', ids: ['lingma'], level: 'verified' },
  { dir: '.loom/skills', ids: ['loom'], level: 'legacy' },
  { dir: '.mcpjam/skills', ids: ['mcp-jam'], level: 'verified' },
  { dir: '.moxby/skills', ids: ['moxby'], level: 'experimental' },
  { dir: '.mux/skills', ids: ['mux'], level: 'verified' },
  { dir: '.neovate/skills', ids: ['neovate'], level: 'verified' },
  { dir: '.omp/agent/skills', ids: ['omp'], level: 'verified' },
  { dir: '.ona/skills', ids: ['ona'], level: 'experimental' },
  { dir: '.openclaw/skills', ids: ['openclaw'], level: 'verified' },
  { dir: '.pi/agent/skills', ids: ['pi'], level: 'community' },
  { dir: '.pochi/skills', ids: ['pochi'], level: 'verified' },
  { dir: '.posit/assistant/skills', ids: ['posit'], level: 'verified' },
  { dir: '.pr-pilot/skills', ids: ['pr-pilot'], level: 'experimental' },
  { dir: '.qoder-cn/skills', ids: ['qoder-cn'], level: 'community' },
  { dir: '.qoder/skills', ids: ['qoder'], level: 'community' },
  { dir: '.qwen/skills', ids: ['qwen-code'], level: 'verified' },
  { dir: '.reasonix/skills', ids: ['reasonix'], level: 'verified' },
  { dir: '.roo/skills', ids: ['roo'], level: 'verified' },
  { dir: '.rovodev/skills', ids: ['rovo'], level: 'verified' },
  { dir: '.snowflake/cortex/skills', ids: ['cortex'], level: 'experimental' },
  { dir: '.supermaven/skills', ids: ['supermaven'], level: 'legacy' },
  { dir: '.tabnine/agent/skills', ids: ['tabnine'], level: 'verified' },
  { dir: '.terramind/skills', ids: ['terra-mind'], level: 'experimental' },
  { dir: '.tinycloud/skills', ids: ['tiny-cloud'], level: 'experimental' },
  { dir: '.trae-cn/skills', ids: ['trae-cn'], level: 'verified' },
  { dir: '.trae/skills', ids: ['trae'], level: 'verified' },
  { dir: '.vibe/skills', ids: ['mistral-vibe'], level: 'verified' },
  { dir: '.zap/skills', ids: ['zap'], level: 'verified' },
  { dir: '.zcode/skills', ids: ['zcode'], level: 'verified' },
  { dir: '.zencoder/skills', ids: ['zencoder'], level: 'experimental' },
  { dir: '.zenflow/skills', ids: ['zenflow'], level: 'experimental' },
];

// A skill is CODE the agent will run, so the install inspects the WHOLE tree — every file
// (hidden ones included) and every link. Two rules, no exceptions:
//   - a link that leaves the skill is refused: it would point the agent at the user's
//     ~/.ssh/id_rsa while no scan ever sees what it points at;
//   - a file carrying a credential is refused, wherever it hides.
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
// The fingerprint algorithm the manifest stores, so a manifest written by an older keyflip is
// read with THAT algorithm instead of being misread as an edited copy.
const FP_VERSION = 2;

function manifestPath(ctx) {
  return path.join(ctx.configDir, 'installed-skills.json');
}

// Every entry in the tree, hidden files included. .git is skipped: it is version-control
// metadata, never installed, never scanned and never hashed.
function walkTree(dir, rel, cb, depth) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch (e) {
    return;
  }
  entries.forEach(function (e) {
    if (e.name === '.git') return;
    const childRel = rel ? rel + '/' + e.name : e.name;
    cb(childRel, path.join(dir, childRel), e);
    if (e.isDirectory()) walkTree(dir, childRel, cb, depth + 1);
  });
}

// A binary is not where a readable credential hides; skip it instead of guessing.
function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Read the head of a file. A skill may ship a big blob; the credential is near the top.
function readHead(abs, max) {
  let size;
  try {
    size = fs.statSync(abs).size;
  } catch (e) {
    return null;
  }
  if (!size) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
  } catch (e) {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.min(size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch (e) {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* */
    }
  }
}

// A credential whose VALUE has no tell-tale shape: `AWS_SECRET_ACCESS_KEY=<40 base64 chars>`.
// The key name gives it away, the value decides (a placeholder or a sentence is not a secret).
function credentialValues(text) {
  const hits = [];
  text.split('\n').forEach(function (line) {
    const m = line.match(/^\s*[-*]?\s*(["']?[A-Za-z0-9_.\-[\]]+["']?)\s*[:=]\s*(.+?)\s*[,;]?\s*$/);
    if (!m) return;
    const key = m[1].replace(/^["']|["']$/g, '');
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (!_secretscan.isCredentialKey(key)) return;
    if (_secretscan.isEnvRefOrEmpty(val)) return;
    if (!_secretscan.looksSecret(val)) return;
    hits.push(key);
  });
  return hits;
}

// Every file in the skill, scanned for credentials — hidden files included, because `.env` and
// `.claude/settings.json` are read by the agent exactly like SKILL.md. Returns labels only
// (never the secret).
function secretsIn(dir) {
  const found = [];
  walkTree(dir, '', function (rel, abs, e) {
    if (!e.isFile() || e.isSymbolicLink()) return;
    const buf = readHead(abs, MAX_SCAN_BYTES);
    if (!buf || !buf.length) return;
    if (isBinary(buf)) return;
    const text = buf.toString('utf8');
    const labels = _secretscan.scanLabeled(text);
    credentialValues(text).forEach(function (k) {
      const label = 'credential-value:' + k;
      if (labels.indexOf(label) === -1) labels.push(label);
    });
    if (labels.length) found.push({ file: rel, kinds: labels });
  });
  return found;
}

// A skill must be self-contained. A link inside it is refused: copied as-is it becomes a link
// in the agent's skills dir that points at the SOURCE (a temp dir that is deleted right after
// the install — a dangling link), and a link to ~/.ssh/id_rsa would hand the agent the user's
// private key while no scan ever sees what it points at. Returns a human reason, or null when
// the tree is clean.
function linkProblem(dir) {
  let problem = null;
  const root = path.resolve(dir);
  walkTree(dir, '', function (rel, abs, e) {
    if (problem || !e.isSymbolicLink()) return;
    let raw;
    try {
      raw = fs.readlinkSync(abs);
    } catch (err) {
      raw = '';
    }
    const resolved = path.resolve(path.dirname(abs), raw);
    if (resolved !== root && resolved.indexOf(root + path.sep) !== 0) {
      problem = rel + ' links outside the skill (' + raw + ')';
      return;
    }
    problem = rel + ' is a link (' + raw + ') — a skill must be self-contained';
  });
  return problem;
}

// Copy a skill into place. .git is version-control metadata, not skill content: it is left
// behind (and it is not in the fingerprint either, so the hash still describes what is written).
function copySkill(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: function (s) {
      return path.basename(s) !== '.git';
    },
  });
}

// The exact bytes keyflip will write: every file the skill ships, hidden ones included.
function fingerprint(dir) {
  return skill.fingerprint(dir);
}

// The hash an older keyflip recorded (visible files only). READ to recognise an old manifest;
// never written any more.
function legacyFingerprint(dir) {
  return skill.fingerprintVisible(dir);
}

// Does the tree at `dir` still hold what the manifest recorded? `ver` is the fingerprint
// algorithm that produced the recorded hash.
function matchesRecorded(dir, sha256, ver) {
  if (!sha256) return false;
  const hash = ver >= FP_VERSION ? fingerprint(dir) : legacyFingerprint(dir);
  return hash === sha256;
}
function readManifest(ctx) {
  try {
    const o = JSON.parse(fs.readFileSync(manifestPath(ctx), 'utf8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    // v1 entries were Claude-only: no `targets` map. Read them as one claude target so `list`,
    // `remove` and drift checks keep working on an install made by an older keyflip.
    Object.keys(o).forEach(function (n) {
      const e = o[n];
      if (!e || typeof e !== 'object') return;
      if (!e.targets || typeof e.targets !== 'object')
        e.targets = { claude: { dir: '.claude/skills', sha256: e.sha256 || null, mode: e.mode || 'copy' } };
    });
    return o;
  } catch (e) {
    return {};
  }
}
function writeManifest(ctx, m) {
  fsutil.writeJsonStable(manifestPath(ctx), m, 0o600);
}

function allTargets() {
  return TARGETS.map(function (t) {
    return { dir: t.dir, ids: t.ids.slice(), level: t.level };
  });
}
function targetById(id) {
  return (
    TARGETS.filter(function (t) {
      return t.ids.indexOf(id) !== -1;
    })[0] || null
  );
}
// The manifest is a file on disk: it can be edited, restored from a backup or copied from another
// machine. Its `dir` is therefore NOT trusted — a skill may only be written to a directory keyflip
// knows it writes to. That is what stops a poisoned manifest from turning `keyflip skill sync`
// into "delete ~/.ssh and put the skill there".
function targetForDir(dir) {
  return (
    TARGETS.filter(function (t) {
      return t.dir === dir;
    })[0] || null
  );
}
function parentOf(dir) {
  const i = dir.lastIndexOf('/');
  return i === -1 ? '' : dir.slice(0, i);
}
// A tool is "here" when its home dir exists (e.g. ~/.cursor for ~/.cursor/skills). The skills dir
// itself may not exist yet — that is what an install creates.
function isDetected(ctx, t) {
  const home = path.join(ctx.home, parentOf(t.dir));
  try {
    return fs.existsSync(home);
  } catch (e) {
    return false;
  }
}
function detectedTargets(ctx) {
  return allTargets().filter(function (t) {
    return isDetected(ctx, t);
  });
}

// Resolve --agents a,b to targets. Unknown ids are reported, never ignored: a typo must not look
// like "installed everywhere".
function selectTargets(ctx, ids) {
  if (!ids || !ids.length) return { targets: detectedTargets(ctx), unknown: [], detected: true };
  const chosen = [];
  const unknown = [];
  ids.forEach(function (id) {
    const t = targetById(String(id).trim().toLowerCase());
    if (!t) return unknown.push(String(id));
    if (
      !chosen.some(function (c) {
        return c.dir === t.dir;
      })
    )
      chosen.push(t);
  });
  return { targets: chosen, unknown: unknown, detected: false };
}

function safeName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(name || ''));
}

// A skill target is replaced by unlink-and-write, so a leaf symlink (which is how a --link install
// is stored) is a normal state here, not an escape.
function safeDest(dest, root) {
  return fsutil.safeDestUnder(root, dest, { allowSymlinkLeaf: true }).ok;
}

// The target set a skill would be written to, plus every check that must pass BEFORE anything is
// written: an unsafe name, a link that leaves the skill, a credential inside it, or a copy that
// keyflip did not install (that one needs --force). All of it is checked up front, so a refusal
// never leaves half an install behind.
function prepareInstall(ctx, root, opts) {
  opts = opts || {};
  const dirs = _skillstore.findSkillDirs(root);
  if (!dirs.length) throw new Error('no SKILL.md found under ' + root + ' — not a skill');
  const sel = selectTargets(ctx, opts.agents);
  if (sel.unknown.length)
    throw new Error('unknown agent(s): ' + sel.unknown.join(', ') + ' — run `keyflip skill agents` for the list');
  if (!sel.targets.length)
    throw new Error('no agent detected on this machine — name one with --agents (see `keyflip skill agents`)');
  const manifest = readManifest(ctx);
  const plans = [];
  const skipped = [];
  dirs.forEach(function (d) {
    const name = path.basename(d);
    if (!safeName(name)) {
      skipped.push({ name: name, reason: 'unsafe name' });
      return;
    }
    const link = linkProblem(d);
    if (link) throw new Error("refusing to install '" + name + "': " + link);
    const secrets = secretsIn(d);
    if (secrets.length) {
      // A skill the agent will read is code the agent will follow. A credential inside it is a leak
      // with an audience, so this is a refusal, not a redaction.
      throw new Error(
        "refusing to install '" +
          name +
          "': it carries a credential (" +
          secrets
            .map(function (s) {
              return s.file + ': ' + s.kinds.join(', ');
            })
            .join('; ') +
          ')',
      );
    }
    const fp = fingerprint(d);
    const tgt = [];
    sel.targets.forEach(function (t) {
      const dest = path.join(ctx.home, t.dir, name);
      if (!safeDest(dest, path.join(ctx.home, t.dir))) return;
      const exists = fs.existsSync(dest);
      const recorded = !!(manifest[name] && manifest[name].targets && manifest[name].targets[t.ids[0]]);
      if (exists && !recorded && !opts.force) {
        throw new Error(
          "a skill '" +
            name +
            "' already exists in " +
            t.dir +
            ' (not installed by keyflip) — pass --force to overwrite',
        );
      }
      tgt.push({ id: t.ids[0], dir: t.dir, mode: opts.link ? 'symlink' : 'copy' });
    });
    plans.push({ name: name, dir: d, fp: fp, targets: tgt });
  });
  return { plans: plans, skipped: skipped };
}

// Write a prepared plan. Links inside the skill are copied dereferenced, so the installed tree
// holds exactly the bytes the fingerprint described.
function writeInstall(ctx, source, prepared, opts) {
  opts = opts || {};
  const manifest = readManifest(ctx);
  const installed = [];
  prepared.plans.forEach(function (p) {
    const name = p.name;
    const d = p.dir;
    const fp = p.fp;
    const tgt = [];
    p.targets.forEach(function (x) {
      const dest = path.join(ctx.home, x.dir, name);
      if (!safeDest(dest, path.join(ctx.home, x.dir))) return;
      fs.rmSync(dest, { recursive: true, force: true });
      let mode = 'copy';
      if (opts.link) {
        try {
          fs.symlinkSync(fs.realpathSync(d), dest, 'dir');
          mode = 'symlink';
        } catch (e) {
          copySkill(d, dest);
        }
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        copySkill(d, dest);
      }
      tgt.push({ id: x.id, dir: x.dir, mode: mode });
    });
    const prev = manifest[name] || {};
    manifest[name] = {
      source: String(source || ''),
      installedAt: ctx.now(),
      mode: tgt.length ? tgt[0].mode : 'copy',
      sha256: fp,
      fp: FP_VERSION,
      targets: Object.assign({}, prev.targets || {}),
    };
    tgt.forEach(function (x) {
      manifest[name].targets[x.id] = { dir: x.dir, sha256: fp, mode: x.mode, fp: FP_VERSION };
    });
    installed.push({ name: name, targets: tgt });
  });
  writeManifest(ctx, manifest);
  return { installed: installed, skipped: prepared.skipped };
}

// The plan as it would be written — what a dry run reports.
function plannedInstall(prepared) {
  return {
    installed: prepared.plans.map(function (p) {
      return {
        name: p.name,
        targets: p.targets.map(function (t) {
          return Object.assign({}, t, { dryRun: true });
        }),
        dryRun: true,
      };
    }),
    skipped: prepared.skipped,
  };
}

// Install the skill dirs under one resolved source into the chosen targets.
// Returns { installed:[{name, targets:[{id, dir, mode}]}], skipped:[{name, reason}] }.
function installResolved(ctx, root, source, opts) {
  opts = opts || {};
  const prepared = prepareInstall(ctx, root, opts);
  if (opts.dryRun) return plannedInstall(prepared);
  return writeInstall(ctx, source, prepared, opts);
}

async function add(ctx, src, opts) {
  opts = opts || {};
  const resolved = await _skillstore.resolveSource(src, opts);
  try {
    const prepared = prepareInstall(ctx, resolved.root, opts);
    if (opts.approve) {
      // A skill is CODE the agent will run, so the user sees the exact list of directories that
      // will receive it and says yes BEFORE anything is written.
      const ok = await opts.approve(
        prepared.plans.map(function (p) {
          return { name: p.name, targets: p.targets };
        }),
      );
      if (!ok) {
        prepared.plans.forEach(function (p) {
          prepared.skipped.push({ name: p.name, reason: 'not approved' });
        });
        return { installed: [], skipped: prepared.skipped };
      }
    }
    if (opts.dryRun) return plannedInstall(prepared);
    return writeInstall(ctx, resolved.source, prepared, opts);
  } finally {
    if (resolved.cleanup) {
      try {
        fs.rmSync(resolved.cleanup, { recursive: true, force: true });
      } catch (e) {
        /* */
      }
    }
  }
}

// The bundled keyflip skill, fanned out to the OTHER agents on this machine. Claude keeps
// skill.js's install (it backs up the previous copy and answers `install-skill --check` for drift), so this
// skips ~/.claude/skills and reports an empty result when that is the only CLI here.
function installBundled(ctx, opts) {
  opts = opts || {};
  const sel =
    opts.agents && opts.agents.length
      ? selectTargets(ctx, opts.agents)
      : { targets: detectedTargets(ctx), unknown: [] };
  if (sel.unknown.length)
    throw new Error('unknown agent(s): ' + sel.unknown.join(', ') + ' — run `keyflip skill agents` for the list');
  const ids = sel.targets
    .filter(function (t) {
      return t.dir !== '.claude/skills';
    })
    .map(function (t) {
      return t.ids[0];
    });
  if (!ids.length) return { installed: [], skipped: [] };
  const src = skill.sourceDir();
  return installResolved(ctx, src, 'dir:' + src, { agents: ids, link: true });
}

// Record a copy keyflip installed through another path (skill.js owns ~/.claude/skills and its
// backup/drift check), so `list`, `sync` and `remove` tell one story instead of two.
function recordTarget(ctx, name, id, dir, sha256, mode, source) {
  const m = readManifest(ctx);
  const e = m[name] || { source: String(source || ''), installedAt: ctx.now(), sha256: sha256, targets: {} };
  e.targets = e.targets || {};
  e.targets[id] = { dir: dir, sha256: sha256, mode: mode };
  e.sha256 = e.sha256 || sha256;
  m[name] = e;
  writeManifest(ctx, m);
  return e;
}

// The manifest stores the source in the form resolveSource RETURNED ("dir:/abs", "github:o/r",
// "archive:x.tgz"); turn it back into something resolveSource accepts. An archive cannot be
// re-fetched, so sync says so instead of pretending.
async function resolveRecorded(source, opts) {
  const s = String(source || '');
  if (s.indexOf('dir:') === 0) return _skillstore.resolveSource(s.slice(4), opts);
  if (s.indexOf('github:') === 0) return _skillstore.resolveSource(s.slice(7), opts);
  throw new Error(
    'recorded source ' +
      (s.indexOf('archive:') === 0 ? 'is an archive with no re-fetchable origin' : 'is not re-resolvable'),
  );
}

function list(ctx) {
  const m = readManifest(ctx);
  return Object.keys(m)
    .sort()
    .map(function (n) {
      const e = m[n];
      const nameOk = safeName(n);
      const targets = Object.keys(e.targets || {}).map(function (id) {
        const t = e.targets[id];
        const known = targetForDir(t.dir);
        if (!known) return { id: id, dir: t.dir, mode: t.mode, state: 'unknown-target' };
        if (!nameOk) return { id: id, dir: known.dir, mode: t.mode, state: 'unsafe-name' };
        const dest = path.join(ctx.home, known.dir, n);
        let state = 'missing';
        if (fs.existsSync(path.join(dest, 'SKILL.md'))) {
          state = matchesRecorded(dest, t.sha256, t.fp || 1) ? 'ok' : 'edited';
        }
        return { id: id, dir: known.dir, mode: t.mode, state: state };
      });
      return {
        name: n,
        source: e.source || '',
        installedAt: e.installedAt || null,
        sha256: e.sha256 || null,
        targets: targets,
      };
    });
}

// Re-apply recorded skills from their source. A target the user edited is reported, never
// overwritten; a target that keyflip wrote and that is unchanged is refreshed to the new source.
async function sync(ctx, opts) {
  opts = opts || {};
  const m = readManifest(ctx);
  const report = [];
  const names = opts.names && opts.names.length ? opts.names : Object.keys(m).sort();
  for (const name of names) {
    const e = m[name];
    if (!e) {
      report.push({ name: name, status: 'unknown' });
      continue;
    }
    let resolved;
    try {
      resolved = await resolveRecorded(e.source, opts);
    } catch (err) {
      report.push({ name: name, status: 'source-unavailable', detail: (err && err.message) || String(err) });
      continue;
    }
    try {
      const dirs = _skillstore.findSkillDirs(resolved.root);
      const dir = dirs.filter(function (d) {
        return path.basename(d) === name;
      })[0];
      if (!dir) {
        report.push({ name: name, status: 'source-changed', detail: 'the source no longer contains ' + name });
        continue;
      }
      // The source is held to the same rule as a fresh install: a skill that carries a link or a
      // credential is not written into an agent's skills dir.
      const link = linkProblem(dir);
      if (link) {
        report.push({ name: name, status: 'source-unsafe', detail: link });
        continue;
      }
      const secrets = secretsIn(dir);
      if (secrets.length) {
        report.push({
          name: name,
          status: 'source-unsafe',
          detail:
            'it carries a credential (' +
            secrets
              .map(function (s) {
                return s.file + ': ' + s.kinds.join(', ');
              })
              .join('; ') +
            ')',
        });
        continue;
      }
      const targets = [];
      Object.keys(e.targets || {}).forEach(function (id) {
        const t = e.targets[id];
        // The manifest is a file on disk: it can be edited, restored from a backup or copied from
        // another machine. Its `dir` is therefore NOT trusted — a skill may only be written to a
        // directory keyflip knows it writes to. That is what stops a poisoned manifest from
        // turning `keyflip skill sync` into "delete ~/.ssh and put the skill there".
        const known = targetForDir(t.dir);
        if (!known) return targets.push({ id: id, action: 'skipped-unknown-target' });
        if (!safeName(name)) return targets.push({ id: id, action: 'skipped-unsafe-name' });
        const dest = path.join(ctx.home, known.dir, name);
        if (!safeDest(dest, path.join(ctx.home, known.dir)))
          return targets.push({ id: id, action: 'skipped-unsafe-path' });
        const present = fs.existsSync(path.join(dest, 'SKILL.md'));
        const ver = t.fp || 1; // 1 = a manifest written before the fingerprint covered hidden files
        const state = !present ? 'missing' : matchesRecorded(dest, t.sha256, ver) ? 'ok' : 'edited';
        if (state === 'edited') return targets.push({ id: id, action: 'left-edited' });
        const fresh = ver >= FP_VERSION ? fingerprint(dir) : legacyFingerprint(dir);
        if (fresh === t.sha256 && state === 'ok') return targets.push({ id: id, action: 'current' });
        if (opts.dryRun) return targets.push({ id: id, action: 'would-update' });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        copySkill(dir, dest);
        t.sha256 = fingerprint(dir);
        t.fp = FP_VERSION;
        t.mode = 'copy';
        targets.push({ id: id, action: 'updated' });
      });
      if (!opts.dryRun) {
        e.sha256 = fingerprint(dir);
        e.fp = FP_VERSION;
        writeManifest(ctx, m);
      }
      const changed = targets.some(function (t2) {
        return t2.action === 'updated' || t2.action === 'would-update';
      });
      report.push({ name: name, status: changed ? 'updated' : 'current', targets: targets });
    } finally {
      if (resolved.cleanup) {
        try {
          fs.rmSync(resolved.cleanup, { recursive: true, force: true });
        } catch (err2) {
          /* */
        }
      }
    }
  }
  return report;
}

function remove(ctx, name, opts) {
  opts = opts || {};
  const m = readManifest(ctx);
  const e = m[name];
  if (!e) throw new Error("'" + name + "' was not installed by keyflip (refusing to remove it)");
  if (!safeName(name)) throw new Error("refusing to remove '" + name + "': that is not a plain skill name");
  const ids =
    opts.agents && opts.agents.length
      ? opts.agents.map(function (id) {
          const t = targetById(String(id).trim().toLowerCase());
          return t ? t.ids[0] : String(id); // canonical key: several tools can share one dir
        })
      : Object.keys(e.targets || {});
  const removed = [];
  const skipped = [];
  ids.forEach(function (id) {
    const t = (e.targets || {})[id];
    if (!t) return;
    // Only a directory keyflip knows it writes to may be touched. The manifest's own `dir` is
    // never used as the root of the check — a self-referential check would bless any path.
    const known = targetForDir(t.dir);
    if (!known) {
      skipped.push(id + ' (unknown target dir ' + t.dir + ')');
      return;
    }
    const dest = path.join(ctx.home, known.dir, name);
    if (!safeDest(dest, path.join(ctx.home, known.dir))) {
      skipped.push(id + ' (unsafe path)');
      return;
    }
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      removed.push(id);
    } catch (err) {
      /* */
    }
    delete e.targets[id];
  });
  if (!Object.keys(e.targets || {}).length) delete m[name];
  writeManifest(ctx, m);
  return { name: name, removed: removed, skipped: skipped };
}

export {
  TARGETS,
  allTargets,
  targetById,
  targetForDir,
  isDetected,
  detectedTargets,
  selectTargets,
  installResolved,
  installBundled,
  recordTarget,
  add,
  list,
  sync,
  remove,
  secretsIn,
  linkProblem,
  fingerprint,
  legacyFingerprint,
  readManifest,
  manifestPath,
};
