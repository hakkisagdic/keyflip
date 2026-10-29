// #10 Bundled-skill install/freshness. The package's skills/keyflip dir is the
// single source of truth; install symlinks it into ~/.claude/skills (copy
// fallback for Windows/permission issues) so upgrades propagate. Drift is
// detected by a SHA-256 fingerprint over sorted "relpath\0content\0" of EVERY
// file the skill ships (hidden ones included — an agent reads those too). The old
// install is backed up before overwrite/removal.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sourceDir() {
  return path.join(__dirname, '..', 'skills', 'keyflip');
}
function installDir(ctx) {
  return path.join(ctx.home, '.claude', 'skills', 'keyflip');
}
function backupsDir(ctx) {
  return path.join(ctx.configDir, 'skill-backups');
}

// The legacy walk: visible files only. Kept because a manifest written by an older keyflip
// stores THAT hash — see fingerprintVisible below.
function walk(dir, base, acc) {
  base = base || dir;
  acc = acc || [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  entries.forEach(function (e) {
    if (e.name[0] === '.') return; // skip hidden
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc);
    else if (e.isFile()) acc.push(path.relative(base, p));
  });
  return acc.sort();
}

// Every file a skill ships — HIDDEN ones included. A skill is code the agent will run, and a
// hidden file (`.env`, `.claude/settings.json`, `.mcp.json`) is read by that agent just like
// SKILL.md, so a hash that skips it cannot claim the installed copy is the one keyflip wrote.
// A symlink is hashed by the CONTENT it points at when it stays inside the skill (that is what
// the installer writes: links are copied dereferenced); a link that leaves the skill is hashed
// by its target string, because no content can describe it.
function walkAll(dir, base, acc, depth) {
  base = base || dir;
  acc = acc || [];
  if (depth > 12) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  entries.forEach(function (e) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p);
    if (e.isDirectory()) {
      // .git is version-control metadata, not skill content: it is never installed and never
      // hashed, so the hash describes exactly what ends up in the agent's skills dir.
      if (e.name === '.git') return;
      walkAll(p, base, acc, depth + 1);
      return;
    }
    if (e.isSymbolicLink()) {
      let target = null;
      try {
        target = fs.realpathSync(p);
      } catch (e2) {
        target = null;
      }
      let inside = false;
      try {
        inside = !!target && (target === base || target.indexOf(base + path.sep) === 0);
      } catch (e3) {
        inside = false;
      }
      if (inside) {
        let st = null;
        try {
          st = fs.statSync(target);
        } catch (e4) {
          st = null;
        }
        if (st && st.isFile()) {
          acc.push({ rel: rel, file: target });
          return;
        }
      }
      let raw = '';
      try {
        raw = fs.readlinkSync(p);
      } catch (e5) {
        raw = '';
      }
      acc.push({ rel: rel, link: raw });
      return;
    }
    if (e.isFile()) acc.push({ rel: rel, file: p });
  });
  return acc;
}

// SHA-256 over sorted "relpath\0content\0" — order-independent, content-sensitive.
function fingerprint(dir) {
  const h = crypto.createHash('sha256');
  const items = walkAll(dir).sort(function (a, b) {
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });
  items.forEach(function (it) {
    h.update(it.rel);
    h.update('\0');
    if (it.link !== undefined) {
      h.update('L');
      h.update(it.link);
    } else {
      try {
        h.update(fs.readFileSync(it.file));
      } catch (e) {
        /* */
      }
    }
    h.update('\0');
  });
  return h.digest('hex');
}

// The hash an older keyflip stored: visible files only. Read ONLY to recognise a manifest
// written before the fingerprint covered hidden files — never written any more.
function fingerprintVisible(dir) {
  const h = crypto.createHash('sha256');
  walk(dir).forEach(function (rel) {
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(path.join(dir, rel)));
    } catch (e) {
      /* */
    }
    h.update('\0');
  });
  return h.digest('hex');
}

function isInstalled(ctx) {
  try {
    return fs.existsSync(path.join(installDir(ctx), 'SKILL.md'));
  } catch (e) {
    return false;
  }
}

// 'current' | 'stale' | 'absent'
function status(ctx) {
  if (!isInstalled(ctx)) return 'absent';
  return fingerprint(sourceDir()) === fingerprint(installDir(ctx)) ? 'current' : 'stale';
}

function backupExisting(ctx) {
  const dest = installDir(ctx);
  if (!fs.existsSync(dest)) return null;
  fs.mkdirSync(backupsDir(ctx), { recursive: true });
  const b = path.join(backupsDir(ctx), 'keyflip-' + String(ctx.now()).replace(/[-:]/g, '').replace(/\..*$/, ''));
  try {
    fs.cpSync(dest, b, { recursive: true });
  } catch (e) {
    /* best effort */
  }
  // keep 20 most recent
  try {
    const all = fs
      .readdirSync(backupsDir(ctx))
      .filter(function (n) {
        return n.indexOf('keyflip-') === 0;
      })
      .sort();
    all.slice(0, Math.max(0, all.length - 20)).forEach(function (n) {
      fs.rmSync(path.join(backupsDir(ctx), n), { recursive: true, force: true });
    });
  } catch (e) {
    /* */
  }
  return b;
}

// Install (or refresh) the skill. Prefers a symlink so future upgrades are
// instant; copies on failure (Windows / no symlink permission).
function install(ctx) {
  const src = sourceDir();
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('bundled skill missing SKILL.md — reinstall keyflip');
  const dest = installDir(ctx);
  backupExisting(ctx);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch (e) {
    /* */
  }
  let mode = 'symlink';
  try {
    fs.symlinkSync(src, dest, 'dir');
  } catch (e) {
    fs.cpSync(src, dest, { recursive: true });
    mode = 'copy';
  }
  return { dest: dest, mode: mode };
}

export { sourceDir, installDir, fingerprint, fingerprintVisible, status, install, isInstalled };
