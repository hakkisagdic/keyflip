// @ts-check
// Command Code (`cmd`, npm package `command-code`) surface adapter.
//
// ONE file owns every local Command Code surface: `~/.commandcode/auth.json` (mode 0600).
// The shipped VS Code extension reads the SAME file, so a switch flips the CLI and the
// extension together. The web dashboard (commandcode.ai/billing, /usage) is a separate
// browser-cookie login keyflip does not carry — sign in there once per account, by hand.
//
// Shape (verified against command-code@1.81.0, 2026-10):
//   { <providerId>: { type: 'api', key }, apiKey, userId, userName, keyName, authenticatedAt }
// `apiKey` is the Command Code login; provider entries are BYOK overrides stored beside it,
// so a capture is one full file: switching also restores that account's provider keys.
// `userName` is a username (not an e-mail) — it is the label, never the key.
//
// Secrets live in 0600 files under <configDir>/surfaces/command-code/<slug>/ (the state repo
// git-ignores that tree as a whole); meta.json is secret-free. Nothing here ever prints,
// returns or logs a key. `COMMAND_CODE_API_KEY`, when exported in the shell, takes
// precedence over this file for `cmd` — status reports that, because a switch would look
// like it did nothing.
import fs from 'fs';
import path from 'path';
import { run as defaultRun } from './exec.js';
import { atomicWrite, writeJsonStable } from './fsutil.js';
import * as profiles from './profiles.js';
import * as _log from './log.js';

const SURFACE = 'command-code';
const ENV_KEY = 'COMMAND_CODE_API_KEY';
const DIR_NAME = '.commandcode';
const BACKUP_KEEP = 10;

function err(message, code) {
  const e = /** @type {any} */ (new Error(message));
  e.code = code || 'COMMANDCODE';
  return e;
}

function depsOf(d) {
  d = d || {};
  return {
    run: d.run || defaultRun,
    now:
      typeof d.now === 'function'
        ? d.now
        : d.now
          ? function () {
              return String(d.now);
            }
          : null,
  };
}

function nowIso(deps) {
  return deps && deps.now ? deps.now() : new Date().toISOString();
}

// ---- locations ---------------------------------------------------------------------------

function homeDir(ctx) {
  return (ctx && ctx.commandCodeHome) || path.join((ctx && ctx.home) || process.env.HOME || '', DIR_NAME);
}

function authPath(ctx) {
  return path.join(homeDir(ctx), 'auth.json');
}

function configPath(ctx) {
  return path.join(homeDir(ctx), 'config.json');
}

function mcpPath(ctx) {
  return path.join(homeDir(ctx), 'mcp.json');
}

function projectsRoot(ctx) {
  return path.join(homeDir(ctx), 'projects');
}

function surfaceRoot(ctx) {
  return path.join(ctx.configDir, 'surfaces', SURFACE);
}

function accountDir(ctx, slug) {
  return path.join(surfaceRoot(ctx), slug);
}

function metaPath(ctx, slug) {
  return path.join(accountDir(ctx, slug), 'meta.json');
}

function backupDir(ctx) {
  return path.join(surfaceRoot(ctx), '.backups');
}

// ---- small parsers -----------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;

function safeStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CTRL, '').trim();
  return s ? s.slice(0, max || 200) : null;
}

function normalizeId(v) {
  const s = safeStr(v, 200);
  return s ? s.toLowerCase() : null;
}

// Public identity from a parsed auth.json. Never includes a key.
function identityFromAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const providers = [];
  Object.keys(auth).forEach(function (k) {
    const v = auth[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.key === 'string') providers.push(safeStr(k, 60));
  });
  return {
    userName: safeStr(auth.userName, 120),
    userId: safeStr(auth.userId, 120),
    keyName: safeStr(auth.keyName, 200),
    authenticatedAt: safeStr(auth.authenticatedAt, 40),
    hasApiKey: typeof auth.apiKey === 'string' && !!auth.apiKey,
    providers: providers.filter(Boolean),
  };
}

// Read auth.json without ever throwing at the caller. `raw` stays in-process.
function readAuth(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false, raw: null, auth: null, identity: null, error: null };
    return { present: false, raw: null, auth: null, identity: null, error: e.message };
  }
  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    return { present: true, raw: raw, auth: null, identity: null, error: 'auth.json is not valid JSON' };
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { present: true, raw: raw, auth: null, identity: null, error: 'auth.json is not a JSON object' };
  }
  const identity = identityFromAuth(auth);
  const signedIn = !!(identity && (identity.userName || identity.userId) && identity.hasApiKey);
  return { present: true, raw: raw, auth: auth, identity: identity, signedIn: signedIn, error: null };
}

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

function readMeta(ctx, slug) {
  return readJson(metaPath(ctx, slug));
}

// ---- install detection -------------------------------------------------------------------

// `cmd` is an npm bin. When it is installed under a version-managed Node (fnm/nvm/asdf) the
// shim lives in that version's bin dir, which a different active Node does not put on PATH —
// the binary is installed but `cmd` is "command not found". Report both, so the user knows to
// `fnm use <version>` rather than reinstalling.
function binStatus(ctx) {
  const names = process.platform === 'win32' ? ['cmd.cmd', 'cmd.exe', 'cmdc.cmd'] : ['cmd', 'cmdc'];
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < names.length; j++) {
      const p = path.join(dirs[i], names[j]);
      try {
        if (fs.statSync(p).isFile()) return { onPath: true, path: p, via: 'PATH' };
      } catch {
        /* keep looking */
      }
    }
  }
  const found = [];
  const home = (ctx && ctx.home) || '';
  const bases = [
    path.join(home, '.local', 'share', 'fnm', 'node-versions'),
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  let versionDirs = [];
  try {
    versionDirs = fs.readdirSync(bases[0], { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    /* no fnm */
  }
  versionDirs.forEach(function (d) {
    const p = path.join(bases[0], d.name, 'installation', 'bin', 'cmd');
    try {
      if (fs.statSync(p).isFile()) found.push(p);
    } catch {
      /* not this version */
    }
  });
  const nvm = bases[1];
  try {
    fs.readdirSync(nvm, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .forEach(function (d) {
        const p = path.join(nvm, d.name, 'bin', 'cmd');
        try {
          if (fs.statSync(p).isFile()) found.push(p);
        } catch {
          /* not this version */
        }
      });
  } catch {
    /* no nvm */
  }
  if (found.length) return { onPath: false, path: found.sort()[found.length - 1], via: 'version-managed Node' };
  return { onPath: false, path: null, via: null };
}

function readUserConfig(ctx) {
  const c = readJson(configPath(ctx));
  if (!c) return { provider: null, model: null };
  return { provider: safeStr(c.provider, 80), model: safeStr(c.model, 120) };
}

function envOverride() {
  const v = process.env[ENV_KEY];
  return typeof v === 'string' && v.length > 0;
}

// ---- captures ----------------------------------------------------------------------------

function publicAccount(meta) {
  return {
    name: meta.name,
    userName: meta.userName || '',
    userId: meta.userId || '',
    keyName: meta.keyName || '',
    authenticatedAt: meta.authenticatedAt || null,
    providers: Array.isArray(meta.providers) ? meta.providers.slice() : [],
    source: meta.source || 'live',
    capturedAt: meta.capturedAt || null,
    updatedAt: meta.updatedAt || null,
    bytes: meta.bytes || 0,
  };
}

function listAccounts(ctx) {
  let entries;
  try {
    entries = fs.readdirSync(surfaceRoot(ctx), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  entries.forEach(function (e) {
    if (!e.isDirectory() || e.name[0] === '.') return;
    const meta = readMeta(ctx, e.name);
    if (meta && meta.name) out.push(publicAccount(Object.assign({}, meta, { name: e.name })));
  });
  out.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  return out;
}

function resolveAccount(ctx, arg) {
  if (arg == null) return null;
  const accounts = listAccounts(ctx);
  const s = String(arg);
  if (/^[0-9]+$/.test(s)) {
    const i = parseInt(s, 10);
    return i >= 1 && i <= accounts.length ? accounts[i - 1].name : null;
  }
  for (let i = 0; i < accounts.length; i++) {
    if (accounts[i].name === s) return s;
  }
  const want = normalizeId(s);
  for (let i = 0; i < accounts.length; i++) {
    if (normalizeId(accounts[i].userName) === want || normalizeId(accounts[i].userId) === want) return accounts[i].name;
  }
  return null;
}

function nameForIdentity(ctx, identity) {
  const accounts = listAccounts(ctx);
  for (let i = 0; i < accounts.length; i++) {
    if (identity.userId && accounts[i].userId && accounts[i].userId === identity.userId) return accounts[i].name;
    if (identity.userName && normalizeId(accounts[i].userName) === normalizeId(identity.userName))
      return accounts[i].name;
  }
  return null;
}

function autoSlug(ctx, identity) {
  const base = profiles.sanitizeName(identity.userName || identity.userId || 'account');
  const prev = readMeta(ctx, base);
  if (!prev) return base;
  if (prev.userId && identity.userId && prev.userId === identity.userId) return base;
  if (normalizeId(prev.userName) === normalizeId(identity.userName) && identity.userName) return base;
  let n = 1;
  let candidate = base;
  while (readMeta(ctx, candidate)) {
    n += 1;
    candidate = base + '-' + n;
  }
  return candidate;
}

function capture(ctx, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const live = opts.auth ? opts.auth : readAuth(authPath(ctx));
  if (!live.present) {
    throw err(
      'no live Command Code login found (' + authPath(ctx) + ' is missing). Run `cmd login` first.',
      'COMMANDCODE_NO_LOGIN',
    );
  }
  if (!live.auth) {
    throw err(
      'the live Command Code auth.json is unreadable/corrupt: ' + (live.error || 'invalid'),
      'COMMANDCODE_CORRUPT',
    );
  }
  const identity = live.identity;
  if (!identity || !live.signedIn) {
    throw err(
      'auth.json has no Command Code login (apiKey/userName missing). Run `cmd login` first.',
      'COMMANDCODE_NO_LOGIN',
    );
  }

  let slug;
  if (opts.name) {
    if (!profiles.isValidName(opts.name))
      throw err("invalid account name: '" + opts.name + "'", 'COMMANDCODE_BAD_NAME');
    const prev = readMeta(ctx, opts.name);
    if (
      prev &&
      ((prev.userId && identity.userId && prev.userId !== identity.userId) ||
        (prev.userName && identity.userName && normalizeId(prev.userName) !== normalizeId(identity.userName)))
    ) {
      throw err(
        "account '" + opts.name + "' already exists for " + (prev.userName || prev.userId) + '; choose another name.',
        'COMMANDCODE_NAME_CONFLICT',
      );
    }
    slug = opts.name;
  } else {
    slug = nameForIdentity(ctx, identity) || autoSlug(ctx, identity);
  }

  const dir = accountDir(ctx, slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  atomicWrite(path.join(dir, 'auth.json'), live.raw, 0o600);

  const prev = readMeta(ctx, slug) || {};
  const at = nowIso(deps);
  const meta = {
    schemaVersion: 1,
    name: slug,
    userName: identity.userName || prev.userName || '',
    userId: identity.userId || prev.userId || '',
    keyName: identity.keyName || prev.keyName || '',
    authenticatedAt: identity.authenticatedAt || prev.authenticatedAt || null,
    providers: identity.providers.length ? identity.providers : prev.providers || [],
    source: opts.source || 'live',
    capturedAt: prev.capturedAt || at,
    updatedAt: at,
    bytes: Buffer.byteLength(live.raw),
  };
  writeJsonStable(metaPath(ctx, slug), meta, 0o600);
  return { slug: slug, dir: dir, meta: publicAccount(meta) };
}

function loadBundle(ctx, slug) {
  const meta = readMeta(ctx, slug);
  if (!meta) return null;
  const stored = readAuth(path.join(accountDir(ctx, slug), 'auth.json'));
  return {
    slug: slug,
    meta: meta,
    raw: stored.raw,
    identity: stored.identity,
    file: path.join(accountDir(ctx, slug), 'auth.json'),
  };
}

// ---- backups -----------------------------------------------------------------------------

function listBackups(ctx) {
  let names;
  try {
    names = fs.readdirSync(backupDir(ctx));
  } catch {
    return [];
  }
  return names
    .filter(function (n) {
      return /-auth\.json$/.test(n);
    })
    .sort()
    .reverse()
    .map(function (n) {
      const file = path.join(backupDir(ctx), n);
      const r = readAuth(file);
      return {
        file: n,
        path: file,
        userName: (r.identity && r.identity.userName) || '',
        userId: (r.identity && r.identity.userId) || '',
        keyName: (r.identity && r.identity.keyName) || '',
        capturedAt: n.replace(/-auth\.json$/, ''),
        bytes: r.raw ? Buffer.byteLength(r.raw) : 0,
      };
    });
}

function backupLive(ctx, live, deps) {
  if (!live || !live.present || !live.raw) return null;
  const stamp = nowIso(deps).replace(/[:.]/g, '-');
  const dir = backupDir(ctx);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, stamp + '-auth.json');
  atomicWrite(dest, live.raw, 0o600);
  const all = listBackups(ctx);
  all.slice(BACKUP_KEEP).forEach(function (b) {
    try {
      fs.rmSync(b.path, { force: true });
    } catch {
      /* keep the rest */
    }
  });
  return dest;
}

function resolveBackup(ctx, ref) {
  const all = listBackups(ctx);
  if (!all.length) return null;
  const s = String(ref || '');
  if (/^[0-9]+$/.test(s)) {
    const i = parseInt(s, 10);
    return i >= 1 && i <= all.length ? all[i - 1] : null;
  }
  for (let i = 0; i < all.length; i++) if (all[i].file === s) return all[i];
  const hits = all.filter(function (b) {
    return b.file.indexOf(s) === 0;
  });
  return hits.length === 1 ? hits[0] : null;
}

// ---- status / switch ---------------------------------------------------------------------

function status(ctx, opts) {
  const deps = depsOf(opts);
  const live = readAuth(authPath(ctx));
  const cfg = readUserConfig(ctx);
  return {
    surface: SURFACE,
    file: authPath(ctx),
    present: live.present,
    signedIn: !!live.signedIn,
    error: live.error || null,
    identity: live.identity
      ? {
          userName: live.identity.userName,
          userId: live.identity.userId,
          keyName: live.identity.keyName,
          authenticatedAt: live.identity.authenticatedAt,
          hasApiKey: live.identity.hasApiKey,
        }
      : null,
    providers: live.identity ? live.identity.providers : [],
    bytes: live.raw ? Buffer.byteLength(live.raw) : 0,
    provider: cfg.provider,
    model: cfg.model,
    envOverride: envOverride(),
    bin: binStatus(ctx),
    accounts: listAccounts(ctx),
    now: nowIso(deps),
  };
}

function writeLive(ctx, raw, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const file = authPath(ctx);
  const live = readAuth(file);
  const expected = opts.expect || null;
  const plan = {
    file: file,
    userName: expected ? expected.userName || '' : '',
    userId: expected ? expected.userId || '' : '',
    live: live.identity ? { userName: live.identity.userName, userId: live.identity.userId } : null,
    write: { bytes: Buffer.byteLength(raw), providers: (expected && expected.providers) || [] },
  };
  if (opts.dryRun) return { dryRun: true, plan: plan };

  const capturedOutgoing = live.present && live.auth && live.signedIn ? tryCaptureOutgoing(ctx, live, deps) : null;
  const backup = backupLive(ctx, live, deps);
  atomicWrite(file, raw, 0o600);

  let verified = false;
  const after = readAuth(file);
  if (after.raw !== raw)
    throw err('post-switch check failed: ' + file + ' did not read back identically', 'COMMANDCODE_VERIFY');
  if (opts.noVerify !== true) {
    const got = after.identity || {};
    if (expected && expected.userId && got.userId && got.userId !== expected.userId) {
      throw err(
        'post-switch check failed: auth.json reports ' +
          got.userName +
          ', expected ' +
          expected.userName +
          (backup ? ' (backup: ' + backup + ')' : ''),
        'COMMANDCODE_VERIFY',
      );
    }
    if (expected && !expected.userId && expected.userName && got.userName) {
      if (normalizeId(got.userName) !== normalizeId(expected.userName)) {
        throw err(
          'post-switch check failed: auth.json reports ' +
            got.userName +
            ', expected ' +
            expected.userName +
            (backup ? ' (backup: ' + backup + ')' : ''),
          'COMMANDCODE_VERIFY',
        );
      }
    }
    verified = true;
  }
  return {
    dryRun: false,
    file: file,
    identity: after.identity,
    backup: backup,
    capturedOutgoing: capturedOutgoing,
    verified: verified,
  };
}

function tryCaptureOutgoing(ctx, live, deps) {
  try {
    return capture(ctx, { auth: live, source: 'live-outgoing', deps: deps }).slug;
  } catch {
    return null; // non-fatal: the switch is still what the user asked for
  }
}

function switchTo(ctx, target, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const slug = resolveAccount(ctx, target);
  if (!slug)
    throw err(
      "no such Command Code account: '" + target + "' (see `keyflip commandcode list`)",
      'COMMANDCODE_NOT_FOUND',
    );
  const bundle = loadBundle(ctx, slug);
  if (!bundle || !bundle.raw) {
    throw err(
      "the capture for '" + slug + "' has no readable auth.json; re-run `keyflip commandcode capture`",
      'COMMANDCODE_CORRUPT',
    );
  }
  if (!bundle.identity || !bundle.identity.hasApiKey) {
    throw err("the capture for '" + slug + "' holds no Command Code apiKey; re-capture it", 'COMMANDCODE_CORRUPT');
  }
  const expect = {
    userName: bundle.meta.userName || bundle.identity.userName || '',
    userId: bundle.meta.userId || bundle.identity.userId || '',
    providers: bundle.meta.providers || bundle.identity.providers || [],
  };
  const r = writeLive(ctx, bundle.raw, {
    dryRun: opts.dryRun,
    noVerify: opts.noVerify,
    expect: expect,
    deps: deps,
  });
  if (!r.dryRun) {
    // The one record that this Command Code account is now live. Name only — never a key.
    _log.log('command-code -> ' + slug);
    r.slug = slug;
  }
  return r;
}

function restoreBackup(ctx, ref, opts) {
  opts = opts || {};
  const deps = depsOf(opts);
  const b = resolveBackup(ctx, ref);
  if (!b)
    throw err(
      "no such Command Code backup: '" + ref + "' (see `keyflip commandcode backups`)",
      'COMMANDCODE_NOT_FOUND',
    );
  const stored = readAuth(b.path);
  if (!stored.raw) throw err('backup ' + b.file + ' is unreadable', 'COMMANDCODE_CORRUPT');
  const r = writeLive(ctx, stored.raw, {
    dryRun: opts.dryRun,
    noVerify: opts.noVerify,
    expect: stored.identity,
    deps: deps,
  });
  if (!r.dryRun) r.restored = b.file;
  return r;
}

function removeAccount(ctx, arg, opts) {
  opts = opts || {};
  const slug = resolveAccount(ctx, arg);
  if (!slug) throw err("no such Command Code account: '" + arg + "'", 'COMMANDCODE_NOT_FOUND');
  if (!opts.force) {
    throw err(
      "refusing to delete '" + slug + "' without --force (removes its captured auth.json)",
      'COMMANDCODE_CONFIRM',
    );
  }
  fs.rmSync(accountDir(ctx, slug), { recursive: true, force: true });
  return { removed: slug };
}

export {
  SURFACE,
  ENV_KEY,
  authPath,
  configPath,
  mcpPath,
  projectsRoot,
  surfaceRoot,
  accountDir,
  identityFromAuth,
  readAuth,
  binStatus,
  listAccounts,
  resolveAccount,
  capture,
  loadBundle,
  listBackups,
  resolveBackup,
  status,
  switchTo,
  restoreBackup,
  removeAccount,
};
