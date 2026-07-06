'use strict';
// A2: map a session to a specific account, so it can be resumed AS that account without
// switching the machine's active profile (`keyflip resume <id>` then runs it isolated as the
// assigned account). Transcripts are account-independent, so this is just a pointer stored in
// keyflip's config (H3 git-versions it). Keyed by full sessionId.
const fs = require('fs');
const path = require('path');
const fsutil = require('./fsutil');

function file(ctx) { return path.join(ctx.configDir, 'session-accounts.json'); }
function read(ctx) { try { return JSON.parse(fs.readFileSync(file(ctx), 'utf8')) || {}; } catch (e) { return {}; } }
function get(ctx, id) { const m = read(ctx); return (id && m[id]) || null; }
function set(ctx, id, name) {
  const m = read(ctx); m[id] = name;
  // Atomic (temp+rename): a torn write must never replace the whole map with a truncated
  // file — read() swallows parse errors and returns {}, so a corrupt file would silently
  // wipe EVERY session→account assignment on the next write.
  fsutil.atomicWrite(file(ctx), JSON.stringify(m, null, 2), 0o600);
}
function unset(ctx, id) {
  const m = read(ctx); if (!(id in m)) return false;
  try { delete m[id]; fsutil.atomicWrite(file(ctx), JSON.stringify(m, null, 2), 0o600); } catch (e) { /* ignore */ }
  return true;
}

module.exports = { read: read, get: get, set: set, unset: unset };
