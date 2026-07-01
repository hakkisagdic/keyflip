'use strict';
// Non-secret profile metadata stored as <configDir>/<name>.json (0600).
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fsutil');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function metaPath(dir, name) { return path.join(dir, name + '.json'); }

function list(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return []; }
  return files
    .filter(function (f) { return f.length > 5 && f.slice(-5) === '.json' && f[0] !== '.'; })
    .map(function (f) { return f.slice(0, -5); })
    .sort();
}

function read(dir, name) {
  try { return JSON.parse(fs.readFileSync(metaPath(dir, name), 'utf8')); } catch (e) { return null; }
}

function exists(dir, name) {
  try { return fs.existsSync(metaPath(dir, name)); } catch (e) { return false; }
}

function write(dir, meta) {
  if (!meta.schemaVersion) meta.schemaVersion = 1;
  atomicWrite(metaPath(dir, meta.name), JSON.stringify(meta, null, 2), 0o600);
}

function remove(dir, name) {
  try { fs.unlinkSync(metaPath(dir, name)); } catch (e) { /* ignore */ }
}

function email(dir, name) {
  const m = read(dir, name);
  return (m && m.email) || '';
}

function isValidName(name) { return typeof name === 'string' && NAME_RE.test(name); }

// Turn an email into a safe, human profile name (local-part, lowercased).
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

module.exports = {
  metaPath: metaPath,
  list: list,
  read: read,
  exists: exists,
  write: write,
  remove: remove,
  email: email,
  isValidName: isValidName,
  sanitizeName: sanitizeName,
  NAME_RE: NAME_RE,
};
