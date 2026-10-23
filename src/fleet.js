// FLEET: manage every associated keyflip from one place. keyflip is not a daemon, so the fleet
// coordinates through a SHARED RENDEZVOUS folder (a Dropbox/iCloud/WebDAV-synced dir, or any
// path both machines can reach) — every file written there is encrypted with the fleet
// passphrase (via sync.encrypt), so the folder never holds plaintext. Each machine PUBLISHES a
// status (accounts + quota + chat state) and reads an INBOX of commands other machines queued
// for it (switch account, receive a distributed account). This lets machine A, in one screen,
// see B and C, flip B's account, and hand C's account to B.
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as _sync from './sync.js';
import * as _core from './core.js';
import * as _sessions from './sessions.js';
import * as _transcript from './transcript.js';
import * as _transfer from './transfer.js';
import * as _fsutil from './fsutil.js';

function idPath(ctx) {
  return path.join(ctx.configDir, 'fleet.json');
}

// Stable per-machine identity (hostname + a random suffix), minted once and then reused. Also
// holds the configured fleet name + rendezvous dir. The passphrase is NEVER stored (supplied per
// command). The id must satisfy safeId() or every bus filename derived from it throws, so it is
// re-minted when a stored fleet.json carries one that does not.
function identity(ctx) {
  let id = {};
  try {
    id = JSON.parse(fs.readFileSync(idPath(ctx), 'utf8')) || {};
  } catch (e) {
    id = {};
  }
  let minted = false;
  if (!id.machineId) {
    const host = safeHost();
    const suffix = crypto.randomBytes(3).toString('hex');
    id.machineId = host + '-' + suffix;
    if (!id.name) id.name = host;
    minted = true;
  }
  if (!safeId(id.machineId)) {
    const host = safeHost();
    id.machineId = host + '-' + crypto.randomBytes(3).toString('hex');
    if (!id.name) id.name = host;
    minted = true;
  }
  if (minted) {
    try {
      const fsutil = _fsutil;
      fsutil.atomicWrite(idPath(ctx), JSON.stringify(id, null, 2), 0o600);
    } catch (e) {
      /* best-effort */
    }
  }
  return id;
}
// Capped at 40 chars so hostname + '-' + 6 hex suffix always fits SAFE_ID's 64-char bound.
function safeHost() {
  try {
    return (
      String(os.hostname())
        .split('.')[0]
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 40) || 'machine'
    );
  } catch (e) {
    return 'machine';
  }
}

// A machine id must be a single SAFE FILENAME SEGMENT — never a path. Peer-supplied ids reach
// filenames (<id>.status.enc / <id>.inbox.enc), so an unvalidated '../' would let a hostile peer
// (the rendezvous folder is only semi-trusted — a shared passphrase + shared write access) write
// or read OUTSIDE the rendezvous dir. Reject anything that isn't a bounded [A-Za-z0-9._-] token.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
function safeId(x) {
  return typeof x === 'string' && SAFE_ID.test(x) && x.indexOf('..') === -1;
}
// A bus entry name must be a plain basename (no separators, no traversal) — defence in depth.
function nameOk(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 96 &&
    name.indexOf('/') === -1 &&
    name.indexOf('\\') === -1 &&
    name.indexOf('\0') === -1 &&
    name !== '.' &&
    name !== '..' &&
    path.basename(name) === name
  );
}
const MAX_ENC_BYTES = 8 * 1024 * 1024; // cap a single peer file (anti-DoS: a hostile huge .enc)
const MAX_STATUS_FILES = 500; // cap how many peer statuses we process per read
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g; // control chars incl. ANSI ESC — strip from peer strings pre-render
function scrub(s, max) {
  return String(s == null ? '' : s)
    .replace(CTRL, ' ')
    .slice(0, max || 200);
}

function setConfig(ctx, patch) {
  const id = identity(ctx);
  Object.keys(patch || {}).forEach(function (k) {
    if (patch[k] != null) id[k] = patch[k];
  });
  _fsutil.atomicWrite(idPath(ctx), JSON.stringify(id, null, 2), 0o600);
  return id;
}

// ---- per-machine ORIGIN AUTHENTICATION (Ed25519 signing keys, trust-on-first-use) ----
// The rendezvous folder is only as trustworthy as the shared passphrase: anyone holding it can
// write any file, so passphrase-encryption alone cannot prove WHO queued a command. So each machine
// owns an Ed25519 keypair: the PRIVATE key never leaves this machine (0600 in configDir, never the
// shared folder, never argv); the PUBLIC key is published in the machine's status. Commands are
// signed; a receiver verifies the signature against the sender's TOFU-PINNED public key. A pinned
// key that later CHANGES is flagged as a possible key-substitution attack and the command rejected.
function keyPath(ctx) {
  return path.join(ctx.configDir, 'fleet-key.json');
}
function machineKeys(ctx) {
  let k = null;
  try {
    k = JSON.parse(fs.readFileSync(keyPath(ctx), 'utf8'));
  } catch (e) {
    k = null;
  }
  if (!k || !k.privatePem || !k.publicB64) {
    const pair = crypto.generateKeyPairSync('ed25519');
    k = {
      privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicB64: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      createdAt: ctx.now(),
    };
    try {
      _fsutil.atomicWrite(keyPath(ctx), JSON.stringify(k), 0o600);
    } catch (e) {
      /* best-effort */
    }
  }
  return k;
}
function publicKey(ctx) {
  return machineKeys(ctx).publicB64;
}
// A public key travels as single-line base64 DER (spki) — scrub-safe (no newlines) and compact.
function isPubB64(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 2000 && /^[A-Za-z0-9+/=]+$/.test(s);
}
function pubKeyObject(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

// Canonical bytes we sign/verify: the command's meaning, order-stable. payload round-trips through
// JSON identically on both machines (our own code produces it), so re-serialising here is stable.
// `to` (the intended RECIPIENT machine) is signed so a genuine signature can't be replayed into a
// different machine's inbox — origin auth must prove not just WHO+WHAT but FOR WHOM.
function signable(cmd) {
  return JSON.stringify({
    id: cmd.id,
    from: cmd.from,
    to: cmd.to == null ? null : cmd.to,
    at: cmd.at,
    type: cmd.type,
    payload: cmd.payload === undefined ? null : cmd.payload,
  });
}
function signCommand(ctx, cmd) {
  const k = machineKeys(ctx);
  const sig = crypto.sign(null, Buffer.from(signable(cmd), 'utf8'), crypto.createPrivateKey(k.privatePem));
  cmd.sig = sig.toString('base64');
  return cmd;
}
function verifyCommand(cmd, pubB64) {
  if (!cmd || typeof cmd.sig !== 'string' || !isPubB64(pubB64)) return false;
  let sigBuf;
  try {
    sigBuf = Buffer.from(cmd.sig, 'base64');
  } catch (e) {
    return false;
  }
  try {
    return crypto.verify(null, Buffer.from(signable(cmd), 'utf8'), pubKeyObject(pubB64), sigBuf);
  } catch (e) {
    return false;
  }
}

// TOFU key store: machineId -> pinned public key (first one we ever saw for that id). The in-memory
// map is a NULL-PROTOTYPE object so a peer-controlled machineId (e.g. "__proto__"/"constructor") can
// never pollute a prototype or shadow an inherited property during lookup.
function knownPath(ctx) {
  return path.join(ctx.configDir, 'fleet-known.json');
}
function knownKeys(ctx) {
  const out = Object.create(null);
  try {
    const k = JSON.parse(fs.readFileSync(knownPath(ctx), 'utf8'));
    if (k && typeof k === 'object' && !Array.isArray(k))
      Object.keys(k).forEach(function (id) {
        if (safeId(id) && isPubB64(k[id])) out[id] = k[id];
      });
  } catch (e) {
    /* none yet */
  }
  return out;
}
function saveKnown(ctx, map) {
  try {
    _fsutil.atomicWrite(knownPath(ctx), JSON.stringify(map), 0o600);
  } catch (e) {
    /* best-effort */
  }
}
const MAX_KNOWN = 1000; // cap the TOFU roster (anti-DoS: a passphrase holder flooding distinct ids)
// Reconcile pinned keys against what peers currently publish.
//
// PINNING IS DELIBERATE. This used to pin a peer on FIRST SIGHT (classic TOFU), which meant anyone
// holding the passphrase and write access to the rendezvous could add a machine just by publishing —
// a new id would be auto-trusted and its commands accepted. Now a NEW peer is only REPORTED (as
// `pending`), never pinned: pinning happens through `keyflip fleet trust` or the invite/join pairing
// flow, both of which require the user's action. A pinned key is still NEVER overwritten — a mismatch
// stays a conflict (possible substitution). `opts.pinNew` restores the old behaviour and exists only
// for tests that exercise TOFU in isolation; production callers never pass it.
// Returns { keys, conflicts, firstSeen, pending }.
function reconcileKeys(ctx, statuses, opts) {
  opts = opts || {};
  const pinNew = opts.pinNew === true; // DEFAULT OFF: pinning is a user decision, not an inference
  const known = knownKeys(ctx);
  const selfId = identity(ctx).machineId; // a machine is never its own peer: skip its own status
  const conflicts = [],
    firstSeen = [],
    pending = [];
  let changed = false;
  (Array.isArray(statuses) ? statuses : []).forEach(function (s) {
    if (!s || !safeId(s.machineId) || !isPubB64(s.pubKey)) return;
    if (s.machineId === selfId) return; // otherwise every push warns "new machine <self>"
    const cur = known[s.machineId];
    if (!cur) {
      if (!pinNew) {
        pending.push({ machineId: s.machineId, name: scrub(s.name, 80) || s.machineId }); // seen, not trusted
        return;
      }
      if (Object.keys(known).length >= MAX_KNOWN) return; // roster full — don't pin new peers
      known[s.machineId] = s.pubKey;
      firstSeen.push(s.machineId);
      changed = true;
    } else if (cur !== s.pubKey) {
      conflicts.push({ machineId: s.machineId, name: scrub(s.name, 80) || s.machineId });
    }
  });
  if (changed) saveKnown(ctx, known);
  return { keys: known, conflicts: conflicts, firstSeen: firstSeen, pending: pending };
}
// Is this machine's published key already pinned here? Used to distinguish "a peer I trust" from
// "a stranger publishing into the folder" without pinning the stranger.
function isPinned(ctx, machineId) {
  return !!knownKeys(ctx)[machineId];
}
// Short SHA-256 fingerprint of a public key — shown at trust time so a re-key can be verified
// out-of-band (compare against the fingerprint the other machine prints).
function fingerprint(pubB64) {
  try {
    return crypto
      .createHash('sha256')
      .update(Buffer.from(String(pubB64), 'base64'))
      .digest('hex')
      .replace(/(..)/g, '$1:')
      .slice(0, 23);
  } catch (e) {
    return '?';
  }
}
// Audit view of the TOFU key store: every pinned/published machine, its fingerprint, and whether the
// currently-published key still MATCHES the pin (ok / CHANGED = possible substitution / unpinned /
// offline = pinned but not currently publishing). Read-only — for `fleet keys` and its MCP tool.
function keyReport(ctx, statuses) {
  const known = knownKeys(ctx);
  const published = Object.create(null);
  (Array.isArray(statuses) ? statuses : []).forEach(function (s) {
    if (s && safeId(s.machineId) && isPubB64(s.pubKey))
      published[s.machineId] = { key: s.pubKey, name: scrub(s.name, 80) || s.machineId };
  });
  const ids = Object.keys(known);
  Object.keys(published).forEach(function (id) {
    if (ids.indexOf(id) === -1) ids.push(id);
  });
  return ids.sort().map(function (id) {
    const pin = known[id],
      pub = published[id];
    return {
      machineId: id,
      name: (pub && pub.name) || id,
      pinned: pin ? fingerprint(pin) : null,
      published: pub ? fingerprint(pub.key) : null,
      status: !pin ? 'unpinned' : !pub ? 'offline' : pin === pub.key ? 'ok' : 'CHANGED',
    };
  });
}
// Deliberately (re)pin a machine's current published key — used after a LEGITIMATE re-key, only on
// explicit user consent (the CLI `fleet trust` command). This is the sole way a pinned key changes.
function trustKey(ctx, machineId, pubB64) {
  if (!safeId(machineId) || !isPubB64(pubB64)) return false;
  const known = knownKeys(ctx);
  known[machineId] = pubB64;
  saveKnown(ctx, known);
  return true;
}
// Full origin check for one command against a reconcile() result. The single gate the CLI/MCP use.
// `ctx` identifies the RECEIVING machine so we can reject a genuine signature that was addressed to a
// DIFFERENT machine (cross-inbox replay/fan-out) — the recipient is part of the signed bytes.
function checkOrigin(ctx, cmd, reconcile) {
  reconcile = reconcile || { keys: {}, conflicts: [] };
  if (!cmd || typeof cmd.sig !== 'string') return { ok: false, reason: 'unsigned command (rejected)' };
  if (!safeId(cmd.from)) return { ok: false, reason: 'command has no valid sender' };
  const selfId = identity(ctx).machineId;
  if (cmd.to !== selfId)
    return { ok: false, reason: 'command was not addressed to this machine (rejected — possible cross-inbox replay)' };
  if (
    (reconcile.conflicts || []).some(function (c) {
      return c.machineId === cmd.from;
    })
  )
    return {
      ok: false,
      reason: "sender '" + cmd.from + "' key CHANGED since first seen — possible key substitution (rejected)",
    };
  const key = (reconcile.keys || {})[cmd.from];
  if (!key)
    return {
      ok: false,
      reason: "no pinned key for sender '" + cmd.from + "' (it must publish `keyflip fleet push` first)",
    };
  if (!verifyCommand(cmd, key))
    return { ok: false, reason: 'signature does not verify against the pinned sender key (rejected)' };
  return { ok: true, key: key };
}

// A rendezvous bus over a directory (later swappable for WebDAV via sync's dav*). Everything is
// encrypted at rest with the fleet passphrase.
function bus(ctx, opts) {
  opts = opts || {};
  const id = identity(ctx);
  const dir = opts.dir || id.dir;
  if (!dir) throw new Error('no fleet rendezvous configured — run `keyflip fleet init --dir <shared-folder>`');
  if (!opts.passphrase) throw new Error('a fleet passphrase is required (--passphrase-file <f>)');
  const sync = _sync;
  return {
    dir: dir,
    machineId: id.machineId,
    name: id.name,
    write: function (name, obj) {
      if (!nameOk(name)) throw new Error('unsafe fleet entry name');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, name);
      fs.writeFileSync(f, sync.encrypt(JSON.stringify(obj), opts.passphrase), { mode: 0o600 });
      try {
        fs.chmodSync(f, 0o600);
      } catch (e) {
        /* non-POSIX */
      }
    },
    read: function (name) {
      if (!nameOk(name)) return null;
      const f = path.join(dir, name);
      try {
        if (fs.statSync(f).size > MAX_ENC_BYTES) return null;
      } catch (e) {
        return null;
      }
      let raw;
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch (e) {
        return null;
      }
      try {
        return JSON.parse(sync.decrypt(raw, opts.passphrase));
      } catch (e) {
        return null;
      }
    },
    list: function (suffix) {
      let ents = [];
      try {
        ents = fs.readdirSync(dir);
      } catch (e) {
        return [];
      }
      return ents.filter(function (n) {
        return nameOk(n) && n.slice(-suffix.length) === suffix;
      });
    },
    remove: function (name) {
      if (!nameOk(name)) return;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (e) {
        /* ignore */
      }
    },
    // Raw rendezvous I/O — the exact bytes, no fleet-passphrase (de)encryption. The PAIRING files
    // are encrypted with the one-time CODE instead, so they must not go through write()/read()
    // (which would double-encrypt them and make only the passphrase, not the code, the key).
    // Same 0600 + size guard as the encrypted path.
    rawWrite: function (name, text) {
      if (!nameOk(name)) throw new Error('unsafe fleet entry name');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
      try {
        fs.chmodSync(path.join(dir, name), 0o600);
      } catch (e) {
        /* non-POSIX */
      }
    },
    rawRead: function (name) {
      if (!nameOk(name)) return null;
      try {
        const f = path.join(dir, name);
        if (fs.statSync(f).size > MAX_ENC_BYTES) return null;
        return fs.readFileSync(f, 'utf8');
      } catch (e) {
        return null;
      }
    },
  };
}

function statusName(machineId) {
  if (!safeId(machineId)) throw new Error('unsafe machine id');
  return machineId + '.status.enc';
}
function inboxName(machineId) {
  if (!safeId(machineId)) throw new Error('unsafe machine id');
  return machineId + '.inbox.enc';
}

// Build this machine's status: accounts (+cached quota), the active account, and recent chat
// state (last message role -> replied/waiting). withSecrets also carries the account credentials
// (encrypted in the bus) so another machine can be handed one of them.
function buildStatus(ctx, opts) {
  opts = opts || {};
  const core = _core;
  const id = identity(ctx);
  let usageCache = {};
  try {
    usageCache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')) || {};
  } catch (e) {
    usageCache = {};
  }
  const accounts = safe(function () {
    return core.listProfiles(ctx).map(function (p) {
      const u = usageCache[p.name] && usageCache[p.name].usage;
      return {
        name: p.name,
        email: p.email || null,
        active: !!p.active,
        fiveHourPct: u && u.fiveHour && typeof u.fiveHour.pct === 'number' ? u.fiveHour.pct : null,
        sevenDayPct: u && u.sevenDay && typeof u.sevenDay.pct === 'number' ? u.sevenDay.pct : null,
      };
    });
  }, []);
  const chats = safe(function () {
    return recentChats(ctx, 12);
  }, []);
  const status = {
    machineId: id.machineId,
    name: id.name,
    at: ctx.now(),
    pubKey: safe(function () {
      return publicKey(ctx);
    }, null), // origin-auth: peers TOFU-pin this
    activeEmail: safe(function () {
      return core.currentEmail(ctx);
    }, null),
    accounts: accounts,
    chats: chats,
  };
  if (opts.withSecrets) {
    const creds = {};
    safe(function () {
      _transfer.buildExport(ctx).envelope.accounts.forEach(function (a) {
        creds[a.name] = {
          email: a.email,
          oauthAccount: a.oauthAccount,
          userID: a.userID,
          cliCredentials: a.cliCredentials,
        };
      });
    }, null);
    status.creds = creds;
  }
  return status;
}
function safe(fn, d) {
  try {
    return fn();
  } catch (e) {
    return d;
  }
}

// Recent sessions with last-message role (assistant = a reply arrived; user = waiting on Claude).
function recentChats(ctx, limit) {
  const sessions = _sessions;
  const transcript = _transcript;
  return sessions.list(ctx, { limit: limit }).map(function (r) {
    let lastRole = null,
      lastText = null;
    try {
      const msgs = transcript.parse(fs.readFileSync(r.file, 'utf8')).messages;
      const last = msgs[msgs.length - 1];
      if (last) {
        lastRole = last.role;
        lastText = String(last.text || '')
          .replace(/\s+/g, ' ')
          .slice(0, 80);
      }
    } catch (e) {
      /* ignore */
    }
    return {
      sessionId: r.sessionId,
      cwd: r.cwd || null,
      mtime: r.mtime,
      lastRole: lastRole,
      lastText: lastText,
      replied: lastRole === 'assistant',
    };
  });
}

// ---- publish / read the fleet ----
function publish(ctx, b, opts) {
  const status = buildStatus(ctx, opts || {});
  b.write(statusName(b.machineId), status);
  return status;
}
// Coerce a DECRYPTED PEER status into safe shapes — a peer is only semi-trusted, so every field it
// controls is type-checked, control-chars stripped, and length-capped before it can reach a
// terminal render, an HTML/JSON surface, or a filename. Drops the whole status (null) if it has no
// usable machine id. `creds` (only present with --with-secrets) is preserved for the relay paths
// (accountFrom / collect) but is NEVER a display field — sanitizeStatus() strips it for that.
function normalizeStatus(s) {
  if (!s || typeof s !== 'object') return null;
  const machineId = typeof s.machineId === 'string' ? s.machineId : '';
  if (!safeId(machineId)) return null;
  const out = {
    machineId: machineId,
    name: scrub(s.name == null ? machineId : s.name, 80) || machineId,
    at: scrub(s.at, 40),
    pubKey: isPubB64(s.pubKey) ? s.pubKey : null, // public key is single-line base64 — kept verbatim
    activeEmail: s.activeEmail == null ? null : scrub(s.activeEmail, 200),
    accounts: (Array.isArray(s.accounts) ? s.accounts : [])
      .filter(function (a) {
        return a && typeof a === 'object';
      })
      .map(function (a) {
        return {
          name: scrub(a.name, 80),
          email: a.email == null ? null : scrub(a.email, 200),
          active: !!a.active,
          fiveHourPct: typeof a.fiveHourPct === 'number' ? a.fiveHourPct : null,
          sevenDayPct: typeof a.sevenDayPct === 'number' ? a.sevenDayPct : null,
        };
      }),
    chats: (Array.isArray(s.chats) ? s.chats : [])
      .filter(function (c) {
        return c && typeof c === 'object';
      })
      .map(function (c) {
        return {
          sessionId: scrub(c.sessionId, 120),
          cwd: c.cwd == null ? null : scrub(c.cwd, 300),
          mtime: typeof c.mtime === 'number' ? c.mtime : typeof c.mtime === 'string' ? scrub(c.mtime, 40) : null,
          lastRole:
            c.lastRole == null
              ? null
              : String(c.lastRole)
                  .replace(/[^\w-]/g, '')
                  .slice(0, 20),
          lastText: c.lastText == null ? null : scrub(c.lastText, 120),
          replied: !!c.replied,
        };
      }),
  };
  if (s.creds && typeof s.creds === 'object') out.creds = s.creds; // relay only; stripped for display
  return out;
}
// Display-safe projection: normalized AND with credentials removed. Every surface that leaves the
// process (web panel /api/fleet, MCP fleet_status result, `fleet status --json`) MUST use this.
function sanitizeStatus(s) {
  const n = normalizeStatus(s);
  if (n) delete n.creds;
  return n;
}

function readFleet(ctx, b) {
  return b
    .list('.status.enc')
    .slice(0, MAX_STATUS_FILES)
    .map(function (n) {
      const s = normalizeStatus(b.read(n));
      if (!s) return null;
      // bind the claimed id to the filename: a status in <id>.status.enc must claim <id> (no spoofing
      // another machine's identity in the roster, which could misdirect a switch/send-account).
      let expect;
      try {
        expect = statusName(s.machineId);
      } catch (e) {
        return null;
      }
      return expect === n ? s : null;
    })
    .filter(Boolean);
}

// ---- command queue (per-machine inbox) ----
function queue(ctx, b, targetMachineId, command) {
  if (!safeId(targetMachineId)) throw new Error('invalid target machine id');
  const cmd = Object.assign({ id: crypto.randomBytes(8).toString('hex'), from: b.machineId, at: ctx.now() }, command);
  cmd.to = targetMachineId; // bind the recipient INTO the signature (set after assign so it can't be overridden)
  signCommand(ctx, cmd); // sign with this machine's private key so the target can verify the origin
  const inbox = b.read(inboxName(targetMachineId)) || [];
  inbox.push(cmd);
  b.write(inboxName(targetMachineId), inbox);
  return cmd;
}
function readInbox(ctx, b) {
  const inbox = b.read(inboxName(b.machineId));
  return Array.isArray(inbox) ? inbox : [];
}
function clearInbox(ctx, b) {
  b.remove(inboxName(b.machineId));
}

// ---- PAIRING (invite + one-time code) --------------------------------------------------------
// Adding a machine must be a two-sided, deliberate act, not a side effect of publishing into the
// folder. The code IS the shared secret that both proves "you invited me" and carries integrity:
//   * `invite` mints a short one-time code, shows it to the user ONCE, and drops an INVITE file that
//     is ENCRYPTED WITH THE CODE (sync.encrypt) — so only a machine that was GIVEN the code can open
//     it and learn the inviter's real public key. Nothing pins on first sight.
//   * `join --code` opens that invite with the code, PINS the inviter (the code proves this key is
//     the inviter's), and writes back a JOIN file ALSO encrypted with the code, this time carrying
//     the joiner's public key.
//   * on the next `push`, the inviter opens the JOIN file with the SAME code and pins the joiner.
// Both sides end up pinned, each only after presenting the code — no passphrase-only forgery, no
// silent auto-trust. The code is never stored in cleartext (only inside these code-encrypted files),
// expires, and is consumed (the invite file is removed) once a join is accepted.
function invitePath(b, inviterId) {
  return 'pair-' + inviterId + '.invite.enc';
}
function joinPath(b, inviterId) {
  return 'pair-' + inviterId + '.join.enc';
}
// Random 32-bit nonce, hex — mixed into the code so two invites never collide.
function pairingNonce() {
  return crypto.randomBytes(4).toString('hex');
}

// Step 1 (inviter): mint a code + write the code-encrypted invite. Returns the code to SHOW the user
// (it is never written anywhere in cleartext; it is the only way to open the invite).
function invite(ctx, b, opts) {
  opts = opts || {};
  const me = identity(ctx);
  const code = String(opts.code || '')
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '');
  if (code.length < 6) throw new Error('a pairing code of at least 6 characters is required');
  const invite = {
    v: 1,
    kind: 'fleet-invite',
    hostId: me.machineId,
    hostName: scrub(me.name, 80),
    hostPub: publicKey(ctx), // pinned by the joiner ONLY after the code opens this file
    at: ctx.now(),
    // A caller-supplied ttl is honored verbatim (a NON-positive value mints an already-expired
    // invite, which the tests use); otherwise the default 15-minute window applies.
    exp: Date.now() + (typeof opts.ttlMs === 'number' ? opts.ttlMs : 15 * 60 * 1000),
    nonce: pairingNonce(),
  };
  const _s = _sync;
  // Raw write: this file is encrypted with the CODE, not the fleet passphrase (bus.write would
  // double-encrypt). Nothing here is ever plaintext in the folder.
  b.rawWrite(invitePath(b, me.machineId), _s.encrypt(JSON.stringify(invite), code));
  // A stale JOIN from an earlier attempt must not be accepted against a fresh invite.
  b.remove(joinPath(b, me.machineId));
  return { code: code, hostId: me.machineId, exp: invite.exp };
}

// Step 2 (joiner): open an inviter's invite with the code, PIN the inviter, and write the join back
// (also code-encrypted). Returns { hostId, hostName, hostPub } on success; throws on a wrong/expired
// code or a missing invite.
function join(ctx, b, opts) {
  opts = opts || {};
  const code = String(opts.code || '')
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '');
  if (code.length < 6) throw new Error('a pairing code is required');
  const hostId = String(opts.hostId || '');
  if (!safeId(hostId)) throw new Error('the inviter machine id is required (from `fleet invite`)');
  const _s = _sync;
  const envelope = b.rawRead(invitePath(b, hostId)); // ENCRYPTED WITH THE CODE, not the passphrase
  if (!envelope) throw new Error('no invite from ' + hostId + ' in the rendezvous folder');
  let inv = null;
  try {
    inv = JSON.parse(_s.decrypt(envelope, code));
  } catch (e) {
    throw new Error('wrong code (or no invite from ' + hostId + ')');
  }
  if (!inv || inv.kind !== 'fleet-invite' || inv.hostId !== hostId) throw new Error('invite is malformed');
  if (!(inv.exp > Date.now())) throw new Error('this invite has expired — ask for a fresh `fleet invite`');
  if (!isPubB64(inv.hostPub)) throw new Error('invite carries no usable host key');
  // The code opened a file that names hostId and its key → that key is genuinely the inviter's. Pin it.
  trustKey(ctx, hostId, inv.hostPub);
  const me = identity(ctx);
  const back = {
    v: 1,
    kind: 'fleet-join',
    id: me.machineId,
    name: scrub(me.name, 80),
    pub: publicKey(ctx),
    at: ctx.now(),
    nonce: inv.nonce,
  };
  b.rawWrite(joinPath(b, hostId), _s.encrypt(JSON.stringify(back), code));
  return { hostId: hostId, hostName: inv.hostName, hostPub: inv.hostPub };
}

// Step 3 (inviter, on the next push): open join files with the SAME code and pin the joiners.
// `codes` maps hostId -> code (the caller still holds the code it minted). Anything that does not
// open with a known code is left alone (a stranger cannot get pinned by writing a file).
function acceptJoins(ctx, b, codes) {
  codes = codes || {};
  const me = identity(ctx);
  const pinned = [],
    rejected = [];
  Object.keys(codes).forEach(function (hostId) {
    if (hostId !== me.machineId) return; // only MY invites
    const _s = _sync;
    const envelope = b.rawRead(joinPath(b, me.machineId)); // code-encrypted raw envelope
    if (!envelope) return;
    let j = null;
    try {
      j = JSON.parse(_s.decrypt(envelope, codes[hostId]));
    } catch (e) {
      rejected.push({ hostId: hostId, reason: 'join did not open with the invite code' });
      return;
    }
    if (!j || j.kind !== 'fleet-join' || !safeId(j.id) || !isPubB64(j.pub)) {
      rejected.push({ hostId: hostId, reason: 'malformed join' });
      return;
    }
    trustKey(ctx, j.id, j.pub); // the code proves this joiner was invited
    pinned.push({ machineId: j.id, name: scrub(j.name, 80) || j.id });
    b.remove(joinPath(b, me.machineId)); // consumed — one-time
    b.remove(invitePath(b, me.machineId));
  });
  return { pinned: pinned, rejected: rejected };
}

// ---- replay protection ----
// The rendezvous is only semi-trusted (shared passphrase + write access). Even though the inbox is
// cleared after processing, a hostile peer can RE-INJECT a captured command. So we (1) reject
// commands older than a max age and (2) remember applied command ids and never re-run one. The
// ledger is a bounded, per-machine file — never an account (see profiles.RESERVED_FILES).
function appliedPath(ctx) {
  return path.join(ctx.configDir, 'fleet-applied.json');
}
function loadApplied(ctx) {
  try {
    const a = JSON.parse(fs.readFileSync(appliedPath(ctx), 'utf8'));
    return a && Array.isArray(a.ids) ? a.ids : [];
  } catch (e) {
    return [];
  }
}
function wasApplied(ctx, id) {
  return !!id && loadApplied(ctx).indexOf(id) !== -1;
}
function markApplied(ctx, id) {
  if (!id) return;
  let ids = loadApplied(ctx);
  if (ids.indexOf(id) !== -1) return;
  ids.push(id);
  if (ids.length > 1000) ids = ids.slice(-1000); // bounded ledger
  try {
    _fsutil.atomicWrite(appliedPath(ctx), JSON.stringify({ ids: ids }), 0o600);
  } catch (e) {
    /* best-effort */
  }
}
const CMD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ignore inbox commands older than a week
function commandFresh(ctx, cmd) {
  if (!cmd || !cmd.at) return true; // legacy/undated command — don't block on age
  const t = Date.parse(cmd.at),
    now = Date.parse(ctx.now());
  if (isNaN(t) || isNaN(now)) return true;
  return now - t <= CMD_MAX_AGE_MS && t - now <= CMD_MAX_AGE_MS; // reject stale AND far-future
}

// Apply a single inbound command. Mutations are gated: opts.allowSwitch / opts.allowSave must be
// true (the caller confirms with the user first). Returns { ok, applied, detail }.
function applyCommand(ctx, cmd, opts) {
  opts = opts || {};
  if (!cmd || !cmd.type) return { ok: false, detail: 'malformed command' };
  // Origin authentication (defence in depth — the CLI/MCP already gate on checkOrigin before the
  // consent prompt): when a sender key is supplied, the signature MUST verify before we mutate.
  if (opts.requireSignature || opts.senderKey) {
    if (!verifyCommand(cmd, opts.senderKey))
      return { ok: false, applied: cmd.type, detail: 'unverified origin (rejected)' };
    if (cmd.to !== identity(ctx).machineId)
      return { ok: false, applied: cmd.type, detail: 'wrong recipient (rejected)' };
  }
  if (cmd.type === 'note')
    return { ok: true, applied: 'note', detail: scrub((cmd.payload && cmd.payload.text) || '', 500) };
  if (cmd.type === 'save-account') {
    if (!opts.allowSave) return { ok: false, applied: 'save-account', detail: 'skipped (needs consent)' };
    const a = cmd.payload && cmd.payload.account;
    if (!a || !a.name || !a.cliCredentials) return { ok: false, detail: 'no account payload' };
    try {
      const transfer = _transfer;
      const r = transfer.applyImport(
        ctx,
        { format: transfer.FORMAT, version: transfer.VERSION, accounts: [a] },
        { force: !!opts.force },
      );
      return {
        ok: true,
        applied: 'save-account',
        detail: r.imported[0] ? 'saved ' + r.imported[0] : 'kept existing ' + a.name,
      };
    } catch (e) {
      return { ok: false, applied: 'save-account', detail: (e && e.message) || 'error' };
    }
  }
  if (cmd.type === 'switch') {
    if (!opts.allowSwitch) return { ok: false, applied: 'switch', detail: 'skipped (needs consent)' };
    const name = cmd.payload && cmd.payload.account;
    const core = _core;
    const resolved = core.resolveProfile(ctx, name);
    if (!resolved) return { ok: false, applied: 'switch', detail: "no such account: '" + name + "'" };
    try {
      core.performSwitch(ctx, resolved);
      return { ok: true, applied: 'switch', detail: 'switched to ' + resolved };
    } catch (e) {
      return { ok: false, applied: 'switch', detail: (e && e.message) || 'error' };
    }
  }
  return { ok: false, detail: 'unknown command type: ' + cmd.type };
}

// Process this machine's inbox exactly as `fleet push` does: replay/expiry checks, origin auth, the
// exec deferral, per-command consent, and clearing what was consumed. Shared by the CLI and the MCP
// `keyflip_fleet_push` tool so the two surfaces cannot drift on a security-sensitive path.
//   opts.reconcile  — a reconcileKeys() result (callers that already accepted joins pass theirs)
//   opts.consent    — optional async (cmd) => { allowSwitch, allowSave }; called only for mutations
//   opts.allowSwitch/allowSave — consent defaults when no callback is supplied (MCP `apply`)
//   opts.force      — overwrite an existing account on save-account
async function processInbox(ctx, b, opts) {
  opts = opts || {};
  const reconcile = opts.reconcile || reconcileKeys(ctx, readFleet(ctx, b));
  const inbox = readInbox(ctx, b);
  const results = [];
  const kept = []; // 'exec' commands belong to `keyflip swarm drain --allow-exec`; leave them queued
  for (let i = 0; i < inbox.length; i++) {
    const cmd = inbox[i];
    if (cmd && cmd.type === 'exec') {
      kept.push(cmd);
      results.push({ ok: false, applied: 'exec', detail: 'deferred → run `keyflip swarm drain --allow-exec`' });
      continue;
    }
    if (cmd && cmd.id && wasApplied(ctx, cmd.id)) {
      results.push({ ok: false, applied: cmd.type, detail: 'skipped (already applied)' });
      continue;
    }
    if (!commandFresh(ctx, cmd)) {
      results.push({ ok: false, applied: cmd && cmd.type, detail: 'skipped (expired)' });
      continue;
    }
    const origin = checkOrigin(ctx, cmd, reconcile);
    if (!origin.ok) {
      results.push({ ok: false, applied: cmd && cmd.type, detail: 'rejected: ' + origin.reason });
      continue;
    }
    let consent = { allowSwitch: !!opts.allowSwitch, allowSave: !!opts.allowSave };
    if (opts.consent && cmd && (cmd.type === 'switch' || cmd.type === 'save-account')) {
      const c = await opts.consent(cmd);
      if (c) consent = { allowSwitch: !!c.allowSwitch, allowSave: !!c.allowSave };
    }
    const allow = {
      allowSwitch: consent.allowSwitch,
      allowSave: consent.allowSave,
      force: !!opts.force,
      senderKey: origin.key,
      requireSignature: true,
    };
    const r = applyCommand(ctx, cmd, allow);
    if (r.ok && cmd.id) markApplied(ctx, cmd.id); // ledger EVERY applied command (incl. notes)
    results.push(r);
  }
  if (kept.length) {
    try {
      b.write(inboxName(b.machineId), kept);
    } catch (e) {
      /* leave inbox as-is */
    }
  } else if (inbox.length) {
    clearInbox(ctx, b);
  }
  return { results: results, reconcile: reconcile };
}

// Pull one account's full credential from a machine's published status (needs it published
// --with-secrets) → an account object suitable for a save-account command.
function accountFrom(status, accountName) {
  const c = status && status.creds && status.creds[accountName];
  if (!c || !c.cliCredentials) return null;
  return {
    name: accountName,
    email: c.email || '',
    oauthAccount: c.oauthAccount || {},
    userID: c.userID || '',
    cliCredentials: c.cliCredentials,
  };
}

// Diff the fleet's chats against the last-seen snapshot to spot NEW replies since last check.
function seenPath(ctx) {
  return path.join(ctx.configDir, 'fleet-seen.json');
}
function newReplies(ctx, statuses) {
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(seenPath(ctx), 'utf8')) || {};
  } catch (e) {
    seen = {};
  }
  const fresh = {};
  const out = [];
  (Array.isArray(statuses) ? statuses : []).forEach(function (s) {
    if (!s || typeof s !== 'object') return;
    const chats = Array.isArray(s.chats) ? s.chats : [];
    chats.forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      const key = String(s.machineId) + '/' + String(c.sessionId);
      fresh[key] = String(c.mtime) + '|' + (c.lastRole || '');
      const prev = seen[key];
      if (c.replied && prev && prev !== fresh[key] && String(prev).split('|')[0] !== String(c.mtime))
        out.push({ machine: s.name, sessionId: c.sessionId, cwd: c.cwd, lastText: c.lastText });
    });
  });
  return { newReplies: out, snapshot: fresh };
}
function saveSeen(ctx, snapshot) {
  try {
    _fsutil.atomicWrite(seenPath(ctx), JSON.stringify(snapshot), 0o600);
  } catch (e) {
    /* ignore */
  }
}

export {
  identity,
  setConfig,
  bus,
  buildStatus,
  publish,
  readFleet,
  normalizeStatus,
  sanitizeStatus,
  machineKeys,
  publicKey,
  signCommand,
  verifyCommand,
  knownKeys,
  reconcileKeys,
  isPinned,
  checkOrigin,
  trustKey,
  fingerprint,
  keyReport,
  queue,
  readInbox,
  clearInbox,
  invite,
  join,
  acceptJoins,
  invitePath,
  joinPath,
  applyCommand,
  processInbox,
  wasApplied,
  markApplied,
  commandFresh,
  accountFrom,
  newReplies,
  saveSeen,
  statusName,
  inboxName,
  safeId,
};
