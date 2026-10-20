// @ts-check
// Background token refresh daemon for keyflip. Runs as a launchd KeepAlive process,
// checking credential expiry every 5 minutes and proactively refreshing tools that
// support it (Antigravity, ChatGPT). Kiro is EXCLUDED from proactive refresh due to
// single-use refresh_token race conditions — it's handled reactively during switch.
//
// Security: Only reads/writes 0600 files under ~/.config/keyflip/surfaces/. No tokens
// are passed on command lines; Keychain access uses stdin-based helpers.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { run } from './exec.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PROACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // refresh if expires within 30 min

// --- Tool-specific refresh strategies ---

const STRATEGIES = {
  antigravity: {
    proactive: true,
    thresholdMs: PROACTIVE_THRESHOLD_MS,
    refreshFn: refreshAntigravity,
  },
  chatgpt: {
    proactive: true,
    thresholdMs: 60 * 60 * 1000, // bearer ~5-9 days, but session token ~3 months
    refreshFn: refreshChatGPT,
  },
  kiro: {
    proactive: false, // NEVER proactively refresh Kiro
    checkFn: checkKiroHash, // only reactive hash comparison
  },
  claude: {
    proactive: false, // passive Set-Cookie capture only
    note: 'No active refresh mechanism; relies on HTTP response headers',
  },
};

// --- Antigravity refresh (Google OAuth) ---

async function refreshAntigravity(ctx, cred) {
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
    return updated;
  } catch (e) {
    console.error(`[refresh] Antigravity refresh error: ${e.message}`);
    return null;
  }
}

// --- ChatGPT refresh (session token → bearer) ---

async function refreshChatGPT(ctx, cred) {
  // Read the session token from cookies snapshot
  const cookieData = JSON.parse(fs.readFileSync(cred.cookiePath, 'utf8'));
  const sessionToken = cookieData['__Secure-next-auth.session-token'];
  if (!sessionToken) return null;

  try {
    // Call the session endpoint to get a fresh bearer
    const resp = await fetch('https://chatgpt.com/api/auth/session', {
      headers: {
        Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });

    if (!resp.ok) {
      console.error(`[refresh] ChatGPT session refresh failed: ${resp.status}`);
      return null;
    }

    const session = await resp.json();
    if (!session.accessToken) return null;

    // Update the bearer in the credential file
    const updated = Object.assign({}, cookieData, {
      accessToken: session.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // ~7 days
    });
    fs.writeFileSync(cred.cookiePath, JSON.stringify(updated, null, 2), { mode: 0o600 });
    console.log(`[refresh] ChatGPT bearer refreshed (${cred.slug})`);
    return updated;
  } catch (e) {
    console.error(`[refresh] ChatGPT refresh error: ${e.message}`);
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
    return null;
  }

  if (!tokenData || !tokenData.refresh_token) return null;

  const hash = crypto.createHash('sha256').update(tokenData.refresh_token).digest('hex');
  return {
    refresh_token_hash: hash,
    expires_at: tokenData.expires_at,
  };
}

// --- Main refresh loop ---

async function tick(ctx) {
  const surfacesDir = path.join(ctx.configDir, 'surfaces');
  if (!fs.existsSync(surfacesDir)) return;

  const tools = fs.readdirSync(surfacesDir);

  for (const tool of tools) {
    const strategy = STRATEGIES[tool];
    if (!strategy || !strategy.proactive) continue;

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
        };

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
