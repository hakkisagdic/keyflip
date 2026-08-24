// Account GROUPS/TAGS: label accounts (e.g. "work", "personal", "clientX") so
// rotation and failover can be SCOPED to a pool — `keyflip next --group work`
// only cycles the work accounts. State lives in <configDir>/groups.json as
// { accountName: [tag, ...] }; the inverse view (group -> [members]) is derived
// on read. Every map keyed by a user-supplied name is Object.create(null) so a
// hostile account/tag name (e.g. "__proto__") can never pollute a prototype.
import path from 'path';
import * as profiles from './profiles.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';

// A tag/group name must start alphanumeric and use only safe chars (mirrors
// profiles' NAME_RE). Bounded length. Reserved object keys are rejected so a tag
// — which becomes a KEY in the derived group index — can never shadow a prototype.
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED = ['__proto__', 'prototype', 'constructor'];
function isValidTag(t) {
  return typeof t === 'string' && t.length <= 64 && TAG_RE.test(t) && RESERVED.indexOf(t) === -1;
}

function groupsPath(ctx) {
  return path.join(ctx.configDir, 'groups.json');
}

// Coerce parsed JSON into a null-prototype { validName: [validTags(sorted,deduped)] }.
// Drops junk keys/values (bad names, non-arrays, bad tags) and entries with no tags,
// so a tampered or hand-edited file can never inject an invalid or dangerous shape.
function normalize(parsed) {
  const out = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  Object.keys(parsed).forEach(function (name) {
    if (!profiles.isValidName(name)) return; // rejects '__proto__'/'constructor'/reserved files
    const tags = parsed[name];
    if (!Array.isArray(tags)) return;
    const clean = [];
    tags.forEach(function (t) {
      if (isValidTag(t) && clean.indexOf(t) === -1) clean.push(t);
    });
    if (clean.length) out[name] = clean.sort();
  });
  return out;
}

// Guarded read (never throws): missing OR corrupt -> empty. Used by every read-only
// accessor. Returns a null-prototype map.
function readAll(ctx) {
  let parsed;
  try {
    parsed = readJsonForWrite(groupsPath(ctx));
  } catch (e) {
    return Object.create(null);
  }
  return normalize(parsed);
}

// Read-for-write: a MISSING file is empty ({}), but a CORRUPT file THROWS so a
// read-modify-write never silently clobbers the user's real state.
function loadForWrite(ctx) {
  return normalize(readJsonForWrite(groupsPath(ctx)));
}

function save(ctx, map) {
  const out = {};
  Object.keys(map)
    .sort()
    .forEach(function (k) {
      out[k] = map[k].slice().sort();
    });
  atomicWrite(groupsPath(ctx), JSON.stringify(out, null, 2), 0o600);
}

// ---- per-account tags ----
function tagsFor(ctx, name) {
  const t = readAll(ctx)[name];
  return t ? t.slice() : [];
}

// Replace an account's tags wholesale. An empty (or all-removed) set drops the
// account from the file entirely. Rejects invalid names/tags BEFORE writing.
function setTags(ctx, name, tags) {
  if (!profiles.isValidName(name)) throw new Error("invalid account name: '" + name + "'");
  if (!Array.isArray(tags)) throw new Error('tags must be an array');
  const clean = [];
  tags.forEach(function (t) {
    if (!isValidTag(t)) throw new Error("invalid group tag: '" + t + "'");
    if (clean.indexOf(t) === -1) clean.push(t);
  });
  const map = loadForWrite(ctx);
  if (clean.length) map[name] = clean.sort();
  else delete map[name];
  save(ctx, map);
  return clean.slice();
}

function addTag(ctx, name, tag) {
  if (!profiles.isValidName(name)) throw new Error("invalid account name: '" + name + "'");
  if (!isValidTag(tag)) throw new Error("invalid group tag: '" + tag + "'");
  const map = loadForWrite(ctx);
  const cur = map[name] ? map[name].slice() : [];
  if (cur.indexOf(tag) === -1) cur.push(tag);
  map[name] = cur.sort();
  save(ctx, map);
  return cur.slice();
}

function removeTag(ctx, name, tag) {
  if (!profiles.isValidName(name)) throw new Error("invalid account name: '" + name + "'");
  const map = loadForWrite(ctx);
  const cur = (map[name] || []).filter(function (t) {
    return t !== tag;
  });
  if (cur.length) map[name] = cur.sort();
  else delete map[name];
  save(ctx, map);
  return cur.slice();
}

// ---- derived group views ----
// group -> [member accounts], the union over every account's tags (null-proto).
function listGroups(ctx) {
  const all = readAll(ctx);
  const out = Object.create(null);
  Object.keys(all).forEach(function (name) {
    all[name].forEach(function (tag) {
      if (!out[tag]) out[tag] = [];
      if (out[tag].indexOf(name) === -1) out[tag].push(name);
    });
  });
  Object.keys(out).forEach(function (g) {
    out[g].sort();
  });
  return out;
}

function membersOf(ctx, group) {
  if (!isValidTag(group)) return [];
  const all = readAll(ctx);
  return Object.keys(all)
    .filter(function (name) {
      return all[name].indexOf(group) !== -1;
    })
    .sort();
}

// Subset of a PROFILES ARRAY (order preserved — rotation order matters) whose
// .name is tagged `group`. Membership is checked via a null-proto set.
function filterProfiles(ctx, profs, group) {
  const set = Object.create(null);
  membersOf(ctx, group).forEach(function (m) {
    set[m] = true;
  });
  return (Array.isArray(profs) ? profs : []).filter(function (p) {
    return p && typeof p.name === 'string' && set[p.name] === true;
  });
}

export { groupsPath, isValidTag, readAll, tagsFor, setTags, addTag, removeTag, listGroups, membersOf, filterProfiles };
