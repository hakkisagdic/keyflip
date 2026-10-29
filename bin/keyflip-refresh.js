#!/usr/bin/env node
// keyflip-refresh — background token refresh daemon for keyflip.
// Runs as a launchd KeepAlive process, checking credential expiry every 5 minutes
// and proactively refreshing tools that support it (Antigravity, ChatGPT).
import { createContext } from '../src/ctx.js';
import { startDaemon } from '../src/refresh.js';

const ctx = createContext();
startDaemon(ctx).catch(function (err) {
  process.stderr.write('❌ ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
