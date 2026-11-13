// Track the moment the current live CLI login became live (<configDir>/.live-since.json),
// so older rate-limit lines in transcripts do not re-trigger switches or re-engage failover.
// Imports only fs, path and fsutil so core.js, failover.js and limitsignal.js share it
// without circular imports.
import fs from 'fs';
import path from 'path';
import { atomicWrite } from './fsutil.js';

const LIVE_SINCE_FILE = '.live-since.json';

function liveSincePath(ctx) {
  return path.join(ctx.configDir, LIVE_SINCE_FILE);
}

function writeLiveSince(ctx, opts) {
  if (!ctx || !ctx.configDir) return null;
  opts = opts || {};
  let atIso;
  if (typeof opts.at === 'string' && isFinite(Date.parse(opts.at))) {
    atIso = new Date(Date.parse(opts.at)).toISOString();
  } else {
    const ms = typeof opts.nowMs === 'number' && isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    atIso = new Date(ms).toISOString();
  }
  const p = liveSincePath(ctx);
  try {
    atomicWrite(p, JSON.stringify({ at: atIso }, null, 2), 0o600);
    return { at: atIso };
  } catch (e) {
    return null;
  }
}

function readLiveSince(ctx, fsImpl) {
  if (!ctx || !ctx.configDir) return null;
  const f = fsImpl || fs;
  try {
    const raw = f.readFileSync(liveSincePath(ctx), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j.at === 'string') {
      const ms = Date.parse(j.at);
      if (isFinite(ms)) return ms;
    }
  } catch (e) {
    /* absent or unreadable */
  }
  return null;
}

export { LIVE_SINCE_FILE, liveSincePath, writeLiveSince, readLiveSince };
