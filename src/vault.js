'use strict';
// EXTERNAL SECRET BACKEND: keep saved keyflip credentials in a real secret
// manager — 1Password (`op`), Bitwarden (`bw`) or HashiCorp Vault (`vault`) —
// instead of (or beside) the OS keychain. Each backend is driven through its
// own CLI, and the CLI runner is INJECTED (opts.run, default ./exec.run) so the
// tests never spawn a real vault. This is OPT-IN: the parent decides whether to
// wire makeStore() into createStore() behind a config flag; the chosen backend
// is recorded in <configDir>/vault.json.
//
// Invariants (mirrors stores/keychain.js): a secret NEVER appears on argv — it
// travels on the child's stdin (op: item template; bw: base64 item; vault:
// `credential=-`). A secret is NEVER logged, echoed or returned except as the
// value asked for by get(). A locked/absent/unauthenticated vault fails LOUDLY
// with a clear, actionable Error (code 'EVAULT') instead of a silent miss.
const path = require('path');
const profiles = require('./profiles');
const { atomicWrite, readJsonForWrite } = require('./fsutil');

const defaultRun = require('./exec').run;

// Canonical backend ids, in probe/display order. A frozen array + indexOf gives
// a pollution-safe membership test for a user-supplied provider name.
const PROV_IDS = Object.freeze(['op', 'bw', 'vault']);
function isProvider(x) { return typeof x === 'string' && PROV_IDS.indexOf(x) !== -1; }

const OP_VAULT_DEFAULT = 'Private';   // 1Password personal vault
const VAULT_MOUNT_DEFAULT = 'secret'; // HashiCorp kv mount
const NS = 'keyflip/';                // item namespace: keyflip/<name>
const FIELD = 'credential';           // field/notes key holding the blob

const PROBE_TIMEOUT_MS = 5000;        // a `--version` must never hang the CLI
const OP_TIMEOUT_MS = 15000;          // a locked vault waiting on a prompt must not hang forever

const confirmProp = { confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' } };
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

// ---- errors ----------------------------------------------------------------
function vaultError(msg) { const e = new Error(msg); e.code = 'EVAULT'; return e; }
// Strip control chars (incl. ANSI ESC) and collapse whitespace from a CLI's
// stderr before it reaches an error message. The secret went in on stdin, so it
// can't be in stderr — but scrubbing keeps errors tidy and non-injective.
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g;
function cleanErr(r) {
  const raw = ((r && r.stderr) || '') || ((r && r.stdout) || '');
  return String(raw).replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function errText(r) { return (((r && r.stderr) || '') + '\n' + ((r && r.stdout) || '')); }
function stripNl(s) { return String(s == null ? '' : s).replace(/\r?\n$/, ''); }
function firstLine(s) { return String(s == null ? '' : s).split(/\r?\n/)[0].trim(); }

function absentError(meta) { return vaultError(meta.label + " CLI ('" + meta.bin + "') not found — install it, or pick another backend with `keyflip vault use <op|bw|vault>`"); }
function timeoutError(meta) { return vaultError(meta.label + ' timed out (locked, or waiting on an interactive prompt?) — ' + meta.hint); }
function lockedError(meta, r) { const d = cleanErr(r); return vaultError(meta.label + ' is locked or not authenticated — ' + meta.hint + (d ? ' (' + d + ')' : '')); }
function opFailed(meta, action, r) { return vaultError(meta.label + ' ' + action + ' failed: ' + (cleanErr(r) || ('exit ' + (r && r.code)))); }

// ---- provider adapters -----------------------------------------------------
// Each adapter's methods take an `io` = { run, settings, timeoutMs, meta } and a
// pre-validated profile name, and return the store value (or throw a clear
// error). invoke() is the single spawn point: it turns a failed/absent/timed-out
// spawn into a taxonomised Error so every method sees a normalized result.
function invoke(io, args, input) {
  let r;
  try { r = io.run(io.meta.bin, args, input, { timeoutMs: io.timeoutMs }); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.errno === 'ENOENT')) throw absentError(io.meta);
    throw vaultError(io.meta.label + ' could not be run: ' + ((e && e.message) || 'spawn failed'));
  }
  r = r || {};
  if (r.error && (r.error.code === 'ENOENT' || r.error.errno === 'ENOENT')) throw absentError(io.meta);
  if (r.timedOut) throw timeoutError(io.meta);
  return r;
}

function parseJsonArray(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
// De-namespace + validate a set of candidate item labels into sorted profile
// names. The dedupe set is a NULL-PROTOTYPE map so a returned title like
// "keyflip/__proto__" can never pollute a prototype during the scan.
function namesFrom(candidates, strip) {
  const out = []; const seen = Object.create(null);
  (candidates || []).forEach(function (c) {
    if (typeof c !== 'string') return;
    let n = c;
    if (strip) { if (n.indexOf(NS) !== 0) return; n = n.slice(NS.length); }
    n = n.replace(/\/$/, ''); // vault kv list yields "name" (or "name/" for subtrees)
    if (profiles.isValidName(n) && !seen[n]) { seen[n] = true; out.push(n); }
  });
  return out.sort();
}

// -- 1Password (op) --
// Secret path: WRITE feeds a full item template (with the concealed field) on
// stdin via `--template=/dev/stdin`; READ uses `op read op://…` whose reference
// is not a secret. Upsert = best-effort delete + create (op create rejects a
// duplicate title). NOTE: `/dev/stdin` is POSIX (macOS/Linux); on Windows use
// bw/vault. The blob never touches argv on any platform.
function opGet(io, name) {
  // Read the field by LOOKING UP THE ITEM BY ITS LITERAL TITLE (which contains a '/'), not via an
  // `op://…` reference — in op's reference grammar '/' is the path separator, so
  // `op://vault/keyflip/<name>/credential` mis-parses (item="keyflip", section="<name>") and never
  // finds the item titled "keyflip/<name>". `op item get <title> --fields …` takes the title literally.
  const r = invoke(io, ['item', 'get', NS + name, '--vault', io.settings.vault, '--fields', 'label=' + FIELD, '--reveal'], undefined);
  if (r.code === 0) return stripNl(r.stdout);
  const t = errText(r);
  if (io.meta.lockedRe.test(t)) throw lockedError(io.meta, r);
  if (io.meta.missRe.test(t)) return null;
  throw opFailed(io.meta, 'read', r);
}
function opDel(io, name) {
  const r = invoke(io, ['item', 'delete', NS + name, '--vault', io.settings.vault], undefined);
  if (r.code === 0) return true;
  const t = errText(r);
  if (io.meta.lockedRe.test(t)) throw lockedError(io.meta, r);
  if (io.meta.missRe.test(t)) return false; // already gone => idempotent
  throw opFailed(io.meta, 'delete', r);
}
function opSet(io, name, blob) {
  try { opDel(io, name); } catch (e) { /* best effort; create below surfaces the real state (e.g. locked) */ }
  const tmpl = JSON.stringify({
    title: NS + name, category: 'PASSWORD', vault: { name: io.settings.vault },
    fields: [{ id: FIELD, type: 'CONCEALED', label: FIELD, value: blob }],
  });
  const r = invoke(io, ['item', 'create', '--template=/dev/stdin'], tmpl);
  if (r.code === 0) return true;
  if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r);
  throw opFailed(io.meta, 'write', r);
}
function opList(io) {
  const r = invoke(io, ['item', 'list', '--vault', io.settings.vault, '--format=json'], undefined);
  if (r.code !== 0) { if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r); throw opFailed(io.meta, 'list', r); }
  return namesFrom(parseJsonArray(r.stdout).map(function (it) { return it && it.title; }), true);
}

// -- Bitwarden (bw) --
// Secret path: the blob is the item's secureNote NOTES; WRITE pipes the
// base64-encoded item template on stdin (the standard `bw encode | bw create`
// flow, done in-process so nothing lands on argv). Auth comes from BW_SESSION in
// the inherited environment.
function bwId(io, name) {
  const r = invoke(io, ['get', 'item', NS + name], undefined);
  if (r.code === 0) { try { const it = JSON.parse(r.stdout); return it && typeof it.id === 'string' ? it.id : null; } catch (e) { return null; } }
  const t = errText(r);
  if (io.meta.lockedRe.test(t)) throw lockedError(io.meta, r);
  if (/more than one/i.test(t)) throw opFailed(io.meta, 'lookup (ambiguous item name)', r);
  if (io.meta.missRe.test(t)) return null;
  throw opFailed(io.meta, 'lookup', r);
}
function bwGet(io, name) {
  const r = invoke(io, ['get', 'notes', NS + name], undefined);
  if (r.code === 0) return stripNl(r.stdout);
  const t = errText(r);
  if (io.meta.lockedRe.test(t)) throw lockedError(io.meta, r);
  if (/more than one/i.test(t)) throw opFailed(io.meta, 'read (ambiguous item name)', r);
  if (io.meta.missRe.test(t)) return null;
  throw opFailed(io.meta, 'read', r);
}
function bwSet(io, name, blob) {
  const id = bwId(io, name);
  const tmpl = { organizationId: null, folderId: null, type: 2, name: NS + name, notes: blob, secureNote: { type: 0 } };
  const b64 = Buffer.from(JSON.stringify(tmpl), 'utf8').toString('base64'); // carries the secret; stdin only
  const args = id ? ['edit', 'item', id] : ['create', 'item'];
  const r = invoke(io, args, b64);
  if (r.code === 0) return true;
  if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r);
  throw opFailed(io.meta, id ? 'update' : 'create', r);
}
function bwDel(io, name) {
  const id = bwId(io, name);
  if (!id) return false;
  const r = invoke(io, ['delete', 'item', id], undefined);
  if (r.code === 0) return true;
  if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r);
  if (io.meta.missRe.test(errText(r))) return false;
  throw opFailed(io.meta, 'delete', r);
}
function bwList(io) {
  const r = invoke(io, ['list', 'items', '--search', NS], undefined);
  if (r.code !== 0) { if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r); throw opFailed(io.meta, 'list', r); }
  return namesFrom(parseJsonArray(r.stdout).map(function (it) { return it && it.name; }), true);
}

// -- HashiCorp Vault (vault) --
// Secret path: `vault kv put <mount>/keyflip/<name> credential=-` reads the
// field VALUE from stdin (the `-` sentinel), so the blob never hits argv. Auth
// comes from VAULT_ADDR/VAULT_TOKEN in the inherited environment.
function vPath(io, name) { return io.settings.mount + '/' + NS + name; }
function vGet(io, name) {
  const r = invoke(io, ['kv', 'get', '-field=' + FIELD, vPath(io, name)], undefined);
  if (r.code === 0) return stripNl(r.stdout);
  const t = errText(r);
  if (io.meta.lockedRe.test(t)) throw lockedError(io.meta, r);
  if (io.meta.missRe.test(t)) return null;
  throw opFailed(io.meta, 'read', r);
}
function vSet(io, name, blob) {
  const r = invoke(io, ['kv', 'put', vPath(io, name), FIELD + '=-'], blob);
  if (r.code === 0) return true;
  if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r);
  throw opFailed(io.meta, 'write', r);
}
function vDel(io, name) {
  const r = invoke(io, ['kv', 'delete', vPath(io, name)], undefined);
  if (r.code === 0) return true;
  if (io.meta.lockedRe.test(errText(r))) throw lockedError(io.meta, r);
  if (io.meta.missRe.test(errText(r))) return false;
  throw opFailed(io.meta, 'delete', r);
}
function vList(io) {
  const r = invoke(io, ['kv', 'list', '-format=json', io.settings.mount + '/' + NS.replace(/\/$/, '')], undefined);
  if (r.code !== 0) {
    const t = errText(r);
    if (io.meta.lockedRe.test(t)) throw lockedError(io.meta, r);
    if (io.meta.missRe.test(t)) return []; // empty path => no items yet
    throw opFailed(io.meta, 'list', r);
  }
  return namesFrom(parseJsonArray(r.stdout), false);
}

// Adapter registry — a NULL-PROTOTYPE map so PROVIDERS[userInput] can never
// resolve to an inherited property. Always gate a lookup on isProvider() first.
const PROVIDERS = Object.create(null);
PROVIDERS.op = {
  bin: 'op', label: '1Password', probeArgs: ['--version'],
  hint: "run `op signin` (or set OP_SERVICE_ACCOUNT_TOKEN)",
  lockedRe: /sign ?in|signed ?in|session (has )?expired|session .*invalid|not currently signed|no account found|unauthor|authoriz/i,
  missRe: /isn'?t an item|not found|no items? |couldn'?t find|could not find|doesn'?t exist|no such/i,
  get: opGet, set: opSet, del: opDel, list: opList,
};
PROVIDERS.bw = {
  bin: 'bw', label: 'Bitwarden', probeArgs: ['--version'],
  hint: "run `bw unlock` and export BW_SESSION",
  lockedRe: /vault is locked|you are not logged in|not logged in|session key|bw_session|master password|mac failed|invalid master/i,
  missRe: /not found/i,
  get: bwGet, set: bwSet, del: bwDel, list: bwList,
};
PROVIDERS.vault = {
  bin: 'vault', label: 'HashiCorp Vault', probeArgs: ['version'],
  hint: "check VAULT_ADDR/VAULT_TOKEN and that the vault is unsealed",
  lockedRe: /vault is sealed|permission denied|missing client token|no vault token|invalid token|connection refused|error checking seal|code:\s*403|code:\s*503|dial tcp|x509/i,
  missRe: /no value found|not found|no secret|secret not found/i,
  get: vGet, set: vSet, del: vDel, list: vList,
};

// ---- detection -------------------------------------------------------------
// probe: is a single backend's CLI installed + responsive? (Availability, not
// unlockedness — a `--version` succeeds even when the vault is locked.)
function probe(provider, opts) {
  opts = opts || {};
  if (!isProvider(provider)) return { ok: false, reason: "unknown backend '" + provider + "'" };
  const run = opts.run || defaultRun;
  const meta = PROVIDERS[provider];
  let r;
  try { r = run(meta.bin, meta.probeArgs, undefined, { timeoutMs: opts.timeoutMs || PROBE_TIMEOUT_MS }); }
  catch (e) { if (e && (e.code === 'ENOENT' || e.errno === 'ENOENT')) return { ok: false, reason: meta.bin + ' not installed' }; return { ok: false, reason: (e && e.message) || 'spawn failed' }; }
  r = r || {};
  if (r.error && (r.error.code === 'ENOENT' || r.error.errno === 'ENOENT')) return { ok: false, reason: meta.bin + ' not installed' };
  if (r.timedOut) return { ok: false, reason: 'probe timed out' };
  if (r.code === 0) return { ok: true, version: firstLine(r.stdout) || null };
  return { ok: false, reason: cleanErr(r) || ('exit ' + r.code) };
}
// detect: which of ['op','bw','vault'] is available on this machine, in order.
function detect(opts) {
  opts = opts || {};
  const run = opts.run || defaultRun;
  const out = [];
  PROV_IDS.forEach(function (id) { if (probe(id, { run: run, timeoutMs: opts.timeoutMs }).ok) out.push(id); });
  return out;
}

// ---- persisted state (<configDir>/vault.json) ------------------------------
function statePath(ctx) { return path.join(ctx.configDir, 'vault.json'); }
function defaultSettings() { return { vault: OP_VAULT_DEFAULT, mount: VAULT_MOUNT_DEFAULT }; }
// A settings value flows into an item reference/path as one argv token, so keep
// it to a bounded, boring charset (no control chars, no newlines).
function safeSetting(s) { return typeof s === 'string' && /^[A-Za-z0-9 ._/-]{1,64}$/.test(s); }
function normalizeState(raw) {
  const s = { backend: null, settings: defaultSettings(), updatedAt: null };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (isProvider(raw.backend)) s.backend = raw.backend;
    if (typeof raw.updatedAt === 'string') s.updatedAt = raw.updatedAt;
    if (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
      if (safeSetting(raw.settings.vault)) s.settings.vault = raw.settings.vault;
      if (safeSetting(raw.settings.mount)) s.settings.mount = raw.settings.mount;
    }
  }
  return s;
}
// Guarded read (never throws): missing OR corrupt => defaults. The state file
// holds only a backend CHOICE (never a secret), so defaulting on a hand-mangled
// file is safe — it just means "no external backend yet".
function readState(ctx) {
  let raw;
  try { raw = readJsonForWrite(statePath(ctx)); } catch (e) { return normalizeState(null); }
  return normalizeState(raw);
}
function writeState(ctx, st) {
  const out = { backend: st.backend || null, settings: st.settings || defaultSettings(), updatedAt: st.updatedAt || null };
  atomicWrite(statePath(ctx), JSON.stringify(out, null, 2), 0o600);
  return out;
}

// ---- store factory ---------------------------------------------------------
function mergeSettings(base, over) {
  const s = { vault: (base && base.vault) || OP_VAULT_DEFAULT, mount: (base && base.mount) || VAULT_MOUNT_DEFAULT };
  if (over && typeof over === 'object') {
    if (safeSetting(over.vault)) s.vault = over.vault;
    if (safeSetting(over.mount)) s.mount = over.mount;
  }
  return s;
}
function reqName(name) {
  if (!profiles.isValidName(name)) throw vaultError("invalid credential name: '" + name + "'");
  return name;
}
function blobStr(blob) {
  if (blob == null) throw vaultError('refusing to store an empty credential blob');
  return String(blob);
}
function liveUnsupported() { throw vaultError('the external vault backend stores saved profiles only — the live credential stays in the OS keychain / credentials file'); }

// makeStore(ctx, {provider, run, settings}) -> a Store-compatible object mapping
// keyflip profile creds to the backend's item schema (items namespaced
// keyflip/<name>, blob in the `credential` field). Primary interface is
// get/set/del/list; getProfile/setProfile/delProfile are aliases so the parent
// can drop this straight into createStore() for saved profiles.
function makeStore(ctx, opts) {
  opts = opts || {};
  const provider = opts.provider;
  if (!isProvider(provider)) throw vaultError("makeStore: unknown vault backend '" + provider + "' (choose one of: " + PROV_IDS.join(', ') + ')');
  const st = readState(ctx);
  const io = {
    run: opts.run || (ctx && ctx.run) || defaultRun, // ctx.run: injection channel for the MCP path (ctx-only callers)
    settings: mergeSettings(st.settings, opts.settings),
    timeoutMs: opts.timeoutMs || OP_TIMEOUT_MS,
    meta: PROVIDERS[provider],
  };
  return {
    type: 'vault', provider: provider, label: io.meta.label,
    get: function (name) { return io.meta.get(io, reqName(name)); },
    set: function (name, blob) { return io.meta.set(io, reqName(name), blobStr(blob)); },
    del: function (name) { return io.meta.del(io, reqName(name)); },
    list: function () { return io.meta.list(io); },
    getProfile: function (name) { return io.meta.get(io, reqName(name)); },
    setProfile: function (name, blob) { return io.meta.set(io, reqName(name), blobStr(blob)); },
    delProfile: function (name) { return io.meta.del(io, reqName(name)); },
    getLive: liveUnsupported, setLive: liveUnsupported, delLive: liveUnsupported,
  };
}

// ---- high-level operations (CLI + MCP share these) -------------------------
function status(ctx, opts) {
  opts = opts || {};
  const run = opts.run || (ctx && ctx.run) || defaultRun;
  const st = readState(ctx);
  const doProbe = opts.probe !== false;
  const available = doProbe ? detect({ run: run, timeoutMs: opts.timeoutMs }) : null;
  return {
    backend: st.backend,
    configured: !!st.backend,
    backendLabel: st.backend ? PROVIDERS[st.backend].label : null,
    backendAvailable: (st.backend && available) ? (available.indexOf(st.backend) !== -1) : null,
    available: available,
    settings: st.settings,
    updatedAt: st.updatedAt,
  };
}
function use(ctx, provider, opts) {
  opts = opts || {};
  const run = opts.run || (ctx && ctx.run) || defaultRun;
  if (!isProvider(provider)) throw vaultError("unknown vault backend '" + provider + "' — choose one of: " + PROV_IDS.join(', '));
  if (!opts.force) {
    const p = probe(provider, { run: run, timeoutMs: opts.timeoutMs });
    if (!p.ok) throw vaultError(PROVIDERS[provider].label + ' is not available: ' + p.reason + ' — install/authenticate it, or pass force to record it anyway');
  }
  const st = readState(ctx);
  st.backend = provider;
  st.updatedAt = ctx.now();
  writeState(ctx, st);
  return { backend: provider, backendLabel: PROVIDERS[provider].label, updatedAt: st.updatedAt, settings: st.settings };
}
function off(ctx) {
  const st = readState(ctx);
  const previous = st.backend;
  st.backend = null;
  st.updatedAt = ctx.now();
  writeState(ctx, st);
  return {
    backend: null, previous: previous, updatedAt: st.updatedAt,
    note: 'External vault backend disabled. Anything already stored in the external vault was left untouched.',
  };
}

// ---- CLI dispatch ----------------------------------------------------------
// The parent's cmdVault(ctx, rest) can be a one-liner over this. Returns
// { action, data, lines } — `lines` are ready-to-print strings, `data` is the
// structured payload for --json. IO is injected via opts.run (tests need no
// subprocess); nothing here echoes a secret.
function statusLines(s) {
  const lines = [];
  if (!s.configured) lines.push('External secret backend: OFF (credentials use the OS keychain / credentials file).');
  else lines.push('External secret backend: ' + s.backendLabel + ' (' + s.backend + ')' +
    (s.backendAvailable === false ? '  [CLI not available right now]' : ''));
  if (Array.isArray(s.available)) lines.push('Available backends: ' + (s.available.length ? s.available.join(', ') : '(none detected)'));
  return lines;
}
function cli(ctx, rest, opts) {
  opts = opts || {};
  rest = Array.isArray(rest) ? rest : [];
  const run = opts.run || (ctx && ctx.run) || defaultRun;
  const sub = rest[0] || 'status';
  if (sub === 'status') {
    const s = status(ctx, { run: run });
    return { action: 'status', data: s, lines: statusLines(s) };
  }
  if (sub === 'use') {
    const provider = rest.filter(function (a) { return a.indexOf('-') !== 0; })[1];
    const force = rest.indexOf('--force') !== -1;
    if (!provider) throw vaultError('usage: keyflip vault use <op|bw|vault> [--force]');
    const s = use(ctx, provider, { run: run, force: force });
    return { action: 'use', data: s, lines: ['Now using ' + s.backendLabel + ' (' + s.backend + ') for saved keyflip credentials.'] };
  }
  if (sub === 'off') {
    const s = off(ctx);
    return { action: 'off', data: s, lines: [s.previous ? ('External secret backend disabled (was ' + s.previous + '). ' + s.note) : 'No external secret backend was configured.'] };
  }
  throw vaultError('unknown: keyflip vault ' + sub + ' (use: status | use <op|bw|vault> | off)');
}

// ---- MCP tools -------------------------------------------------------------
function needConfirm(args) { if (!args || args.confirm !== true) throw new Error('confirmation required: ask the user first, then call again with confirm=true'); }
const tools = [
  {
    name: 'keyflip_vault_status',
    title: 'External secret backend status',
    description: 'Which external secret backend (1Password/Bitwarden/HashiCorp Vault) keyflip is configured to use for saved credentials, plus which backend CLIs are currently available. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) { return status(ctx, {}); },
  },
  {
    name: 'keyflip_vault_use',
    title: 'Use an external secret backend',
    description: 'Route saved keyflip credentials through an external secret manager instead of the OS keychain: "op" (1Password), "bw" (Bitwarden) or "vault" (HashiCorp Vault). Records the choice for future credential reads/writes; the backend must be installed and unlocked. Ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['op', 'bw', 'vault'], description: 'op=1Password, bw=Bitwarden, vault=HashiCorp Vault.' },
        confirm: confirmProp.confirm,
      },
      required: ['provider', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return use(ctx, String(args.provider), {}); },
  },
  {
    name: 'keyflip_vault_off',
    title: 'Disable the external secret backend',
    description: 'Stop using an external secret backend for saved credentials and revert to the OS keychain / credentials file. Does NOT delete anything already stored in the external vault. Ask the user before calling, then set confirm=true.',
    inputSchema: { type: 'object', properties: { confirm: confirmProp.confirm }, required: ['confirm'], additionalProperties: false },
    annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return off(ctx); },
  },
];

module.exports = {
  PROV_IDS: PROV_IDS,
  isProvider: isProvider,
  PROVIDERS: PROVIDERS,
  detect: detect,
  probe: probe,
  makeStore: makeStore,
  statePath: statePath,
  readState: readState,
  writeState: writeState,
  status: status,
  use: use,
  off: off,
  cli: cli,
  tools: tools,
};
