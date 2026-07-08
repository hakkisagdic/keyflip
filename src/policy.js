'use strict';
// POLICY ENGINE: let an org constrain WHICH account a directory/repo may use
// ("client code only on the work account"). State lives in <configDir>/policy.json
// as { rules:[ {id, match:{cwdPrefix?,repo?}, allow?:{accounts?,groups?},
// deny?:{accounts?,groups?}, note?, createdAt? } ], default:'allow'|'deny' }.
//
// This is an ENFORCEMENT helper: switch/run/link call evaluate()/enforce() with the
// {cwd, account} they are about to activate. Decision model (deterministic, documented):
//   1. Collect rules whose `match` matches the context (cwdPrefix is a path-segment
//      prefix of cwd AND/OR repo equals the resolved repo; an empty match is global).
//   2. deny beats allow — an EXPLICIT deny on the account (by name or group) in ANY
//      matching rule is a hard block (the most specific such rule is reported).
//   3. Otherwise the MOST SPECIFIC matching rule (longest cwdPrefix; repo-qualified
//      wins ties) that expresses a constraint governs: an allow-set is an EXCLUSIVE
//      allowlist (account must be in it), a deny-only rule the account is not on is a
//      pass (blocklist).
//   4. If nothing constrains the account, fall back to `default`.
// Group membership is resolved via groups.membersOf (injectable). Everything is pure +
// validated; every map keyed by a user-supplied name is Object.create(null) so a hostile
// name (e.g. "__proto__") can never pollute a prototype.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const profiles = require('./profiles');
const groups = require('./groups');
const { atomicWrite, readJsonForWrite } = require('./fsutil');

// Compare paths PHYSICALLY (resolve symlinks): on macOS /tmp->/private/tmp etc., so a lexical
// path.resolve on the rule prefix vs the kernel's physical process.cwd() would make a deny rule
// silently fail open. realpathSync where the path exists; fall back to lexical for a non-existent
// path (e.g. a rule prefix for a not-yet-created dir).
function physical(p) { try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); } }

function policyPath(ctx) { return path.join(ctx.configDir, 'policy.json'); }

// A rule id must start alphanumeric and use only safe chars (bounded). It becomes a
// KEY in the null-proto dedupe map, so '__proto__' (fails the regex) can never enter.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isValidId(x) { return typeof x === 'string' && ID_RE.test(x); }

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g; // strip control chars incl. ANSI ESC from a free-text note
function scrub(s, max) { return String(s == null ? '' : s).replace(CTRL, ' ').trim().slice(0, max || 200); }

// ---- normalization (a tampered/hand-edited file can never inject a dangerous shape) --

function cleanNameList(arr, valid) {
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (x) { if (valid(x) && out.indexOf(x) === -1) out.push(x); });
  return out.sort();
}

// A {accounts?,groups?} bucket -> clean bucket, or null if it lists nothing usable.
function normalizeBucket(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const accounts = cleanNameList(b.accounts, profiles.isValidName);
  const grps = cleanNameList(b.groups, groups.isValidTag);
  if (!accounts.length && !grps.length) return null;
  const out = {};
  if (accounts.length) out.accounts = accounts;
  if (grps.length) out.groups = grps;
  return out;
}

function normalizeMatch(m) {
  const out = {};
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    if (typeof m.cwdPrefix === 'string' && m.cwdPrefix.trim()) out.cwdPrefix = m.cwdPrefix;
    if (typeof m.repo === 'string' && m.repo.trim()) out.repo = m.repo.trim();
  }
  return out;
}

// One parsed rule -> a clean rule, or null (dropped) if it has no valid id. Rules are
// machine-managed via addRule (which always assigns an id); dropping id-less/hostile
// entries mirrors groups.js's "drop junk" philosophy and keeps every id map safe.
function normalizeRule(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!isValidId(r.id)) return null;
  const rule = { id: r.id, match: normalizeMatch(r.match) };
  const allow = normalizeBucket(r.allow);
  const deny = normalizeBucket(r.deny);
  if (allow) rule.allow = allow;
  if (deny) rule.deny = deny;
  if (typeof r.note === 'string' && r.note.trim()) rule.note = scrub(r.note, 200);
  if (typeof r.createdAt === 'string') rule.createdAt = scrub(r.createdAt, 40);
  return rule;
}

function normalizeState(parsed) {
  const out = { rules: [], default: 'allow' };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  if (parsed.default === 'deny') out.default = 'deny';
  const seen = Object.create(null); // null-proto: a hostile id can't shadow a prototype key
  (Array.isArray(parsed.rules) ? parsed.rules : []).forEach(function (r) {
    const nr = normalizeRule(r);
    if (nr && !seen[nr.id]) { seen[nr.id] = true; out.rules.push(nr); }
  });
  return out;
}

// ---- state IO --------------------------------------------------------------------

// Read-only accessor: never throws — missing OR corrupt file degrades to the empty
// default state. Returns { rules:[...], default:'allow'|'deny' }.
function get(ctx) {
  let parsed;
  try { parsed = readJsonForWrite(policyPath(ctx)); } catch (e) { return { rules: [], default: 'allow' }; }
  return normalizeState(parsed);
}

// Read-for-write: a MISSING file is empty; a CORRUPT file THROWS (readJsonForWrite) so a
// read-modify-write never silently clobbers the user's real policy.
function loadForWrite(ctx) { return normalizeState(readJsonForWrite(policyPath(ctx))); }

function ruleForSave(r) {
  const out = { id: r.id, match: r.match || {} };
  if (r.allow) out.allow = r.allow;
  if (r.deny) out.deny = r.deny;
  if (r.note) out.note = r.note;
  if (r.createdAt) out.createdAt = r.createdAt;
  return out;
}

function save(ctx, state) {
  const out = { rules: state.rules.map(ruleForSave), default: state.default === 'deny' ? 'deny' : 'allow' };
  atomicWrite(policyPath(ctx), JSON.stringify(out, null, 2), 0o600);
}

// ---- mutations -------------------------------------------------------------------

function genId(state) {
  for (;;) { const id = 'r' + crypto.randomBytes(4).toString('hex'); if (!state.rules.some(function (r) { return r.id === id; })) return id; }
}

// Reject invalid account/group names LOUDLY (clear CLI/MCP error) rather than silently
// dropping them the way the tolerant read path does.
function assertNames(b) {
  if (!b || typeof b !== 'object') return;
  (Array.isArray(b.accounts) ? b.accounts : []).forEach(function (a) { if (!profiles.isValidName(a)) throw new Error("invalid account name: '" + a + "'"); });
  (Array.isArray(b.groups) ? b.groups : []).forEach(function (g) { if (!groups.isValidTag(g)) throw new Error("invalid group name: '" + g + "'"); });
}

// Add (append) a rule. Assigns an id when absent; rejects a duplicate/invalid id and a
// rule that constrains nothing. cwdPrefix is stored ABSOLUTE. Returns the stored rule.
function addRule(ctx, rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('rule must be an object');
  const match = normalizeMatch(rule.match);
  if (match.cwdPrefix) match.cwdPrefix = path.resolve(match.cwdPrefix);
  assertNames(rule.allow); assertNames(rule.deny);
  const allow = normalizeBucket(rule.allow);
  const deny = normalizeBucket(rule.deny);
  const note = typeof rule.note === 'string' ? scrub(rule.note, 200) : '';
  if (!allow && !deny && !match.cwdPrefix && !match.repo) throw new Error('a policy rule needs at least a match (cwdPrefix/repo) or an allow/deny set');
  if (rule.id != null && !isValidId(rule.id)) throw new Error("invalid rule id: '" + rule.id + "'");
  const state = loadForWrite(ctx);
  let id = rule.id;
  if (id == null) id = genId(state);
  else if (state.rules.some(function (r) { return r.id === id; })) throw new Error("rule id already exists: '" + id + "'");
  const nr = { id: id, match: match };
  if (allow) nr.allow = allow;
  if (deny) nr.deny = deny;
  if (note) nr.note = note;
  nr.createdAt = ctx.now();
  state.rules.push(nr);
  save(ctx, state);
  return nr;
}

function removeRule(ctx, id) {
  const state = loadForWrite(ctx);
  const before = state.rules.length;
  state.rules = state.rules.filter(function (r) { return r.id !== id; });
  if (state.rules.length === before) return false;
  save(ctx, state);
  return true;
}

function setDefault(ctx, def) {
  if (def !== 'allow' && def !== 'deny') throw new Error("default must be 'allow' or 'deny'");
  const state = loadForWrite(ctx);
  state.default = def;
  save(ctx, state);
  return def;
}

// ---- repo resolution (injectable — tests need no subprocess) ----------------------

// Normalize a repo identifier to a comparable "owner/repo" (lowercased): strips a
// trailing .git and slashes, and extracts the last owner/name pair from a git URL
// (git@host:owner/repo(.git), https://host/owner/repo(.git), ssh://…). A bare token or
// "owner/repo" is returned lowercased as-is.
function normalizeRepo(s) {
  if (typeof s !== 'string') return null;
  let x = s.trim();
  if (!x) return null;
  x = x.replace(/\.git$/i, '').replace(/[\/]+$/, '');
  const m = x.match(/[:/]([^/:]+\/[^/:]+)$/);
  if (m) x = m[1];
  return x.toLowerCase();
}

// Resolve the repo for a cwd. Fully injectable: opts.repoOf(cwd) short-circuits, else
// opts.run (default exec.run) shells out to git (origin url, else toplevel basename).
function resolveRepo(cwd, opts) {
  opts = opts || {};
  if (typeof opts.repoOf === 'function') { try { return normalizeRepo(opts.repoOf(cwd)); } catch (e) { return null; } }
  if (!cwd) return null;
  const run = opts.run || require('./exec').run;
  try {
    const r = run('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']);
    if (r && r.code === 0 && r.stdout && r.stdout.trim()) return normalizeRepo(r.stdout.trim());
    const t = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (t && t.code === 0 && t.stdout && t.stdout.trim()) return normalizeRepo(path.basename(t.stdout.trim()));
  } catch (e) { /* git absent / not a repo */ }
  return null;
}

// ---- evaluation ------------------------------------------------------------------

function caseFold(p, platform) { return (platform === 'win32' || platform === 'darwin') ? String(p).toLowerCase() : String(p); }

// Is `cwd` at or below `prefix`, PATH-SEGMENT aware (so /a/b matches /a/b and /a/b/c but
// never /a/bc)? Both are resolved; comparison honors the target platform's case rules.
function underPrefix(cwd, prefix, platform) {
  const c = caseFold(physical(cwd), platform);
  const p = caseFold(physical(prefix), platform);
  return c === p || c.indexOf(p + path.sep) === 0;
}

function bucketHas(b) { return !!(b && ((b.accounts && b.accounts.length) || (b.groups && b.groups.length))); }

// Longer resolved cwdPrefix = more specific; -1 for a rule with no cwdPrefix (global/repo-only).
function specificity(r) { return (r.match && typeof r.match.cwdPrefix === 'string' && r.match.cwdPrefix) ? path.resolve(r.match.cwdPrefix).length : -1; }

// evaluate(ctx, {cwd, account, repo?}, opts) -> { allowed, reason, ruleId }
// opts: { membersOf(group)->[names], repoOf(cwd)->repo, run } — all injectable for tests.
function evaluate(ctx, input, opts) {
  input = input || {}; opts = opts || {};
  const state = get(ctx);
  const def = state.default === 'deny' ? 'deny' : 'allow';
  const platform = ctx && ctx.platform;
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  const account = typeof input.account === 'string' ? input.account : '';
  const membersOf = typeof opts.membersOf === 'function' ? opts.membersOf : function (g) { return groups.membersOf(ctx, g); };

  // Resolve the repo lazily and once — only if a candidate rule actually needs it.
  let repoDone = false, repoVal = null;
  function repoOf() {
    if (input.repo != null) return normalizeRepo(input.repo);
    if (!repoDone) { repoDone = true; repoVal = resolveRepo(cwd, opts); }
    return repoVal;
  }

  function ruleMatches(r) {
    const m = r.match || {};
    if (typeof m.cwdPrefix === 'string' && m.cwdPrefix) {
      if (!cwd || !underPrefix(cwd, m.cwdPrefix, platform)) return false;
    }
    if (typeof m.repo === 'string' && m.repo) {
      const cr = repoOf();
      if (!cr || cr !== normalizeRepo(m.repo)) return false;
    }
    return true;
  }

  // Cache group membership lookups within this evaluation (null-proto set per group).
  const memCache = Object.create(null);
  function inBucket(b) {
    if (!b) return false;
    if (b.accounts && b.accounts.indexOf(account) !== -1) return true;
    if (b.groups) {
      for (let i = 0; i < b.groups.length; i++) {
        const g = b.groups[i];
        let set = memCache[g];
        if (!set) { set = Object.create(null); (membersOf(g) || []).forEach(function (n) { set[n] = true; }); memCache[g] = set; }
        if (set[account] === true) return true;
      }
    }
    return false;
  }

  const matches = state.rules.filter(ruleMatches);
  if (!matches.length) return { allowed: def === 'allow', reason: "no policy rule matches; default is '" + def + "'", ruleId: null };

  // Most specific first; a repo-qualified rule outranks a non-repo rule on a cwdPrefix tie.
  const sorted = matches.slice().sort(function (a, b) {
    const sa = specificity(a), sb = specificity(b);
    if (sa !== sb) return sb - sa;
    return ((b.match && b.match.repo) ? 1 : 0) - ((a.match && a.match.repo) ? 1 : 0);
  });

  // (2) deny beats allow: an explicit deny in ANY matching rule is a hard block.
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (inBucket(r.deny)) return { allowed: false, reason: "account '" + account + "' is explicitly denied here by rule " + r.id + (r.note ? ' (' + r.note + ')' : ''), ruleId: r.id };
  }

  // (3) most specific constraining rule governs the allow/allowlist decision.
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (bucketHas(r.allow)) {
      if (inBucket(r.allow)) return { allowed: true, reason: "allowed by rule " + r.id, ruleId: r.id };
      return { allowed: false, reason: "account '" + account + "' is not in the allowlist of rule " + r.id + (r.note ? ' (' + r.note + ')' : ''), ruleId: r.id };
    }
    if (bucketHas(r.deny)) return { allowed: true, reason: "allowed (not on the blocklist of rule " + r.id + ')', ruleId: r.id };
  }

  // (4) rules matched but none constrained the account -> default.
  return { allowed: def === 'allow', reason: "matching rule(s) set no account constraint; default is '" + def + "'", ruleId: sorted[0].id };
}

// enforce: evaluate and THROW a clear Error when disallowed; otherwise return the result.
// The error carries .code='POLICY_DENIED' and .policy (the evaluate result) so callers
// (switch/run/link) can special-case it.
function enforce(ctx, input, opts) {
  const res = evaluate(ctx, input, opts);
  if (!res.allowed) {
    const acct = (input && input.account) || 'account';
    const err = new Error("policy denied: account '" + acct + "' may not be used here — " + res.reason + (res.ruleId ? ' [rule ' + res.ruleId + ']' : ''));
    err.code = 'POLICY_DENIED';
    err.policy = res;
    throw err;
  }
  return res;
}

// ---- MCP tools (spliced into mcp.js TOOLS by the parent) -------------------------
// RO tools: list + check. MUT tools: add + remove — gated on confirm:true.
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
function needConfirm(args) { if (!args || args.confirm !== true) throw new Error('confirmation required: ask the user first, then call again with confirm=true'); }
const confirmProp = { confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' } };
const strArray = { type: 'array', items: { type: 'string' } };

const mcpTools = [
  {
    name: 'keyflip_policy_list',
    title: 'List account-usage policy rules',
    description: 'Read the policy that constrains which Claude account may be used in a directory/repo: every rule (match + allow/deny) and the global default. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) { return get(ctx); },
  },
  {
    name: 'keyflip_policy_check',
    title: 'Check whether an account is allowed here',
    description: 'Evaluate the policy for a given directory (and optional repo) + account WITHOUT switching. Returns { allowed, reason, ruleId }. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account name to test.' },
        cwd: { type: 'string', description: 'Directory to test (defaults to the process cwd).' },
        repo: { type: 'string', description: 'Optional repo id (e.g. "owner/name"); otherwise resolved from cwd via git.' },
      },
      required: ['account'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return evaluate(ctx, { account: String(args.account), cwd: args.cwd ? String(args.cwd) : process.cwd(), repo: args.repo != null ? String(args.repo) : undefined });
    },
  },
  {
    name: 'keyflip_policy_add',
    title: 'Add an account-usage policy rule',
    description: 'Add an allow or deny rule. `effect:"allow"` makes the listed accounts/groups the EXCLUSIVE set permitted where the rule matches; `effect:"deny"` blocks them (deny always beats allow). Scope with cwd_prefix and/or repo. Changes enforcement — ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        effect: { type: 'string', enum: ['allow', 'deny'], description: 'Whether the listed accounts/groups are allowed (exclusive) or denied.' },
        cwd_prefix: { type: 'string', description: 'Directory subtree the rule applies to.' },
        repo: { type: 'string', description: 'Repo id the rule applies to (e.g. "owner/name").' },
        accounts: Object.assign({ description: 'Account names.' }, strArray),
        groups: Object.assign({ description: 'Group names (resolved via keyflip groups).' }, strArray),
        note: { type: 'string', description: 'Optional human note (shown in denial reasons).' },
        id: { type: 'string', description: 'Optional explicit rule id (auto-generated otherwise).' },
        confirm: confirmProp.confirm,
      },
      required: ['effect', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      const bucket = { accounts: Array.isArray(args.accounts) ? args.accounts : [], groups: Array.isArray(args.groups) ? args.groups : [] };
      const rule = { match: {}, note: args.note, id: args.id };
      if (args.cwd_prefix) rule.match.cwdPrefix = String(args.cwd_prefix);
      if (args.repo) rule.match.repo = String(args.repo);
      if (args.effect === 'deny') rule.deny = bucket; else rule.allow = bucket;
      return { added: addRule(ctx, rule) };
    },
  },
  {
    name: 'keyflip_policy_remove',
    title: 'Remove an account-usage policy rule',
    description: 'Delete a policy rule by id (from keyflip_policy_list). Changes enforcement — ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Rule id to remove.' }, confirm: confirmProp.confirm },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) { needConfirm(args); return { removed: removeRule(ctx, String(args.id)) ? String(args.id) : null }; },
  },
];

module.exports = {
  policyPath: policyPath,
  get: get,
  addRule: addRule,
  removeRule: removeRule,
  setDefault: setDefault,
  evaluate: evaluate,
  enforce: enforce,
  normalizeRepo: normalizeRepo,
  resolveRepo: resolveRepo,
  isValidId: isValidId,
  mcpTools: mcpTools,
};
