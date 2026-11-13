// @ts-check
// Non-secret profile metadata stored as <configDir>/<name>.json (0600).
import fs from 'fs';
import path from 'path';
import { atomicWrite } from './fsutil.js';

// Must start with an alphanumeric (blocks '-flag', '.dotfile', '..') and use only
// safe chars. Reserved object-property names are rejected outright so a profile
// name can never collide with a prototype key in any map keyed by name.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = ['__proto__', 'prototype', 'constructor'];
// keyflip's own top-level state files (<configDir>/*.json) that are NOT account
// profiles. Without this, list() counts breakers.json/proxy.json/etc. as phantom
// accounts and the schema migration rewrites them to a bogus `undefined.json`.
// INVARIANT: any NEW file written straight into configDir must be added here — a missing entry is not
// cosmetic, it puts a fake account in `keyflip list`, in the interactive menu and in every count. The
// ones at the end are the ones that got forgotten when their feature landed (schedule receipts, #36/#40,
// the secrets toleration policy #44, and the attribution provenance sidecar #50); test/profiles.test.js
// now pins them.
const RESERVED_FILES = [
  'breakers',
  'proxy',
  'proxy-routes',
  'mcp-registry',
  'links',
  'installed-skills',
  'session-accounts',
  'fleet',
  'fleet-seen',
  'fleet-applied',
  'fleet-key',
  'fleet-known',
  'groups',
  'budget',
  'notify',
  'jobs',
  'teampool',
  'policy',
  'vault',
  'integrations',
  'router',
  'swarm',
  'config',
  'license',
  'embeddings',
  'pii-patterns',
  'dream-schedule',
  'refresh-schedule',
  'secrets-policy',
  'session-accounts-source',
  'prices-cache',
  'conv-index-schedule',
  'refresh-daemon-schedule',
  'refresh-metrics',
  'expired-captures',
  'refresh-state',
];

const TOMBSTONES_FILE = '.tombstones.json';

function metaPath(dir, name) {
  return path.join(dir, name + '.json');
}

function tombstonesPath(dir) {
  return path.join(dir, TOMBSTONES_FILE);
}

/**
 * List all profile names in the config directory.
 * @param {string} dir - Config directory path.
 * @returns {string[]} Sorted array of profile names.
 */
function list(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return files
    .filter(function (f) {
      return f.length > 5 && f.slice(-5) === '.json' && f[0] !== '.';
    })
    .map(function (f) {
      return f.slice(0, -5);
    })
    .filter(function (n) {
      return RESERVED_FILES.indexOf(n) === -1;
    })
    .sort();
}

/**
 * Read profile metadata from disk.
 * @param {string} dir - Config directory path.
 * @param {string} name - Profile name.
 * @returns {{ email?: string, name?: string, userID?: string, oauthAccount?: any, savedAt?: string, schemaVersion?: number, enabled?: boolean, tier?: string } | null} Parsed metadata object or null if not found.
 */
function read(dir, name) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(dir, name), 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Check whether a profile exists on disk.
 * @param {string} dir - Config directory path.
 * @param {string} name - Profile name.
 * @returns {boolean} True if the profile metadata file exists.
 */
function exists(dir, name) {
  try {
    return fs.existsSync(metaPath(dir, name));
  } catch (e) {
    return false;
  }
}

function write(dir, meta) {
  if (!meta.schemaVersion) meta.schemaVersion = 1;
  atomicWrite(metaPath(dir, meta.name), JSON.stringify(meta, null, 2), 0o600);
}

function remove(dir, name) {
  try {
    fs.unlinkSync(metaPath(dir, name));
  } catch (e) {
    /* ignore */
  }
}

function email(dir, name) {
  const m = read(dir, name);
  return (m && m.email) || '';
}

/**
 * Whether a profile is enabled for automatic rotation/proxy routing.
 * Profiles without an explicit `enabled` field default to enabled (true).
 * @param {string} dir - Config directory path.
 * @param {string} name - Profile name.
 * @returns {boolean} True if enabled.
 */
function isEnabled(dir, name) {
  const m = read(dir, name);
  if (!m) return false;
  return m.enabled !== false;
}

/**
 * Enable or disable a profile without deleting its credentials.
 * @param {string} dir - Config directory path.
 * @param {string} name - Profile name.
 * @param {boolean} enabled - Whether the profile is enabled.
 * @returns {object} Updated metadata.
 */
function setEnabled(dir, name, enabled) {
  const m = read(dir, name);
  if (!m) throw new Error("no such profile: '" + name + "'");
  m.enabled = !!enabled;
  write(dir, m);
  return m;
}

/**
 * Detect if another profile resolves to the same underlying account (by accountUuid or email).
 * Returns the canonical (first in sorted order) profile name when `name` is a duplicate, or null.
 * @param {string} dir - Config directory path.
 * @param {string} name - Profile name to check.
 * @returns {string | null} The earlier profile name that shares the same identity, or null.
 */
function duplicateOf(dir, name) {
  const target = read(dir, name);
  if (!target) return null;
  const targetUuid = (target.oauthAccount && target.oauthAccount.accountUuid) || '';
  const targetEmail = (target.email || '').toLowerCase();
  if (!targetUuid && !targetEmail) return null;
  const names = list(dir);
  for (let i = 0; i < names.length; i++) {
    const other = names[i];
    if (other === name) break; // only flag later duplicates against the first canonical profile
    const m = read(dir, other);
    if (!m) continue;
    const otherUuid = (m.oauthAccount && m.oauthAccount.accountUuid) || '';
    const otherEmail = (m.email || '').toLowerCase();
    if (targetUuid && otherUuid && targetUuid === otherUuid) return other;
    if (targetEmail && otherEmail && targetEmail === otherEmail) return other;
  }
  return null;
}

/**
 * Read all profile tombstones (non-secret metadata of removed profiles so labels/tiers
 * can be restored if the same account is re-added later, and historical attribution survives).
 * @param {string} dir - Config directory path.
 * @returns {Array<{ name: string, email: string, accountUuid: string | null, tier: string | null, removedAt: string }>}
 */
function listTombstones(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(tombstonesPath(dir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

/**
 * Record a tombstone when a profile is removed. Never stores any credential or token.
 * @param {string} dir - Config directory path.
 * @param {any} meta - Profile metadata being removed.
 * @param {string} [removedAt] - ISO timestamp.
 */
function recordTombstone(dir, meta, removedAt) {
  if (!meta || !meta.name) return;
  const emailAddr = String(meta.email || '');
  const accountUuid = (meta.oauthAccount && meta.oauthAccount.accountUuid) || null;
  if (!emailAddr && !accountUuid) return;
  const existing = listTombstones(dir).filter(function (t) {
    if (!t || typeof t !== 'object') return false;
    if (accountUuid && t.accountUuid === accountUuid) return false;
    if (emailAddr && String(t.email || '').toLowerCase() === emailAddr.toLowerCase()) return false;
    return t.name !== meta.name;
  });
  existing.push({
    name: String(meta.name),
    email: emailAddr,
    accountUuid: accountUuid ? String(accountUuid) : null,
    tier: typeof meta.tier === 'string' ? meta.tier : null,
    removedAt: removedAt || new Date().toISOString(),
  });
  try {
    atomicWrite(tombstonesPath(dir), JSON.stringify(existing.slice(-100), null, 2), 0o600);
  } catch (e) {
    /* best effort */
  }
}

/**
 * Find a tombstone matching an email or accountUuid.
 * @param {string} dir - Config directory path.
 * @param {string} [emailAddr] - Email address.
 * @param {string} [accountUuid] - Account UUID.
 * @returns {{ name: string, email: string, accountUuid: string | null, tier: string | null, removedAt: string } | null}
 */
function findTombstone(dir, emailAddr, accountUuid) {
  const em = String(emailAddr || '').toLowerCase();
  const uuid = String(accountUuid || '');
  if (!em && !uuid) return null;
  const listAll = listTombstones(dir);
  for (let i = listAll.length - 1; i >= 0; i--) {
    const t = listAll[i];
    if (!t) continue;
    if (uuid && t.accountUuid && t.accountUuid === uuid) return t;
    if (em && t.email && String(t.email).toLowerCase() === em) return t;
  }
  return null;
}

/**
 * Validate a profile name against naming rules.
 * @param {string} name - Name to validate.
 * @returns {boolean} True if the name is valid for use as a profile name.
 */
function isValidName(name) {
  // Reject RESERVED_FILES too: an inbound/imported account named e.g. 'fleet' would otherwise
  // overwrite keyflip's own <configDir>/fleet.json state (a hostile fleet save-account vector).
  return (
    typeof name === 'string' &&
    NAME_RE.test(name) &&
    RESERVED_NAMES.indexOf(name) === -1 &&
    RESERVED_FILES.indexOf(name) === -1
  );
}

/**
 * Turn an email into a safe, human-readable profile name (local-part, lowercased).
 * @param {string} emailAddr - Email address to derive the name from.
 * @returns {string} A sanitized profile name.
 */
function sanitizeName(emailAddr) {
  const local = String(emailAddr || '').split('@')[0] || '';
  const base = local
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return base || 'account';
}

export {
  metaPath,
  list,
  read,
  exists,
  write,
  remove,
  email,
  isEnabled,
  setEnabled,
  duplicateOf,
  listTombstones,
  recordTombstone,
  findTombstone,
  isValidName,
  sanitizeName,
  NAME_RE,
  RESERVED_FILES,
};
