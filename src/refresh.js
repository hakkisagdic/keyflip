// @ts-check
// Background token refresh daemon for keyflip. Runs as a launchd KeepAlive process,
// checking credential expiry every 5 minutes and proactively refreshing tools that
// support it (Antigravity, and the live ChatGPT/Codex auth). Kiro is EXCLUDED from
// proactive refresh due to single-use refresh_token race conditions — it's handled
// reactively during switch.
//
// Security: Only reads/writes 0600 files under the keyflip config dir and the
// tool-owned auth.json. No tokens are passed on command lines; Keychain access
// uses stdin-based helpers.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { run } from './exec.js';
import * as codex from './codex.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PROACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // refresh if expires within 30 min
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [60000, 300000, 900000]; // 1min, 5min, 15min

// Metrics file path — under the context's config dir so tests and relocated
// installs never write to the real ~/.config/keyflip.
function metricsPath(ctx) {
  const base = (ctx && ctx.configDir) || path.join(os.homedir(), '.config', 'keyflip');
  return path.join(base, 'refresh-metrics.json');
}

// --- Metrics tracking ---

function loadMetrics(ctx) {
  try {
    const p = metricsPath(ctx);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    // ignore corrupt metrics
  }
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    tools: {},
    totals: {
      checks: 0,
      refreshes: 0,
      failures: 0,
      lastTick: null,
    },
  };
}

function saveMetrics(ctx, metrics) {
  try {
    fs.writeFileSync(metricsPath(ctx), JSON.stringify(metrics, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[refresh] Failed to save metrics:', e.message);
  }
}

function updateMetrics(ctx, tool, slug, event, details) {
  const metrics = loadMetrics(ctx);
  const key = `${tool}/${slug}`;

  if (!metrics.tools[key]) {
    metrics.tools[key] = {
      tool: tool,
      slug: slug,
      lastCheck: null,
      lastRefresh: null,
      lastFailure: null,
      consecutiveFailures: 0,
      totalChecks: 0,
      totalRefreshes: 0,
      totalFailures: 0,
    };
  }

  const toolMetrics = metrics.tools[key];
  metrics.totals.checks++;
  toolMetrics.totalChecks++;
  toolMetrics.lastCheck = new Date().toISOString();

  if (event === 'refresh') {
    metrics.totals.refreshes++;
    toolMetrics.totalRefreshes++;
    toolMetrics.lastRefresh = new Date().toISOString();
    toolMetrics.consecutiveFailures = 0;
  } else if (event === 'failure') {
    metrics.totals.failures++;
    toolMetrics.totalFailures++;
    toolMetrics.lastFailure = new Date().toISOString();
    toolMetrics.consecutiveFailures++;
  } else if (event === 'check') {
    // Hash check or session extraction
    if (details && details.changed) {
      console.log(`[refresh] 📊 ${key}: token/session changed`);
    }
  }

  metrics.totals.lastTick = new Date().toISOString();
  saveMetrics(ctx, metrics);
}

// --- Retry logic with exponential backoff ---

const retryState = {}; // In-memory retry tracker: key = `${tool}/${slug}`, value = { attempts, nextRetry }

function shouldRetry(tool, slug) {
  const key = `${tool}/${slug}`;
  const state = retryState[key];

  if (!state) return true; // First attempt
  if (Date.now() < state.nextRetry) return false; // Still in backoff period
  if (state.attempts >= MAX_RETRIES) return false; // Max retries reached

  return true;
}

function recordRetryAttempt(tool, slug, success) {
  const key = `${tool}/${slug}`;

  if (!retryState[key]) {
    retryState[key] = { attempts: 0, nextRetry: 0 };
  }

  if (success) {
    // Reset on success
    delete retryState[key];
  } else {
    retryState[key].attempts++;
    const backoffIdx = Math.min(retryState[key].attempts - 1, RETRY_BACKOFF_MS.length - 1);
    retryState[key].nextRetry = Date.now() + RETRY_BACKOFF_MS[backoffIdx];
  }
}

const STRATEGIES = {
  antigravity: {
    proactive: true,
    thresholdMs: PROACTIVE_THRESHOLD_MS,
    refreshFn: refreshAntigravity,
  },
  // ChatGPT.app and Codex CLI share ONE auth.json, so this is a tool-level strategy
  // (`once`) rather than a per-slug loop: refresh ONLY the live file, and only while
  // neither owner process is running. Captures are never refreshed on their own.
  codex: {
    proactive: true,
    thresholdMs: codex.REFRESH_THRESHOLD_MS,
    once: true,
    refreshFn: refreshCodex,
  },
  kiro: {
    proactive: false, // NEVER proactively refresh Kiro
    checkFn: checkKiroHash, // only reactive hash comparison
  },
  claude: {
    proactive: false, // No active refresh mechanism; relies on HTTP Set-Cookie headers
    note: 'Passive Set-Cookie capture during interactive use',
    checkFn: checkClaudeSession, // Reactive extraction from Desktop cookie DB
  },
};

// --- Antigravity refresh (Google OAuth) ---

// --- Tool-specific refresh strategies ---

async function refreshAntigravity(ctx, cred) {
  if (!shouldRetry('antigravity', cred.slug)) {
    console.log(`[refresh] Skipping Antigravity refresh for ${cred.slug} (in backoff period)`);
    return null;
  }

  const tokenData = JSON.parse(fs.readFileSync(cred.tokenPath, 'utf8'));
  if (!tokenData.refresh_token) return null; // no refresh capability

  // Google OAuth client credentials (publicly documented)
  const clientId = '1071006093414-b633i7tuh5u62v96nd08i0q56l0neovp.apps.googleusercontent.com';
  const clientSecret = 'GOCSPX-q07t211i40-l458v30-310321';

  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokenData.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[refresh] Antigravity refresh failed: ${err}`);
      recordRetryAttempt('antigravity', cred.slug, false);
      updateMetrics(ctx, 'antigravity', cred.slug, 'failure', { error: err });
      return null;
    }

    const newTokens = await resp.json();
    // Update the token file with new access_token and extended expiry
    const updated = Object.assign({}, tokenData, {
      access_token: newTokens.access_token,
      expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
    });
    fs.writeFileSync(cred.tokenPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
    console.log(`[refresh] Antigravity token refreshed (${cred.slug})`);

    recordRetryAttempt('antigravity', cred.slug, true);
    updateMetrics(ctx, 'antigravity', cred.slug, 'refresh');
    return updated;
  } catch (e) {
    console.error(`[refresh] Antigravity refresh error: ${e.message}`);
    recordRetryAttempt('antigravity', cred.slug, false);
    updateMetrics(ctx, 'antigravity', cred.slug, 'failure', { error: e.message });
    return null;
  }
}

// --- ChatGPT / Codex refresh (live auth.json only) ---

async function refreshCodex(ctx) {
  if (!shouldRetry('codex', 'live')) {
    console.log('[refresh] Skipping Codex refresh (in backoff period)');
    return null;
  }
  try {
    const r = await codex.refreshLive(ctx, {});
    if (r.refreshed) {
      console.log(
        '[refresh] ChatGPT/Codex token refreshed' +
          (r.updatedCaptures && r.updatedCaptures.length
            ? ' (updated capture: ' + r.updatedCaptures.join(', ') + ')'
            : ''),
      );
      recordRetryAttempt('codex', 'live', true);
      updateMetrics(ctx, 'codex', 'live', 'refresh');
      return r;
    }
    if (r.skipped === 'running') {
      // A running ChatGPT/Codex owns auth.json and would overwrite the rotation.
      console.log('[refresh] ChatGPT/Codex is running — deferring its token refresh.');
      updateMetrics(ctx, 'codex', 'live', 'check', { changed: false });
      return r;
    }
    if (r.skipped === 'no-live-auth' || r.skipped === 'not-due') {
      updateMetrics(ctx, 'codex', 'live', 'check', { changed: false });
      return r;
    }
    console.error('[refresh] ChatGPT/Codex auth is unreadable: ' + (r.error || r.skipped));
    recordRetryAttempt('codex', 'live', false);
    updateMetrics(ctx, 'codex', 'live', 'failure', { error: r.error || r.skipped });
    return r;
  } catch (e) {
    console.error('[refresh] ChatGPT/Codex refresh error: ' + e.message);
    recordRetryAttempt('codex', 'live', false);
    updateMetrics(ctx, 'codex', 'live', 'failure', { error: e.message });
    return null;
  }
}

// --- Kiro hash check (reactive only, NO refresh) ---

function checkKiroHash(ctx, cred) {
  // Compute SHA256 of the current refresh_token to detect IDE/CLI rotation
  let tokenData;
  try {
    if (cred.tokenPath && fs.existsSync(cred.tokenPath)) {
      tokenData = JSON.parse(fs.readFileSync(cred.tokenPath, 'utf8'));
    } else if (cred.keychainService) {
      // Read from Keychain
      const out = run('/usr/bin/security', [
        'find-generic-password',
        '-s',
        cred.keychainService,
        '-a',
        cred.keychainAccount || 'antigravity',
        '-w',
      ]);
      if (out.code === 0) {
        tokenData = JSON.parse(out.stdout.trim());
      }
    }
  } catch (e) {
    updateMetrics(ctx, 'kiro', cred.slug, 'failure', { error: e.message });
    return null;
  }

  if (!tokenData || !tokenData.refresh_token) return null;

  const hash = crypto.createHash('sha256').update(tokenData.refresh_token).digest('hex');
  updateMetrics(ctx, 'kiro', cred.slug, 'check');
  return {
    refresh_token_hash: hash,
    expires_at: tokenData.expires_at,
  };
}

// --- Claude Desktop session extraction (reactive-only, no proactive refresh) ---

const CLAUDE_COOKIE_DB = path.join(os.homedir(), 'Library/Application Support/Claude/Cookies');
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Safe Storage';
const CLAUDE_HOSTS = ['.claude.ai', 'claude.ai'];

function deriveClaudeKey(password) {
  // PBKDF2-HMAC-SHA1 with "saltysalt", 1003 iterations, 16 bytes
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptClaudeCookie(encryptedValue, aesKey) {
  if (!encryptedValue || encryptedValue.length < 3) return null;

  // Check for v10/v11 prefix
  const prefix = encryptedValue.slice(0, 3);
  if (prefix !== 'v10' && prefix !== 'v11') return null;

  const ciphertext = Buffer.from(encryptedValue.slice(3));
  const iv = Buffer.alloc(16, 0x20); // 16 space characters as IV

  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    // Chromium ≥ v130 adds 32-byte host-binding prefix
    if (decrypted.length > 32) {
      let hasBinaryPrefix = false;
      for (let i = 0; i < 32; i++) {
        if (decrypted[i] < 32 || decrypted[i] > 126) {
          hasBinaryPrefix = true;
          break;
        }
      }
      if (hasBinaryPrefix) {
        decrypted = decrypted.slice(32);
      }
    }

    return decrypted.toString('utf8');
  } catch (e) {
    return null;
  }
}

function extractClaudeSession() {
  // Get AES key from Keychain
  let keychainOut;
  try {
    keychainOut = run('/usr/bin/security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w']);
  } catch (e) {
    console.error('[refresh] Cannot access Claude Keychain:', e.message);
    return null;
  }

  if (keychainOut.code !== 0) {
    console.error('[refresh] Keychain access failed for Claude Safe Storage');
    return null;
  }

  const secret = keychainOut.stdout.trim();
  if (!secret) return null;

  const aesKey = deriveClaudeKey(secret);

  // Copy cookie DB to temp location (app may have it locked)
  let tmpPath;
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cookies-'));
    tmpPath = path.join(tmpDir, 'Cookies');
    fs.copyFileSync(CLAUDE_COOKIE_DB, tmpPath);
  } catch (e) {
    console.error('[refresh] Cannot copy Claude cookie DB:', e.message);
    return null;
  }

  try {
    // Query SQLite for cookies using sqlite3 CLI
    const hostsQ = CLAUDE_HOSTS.map((h) => `'${h}'`).join(',');
    const sqlCmd = `SELECT name, encrypted_value FROM cookies WHERE host_key IN (${hostsQ});`;
    const sqliteOut = run('sqlite3', ['-csv', tmpPath, sqlCmd]);

    if (sqliteOut.code !== 0) {
      console.error('[refresh] sqlite3 query failed:', sqliteOut.stderr);
      return null;
    }

    // Parse CSV output: "name","encrypted_value"
    const lines = sqliteOut.stdout.trim().split('\n');
    const cookies = {};

    for (const line of lines) {
      if (!line.trim()) continue;
      // Simple CSV parse (handles quoted fields)
      const matches = line.match(/^"([^"]*)","(.*)"$/);
      if (!matches) continue;

      const name = matches[1];
      const encryptedValue = matches[2].replace(/""/g, '"'); // Unescape quotes

      const decrypted = decryptClaudeCookie(encryptedValue, aesKey);
      if (decrypted) {
        cookies[name] = decrypted;
      }
    }

    // Cleanup temp file
    try {
      fs.unlinkSync(tmpPath);
      fs.rmdirSync(path.dirname(tmpPath));
    } catch (e) {
      // ignore cleanup errors
    }

    if (!cookies.sessionKey) {
      console.warn('[refresh] Claude sessionKey not found in cookies');
      return null;
    }

    return {
      sessionKey: cookies.sessionKey,
      lastActiveOrg: cookies.lastActiveOrg || null,
      extractedAt: new Date().toISOString(),
      // sessionKey has ~30 day lifetime, estimate expiry
      estimatedExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  } catch (e) {
    console.error('[refresh] Failed to extract Claude session:', e.message);
    // Cleanup on error
    try {
      if (tmpPath) {
        fs.unlinkSync(tmpPath);
        fs.rmdirSync(path.dirname(tmpPath));
      }
    } catch (cleanupErr) {
      // ignore
    }
    return null;
  }
}

function checkClaudeSession(ctx, cred) {
  // Reactive check: extract current session and compare with stored one
  const session = extractClaudeSession();
  if (!session) {
    updateMetrics(ctx, 'claude', cred.slug || 'desktop', 'failure', { error: 'extraction_failed' });
    return null;
  }

  updateMetrics(ctx, 'claude', cred.slug || 'desktop', 'check');
  return {
    sessionKey_hash: crypto.createHash('sha256').update(session.sessionKey).digest('hex'),
    lastActiveOrg: session.lastActiveOrg,
    extractedAt: session.extractedAt,
    estimatedExpiry: session.estimatedExpiry,
  };
}

// --- Main refresh loop ---

async function tick(ctx) {
  const surfacesDir = path.join(ctx.configDir, 'surfaces');

  // Expired, non-refreshable captures: the daemon cannot fix them (only a human sign-in can),
  // so it says so — once per SET of dead captures, not once per tick. The marker file is state,
  // not a credential; it lives in the config dir and is pruned when the set changes.
  try {
    const dead = codex
      .listCaptures(ctx)
      .filter(function (c) {
        if (!c.usable) return false;
        const r = c.refreshReason || '';
        return r === 'expired' || r === 'not-refreshable';
      })
      .map(function (c) {
        return c.slug;
      })
      .sort();
    const marker = path.join(ctx.configDir, 'expired-captures.json');
    const fingerprint = JSON.stringify(dead);
    let prev = null;
    try {
      prev = fs.readFileSync(marker, 'utf8');
    } catch {
      prev = null;
    }
    if (prev !== fingerprint) {
      fs.mkdirSync(ctx.configDir, { recursive: true });
      fs.writeFileSync(marker, fingerprint);
      if (dead.length)
        console.log(
          `[refresh] ⚠️  ChatGPT/Codex capture(s) expired and not refreshable: ${dead.join(', ')} — sign in once in ChatGPT/Codex, then \`keyflip chatgpt capture <slug>\` (see \`keyflip doctor\`)`,
        );
      else if (prev != null) console.log('[refresh] expired-capture set cleared');
    }
  } catch {
    /* a broken surfaces dir must not kill the tick */
  }

  // Tool-level strategies own their own credential file (Codex: one live
  // auth.json shared by ChatGPT.app + the CLI), so they run once and do not
  // require a per-account surface directory to exist.
  for (const name of Object.keys(STRATEGIES)) {
    const st = STRATEGIES[name];
    if (!st.once || typeof st.refreshFn !== 'function') continue;
    try {
      await st.refreshFn(ctx);
    } catch (e) {
      console.error(`[refresh] Error running ${name}: ${e.message}`);
    }
  }

  const tools = fs.existsSync(surfacesDir) ? fs.readdirSync(surfacesDir) : [];

  for (const tool of tools) {
    const strategy = STRATEGIES[tool];
    if (!strategy || strategy.once) continue;

    const accountsDir = path.join(surfacesDir, tool);
    if (!fs.statSync(accountsDir).isDirectory()) continue;

    const slugs = fs.readdirSync(accountsDir);
    for (const slug of slugs) {
      const credDir = path.join(accountsDir, slug);
      const metaPath = path.join(credDir, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const cred = {
          slug: slug,
          tool: tool,
          tokenPath: path.join(credDir, 'token.json'),
          cookiePath: path.join(credDir, 'cookies.json'),
          keychainService: meta.keychainService || null,
          keychainAccount: meta.keychainAccount || null,
        };

        // Handle reactive-only strategies (Kiro hash check)
        if (!strategy.proactive && strategy.checkFn) {
          const result = strategy.checkFn(ctx, cred);
          if (result) {
            // Check if hash changed from previous stored value
            const hashPath = path.join(credDir, 'refresh_token_hash.json');
            let previousHash = null;
            if (fs.existsSync(hashPath)) {
              previousHash = JSON.parse(fs.readFileSync(hashPath, 'utf8')).hash;
            }

            if (previousHash && previousHash !== result.refresh_token_hash) {
              console.log(`[refresh] ⚠️  ${tool}/${slug}: refresh_token rotated by IDE/CLI (hash changed)`);
              console.log(`[refresh]   Old: ${previousHash.slice(0, 16)}...`);
              console.log(`[refresh]   New: ${result.refresh_token_hash.slice(0, 16)}...`);
              console.log('[refresh]   This is expected when Kiro CLI or IDE re-authenticates. No action needed.');
            } else if (!previousHash) {
              console.log(`[refresh] Initial hash recorded for ${tool}/${slug}`);
            }

            // Store current hash for next comparison
            fs.writeFileSync(
              hashPath,
              JSON.stringify(
                {
                  hash: result.refresh_token_hash,
                  recordedAt: new Date().toISOString(),
                  expires_at: result.expires_at,
                },
                null,
                2,
              ),
              { mode: 0o600 },
            );
          }
          continue; // Skip proactive refresh logic for reactive-only tools
        }

        // Handle proactive refresh strategies
        if (!strategy.proactive) continue;

        // Check if token is expiring soon
        let shouldRefresh = false;
        if (fs.existsSync(cred.tokenPath)) {
          const tokenData = JSON.parse(fs.readFileSync(cred.tokenPath, 'utf8'));
          if (tokenData.expires_at) {
            const expiresAt = new Date(tokenData.expires_at).getTime();
            const timeLeft = expiresAt - Date.now();
            if (timeLeft > 0 && timeLeft < strategy.thresholdMs) {
              shouldRefresh = true;
            }
          }
        }

        if (shouldRefresh && strategy.refreshFn) {
          await strategy.refreshFn(ctx, cred);
        }
      } catch (e) {
        console.error(`[refresh] Error processing ${tool}/${slug}: ${e.message}`);
      }
    }
  }
}

// --- Daemon entry point ---

async function startDaemon(ctx) {
  console.log(`[refresh] Starting token refresh daemon (interval: ${REFRESH_INTERVAL_MS / 60000}min)`);
  console.log(
    '[refresh] Proactive tools:',
    Object.keys(STRATEGIES)
      .filter((t) => STRATEGIES[t].proactive)
      .join(', '),
  );
  console.log(
    '[refresh] Reactive-only tools:',
    Object.keys(STRATEGIES)
      .filter((t) => !STRATEGIES[t].proactive)
      .join(', '),
  );

  // Initial tick
  await tick(ctx);

  // Schedule periodic ticks
  setInterval(async () => {
    try {
      await tick(ctx);
    } catch (e) {
      console.error(`[refresh] Tick error: ${e.message}`);
    }
  }, REFRESH_INTERVAL_MS);
}

export { startDaemon, tick, STRATEGIES };
