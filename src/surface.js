'use strict';
// SURFACE (E1): a universal credential-surface registry — one place that knows how to DETECT
// (and, later, SWITCH) the active account for EACH supported AI tool, so keyflip can manage more
// than Claude. v1 ships SAFE, READ-first adapters for the tools keyflip already understands via
// agents.js CONFIG_REGISTRY (cursor, gemini, codex, copilot, opencode, aider): detect presence and,
// where the identity lives in a plain NON-SECRET file, read the active account — never decrypting,
// reading, or moving a secret. Opaque/keychain/secret stores report present + 'switch not supported
// yet'. Claude itself stays handled by keyflip core; switch() is a clean seam that throws until built.
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJsonForWrite } = require('./fsutil');

function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
function pathExists(ctx, rel) { try { return fs.existsSync(path.join(ctx.home, rel)); } catch (e) { return false; } }
function tildify(rel) { return '~/' + String(rel).replace(/\\/g, '/'); }

// ---- per-tool identity readers (READ-first: only ever parse a NON-SECRET, plain-text file) ----
// Gemini CLI records the signed-in Google account in ~/.gemini/google_accounts.json — a small,
// world-readable (mode 644) file that holds ONLY identity ({ active, old:[…] }), never the token
// (that lives in the 0600 oauth_creds.json, which we never touch). So this is the one surface where
// a safe active-account read is possible in v1. Every field is type-checked before use so a
// hostile/corrupt file can never throw, spoof a non-string account, or reach a prototype.
function geminiIdentity(ctx) {
  const obj = safe(function () { return JSON.parse(fs.readFileSync(path.join(ctx.home, '.gemini', 'google_accounts.json'), 'utf8')); }, null);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const active = (typeof obj.active === 'string' && obj.active) ? obj.active : null;
  const old = Array.isArray(obj.old) ? obj.old.filter(function (x) { return typeof x === 'string' && x; }) : [];
  const accounts = [];
  if (active) accounts.push(active);
  old.forEach(function (e) { if (accounts.indexOf(e) === -1) accounts.push(e); });
  return { active: active, accounts: accounts };
}

// ---- surface specs (one per tool keyflip already understands) --------------------------------
// presence[]  : home-relative paths (file OR dir) whose existence proves the tool is installed here.
// store       : where the ACTUAL credential lives — `path` (a single known file, existence-probed
//               with stat only, NEVER read) or free-text `location` for opaque/keychain/env stores.
// readIdentity: a reader for a NON-SECRET identity file, or null when identity is only in a secret/
//               opaque store (then we report present + switch-not-supported rather than guessing).
const SPECS = [
  {
    id: 'cursor', label: 'Cursor', kind: 'keychain',
    presence: ['.cursor', '.cursor/mcp.json'],
    store: { kind: 'keychain', secret: true, location: 'OS keychain / Cursor app state (opaque)' },
    readIdentity: null,
  },
  {
    id: 'gemini', label: 'Gemini CLI', kind: 'file',
    presence: ['.gemini', '.gemini/settings.json', '.gemini/google_accounts.json', '.gemini/oauth_creds.json'],
    store: { kind: 'file', secret: true, path: '.gemini/oauth_creds.json' },
    readIdentity: geminiIdentity,
  },
  {
    id: 'codex', label: 'Codex CLI', kind: 'file',
    presence: ['.codex', '.codex/config.toml', '.codex/auth.json'],
    // identity is inside the 0600 auth.json (a JWT id_token / OPENAI_API_KEY) — a secret; never read.
    store: { kind: 'file', secret: true, path: '.codex/auth.json' },
    readIdentity: null,
  },
  {
    id: 'copilot', label: 'GitHub Copilot', kind: 'file',
    presence: ['.copilot', '.copilot/config.json', '.config/github-copilot', '.config/github-copilot/hosts.json', '.config/github-copilot/apps.json'],
    store: { kind: 'file', secret: true, location: '~/.copilot/config.json or ~/.config/github-copilot/hosts.json (opaque/secret)' },
    readIdentity: null,
  },
  {
    id: 'opencode', label: 'opencode', kind: 'file',
    presence: ['.config/opencode', '.config/opencode/opencode.json', '.local/share/opencode', '.local/share/opencode/auth.json'],
    store: { kind: 'file', secret: true, path: '.local/share/opencode/auth.json' },
    readIdentity: null,
  },
  {
    id: 'aider', label: 'Aider', kind: 'env',
    presence: ['.aider.conf.yml', '.aider.conf.yaml', '.aider'],
    store: { kind: 'env', secret: true, location: 'environment (OPENAI_API_KEY / ANTHROPIC_API_KEY / …) or .env' },
    readIdentity: null,
  },
];

function resolveStore(ctx, spec) {
  const s = spec.store || {};
  const out = { kind: s.kind || spec.kind, secret: !!s.secret };
  if (s.path) { out.location = tildify(s.path); out.exists = pathExists(ctx, s.path); } // stat only — never read
  else { out.location = s.location || null; out.exists = null; }
  return out;
}

// Detect one surface -> { id, label, kind, present, activeAccount|null, accounts, switchable, store, note }.
function detectSpec(ctx, spec, opts) {
  const present = spec.presence.some(function (rel) { return pathExists(ctx, rel); });
  let activeAccount = null, accounts = [];
  if (present && typeof spec.readIdentity === 'function') {
    const ident = safe(function () { return spec.readIdentity(ctx); }, null);
    if (ident) { activeAccount = ident.active || null; accounts = Array.isArray(ident.accounts) ? ident.accounts : []; }
  }
  let note;
  if (!present) note = 'not detected';
  else if (activeAccount) note = 'active account detected (switch not supported yet)';
  else note = 'present; account is in an opaque/secret store — switch not supported yet';
  return {
    id: spec.id, label: spec.label, kind: spec.kind,
    present: present, activeAccount: activeAccount, accounts: accounts,
    switchable: false, store: resolveStore(ctx, spec), note: note,
  };
}

function makeSurface(spec) {
  return {
    id: spec.id, label: spec.label, kind: spec.kind, store: spec.store, switchable: false,
    detect: function (ctx, opts) { return detectSpec(ctx, spec, opts); },
    list: function (ctx) { return detectSpec(ctx, spec).accounts; },
  };
}

const SURFACES = SPECS.map(makeSurface);
// id -> surface. NULL-PROTOTYPE map so a lookup key like '__proto__'/'constructor' can never reach
// or shadow an inherited property (the ids are our own constants, but keep the invariant anyway).
const BY_ID = Object.create(null);
SURFACES.forEach(function (s) { BY_ID[s.id] = s; });

function get(id) { return (typeof id === 'string' && BY_ID[id]) ? BY_ID[id] : null; }
function detectAll(ctx, opts) { return SURFACES.map(function (s) { return s.detect(ctx, opts); }); }
function detectOne(ctx, id, opts) { const s = get(id); return s ? s.detect(ctx, opts) : null; }

// The SWITCH SEAM. v1 is detection-only: no non-Claude surface can be switched safely yet (doing so
// would move secrets keyflip does not handle in v1). Claude itself is switched by keyflip core, not
// here. Throws a stable, per-surface message so callers can present it verbatim.
function switchSurface(ctx, surfaceId, account, opts) {
  if (!get(surfaceId)) throw new Error("unknown surface: '" + surfaceId + "' (see: keyflip surfaces)");
  throw new Error('switch not supported for ' + surfaceId + ' (v1 is detection-only)');
}

// ---- optional last-detection snapshot cache (so other keyflip surfaces can read last-known state
// cheaply without re-scanning). Persisted 0600 as <configDir>/surfaces.json. Pure reads never write.
function snapshotPath(ctx) { return path.join(ctx.configDir, 'surfaces.json'); }
function writeSnapshot(ctx, opts) {
  const snap = { at: ctx.now(), surfaces: detectAll(ctx, opts) };
  atomicWrite(snapshotPath(ctx), JSON.stringify(snap, null, 2), 0o600);
  return snap;
}
function readSnapshot(ctx) {
  let x; try { x = readJsonForWrite(snapshotPath(ctx)); } catch (e) { return null; } // corrupt cache = absent
  if (!x || typeof x !== 'object' || Array.isArray(x) || !Array.isArray(x.surfaces)) return null;
  return x;
}

// ---- MCP tool (read-only): expose detection to agents. No secret ever crosses this seam — only
// presence, a NON-SECRET active-account identity where readable, and a store LOCATION (never contents).
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mcpTools = [
  {
    name: 'keyflip_surfaces',
    title: 'Detect other AI tools\' accounts',
    description: 'Detect which other AI coding tools (Cursor, Gemini CLI, Codex CLI, GitHub Copilot, opencode, Aider) are present on this machine and, where the identity is in a readable NON-SECRET file, which account is active. Read-only: never reads, decrypts, or moves any secret/token. Switching non-Claude tools is not supported yet (Claude itself is managed by the other keyflip tools).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) { return { surfaces: detectAll(ctx) }; },
  },
];

module.exports = {
  SURFACES: SURFACES,
  get: get,
  detectOne: detectOne,
  detectAll: detectAll,
  switch: switchSurface,
  snapshotPath: snapshotPath,
  writeSnapshot: writeSnapshot,
  readSnapshot: readSnapshot,
  mcpTools: mcpTools,
};
