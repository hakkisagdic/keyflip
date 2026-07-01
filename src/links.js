'use strict';
// Directory -> account mapping (adopted from claude-swap PR #71): link a repo
// directory to an account once, then `ccswitch run` (no name) in that tree
// launches the right account automatically. Stored in <configDir>/links.json.
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

function linksPath(ctx) { return path.join(ctx.configDir, 'links.json'); }

function readAll(ctx) {
  try { return JSON.parse(fs.readFileSync(linksPath(ctx), 'utf8')) || {}; }
  catch (e) { return {}; }
}

function set(ctx, dir, name) {
  const all = readAll(ctx);
  all[path.resolve(dir)] = name;
  atomicWrite(linksPath(ctx), JSON.stringify(all, null, 2), 0o600);
}

function remove(ctx, dir) {
  const all = readAll(ctx);
  const key = path.resolve(dir);
  if (!(key in all)) return false;
  delete all[key];
  atomicWrite(linksPath(ctx), JSON.stringify(all, null, 2), 0o600);
  return true;
}

// Nearest-ancestor lookup: a link on the repo root covers its whole tree.
function lookup(ctx, dir) {
  const all = readAll(ctx);
  let cur = path.resolve(dir);
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(all, cur)) return { dir: cur, name: all[cur] };
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

module.exports = { set: set, remove: remove, lookup: lookup, readAll: readAll };
