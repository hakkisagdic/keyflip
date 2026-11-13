// POLICY ENGINE:
// 1) Let an org constrain WHICH account a directory/repo may use ("client code only on the work account").
// 2) Outbound Proxy Guardrail (`off` | `redact` | `block`) that inspects outgoing request bodies for
//    raw secrets (sk-ant-..., sk-proj-..., AKIA..., GitHub/Slack tokens) and PII (email, phone, TCKN,
//    credit cards, IBAN) before traffic leaves the machine.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as profiles from './profiles.js';
import * as groups from './groups.js';
import * as pii from './pii.js';
import * as license from './license.js';
import { atomicWrite, readJsonForWrite } from './fsutil.js';
import * as _exec from './exec.js';

const GUARDRAIL_MODES = ['off', 'redact', 'block'];
const GUARDRAIL_CATEGORIES = ['secret', 'email', 'phone', 'tckn', 'creditCard', 'iban'];

function physical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    return path.resolve(p);
  }
}

function policyPath(ctx) {
  return path.join(ctx.configDir, 'policy.json');
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isValidId(x) {
  return typeof x === 'string' && ID_RE.test(x);
}

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g;
function scrub(s, max) {
  return String(s == null ? '' : s)
    .replace(CTRL, ' ')
    .trim()
    .slice(0, max || 200);
}

function cleanNameList(arr, valid) {
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (x) {
    if (valid(x) && out.indexOf(x) === -1) out.push(x);
  });
  return out.sort();
}

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
  if (m && typeof m !== 'object' && !Array.isArray(m)) return out;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    if (typeof m.cwdPrefix === 'string' && m.cwdPrefix.trim()) out.cwdPrefix = m.cwdPrefix;
    if (typeof m.repo === 'string' && m.repo.trim()) out.repo = m.repo.trim();
  }
  return out;
}

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
  if (GUARDRAIL_MODES.indexOf(parsed.guardrail) !== -1 && parsed.guardrail !== 'off') {
    out.guardrail = parsed.guardrail;
  }
  const seen = Object.create(null);
  (Array.isArray(parsed.rules) ? parsed.rules : []).forEach(function (r) {
    const nr = normalizeRule(r);
    if (nr && !seen[nr.id]) {
      seen[nr.id] = true;
      out.rules.push(nr);
    }
  });
  return out;
}

function get(ctx) {
  let parsed;
  try {
    parsed = readJsonForWrite(policyPath(ctx));
  } catch (e) {
    return { rules: [], default: 'allow' };
  }
  const st = normalizeState(parsed);
  return { rules: st.rules, default: st.default };
}

function loadForWrite(ctx) {
  return normalizeState(readJsonForWrite(policyPath(ctx)));
}

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
  if (state.guardrail && GUARDRAIL_MODES.indexOf(state.guardrail) !== -1 && state.guardrail !== 'off') {
    out.guardrail = state.guardrail;
  }
  atomicWrite(policyPath(ctx), JSON.stringify(out, null, 2), 0o600);
}

// ---- Outbound Proxy Guardrail (off | redact | block) -------------------------

function getGuardrail(ctx) {
  try {
    const parsed = readJsonForWrite(policyPath(ctx));
    if (parsed && GUARDRAIL_MODES.indexOf(parsed.guardrail) !== -1) {
      return parsed.guardrail;
    }
  } catch (e) {
    /* fall through */
  }
  return 'off';
}

function setGuardrail(ctx, mode) {
  const m = String(mode || '').toLowerCase();
  if (GUARDRAIL_MODES.indexOf(m) === -1) {
    throw new Error("guardrail mode must be 'off', 'redact', or 'block'");
  }
  const state = loadForWrite(ctx);
  if (m === 'off') delete state.guardrail;
  else state.guardrail = m;
  save(ctx, state);
  return m;
}

function resolveNonOverlapping(matches) {
  const sorted = (matches || []).slice().sort(function (a, b) {
    return a.start - b.start || b.end - a.end;
  });
  const kept = [];
  let lastEnd = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].start >= lastEnd) {
      kept.push(sorted[i]);
      lastEnd = sorted[i].end;
    }
  }
  return kept;
}

// Inspect an outgoing proxy request body according to the active guardrail mode
// ('off' | 'redact' | 'block').
//   - 'off': no-op, returns { action: 'allow', mode: 'off', body, redactedCount: 0, findings: [] }
//   - 'redact': masks secrets with '[REDACTED_SECRET]' and PII with '[REDACTED_PII:<label>]',
//               increments license.recordUsage(ctx, { leaksBlocked: N }), and returns modified body.
//   - 'block': refuses the request with { action: 'block', status: 422, code: 'GUARDRAIL_BLOCKED', ... }
//              when any secret or PII is detected.
function inspectOutboundBody(ctx, body, opts) {
  opts = opts || {};
  const mode = opts.mode && GUARDRAIL_MODES.indexOf(opts.mode) !== -1 ? opts.mode : getGuardrail(ctx);
  if (mode === 'off' || body == null || (Buffer.isBuffer(body) && body.length === 0)) {
    return { action: 'allow', mode: mode, body: body, redactedCount: 0, findings: [] };
  }
  const isBuf = Buffer.isBuffer(body);
  const text = isBuf ? body.toString('utf8') : String(body);
  if (!text) {
    return { action: 'allow', mode: mode, body: body, redactedCount: 0, findings: [] };
  }

  const rawMatches = pii.detect(text, {
    categories: opts.categories || GUARDRAIL_CATEGORIES,
    custom: ctx ? pii.loadCustom(ctx) : [],
  });
  const kept = resolveNonOverlapping(rawMatches);
  if (!kept.length) {
    return { action: 'allow', mode: mode, body: body, redactedCount: 0, findings: [] };
  }

  const findingSet = new Set();
  for (let i = 0; i < kept.length; i++) findingSet.add(kept[i].label);
  const findings = Array.from(findingSet).sort();

  if (mode === 'block') {
    if (ctx && ctx.configDir) {
      try {
        license.recordUsage(ctx, { leaksBlocked: kept.length });
      } catch (e) {
        /* best effort */
      }
    }
    return {
      action: 'block',
      mode: 'block',
      status: 422,
      code: 'GUARDRAIL_BLOCKED',
      redactedCount: kept.length,
      findings: findings,
      reason: 'outbound request blocked by guardrail (' + findings.join(', ') + ' detected)',
      body: body,
    };
  }

  // mode === 'redact'
  let redacted = '';
  let pos = 0;
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i];
    const token = m.label === 'secret' ? '[REDACTED_SECRET]' : '[REDACTED_PII:' + m.label + ']';
    redacted += text.slice(pos, m.start) + token;
    pos = m.end;
  }
  redacted += text.slice(pos);

  if (ctx && ctx.configDir) {
    try {
      license.recordUsage(ctx, { leaksBlocked: kept.length });
    } catch (e) {
      /* best effort */
    }
  }

  return {
    action: 'redact',
    mode: 'redact',
    body: isBuf ? Buffer.from(redacted, 'utf8') : redacted,
    redactedCount: kept.length,
    findings: findings,
  };
}

// ---- mutations -------------------------------------------------------------------

function genId(state) {
  for (;;) {
    const id = 'r' + crypto.randomBytes(4).toString('hex');
    if (
      !state.rules.some(function (r) {
        return r.id === id;
      })
    )
      return id;
  }
}

function assertNames(b) {
  if (!b || typeof b !== 'object') return;
  (Array.isArray(b.accounts) ? b.accounts : []).forEach(function (a) {
    if (!profiles.isValidName(a)) throw new Error("invalid account name: '" + a + "'");
  });
  (Array.isArray(b.groups) ? b.groups : []).forEach(function (g) {
    if (!groups.isValidTag(g)) throw new Error("invalid group name: '" + g + "'");
  });
}

function addRule(ctx, rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('rule must be an object');
  const match = normalizeMatch(rule.match);
  if (match.cwdPrefix) match.cwdPrefix = path.resolve(match.cwdPrefix);
  assertNames(rule.allow);
  assertNames(rule.deny);
  const allow = normalizeBucket(rule.allow);
  const deny = normalizeBucket(rule.deny);
  const note = typeof rule.note === 'string' ? scrub(rule.note, 200) : '';
  if (!allow && !deny && !match.cwdPrefix && !match.repo)
    throw new Error('a policy rule needs at least a match (cwdPrefix/repo) or an allow/deny set');
  if (rule.id != null && !isValidId(rule.id)) throw new Error("invalid rule id: '" + rule.id + "'");
  const state = loadForWrite(ctx);
  let id = rule.id;
  if (id == null) id = genId(state);
  else if (
    state.rules.some(function (r) {
      return r.id === id;
    })
  )
    throw new Error("rule id already exists: '" + id + "'");
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
  state.rules = state.rules.filter(function (r) {
    return r.id !== id;
  });
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

// ---- repo resolution (injectable) ------------------------------------------------

function normalizeRepo(s) {
  if (typeof s !== 'string') return null;
  let x = s.trim();
  if (!x) return null;
  x = x.replace(/\.git$/i, '').replace(/[/]+$/, '');
  const m = x.match(/[:/]([^/:]+\/[^/:]+)$/);
  if (m) x = m[1];
  return x.toLowerCase();
}

function resolveRepo(cwd, opts) {
  opts = opts || {};
  if (typeof opts.repoOf === 'function') {
    try {
      return normalizeRepo(opts.repoOf(cwd));
    } catch (e) {
      return null;
    }
  }
  if (!cwd) return null;
  const run = opts.run || _exec.run;
  try {
    const r = run('git', ['-C', cwd, 'config', '--get', 'remote.origin.url']);
    if (r && r.code === 0 && r.stdout && r.stdout.trim()) return normalizeRepo(r.stdout.trim());
    const t = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    if (t && t.code === 0 && t.stdout && t.stdout.trim()) return normalizeRepo(path.basename(t.stdout.trim()));
  } catch (e) {
    /* git absent / not a repo */
  }
  return null;
}

// ---- evaluation ------------------------------------------------------------------

function caseFold(p, platform) {
  return platform === 'win32' || platform === 'darwin' ? String(p).toLowerCase() : String(p);
}

function underPrefix(cwd, prefix, platform) {
  const c = caseFold(physical(cwd), platform);
  const p = caseFold(physical(prefix), platform);
  return c === p || c.indexOf(p + path.sep) === 0;
}

function bucketHas(b) {
  return !!(b && ((b.accounts && b.accounts.length) || (b.groups && b.groups.length)));
}

function specificity(r) {
  return r.match && typeof r.match.cwdPrefix === 'string' && r.match.cwdPrefix
    ? path.resolve(r.match.cwdPrefix).length
    : -1;
}

function evaluate(ctx, input, opts) {
  input = input || {};
  opts = opts || {};
  const state = get(ctx);
  const def = state.default === 'deny' ? 'deny' : 'allow';
  const platform = ctx && ctx.platform;
  const cwd = input.cwd ? path.resolve(input.cwd) : null;
  const account = typeof input.account === 'string' ? input.account : '';
  const membersOf =
    typeof opts.membersOf === 'function'
      ? opts.membersOf
      : function (g) {
          return groups.membersOf(ctx, g);
        };

  let repoDone = false,
    repoVal = null;
  function repoOf() {
    if (input.repo != null) return normalizeRepo(input.repo);
    if (!repoDone) {
      repoDone = true;
      repoVal = resolveRepo(cwd, opts);
    }
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

  const memCache = Object.create(null);
  function inBucket(b) {
    if (!b) return false;
    if (b.accounts && b.accounts.indexOf(account) !== -1) return true;
    if (b.groups) {
      for (let i = 0; i < b.groups.length; i++) {
        const g = b.groups[i];
        let set = memCache[g];
        if (!set) {
          set = Object.create(null);
          (membersOf(g) || []).forEach(function (n) {
            set[n] = true;
          });
          memCache[g] = set;
        }
        if (set[account] === true) return true;
      }
    }
    return false;
  }

  const matches = state.rules.filter(ruleMatches);
  if (!matches.length)
    return { allowed: def === 'allow', reason: "no policy rule matches; default is '" + def + "'", ruleId: null };

  const sorted = matches.slice().sort(function (a, b) {
    const sa = specificity(a),
      sb = specificity(b);
    if (sa !== sb) return sb - sa;
    return (b.match && b.match.repo ? 1 : 0) - (a.match && a.match.repo ? 1 : 0);
  });

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (inBucket(r.deny))
      return {
        allowed: false,
        reason:
          "account '" + account + "' is explicitly denied here by rule " + r.id + (r.note ? ' (' + r.note + ')' : ''),
        ruleId: r.id,
      };
  }

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (bucketHas(r.allow)) {
      if (inBucket(r.allow)) return { allowed: true, reason: 'allowed by rule ' + r.id, ruleId: r.id };
      return {
        allowed: false,
        reason:
          "account '" + account + "' is not in the allowlist of rule " + r.id + (r.note ? ' (' + r.note + ')' : ''),
        ruleId: r.id,
      };
    }
    if (bucketHas(r.deny))
      return { allowed: true, reason: 'allowed (not on the blocklist of rule ' + r.id + ')', ruleId: r.id };
  }

  return {
    allowed: def === 'allow',
    reason: "matching rule(s) set no account constraint; default is '" + def + "'",
    ruleId: sorted[0].id,
  };
}

function enforce(ctx, input, opts) {
  const res = evaluate(ctx, input, opts);
  if (!res.allowed) {
    const acct = (input && input.account) || 'account';
    const err = new Error(
      "policy denied: account '" +
        acct +
        "' may not be used here \u2014 " +
        res.reason +
        (res.ruleId ? ' [rule ' + res.ruleId + ']' : ''),
    );
    err.code = 'POLICY_DENIED';
    err.policy = res;
    throw err;
  }
  return res;
}

// ---- MCP tools -------------------------------------------------------------------
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
function needConfirm(args) {
  if (!args || args.confirm !== true)
    throw new Error('confirmation required: ask the user first, then call again with confirm=true');
}
const confirmProp = {
  confirm: { type: 'boolean', description: 'Must be true \u2014 set it only after the user has agreed.' },
};
const strArray = { type: 'array', items: { type: 'string' } };

const mcpTools = [
  {
    name: 'keyflip_policy_list',
    title: 'List account-usage policy rules',
    description:
      'Read the policy that constrains which Claude account may be used in a directory/repo: every rule (match + allow/deny) and the global default. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async function (ctx) {
      return get(ctx);
    },
  },
  {
    name: 'keyflip_policy_check',
    title: 'Check whether an account is allowed here',
    description:
      'Evaluate the policy for a given directory (and optional repo) + account WITHOUT switching. Returns { allowed, reason, ruleId }. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account name to test.' },
        cwd: { type: 'string', description: 'Directory to test (defaults to the process cwd).' },
        repo: {
          type: 'string',
          description: 'Optional repo id (e.g. "owner/name"); otherwise resolved from cwd via git.',
        },
      },
      required: ['account'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      return evaluate(ctx, {
        account: String(args.account),
        cwd: args.cwd ? String(args.cwd) : process.cwd(),
        repo: args.repo != null ? String(args.repo) : undefined,
      });
    },
  },
  {
    name: 'keyflip_policy_add',
    title: 'Add an account-usage policy rule',
    description:
      'Add an allow or deny rule. `effect:"allow"` makes the listed accounts/groups the EXCLUSIVE set permitted where the rule matches; `effect:"deny"` blocks them (deny always beats allow). Scope with cwd_prefix and/or repo. Changes enforcement \u2014 ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        effect: {
          type: 'string',
          enum: ['allow', 'deny'],
          description: 'Whether the listed accounts/groups are allowed (exclusive) or denied.',
        },
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
      const bucket = {
        accounts: Array.isArray(args.accounts) ? args.accounts : [],
        groups: Array.isArray(args.groups) ? args.groups : [],
      };
      const rule = { match: {}, note: args.note, id: args.id };
      if (args.cwd_prefix) rule.match.cwdPrefix = String(args.cwd_prefix);
      if (args.repo) rule.match.repo = String(args.repo);
      if (args.effect === 'deny') rule.deny = bucket;
      else rule.allow = bucket;
      return { added: addRule(ctx, rule) };
    },
  },
  {
    name: 'keyflip_policy_remove',
    title: 'Remove an account-usage policy rule',
    description:
      'Delete a policy rule by id (from keyflip_policy_list). Changes enforcement \u2014 ask the user first, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Rule id to remove.' }, confirm: confirmProp.confirm },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      needConfirm(args);
      return { removed: removeRule(ctx, String(args.id)) ? String(args.id) : null };
    },
  },
  {
    name: 'keyflip_policy_guardrail',
    title: 'Get or set outbound proxy PII & secret guardrail mode',
    description:
      'Read or update the outbound proxy guardrail mode ("off" | "redact" | "block"). In "redact" mode, raw API keys and PII (emails, phones, TCKN, credit cards, IBAN) are masked before leaving the machine; in "block" mode, requests containing secrets/PII are rejected with 422 GUARDRAIL_BLOCKED.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['off', 'redact', 'block'] },
        confirm: confirmProp.confirm,
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      if (!args || !args.mode) {
        return { guardrail: getGuardrail(ctx) };
      }
      needConfirm(args);
      return { guardrail: setGuardrail(ctx, String(args.mode)) };
    },
  },
];

export {
  policyPath,
  get,
  addRule,
  removeRule,
  setDefault,
  getGuardrail,
  setGuardrail,
  inspectOutboundBody,
  GUARDRAIL_MODES,
  evaluate,
  enforce,
  normalizeRepo,
  resolveRepo,
  isValidId,
  mcpTools,
};
