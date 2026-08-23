// Versioned state + one-time migrations. Applied migration ids are recorded in
// <configDir>/.migrations.json; each migration is idempotent and self-guarded so
// a failure never bricks startup (it just retries next run).
import fs from 'fs';
import path from 'path';
import * as profiles from './profiles.js';
import { atomicWrite } from './fsutil.js';

const CURRENT_SCHEMA = 1;

const MIGRATIONS = [
  {
    id: '001-stamp-schema-version',
    run: function (ctx) {
      profiles.list(ctx.configDir).forEach(function (n) {
        const m = profiles.read(ctx.configDir, n);
        if (m && !m.schemaVersion) {
          m.schemaVersion = CURRENT_SCHEMA;
          profiles.write(ctx.configDir, m);
        }
      });
    },
  },
];

function stampPath(ctx) { return path.join(ctx.configDir, '.migrations.json'); }

function readApplied(ctx) {
  try { return JSON.parse(fs.readFileSync(stampPath(ctx), 'utf8')).applied || []; }
  catch (e) { return []; }
}

// Returns the ids applied in this run. Never throws.
function runMigrations(ctx) {
  let applied;
  try { applied = readApplied(ctx); } catch (e) { applied = []; }
  const ranNow = [];
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (applied.indexOf(m.id) !== -1) continue;
    try {
      m.run(ctx);
      applied.push(m.id);
      ranNow.push(m.id);
    } catch (e) {
      break; // retry on the next run; never block startup
    }
  }
  if (ranNow.length) {
    try { atomicWrite(stampPath(ctx), JSON.stringify({ applied: applied }, null, 2), 0o600); }
    catch (e) { /* best effort */ }
  }
  return ranNow;
}

export { runMigrations, CURRENT_SCHEMA, MIGRATIONS as _MIGRATIONS };