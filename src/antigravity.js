// @ts-check
// Antigravity surface adapter. Antigravity (formerly Gemini CLI) stores its OAuth
// token in the macOS Keychain under service "gemini", account "antigravity".
// The value is a JSON blob containing refresh/access tokens and metadata.
//
// Unlike Claude/Kiro, Antigravity uses a single keychain entry per machine —
// there's no separate IDE store. Account switching requires writing a new
// keychain item and optionally logging out the current session.
//
// Secrets live in 0600 files under <configDir>/surfaces/antigravity/<slug>/
// (already git-ignored by the state repo); meta.json is secret-free.
import fs from 'fs';
import path from 'path';
import { run as defaultRun } from './exec.js';
import { atomicWrite, writeJsonStable } from './fsutil.js';
import * as profiles from './profiles.js';

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';
const SECURITY = '/usr/bin/security';
const PROC_NAMES = ['Antigravity', 'agy', 'antigravity-cli'];

// Read the current Antigravity OAuth token from macOS Keychain.
// Returns { found, token: string | null, error?: string }.
async function readKeychainToken() {
  try {
    const out = await defaultRun(SECURITY, [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w', // password only (the JSON token)
    ]);
    if (!out || !out.stdout) return { found: false };
    const token = out.stdout.trim();
    if (!token) return { found: false };
    return { found: true, token: token };
  } catch (e) {
    // Exit code 44 = item not found
    if (e.code === 44 || (e.message && e.message.includes('could not be found'))) {
      return { found: false };
    }
    return { found: false, error: e.message };
  }
}

// Write an Antigravity OAuth token to macOS Keychain.
// Creates or updates the generic password item.
async function writeKeychainToken(token) {
  if (!token || typeof token !== 'string') throw new Error('token must be a non-empty string');
  // Use security -i for stdin-based write (avoids exposing token in argv)
  const script = `add-generic-password -s '${KEYCHAIN_SERVICE}' -a '${KEYCHAIN_ACCOUNT}' -w "$(cat)" -U`;
  try {
    await defaultRun(SECURITY, ['-i'], { input: script + '\n' + token });
    return true;
  } catch (e) {
    throw new Error('failed to write keychain token: ' + e.message);
  }
}

// Delete the Antigravity keychain entry (logout).
async function deleteKeychainToken() {
  try {
    await defaultRun(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
    return true;
  } catch (e) {
    // Already gone is fine
    if (e.code === 44 || (e.message && e.message.includes('could not be found'))) {
      return true;
    }
    throw new Error('failed to delete keychain token: ' + e.message);
  }
}

// Capture the current Antigravity login into a slug directory.
// Writes meta.json (public) and token.json (secret, 0600).
async function capture(ctx, slug, opts) {
  opts = opts || {};
  const dir = path.join(ctx.configDir, 'surfaces', 'antigravity', slug);
  fs.mkdirSync(dir, { recursive: true });

  const tokenResult = await readKeychainToken();
  if (!tokenResult.found) {
    throw new Error(
      'no Antigravity login found in keychain (service: ' + KEYCHAIN_SERVICE + ', account: ' + KEYCHAIN_ACCOUNT + ')',
    );
  }

  // Parse token to extract email/account info
  let tokenData;
  try {
    tokenData = JSON.parse(tokenResult.token);
  } catch (e) {
    // Raw token string — store as-is
    tokenData = { raw: tokenResult.token };
  }

  const meta = {
    tool: 'antigravity',
    slug: slug,
    capturedAt: new Date().toISOString(),
    email: tokenData.email || tokenData.account || 'unknown',
    surfaces: ['cli'],
  };

  // Write public meta
  writeJsonStable(path.join(dir, 'meta.json'), meta);

  // Write secret token (0600)
  atomicWrite(path.join(dir, 'token.json'), tokenResult.token, 0o600);

  return {
    slug: slug,
    email: meta.email,
    surfaces: meta.surfaces,
    capturedAt: meta.capturedAt,
  };
}

// Switch the active Antigravity account to the given slug.
// Reads the stored token and writes it to the keychain.
async function switchTo(ctx, slug, opts) {
  opts = opts || {};
  const dir = path.join(ctx.configDir, 'surfaces', 'antigravity', slug);
  const tokenPath = path.join(dir, 'token.json');

  if (!fs.existsSync(tokenPath)) {
    throw new Error('no saved token for antigravity/' + slug);
  }

  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) {
    throw new Error('empty token file for antigravity/' + slug);
  }

  // Optionally logout first (clear existing keychain entry)
  if (!opts.skipLogout) {
    await deleteKeychainToken();
  }

  // Write new token
  await writeKeychainToken(token);

  return {
    slug: slug,
    switchedAt: new Date().toISOString(),
    surfaces: ['cli'],
  };
}

// List all captured Antigravity accounts.
function listCaptures(ctx) {
  const base = path.join(ctx.configDir, 'surfaces', 'antigravity');
  if (!fs.existsSync(base)) return [];

  const slugs = fs.readdirSync(base);
  return slugs
    .map(function (slug) {
      const metaPath = path.join(base, slug, 'meta.json');
      if (!fs.existsSync(metaPath)) return null;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return {
          tool: 'antigravity',
          slug: slug,
          email: meta.email || 'unknown',
          capturedAt: meta.capturedAt,
          surfaces: meta.surfaces || ['cli'],
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

// Check if Antigravity is currently logged in.
async function status(ctx) {
  const result = await readKeychainToken();
  return {
    tool: 'antigravity',
    signedIn: result.found,
    surfaces: ['cli'],
    error: result.error,
  };
}

// Remove a captured account (does NOT touch keychain).
function removeCapture(ctx, slug) {
  const dir = path.join(ctx.configDir, 'surfaces', 'antigravity', slug);
  if (!fs.existsSync(dir)) {
    throw new Error('no capture for antigravity/' + slug);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { removed: slug };
}

export {
  capture,
  switchTo,
  listCaptures,
  status,
  removeCapture,
  readKeychainToken,
  writeKeychainToken,
  deleteKeychainToken,
  PROC_NAMES,
};
