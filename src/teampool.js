// TEAM POOL: a shared, ENCRYPTED credential pool with roles. Where `fleet` is a
// per-machine control plane, a team pool is a single encrypted bundle in a shared
// folder (<sharedDir>/<pool>.pool.enc) that several people/roles pull from: an OWNER
// PUBLISHES saved accounts, tagging each with the MINIMUM role allowed to SEE it, and
// each teammate PULLS only the accounts their role may see. The file is AES-256-GCM
// encrypted at rest (via sync.encrypt/decrypt with the pool passphrase), so plaintext
// credentials never touch the shared disk. (Today keyflip sharing is single-user; this
// is the multi-user shape — role tags are advisory visibility, enforced by who holds
// the pool passphrase, exactly like the fleet's shared-secret rendezvous.)
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import * as transfer from './transfer.js';
import * as sync from './sync.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

const POOL_FORMAT = 'keyflip-pool';
const POOL_VERSION = 1;
const ROLES = ['owner', 'member'];
const ROLE_RANK = { member: 1, owner: 2 }; // owner ⊇ member
const MAX_ENC_BYTES = 8 * 1024 * 1024; // cap a single pool file (anti-DoS: a hostile huge .enc)

// A pool name becomes the filename <pool>.pool.enc, so — fleet-style — it MUST be a
// single bounded filename SEGMENT, never a path: reject separators and traversal, so a
// name from a semi-trusted caller can't read/write outside the shared dir.
const SAFE_POOL = /^[A-Za-z0-9._-]{1,64}$/;
function isValidPool(x) {
  return typeof x === 'string' && SAFE_POOL.test(x) && x.indexOf('..') === -1;
}
// A member id is user-supplied and becomes a KEY in a dedup set — allow emails, bound the
// length, and reject prototype-pollution / path-ish junk so it can never shadow a prototype.
const SAFE_MEMBER = /^[A-Za-z0-9._@+-]{1,128}$/;
const RESERVED_KEYS = ['__proto__', 'prototype', 'constructor'];
function isValidMember(x) {
  return typeof x === 'string' && SAFE_MEMBER.test(x) && x.indexOf('..') === -1 && RESERVED_KEYS.indexOf(x) === -1;
}
function isValidRole(r) {
  return r === 'owner' || r === 'member';
}
function rank(r) {
  return ROLE_RANK[r] || 0;
}
// An account tagged `tag` is visible to `asRole` iff the viewer's rank >= the tag's rank.
function canSee(asRole, tag) {
  return rank(asRole) >= rank(tag || 'member');
}

function poolFile(dir, pool) {
  if (!dir || typeof dir !== 'string') throw new Error('a shared pool directory is required (--dir <shared-folder>)');
  if (!isValidPool(pool))
    throw new Error("invalid pool name '" + pool + "' (use letters, digits, . _ - ; no path separators)");
  return path.join(dir, pool + '.pool.enc');
}

function needPass(passphrase) {
  if (!passphrase || typeof passphrase !== 'string')
    throw new Error('a pool passphrase is required (the pool carries login secrets) — pass --passphrase-file <f>');
  return passphrase;
}

// Coerce a DECRYPTED pool into a safe, null-prototype shape. The shared folder is only
// semi-trusted (shared passphrase + write access), so every field is type-checked, account
// names are validated (dropping prototype-pollution / reserved names) and each account's
// visibility role is CLAMPED to a known value — an unknown/tampered tag becomes 'owner'
// (the most restrictive), so a hand-edited tag can never OVER-share an account.
function normalizePool(raw, poolName) {
  const members = [];
  const seenM = Object.create(null);
  (raw && Array.isArray(raw.members) ? raw.members : []).forEach(function (m) {
    if (!m || typeof m !== 'object' || !isValidMember(m.id) || seenM[m.id]) return;
    seenM[m.id] = true;
    members.push({ id: m.id, role: isValidRole(m.role) ? m.role : 'member' });
  });
  const accounts = Object.create(null); // keyed by user-supplied account name -> null-proto
  const rawAcc =
    raw && raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts) ? raw.accounts : {};
  Object.keys(rawAcc).forEach(function (name) {
    if (!profiles.isValidName(name)) return; // blocks __proto__ / reserved names / bad names
    const a = rawAcc[name];
    if (!a || typeof a !== 'object') return;
    if (typeof a.cliCredentials !== 'string' || !a.cliCredentials.trim()) return; // no creds = not an account
    accounts[name] = {
      email: typeof a.email === 'string' ? a.email : '',
      role: isValidRole(a.role) ? a.role : 'owner', // visibility tag; unknown -> restrict
      oauthAccount: a.oauthAccount && typeof a.oauthAccount === 'object' ? a.oauthAccount : {},
      userID: typeof a.userID === 'string' ? a.userID : '',
      cliCredentials: a.cliCredentials,
    };
  });
  return {
    format: POOL_FORMAT,
    version: POOL_VERSION,
    pool: poolName,
    members: members,
    accounts: accounts,
    at: raw && typeof raw.at === 'string' ? raw.at : null,
  };
}

// Decrypt + normalize the pool file. Returns the RAW pool (INCLUDES credentials) for the
// internal pull/mutation paths, or null if the file does not exist. THROWS on a wrong
// passphrase / corrupt payload (never silently treats it as empty — that would let a
// re-publish clobber a pool you can't actually read). NOT for display: anything that
// surfaces a pool to a user/agent MUST use read() (creds-free).
function loadRaw(ctx, opts) {
  const file = poolFile(opts.dir, opts.pool);
  needPass(opts.passphrase);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return null;
  } // ENOENT -> no pool yet
  if (stat.size > MAX_ENC_BYTES) throw new Error('pool file is too large (refusing to read > 8MB)');
  const rawText = fs.readFileSync(file, 'utf8');
  const plain = sync.decrypt(rawText, opts.passphrase); // throws on wrong passphrase / corrupt
  let parsed;
  try {
    parsed = JSON.parse(plain);
  } catch (e) {
    throw new Error('pool file is corrupt (invalid JSON after decrypt)');
  }
  if (!parsed || parsed.format !== POOL_FORMAT) throw new Error('not a keyflip team pool file');
  return normalizePool(parsed, opts.pool);
}

// Encrypt + write the pool to the shared folder (0600, mirrors fleet's rendezvous writes).
function saveRaw(ctx, opts, poolObj) {
  const file = poolFile(opts.dir, opts.pool);
  needPass(opts.passphrase);
  const accountsOut = {};
  Object.keys(poolObj.accounts)
    .sort()
    .forEach(function (n) {
      accountsOut[n] = poolObj.accounts[n];
    });
  const payload = {
    format: POOL_FORMAT,
    version: POOL_VERSION,
    pool: opts.pool,
    members: poolObj.members.slice().sort(byId),
    accounts: accountsOut,
    at: ctx.now(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, sync.encrypt(JSON.stringify(payload), opts.passphrase), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (e) {
    /* non-POSIX */
  }
  return payload;
}
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Creds-free projection of the pool for DISPLAY (CLI/MCP/panel). Strips every
// cliCredentials blob; keeps each account's name, email and visibility role. This is the
// ONLY pool view that may leave the process.
function sanitize(pool) {
  if (!pool) return null;
  return {
    format: pool.format,
    version: pool.version,
    pool: pool.pool,
    members: pool.members.map(function (m) {
      return { id: m.id, role: m.role };
    }),
    accounts: Object.keys(pool.accounts)
      .sort()
      .map(function (n) {
        const a = pool.accounts[n];
        return { name: n, email: a.email || null, role: a.role };
      }),
    at: pool.at,
  };
}

// read(ctx,{dir,pool,passphrase}) -> the creds-free pool view, or null if it doesn't exist.
function read(ctx, opts) {
  opts = opts || {};
  return sanitize(loadRaw(ctx, opts));
}

// publish(ctx,{dir,pool,passphrase,accounts?,owner?}) — build the pool from THIS machine's
// saved accounts (transfer.buildExport → the credential blobs) and write it ENCRYPTED to the
// shared folder. Each account is tagged with the MINIMUM role allowed to see it; `accounts`
// selects which to publish and, optionally, per-account roles:
//   - omitted        -> every local account, tagged 'member'
//   - ['a','b']      -> only those, tagged 'member'
//   - { a:'owner' }  -> only those, with the given role ('owner'|'member')
// Members are PRESERVED across re-publishes (re-reading needs the same passphrase, so a wrong
// one throws rather than clobbering); a brand-new pool is seeded with the publisher as its
// sole owner (opts.owner, default 'owner'). Replaces the pool's account set wholesale.
function publish(ctx, opts) {
  opts = opts || {};
  needPass(opts.passphrase);
  poolFile(opts.dir, opts.pool); // validate dir + pool name up front

  // Selection + per-account role map (null-proto: names are user-supplied).
  const wanted = Object.create(null);
  let selectAll = false;
  if (opts.accounts == null) {
    selectAll = true;
  } else if (Array.isArray(opts.accounts)) {
    opts.accounts.forEach(function (n) {
      if (!profiles.isValidName(n)) throw new Error("invalid account name '" + n + "'");
      wanted[n] = 'member';
    });
  } else if (typeof opts.accounts === 'object') {
    Object.keys(opts.accounts).forEach(function (n) {
      if (!profiles.isValidName(n)) throw new Error("invalid account name '" + n + "'");
      const raw = opts.accounts[n];
      const role = raw && typeof raw === 'object' ? raw.role : raw;
      if (!isValidRole(role))
        throw new Error("account '" + n + "' has an invalid role '" + role + "' (use 'owner' or 'member')");
      wanted[n] = role;
    });
  } else {
    throw new Error('accounts must be an array of names or a { name: role } map');
  }

  const built = transfer.buildExport(ctx).envelope.accounts; // includes cliCredentials
  const byName = Object.create(null);
  built.forEach(function (a) {
    byName[a.name] = a;
  });

  // Preserve members from an existing pool (throws on a wrong passphrase -> never clobbers).
  const existing = loadRaw(ctx, opts);

  const accounts = Object.create(null);
  const chosen = selectAll
    ? built.map(function (a) {
        return a.name;
      })
    : Object.keys(wanted);
  const missing = [];
  chosen.forEach(function (name) {
    const src = byName[name];
    if (!src) {
      missing.push(name);
      return;
    }
    accounts[name] = {
      email: src.email || '',
      role: selectAll ? 'member' : wanted[name],
      oauthAccount: src.oauthAccount || {},
      userID: src.userID || '',
      cliCredentials: src.cliCredentials,
    };
  });
  if (missing.length) throw new Error('no such local account(s): ' + missing.join(', '));
  if (!Object.keys(accounts).length)
    throw new Error('no accounts to publish (this machine has no saved accounts matching the selection)');

  let members;
  if (existing && existing.members.length) {
    members = existing.members;
  } else {
    const owner = opts.owner && isValidMember(opts.owner) ? opts.owner : 'owner';
    members = [{ id: owner, role: 'owner' }];
  }

  const saved = saveRaw(ctx, opts, { members: members, accounts: accounts });
  recordLocal(ctx, opts.pool, opts.dir, 'owner', saved.at);
  return {
    pool: opts.pool,
    dir: path.resolve(opts.dir),
    at: saved.at,
    members: saved.members.map(function (m) {
      return { id: m.id, role: m.role };
    }),
    accounts: Object.keys(accounts)
      .sort()
      .map(function (n) {
        return { name: n, role: accounts[n].role };
      }),
  };
}

// pull(ctx,{dir,pool,passphrase,asRole,force?}) — import from the pool only the accounts the
// caller's role may SEE, reusing transfer.applyImport (validate-everything-then-write; existing
// accounts are skipped unless opts.force). asRole defaults to the least-privileged 'member'.
function pull(ctx, opts) {
  opts = opts || {};
  needPass(opts.passphrase);
  const asRole = opts.asRole || 'member';
  if (!isValidRole(asRole)) throw new Error("invalid role '" + asRole + "' (use 'owner' or 'member')");
  const pool = loadRaw(ctx, opts);
  if (!pool) throw new Error("no such pool '" + opts.pool + "' in " + path.resolve(opts.dir));

  const visible = [];
  const accts = [];
  Object.keys(pool.accounts)
    .sort()
    .forEach(function (name) {
      const a = pool.accounts[name];
      if (!canSee(asRole, a.role)) return;
      visible.push(name);
      accts.push({
        name: name,
        email: a.email || '',
        oauthAccount: a.oauthAccount || {},
        userID: a.userID || '',
        cliCredentials: a.cliCredentials,
      });
    });

  let imported = [],
    skipped = [];
  if (accts.length) {
    const envelope = { format: transfer.FORMAT, version: transfer.VERSION, exportedAt: ctx.now(), accounts: accts };
    const r = transfer.applyImport(ctx, envelope, { force: !!opts.force });
    imported = r.imported;
    skipped = r.skipped;
  }
  recordLocal(ctx, opts.pool, opts.dir, asRole, pool.at);
  return { pool: opts.pool, role: asRole, visible: visible, imported: imported, skipped: skipped };
}

// ---- member roster (lives INSIDE the encrypted pool file) --------------------------------
function members(ctx, opts) {
  opts = opts || {};
  const pool = loadRaw(ctx, opts);
  if (!pool) throw new Error("no such pool '" + opts.pool + "'");
  return pool.members
    .map(function (m) {
      return { id: m.id, role: m.role };
    })
    .sort(byId);
}

function addMember(ctx, opts) {
  opts = opts || {};
  const id = opts.id;
  const role = opts.role || 'member';
  if (!isValidMember(id)) throw new Error("invalid member id '" + id + "'");
  if (!isValidRole(role)) throw new Error("invalid role '" + role + "' (use 'owner' or 'member')");
  const pool = loadRaw(ctx, opts);
  if (!pool) throw new Error("no such pool '" + opts.pool + "' — publish it first");
  const kept = pool.members.filter(function (m) {
    return m.id !== id;
  }); // upsert
  kept.push({ id: id, role: role });
  saveRaw(ctx, opts, { members: kept, accounts: pool.accounts });
  return kept
    .map(function (m) {
      return { id: m.id, role: m.role };
    })
    .sort(byId);
}

function removeMember(ctx, opts) {
  opts = opts || {};
  const id = opts.id;
  if (typeof id !== 'string' || !id) throw new Error('a member id is required');
  const pool = loadRaw(ctx, opts);
  if (!pool) throw new Error("no such pool '" + opts.pool + "'");
  const kept = pool.members.filter(function (m) {
    return m.id !== id;
  });
  if (kept.length === pool.members.length) throw new Error("no such member '" + id + "'");
  // Never leave the pool un-ownable: refuse to remove the last owner.
  if (
    !kept.some(function (m) {
      return m.role === 'owner';
    })
  )
    throw new Error('cannot remove the last owner of the pool');
  saveRaw(ctx, opts, { members: kept, accounts: pool.accounts });
  return kept
    .map(function (m) {
      return { id: m.id, role: m.role };
    })
    .sort(byId);
}

// ---- local, NON-SECRET registry of pools this machine touches ---------------------------
// A convenience index (<configDir>/teampool.json) so the CLI can list the pools you've
// published/pulled without re-scanning shared folders. Holds NO credentials — just the pool
// name, its shared dir, the role you last used, and when. (Add 'teampool' to
// profiles.RESERVED_FILES so this file is never mistaken for an account.)
function statePath(ctx) {
  return path.join(ctx.configDir, 'teampool.json');
}
function knownPools(ctx) {
  const out = Object.create(null);
  let parsed;
  try {
    parsed = readJsonForWrite(statePath(ctx));
  } catch (e) {
    return out;
  }
  const pools =
    parsed && parsed.pools && typeof parsed.pools === 'object' && !Array.isArray(parsed.pools) ? parsed.pools : {};
  Object.keys(pools).forEach(function (name) {
    if (!isValidPool(name)) return;
    const p = pools[name];
    if (!p || typeof p !== 'object') return;
    out[name] = {
      dir: typeof p.dir === 'string' ? p.dir : null,
      role: isValidRole(p.role) ? p.role : null,
      at: typeof p.at === 'string' ? p.at : null,
    };
  });
  return out;
}
function recordLocal(ctx, pool, dir, role, at) {
  try {
    const known = knownPools(ctx);
    known[pool] = { dir: dir ? path.resolve(dir) : null, role: role, at: at || ctx.now() };
    const out = { pools: {} };
    Object.keys(known)
      .sort()
      .forEach(function (k) {
        out.pools[k] = known[k];
      });
    atomicWrite(statePath(ctx), JSON.stringify(out, null, 2), 0o600);
  } catch (e) {
    /* best-effort — a convenience index, never block publish/pull on it */
  }
}
function list(ctx) {
  const known = knownPools(ctx);
  return Object.keys(known)
    .sort()
    .map(function (k) {
      return { pool: k, dir: known[k].dir, role: known[k].role, at: known[k].at };
    });
}

export {
  publish,
  read,
  pull,
  members,
  addMember,
  removeMember,
  list,
  isValidPool,
  isValidMember,
  isValidRole,
  canSee,
  poolFile,
  sanitize,
  knownPools,
  statePath,
  POOL_FORMAT,
  POOL_VERSION,
  ROLES,
};
