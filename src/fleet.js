'use strict';
// FLEET: manage every associated keyflip from one place. keyflip is not a daemon, so the fleet
// coordinates through a SHARED RENDEZVOUS folder (a Dropbox/iCloud/WebDAV-synced dir, or any
// path both machines can reach) — every file written there is encrypted with the fleet
// passphrase (via sync.encrypt), so the folder never holds plaintext. Each machine PUBLISHES a
// status (accounts + quota + chat state) and reads an INBOX of commands other machines queued
// for it (switch account, receive a distributed account). This lets machine A, in one screen,
// see B and C, flip B's account, and hand C's account to B.
const fs = require('fs');
const path = require('path');
const os = require('os');

function idPath(ctx) { return path.join(ctx.configDir, 'fleet.json'); }

// Stable per-machine identity (hostname + a random suffix), created once. Also holds the
// configured fleet name + rendezvous dir. The passphrase is NEVER stored (supplied per command).
function identity(ctx) {
  let id = {};
  try { id = JSON.parse(fs.readFileSync(idPath(ctx), 'utf8')) || {}; } catch (e) { id = {}; }
  if (!id.machineId) {
    const host = safeHost();
    const suffix = require('crypto').randomBytes(3).toString('hex');
    id.machineId = host + '-' + suffix;
    if (!id.name) id.name = host;
    try { const fsutil = require('./fsutil'); fsutil.atomicWrite(idPath(ctx), JSON.stringify(id, null, 2), 0o600); } catch (e) { /* best-effort */ }
  }
  return id;
}
function safeHost() { try { return String(os.hostname()).split('.')[0].replace(/[^A-Za-z0-9_-]/g, '') || 'machine'; } catch (e) { return 'machine'; } }

// A machine id must be a single SAFE FILENAME SEGMENT — never a path. Peer-supplied ids reach
// filenames (<id>.status.enc / <id>.inbox.enc), so an unvalidated '../' would let a hostile peer
// (the rendezvous folder is only semi-trusted — a shared passphrase + shared write access) write
// or read OUTSIDE the rendezvous dir. Reject anything that isn't a bounded [A-Za-z0-9._-] token.
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
function safeId(x) { return typeof x === 'string' && SAFE_ID.test(x) && x.indexOf('..') === -1; }
// A bus entry name must be a plain basename (no separators, no traversal) — defence in depth.
function nameOk(name) { return typeof name === 'string' && name.length > 0 && name.length <= 96 && name.indexOf('/') === -1 && name.indexOf('\\') === -1 && name.indexOf('\0') === -1 && name !== '.' && name !== '..' && path.basename(name) === name; }
const MAX_ENC_BYTES = 8 * 1024 * 1024; // cap a single peer file (anti-DoS: a hostile huge .enc)
const MAX_STATUS_FILES = 500;          // cap how many peer statuses we process per read
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g; // control chars incl. ANSI ESC — strip from peer strings pre-render
function scrub(s, max) { return String(s == null ? '' : s).replace(CTRL, ' ').slice(0, max || 200); }

function setConfig(ctx, patch) {
  const id = identity(ctx);
  Object.keys(patch || {}).forEach(function (k) { if (patch[k] != null) id[k] = patch[k]; });
  require('./fsutil').atomicWrite(idPath(ctx), JSON.stringify(id, null, 2), 0o600);
  return id;
}

// A rendezvous bus over a directory (later swappable for WebDAV via sync's dav*). Everything is
// encrypted at rest with the fleet passphrase.
function bus(ctx, opts) {
  opts = opts || {};
  const id = identity(ctx);
  const dir = opts.dir || id.dir;
  if (!dir) throw new Error('no fleet rendezvous configured — run `keyflip fleet init --dir <shared-folder>`');
  if (!opts.passphrase) throw new Error('a fleet passphrase is required (--passphrase-file <f>)');
  const sync = require('./sync');
  return {
    dir: dir, machineId: id.machineId, name: id.name,
    write: function (name, obj) { if (!nameOk(name)) throw new Error('unsafe fleet entry name'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, sync.encrypt(JSON.stringify(obj), opts.passphrase), { mode: 0o600 }); try { fs.chmodSync(f, 0o600); } catch (e) { /* non-POSIX */ } },
    read: function (name) { if (!nameOk(name)) return null; const f = path.join(dir, name); try { if (fs.statSync(f).size > MAX_ENC_BYTES) return null; } catch (e) { return null; } let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return null; } try { return JSON.parse(sync.decrypt(raw, opts.passphrase)); } catch (e) { return null; } },
    list: function (suffix) { let ents = []; try { ents = fs.readdirSync(dir); } catch (e) { return []; } return ents.filter(function (n) { return nameOk(n) && n.slice(-suffix.length) === suffix; }); },
    remove: function (name) { if (!nameOk(name)) return; try { fs.rmSync(path.join(dir, name), { force: true }); } catch (e) { /* ignore */ } },
  };
}

function statusName(machineId) { if (!safeId(machineId)) throw new Error('unsafe machine id'); return machineId + '.status.enc'; }
function inboxName(machineId) { if (!safeId(machineId)) throw new Error('unsafe machine id'); return machineId + '.inbox.enc'; }

// Build this machine's status: accounts (+cached quota), the active account, and recent chat
// state (last message role -> replied/waiting). withSecrets also carries the account credentials
// (encrypted in the bus) so another machine can be handed one of them.
function buildStatus(ctx, opts) {
  opts = opts || {};
  const core = require('./core');
  const id = identity(ctx);
  let usageCache = {}; try { usageCache = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8')) || {}; } catch (e) { usageCache = {}; }
  const accounts = safe(function () {
    return core.listProfiles(ctx).map(function (p) {
      const u = usageCache[p.name] && usageCache[p.name].usage;
      return { name: p.name, email: p.email || null, active: !!p.active,
        fiveHourPct: (u && u.fiveHour && typeof u.fiveHour.pct === 'number') ? u.fiveHour.pct : null,
        sevenDayPct: (u && u.sevenDay && typeof u.sevenDay.pct === 'number') ? u.sevenDay.pct : null };
    });
  }, []);
  const chats = safe(function () { return recentChats(ctx, 12); }, []);
  const status = {
    machineId: id.machineId, name: id.name, at: ctx.now(),
    activeEmail: safe(function () { return core.currentEmail(ctx); }, null),
    accounts: accounts, chats: chats,
  };
  if (opts.withSecrets) {
    const creds = {};
    safe(function () { require('./transfer').buildExport(ctx).envelope.accounts.forEach(function (a) { creds[a.name] = { email: a.email, oauthAccount: a.oauthAccount, userID: a.userID, cliCredentials: a.cliCredentials }; }); }, null);
    status.creds = creds;
  }
  return status;
}
function safe(fn, d) { try { return fn(); } catch (e) { return d; } }

// Recent sessions with last-message role (assistant = a reply arrived; user = waiting on Claude).
function recentChats(ctx, limit) {
  const sessions = require('./sessions');
  const transcript = require('./transcript');
  return sessions.list(ctx, { limit: limit }).map(function (r) {
    let lastRole = null, lastText = null;
    try { const msgs = transcript.parse(fs.readFileSync(r.file, 'utf8')).messages; const last = msgs[msgs.length - 1]; if (last) { lastRole = last.role; lastText = String(last.text || '').replace(/\s+/g, ' ').slice(0, 80); } } catch (e) { /* ignore */ }
    return { sessionId: r.sessionId, cwd: r.cwd || null, mtime: r.mtime, lastRole: lastRole, lastText: lastText, replied: lastRole === 'assistant' };
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
    activeEmail: s.activeEmail == null ? null : scrub(s.activeEmail, 200),
    accounts: (Array.isArray(s.accounts) ? s.accounts : []).filter(function (a) { return a && typeof a === 'object'; }).map(function (a) {
      return { name: scrub(a.name, 80), email: a.email == null ? null : scrub(a.email, 200), active: !!a.active,
        fiveHourPct: typeof a.fiveHourPct === 'number' ? a.fiveHourPct : null,
        sevenDayPct: typeof a.sevenDayPct === 'number' ? a.sevenDayPct : null };
    }),
    chats: (Array.isArray(s.chats) ? s.chats : []).filter(function (c) { return c && typeof c === 'object'; }).map(function (c) {
      return { sessionId: scrub(c.sessionId, 120), cwd: c.cwd == null ? null : scrub(c.cwd, 300),
        mtime: typeof c.mtime === 'number' ? c.mtime : (typeof c.mtime === 'string' ? scrub(c.mtime, 40) : null),
        lastRole: c.lastRole == null ? null : String(c.lastRole).replace(/[^\w-]/g, '').slice(0, 20),
        lastText: c.lastText == null ? null : scrub(c.lastText, 120), replied: !!c.replied };
    }),
  };
  if (s.creds && typeof s.creds === 'object') out.creds = s.creds; // relay only; stripped for display
  return out;
}
// Display-safe projection: normalized AND with credentials removed. Every surface that leaves the
// process (web panel /api/fleet, MCP fleet_status result, `fleet status --json`) MUST use this.
function sanitizeStatus(s) { const n = normalizeStatus(s); if (n) delete n.creds; return n; }

function readFleet(ctx, b) {
  return b.list('.status.enc').slice(0, MAX_STATUS_FILES).map(function (n) {
    const s = normalizeStatus(b.read(n));
    if (!s) return null;
    // bind the claimed id to the filename: a status in <id>.status.enc must claim <id> (no spoofing
    // another machine's identity in the roster, which could misdirect a switch/send-account).
    let expect; try { expect = statusName(s.machineId); } catch (e) { return null; }
    return expect === n ? s : null;
  }).filter(Boolean);
}

// ---- command queue (per-machine inbox) ----
function queue(ctx, b, targetMachineId, command) {
  if (!safeId(targetMachineId)) throw new Error('invalid target machine id');
  const cmd = Object.assign({ id: require('crypto').randomBytes(8).toString('hex'), from: b.machineId, at: ctx.now() }, command);
  const inbox = b.read(inboxName(targetMachineId)) || [];
  inbox.push(cmd);
  b.write(inboxName(targetMachineId), inbox);
  return cmd;
}
function readInbox(ctx, b) { const inbox = b.read(inboxName(b.machineId)); return Array.isArray(inbox) ? inbox : []; }
function clearInbox(ctx, b) { b.remove(inboxName(b.machineId)); }

// ---- replay protection ----
// The rendezvous is only semi-trusted (shared passphrase + write access). Even though the inbox is
// cleared after processing, a hostile peer can RE-INJECT a captured command. So we (1) reject
// commands older than a max age and (2) remember applied command ids and never re-run one. The
// ledger is a bounded, per-machine file — never an account (see profiles.RESERVED_FILES).
function appliedPath(ctx) { return path.join(ctx.configDir, 'fleet-applied.json'); }
function loadApplied(ctx) { try { const a = JSON.parse(fs.readFileSync(appliedPath(ctx), 'utf8')); return (a && Array.isArray(a.ids)) ? a.ids : []; } catch (e) { return []; } }
function wasApplied(ctx, id) { return !!id && loadApplied(ctx).indexOf(id) !== -1; }
function markApplied(ctx, id) {
  if (!id) return;
  let ids = loadApplied(ctx);
  if (ids.indexOf(id) !== -1) return;
  ids.push(id);
  if (ids.length > 1000) ids = ids.slice(-1000); // bounded ledger
  try { require('./fsutil').atomicWrite(appliedPath(ctx), JSON.stringify({ ids: ids }), 0o600); } catch (e) { /* best-effort */ }
}
const CMD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // ignore inbox commands older than a week
function commandFresh(ctx, cmd) {
  if (!cmd || !cmd.at) return true; // legacy/undated command — don't block on age
  const t = Date.parse(cmd.at), now = Date.parse(ctx.now());
  if (isNaN(t) || isNaN(now)) return true;
  return (now - t) <= CMD_MAX_AGE_MS && (t - now) <= CMD_MAX_AGE_MS; // reject stale AND far-future
}

// Apply a single inbound command. Mutations are gated: opts.allowSwitch / opts.allowSave must be
// true (the caller confirms with the user first). Returns { ok, applied, detail }.
function applyCommand(ctx, cmd, opts) {
  opts = opts || {};
  if (!cmd || !cmd.type) return { ok: false, detail: 'malformed command' };
  if (cmd.type === 'note') return { ok: true, applied: 'note', detail: scrub((cmd.payload && cmd.payload.text) || '', 500) };
  if (cmd.type === 'save-account') {
    if (!opts.allowSave) return { ok: false, applied: 'save-account', detail: 'skipped (needs consent)' };
    const a = cmd.payload && cmd.payload.account;
    if (!a || !a.name || !a.cliCredentials) return { ok: false, detail: 'no account payload' };
    try {
      const transfer = require('./transfer');
      const r = transfer.applyImport(ctx, { format: transfer.FORMAT, version: transfer.VERSION, accounts: [a] }, { force: !!opts.force });
      return { ok: true, applied: 'save-account', detail: (r.imported[0] ? 'saved ' + r.imported[0] : 'kept existing ' + a.name) };
    } catch (e) { return { ok: false, applied: 'save-account', detail: (e && e.message) || 'error' }; }
  }
  if (cmd.type === 'switch') {
    if (!opts.allowSwitch) return { ok: false, applied: 'switch', detail: 'skipped (needs consent)' };
    const name = cmd.payload && cmd.payload.account;
    const core = require('./core');
    const resolved = core.resolveProfile(ctx, name);
    if (!resolved) return { ok: false, applied: 'switch', detail: "no such account: '" + name + "'" };
    try { core.performSwitch(ctx, resolved); return { ok: true, applied: 'switch', detail: 'switched to ' + resolved }; }
    catch (e) { return { ok: false, applied: 'switch', detail: (e && e.message) || 'error' }; }
  }
  return { ok: false, detail: 'unknown command type: ' + cmd.type };
}

// Pull one account's full credential from a machine's published status (needs it published
// --with-secrets) → an account object suitable for a save-account command.
function accountFrom(status, accountName) {
  const c = status && status.creds && status.creds[accountName];
  if (!c || !c.cliCredentials) return null;
  return { name: accountName, email: c.email || '', oauthAccount: c.oauthAccount || {}, userID: c.userID || '', cliCredentials: c.cliCredentials };
}

// Diff the fleet's chats against the last-seen snapshot to spot NEW replies since last check.
function seenPath(ctx) { return path.join(ctx.configDir, 'fleet-seen.json'); }
function newReplies(ctx, statuses) {
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(seenPath(ctx), 'utf8')) || {}; } catch (e) { seen = {}; }
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
      if (c.replied && prev && prev !== fresh[key] && String(prev).split('|')[0] !== String(c.mtime)) out.push({ machine: s.name, sessionId: c.sessionId, cwd: c.cwd, lastText: c.lastText });
    });
  });
  return { newReplies: out, snapshot: fresh };
}
function saveSeen(ctx, snapshot) { try { require('./fsutil').atomicWrite(seenPath(ctx), JSON.stringify(snapshot), 0o600); } catch (e) { /* ignore */ } }

module.exports = {
  identity: identity, setConfig: setConfig, bus: bus,
  buildStatus: buildStatus, publish: publish, readFleet: readFleet,
  normalizeStatus: normalizeStatus, sanitizeStatus: sanitizeStatus,
  queue: queue, readInbox: readInbox, clearInbox: clearInbox, applyCommand: applyCommand,
  wasApplied: wasApplied, markApplied: markApplied, commandFresh: commandFresh,
  accountFrom: accountFrom, newReplies: newReplies, saveSeen: saveSeen,
  statusName: statusName, inboxName: inboxName, safeId: safeId,
};
