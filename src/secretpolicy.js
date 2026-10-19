// #44 — SECRETS POLICY: "I know that one is there — stop calling it an alarm."
//
// The history scan (#41) is deliberately broad: any blob in the state repo that matches a secret shape
// is reported as `✗`, and `doctor` then tells the user to rotate the credential. That is right for a
// stray Anthropic key in a keepsake. It is wrong for the *expected* case — a free-tier Google AI key
// that keyflip stored where it was supposed to store it, and that the provider hands out for nothing.
// A permanent ✗ over a thing the user has decided is fine is not security, it is noise, and noise is
// what trains people to stop reading `keyflip doctor`.
//
// So the policy does ONE thing: it decides what still counts as an ALARM. It does not decide what is
// clean. A tolerated finding is silenced in the reports and drops out of the "rotate this credential"
// advice — and stays in the `scrub-history` plan, because a secret that is merely *unimportant* is
// still a secret that is merely *readable from an old commit*. Cleaning it costs nothing and is exactly
// what the user asked for ("geçmişte kalan sırları da temizlemek isterdim").
//
// Two rules keep this safe:
//   1. A rule is keyed on PATH + secret KIND, both of which the scan already reports. keyflip never
//      matches a toleration against the secret VALUE, so it never needs the value, never hashes it
//      (a hash of a low-entropy secret is a lookup table), and never writes one. This is the same
//      no-fingerprint rule `keyflip chains` holds itself to: the file this module writes is
//      git-versioned metadata, so it must be safe to read in public.
//   2. Fail closed and fail loud. An unparseable policy applies NOTHING (the alarms stay on, and the
//      report says the policy could not be read); a rule naming an unknown KIND is refused at add time
//      instead of matching nothing forever; a rule that would silence every finding on every path is
//      refused outright, because that is not a policy, it is the scan switched off.
//
// Kept OUT of scope on purpose: keyflip's own keepsakes (`memory/*.md`). A secret in a distilled note
// is never "an expected capture" — it is keyflip's own writing, it travels through recall/migrate/sync,
// and the fix is `memory audit --apply`, not a permission slip.
import fs from 'fs';
import path from 'path';
import * as fsutil from './fsutil.js';
import * as secretscan from './secretscan.js';

const SCHEMA_VERSION = 1;
const FILE_NAME = 'secrets-policy.json';
// The scan reports a capture under a secret dir with NO shape hit as `secretPath: true, kinds: []`.
// That is a finding, so it needs a label a rule can name — otherwise `--kind` could never address it.
const PATH_ONLY_LABEL = 'secret-path-capture';
// Everything a rule is allowed to name. Derived, so a new scanner pattern is tolerable without editing
// this file — and a typo in `--kind` is still refused.
const KNOWN_LABELS = secretscan.SECRET_PATTERNS.map(function (p) {
  return p.label;
}).concat([PATH_ONLY_LABEL]);
const MAX_NOTE = 300;
const MAX_PATH = 300;

function fileFor(ctx) {
  return path.join(ctx.configDir, FILE_NAME);
}

// ---- patterns ----------------------------------------------------------------
// A rule path is matched against what `git rev-list --objects` printed, i.e. a path RELATIVE to the
// state dir — never against the filesystem. So the accepted shape is the one `doctor --history` and
// `keyflip_history_audit` already show the user, verbatim.
//   'surfaces/kiro/work/auth.json'  exact
//   'surfaces/kiro/'                everything below (a directory prefix)
//   '*.json', 'app/claude*'         '*' matches inside ONE path segment, never across '/'
// The last one matters: a `*` that crossed '/' would make `*.json` a rule for the whole repo, which is
// how a policy intended for one account profile ends up silencing a token cache three dirs deep.
function patternToRegExp(pattern) {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === '*') re += '[^/]*';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

function matchPath(pattern, file) {
  const f = String(file == null ? '' : file);
  if (pattern === '*') return true; // the explicit "any path" rule; refused as a default below
  if (pattern.slice(-1) === '/') {
    const dirName = pattern.slice(0, -1);
    return f.indexOf(dirName + '/') === 0 || f === dirName;
  }
  if (pattern.indexOf('*') !== -1) return patternToRegExp(pattern).test(f);
  return f === pattern;
}

// A user pastes what they saw, so tolerate the friendly forms: an absolute path under the state dir is
// made relative, separators are folded to '/', a leading './' is dropped. Anything that still reaches
// outside the repo is refused — "tolerated" must never be able to mean "unscanned, somewhere else".
function normalizePattern(input, ctx) {
  let p = String(input == null ? '' : input)
    .trim()
    .replace(/\\/g, '/');
  if (!p) return { error: 'a rule needs a path (or "*" for any path) — see keyflip secrets list' };
  if (p.slice(0, 2) === './') p = p.slice(2);
  // A pasted path can be POSIX (`/…`) or a Windows drive path (`C:/…` after the fold above).
  if ((p.charAt(0) === '/' || /^[A-Za-z]:\//.test(p)) && ctx && ctx.configDir) {
    // Containment is decided by path.relative, not by a leading character: a Windows drive path
    // is native only on Windows, and on Windows `\etc\passwd` is already absolute (an UNC-rooted
    // relative result), so `indexOf('..')` alone would let it slip through.
    const native = /^[A-Za-z]:\//.test(p) && path.sep === '\\' ? p : p.split('/').join(path.sep);
    const rel = path.relative(ctx.configDir, native);
    const inside = rel && rel !== '..' && !path.isAbsolute(rel) && rel.indexOf('..' + path.sep) !== 0;
    if (inside) p = rel.split(path.sep).join('/');
    else return { error: 'that path is not inside the state repo (' + ctx.configDir + ') — rules are repo-relative' };
  }
  if (p.indexOf('..') !== -1) return { error: 'a rule path cannot contain ".." — rules are relative to the state dir' };
  if (p.length > MAX_PATH) return { error: 'a rule path cannot be longer than ' + MAX_PATH + ' characters' };
  return { pattern: p };
}

// ---- rules -------------------------------------------------------------------

// Fold a hand-edited or older record into the shape callers may rely on. `null` = this rule is not a
// rule at all (and is counted as `dropped`, never silently hidden — a policy that lost a line would
// report itself as "nothing is tolerated").
function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pattern = String(raw.path == null ? '' : raw.path)
    .trim()
    .replace(/\\/g, '/');
  if (!pattern || pattern.charAt(0) === '/' || pattern.indexOf('..') !== -1 || pattern.length > MAX_PATH) return null;
  const given = Array.isArray(raw.kinds) ? raw.kinds : [];
  const kinds = [];
  for (let i = 0; i < given.length; i++) {
    const k = String(given[i] == null ? '' : given[i]).trim();
    if (!k) continue;
    if (KNOWN_LABELS.indexOf(k) === -1) return null; // an unknown KIND is a typo, not a wildcard
    if (kinds.indexOf(k) === -1) kinds.push(k);
  }
  kinds.sort();
  const out = { path: pattern, kinds: kinds };
  if (typeof raw.note === 'string' && raw.note.trim()) out.note = raw.note.trim().slice(0, MAX_NOTE);
  if (typeof raw.addedAt === 'string') out.addedAt = raw.addedAt;
  return out;
}

// The one combination that must never be writable: "everything, of any kind". A policy like that is the
// history scan switched off while still looking like a policy.
function isBlanketRule(rule) {
  return rule.path === '*' && !rule.kinds.length;
}

// ---- read ----------------------------------------------------------------------

/**
 * Load the policy. Never throws: a state dir with no policy yet is an empty policy, and a policy that
 * cannot be read is reported (`error`/`dropped`) while applying NOTHING — so its findings stay alarms.
 * @param {object} ctx - keyflip context.
 * @returns {{file:string, exists:boolean, rules:Array, dropped:number, error:string|null, broad:Array}}
 */
function load(ctx) {
  const file = fileFor(ctx);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { file: file, exists: false, rules: [], dropped: 0, error: null, broad: [] };
    return {
      file: file,
      exists: true,
      rules: [],
      dropped: 0,
      error: 'could not read it (' + String((e && e.message) || e) + ')',
      broad: [],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      file: file,
      exists: true,
      rules: [],
      dropped: 0,
      error: 'it is not valid JSON, so NO rule was applied — the alarms below are complete',
      broad: [],
    };
  }
  const given = parsed && Array.isArray(parsed.rules) ? parsed.rules : [];
  const rules = [];
  let dropped = 0;
  given.forEach(function (r) {
    const n = normalizeRule(r);
    if (!n || isBlanketRule(n)) {
      dropped++;
      return;
    }
    rules.push(n);
  });
  return {
    file: file,
    exists: true,
    rules: rules,
    dropped: dropped,
    error: parsed && !Array.isArray(parsed.rules) ? 'it holds no rules list, so NO rule was applied' : null,
    broad: rules.filter(function (r) {
      return r.path === '*' || r.path.indexOf('*') !== -1 || r.path.slice(-1) === '/';
    }),
  };
}

/**
 * Add a rule. Refuses (rather than writes) a blank rule, an escaping path, an unknown KIND, the blanket
 * rule, and — the one a human would never think of — a rule whose NOTE carries a secret, which is
 * redacted first so the state repo keeps no fingerprint of a value.
 * @param {object} ctx - keyflip context.
 * @param {object} input - { path, kinds?, note?, now? }
 * @returns {{ok:boolean, reason?:string, rule?:object, replaced?:object, noteRedacted?:number}}
 */
function addRule(ctx, input) {
  input = input || {};
  const norm = normalizePattern(input.path, ctx);
  if (norm.error) return { ok: false, reason: norm.error };
  const kinds = [];
  const givenKinds = Array.isArray(input.kinds) ? input.kinds : [];
  for (let i = 0; i < givenKinds.length; i++) {
    const k = String(givenKinds[i] == null ? '' : givenKinds[i]).trim();
    if (!k) continue;
    if (KNOWN_LABELS.indexOf(k) === -1)
      return {
        ok: false,
        reason:
          'unknown secret kind ' +
          JSON.stringify(k) +
          ' — keyflip does not scan for that, so the rule would match nothing and the alarm would stay on forever. Known kinds: ' +
          KNOWN_LABELS.join(', '),
      };
    if (kinds.indexOf(k) === -1) kinds.push(k);
  }
  kinds.sort();
  const rule = { path: norm.pattern, kinds: kinds };
  if (isBlanketRule(rule))
    return {
      ok: false,
      reason:
        'a rule for "*" with no kind would silence every finding everywhere — that is the history scan switched off. Name a path, or name a kind with --kind.',
    };
  let noteRedacted = 0;
  if (typeof input.note === 'string' && input.note.trim()) {
    const red = secretscan.redactConfig(input.note.trim().slice(0, MAX_NOTE));
    noteRedacted = red.count;
    if (red.text) rule.note = red.text;
  }
  rule.addedAt = String(
    (input.now ? input.now() : null) || (typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString()),
  );

  const cur = load(ctx);
  if (cur.error) return { ok: false, reason: fileFor(ctx) + ' ' + cur.error + ' — fix it before adding a rule' };
  const same = cur.rules.filter(function (r) {
    return r.path === rule.path && r.kinds.join() === rule.kinds.join();
  })[0];
  const rules = cur.rules.filter(function (r) {
    return !(r.path === rule.path && r.kinds.join() === rule.kinds.join());
  });
  rules.push(rule);
  save(ctx, rules);
  return { ok: true, rule: rule, replaced: same || null, noteRedacted: noteRedacted };
}

/**
 * Remove rules by path pattern (exact match against the stored rule path); `kinds` narrows it to the
 * rules that also carry those kinds. Deliberately removes EVERY rule on that path when kinds are not
 * given — "untolerate this file" should not leave a half-policy behind.
 * @returns {{ok:boolean, removed:Array, kept:Array, reason?:string}}
 */
function removeRule(ctx, input) {
  input = input || {};
  const norm = normalizePattern(input.path, ctx);
  if (norm.error) return { ok: false, removed: [], kept: [], reason: norm.error };
  const cur = load(ctx);
  if (cur.error)
    return { ok: false, removed: [], kept: cur.rules, reason: fileFor(ctx) + ' ' + cur.error + ' — fix it first' };
  const kinds = (Array.isArray(input.kinds) ? input.kinds : []).map(function (k) {
    return String(k).trim();
  });
  const removed = [];
  const kept = [];
  cur.rules.forEach(function (r) {
    const onPath = r.path === norm.pattern;
    const onKinds =
      !kinds.length || (kinds.length === r.kinds.length && kinds.slice().sort().join() === r.kinds.join());
    if (onPath && onKinds) removed.push(r);
    else kept.push(r);
  });
  if (!removed.length) return { ok: true, removed: [], kept: kept, reason: 'no rule matched that path' };
  save(ctx, kept);
  return { ok: true, removed: removed, kept: kept };
}

function save(ctx, rules) {
  const body = { schemaVersion: SCHEMA_VERSION, rules: rules.slice().sort(pathThenKinds) };
  fsutil.writeJsonStable(fileFor(ctx), body, 0o600);
  return body;
}
function pathThenKinds(a, b) {
  return String(a.path).localeCompare(String(b.path)) || a.kinds.join().localeCompare(b.kinds.join());
}

// ---- matching findings ---------------------------------------------------------

// The kinds a finding is *known by*: a shape hit, or the dir-based label when the only evidence is the
// path. Kept as one function so display, matching and the JSON payload can never disagree.
function labelsOf(leak) {
  const k = Array.isArray(leak.kinds) ? leak.kinds.filter(Boolean) : [];
  return k.length ? k.slice().sort() : [PATH_ONLY_LABEL];
}

// The whole match, in one place: the path has to cover the file AND (unless the rule is "any kind") at
// least one of the finding's KINDs has to be one the user named. Keeping this as one function is what
// makes `coverageOf` and `classify` agree — a report that counted differently from the verdict would be
// the confusing kind of wrong.
function ruleMatches(rule, file, labels) {
  if (!matchPath(rule.path, file)) return false;
  if (!rule.kinds.length) return true;
  return rule.kinds.some(function (k) {
    return labels.indexOf(k) !== -1;
  });
}

// Exact paths beat prefixes beat globs; naming kinds beats matching any kind. `classify` orders rules by
// this so a rule for one file wins over a directory prefix that also covers it — the match the user
// wrote on purpose is the one reported as the reason.
function scoreRule(rule) {
  let s = 0;
  if (rule.path !== '*') s += rule.path.slice(-1) === '/' ? 20 : 40;
  if (rule.path.indexOf('*') !== -1) s -= 10;
  if (rule.kinds.length) s += 5;
  return s;
}

/**
 * Annotate scan findings with the policy. Pure — reads the policy, writes nothing.
 * @param {object} ctx - keyflip context.
 * @param {Array} leaks - leakscan.historyLeaks().leaks
 * @param {object} [opts] - { policy } to pass an already-loaded policy (or a pre-#44 ctx in tests).
 * @returns {{findings:Array, alarms:Array, tolerated:Array, rules:Array, policyError:string|null, dropped:number}}
 *          Each finding is the ORIGINAL leak object plus `labels`, `tolerated` and, when silenced,
 *          `by` — so a caller can filter without losing anything the scanner reported.
 */
function classify(ctx, leaks, opts) {
  opts = opts || {};
  const pol = opts.policy || load(ctx);
  const ordered = (pol.rules || [])
    .map(function (r) {
      return { rule: r, score: scoreRule(r) };
    })
    .sort(function (a, b) {
      return b.score - a.score || String(a.rule.path).localeCompare(String(b.rule.path));
    })
    .map(function (w) {
      return w.rule;
    });
  const findings = [];
  const alarms = [];
  const tolerated = [];
  (leaks || []).forEach(function (l) {
    const labels = labelsOf(l);
    let by = null;
    for (let i = 0; i < ordered.length; i++) {
      if (!ruleMatches(ordered[i], l.file, labels)) continue;
      by = ordered[i];
      break;
    }
    const f = Object.assign({}, l, { labels: labels, tolerated: !!by });
    if (by) {
      f.by = by.path + (by.kinds.length ? ' [' + by.kinds.join(',') + ']' : '');
      if (by.note) f.byNote = by.note;
      tolerated.push(f);
    } else alarms.push(f);
    findings.push(f);
  });
  return {
    findings: findings,
    alarms: alarms,
    tolerated: tolerated,
    rules: pol.rules || [],
    policyError: pol.error || null,
    dropped: pol.dropped || 0,
    broad: pol.broad || [],
  };
}

// ---- reporting -----------------------------------------------------------------

// How many findings — and which DISTINCT paths — one rule actually silences. A kind-only rule
// (`--kind google-api-key`) is the convenient form and the easy way to make three unrelated files
// invisible, so `list` shows the reach instead of pretending it is one decision.
function coverageOf(ctx, leaks, rule) {
  const all = (leaks || []).filter(function (l) {
    return ruleMatches(rule, l.file, labelsOf(l));
  });
  const paths = [];
  all.forEach(function (l) {
    if (paths.indexOf(l.file) === -1) paths.push(l.file);
  });
  return { findings: all.length, paths: paths };
}

export {
  SCHEMA_VERSION,
  FILE_NAME,
  PATH_ONLY_LABEL,
  KNOWN_LABELS,
  fileFor,
  normalizePattern,
  normalizeRule,
  isBlanketRule,
  matchPath,
  ruleMatches,
  labelsOf,
  load,
  save,
  addRule,
  removeRule,
  classify,
  coverageOf,
};
