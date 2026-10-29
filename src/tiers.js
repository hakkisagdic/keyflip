// SUBSCRIPTION TIERS (#12). Which Claude models an account's plan can actually
// serve, decided BEFORE a request is sent — a Free account cannot answer an Opus
// request, so failing over TO it wastes a round trip and hides the real problem.
//
// The tier is read from the account's captured OAuth blob (`subscriptionType`
// plus `rateLimitTier`, e.g. "max" + "default_claude_max_5x") and can be
// overridden per account with `keyflip tier <account> <tier>` when the vendor's
// string drifts. Everything here is PURE: no fs, no network, no ctx.
//
// UNKNOWN is permissive on purpose. A tier we cannot parse (a future plan name,
// a token-only capture) must never make keyflip refuse to route — it routes and
// reports `known:false`, so the user sees "unknown" instead of a wrong guess.

const TIER_IDS = ['free', 'pro', 'max', 'max5x', 'max20x', 'team', 'enterprise'];

// families: which Claude model families the plan may use. Free is the one plan
// that is known to exclude Opus; Pro and above include it today, but a per-account
// override can always tighten this.
const TIERS = Object.freeze({
  free: Object.freeze({ id: 'free', label: 'Free', rank: 0, families: Object.freeze(['haiku', 'sonnet']) }),
  pro: Object.freeze({ id: 'pro', label: 'Pro', rank: 1, families: Object.freeze(['haiku', 'sonnet', 'opus']) }),
  max: Object.freeze({ id: 'max', label: 'Max', rank: 2, families: Object.freeze(['haiku', 'sonnet', 'opus']) }),
  max5x: Object.freeze({ id: 'max5x', label: 'Max 5x', rank: 3, families: Object.freeze(['haiku', 'sonnet', 'opus']) }),
  max20x: Object.freeze({
    id: 'max20x',
    label: 'Max 20x',
    rank: 4,
    families: Object.freeze(['haiku', 'sonnet', 'opus']),
  }),
  team: Object.freeze({ id: 'team', label: 'Team', rank: 3, families: Object.freeze(['haiku', 'sonnet', 'opus']) }),
  enterprise: Object.freeze({
    id: 'enterprise',
    label: 'Enterprise',
    rank: 4,
    families: Object.freeze(['haiku', 'sonnet', 'opus']),
  }),
});

// Accept the spellings a human or an older keyflip might use.
const ALIASES = Object.freeze({
  freemium: 'free',
  basic: 'free',
  'max-5x': 'max5x',
  max_5x: 'max5x',
  '5x': 'max5x',
  max5: 'max5x',
  'max-20x': 'max20x',
  max_20x: 'max20x',
  '20x': 'max20x',
  max20: 'max20x',
  biz: 'team',
  business: 'team',
});

function parseTier(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(TIERS, s)) return s;
  if (Object.prototype.hasOwnProperty.call(ALIASES, s)) return ALIASES[s];
  return null;
}

// (subscriptionType, rateLimitTier) -> tier id | null. The rate-limit string is
// the more specific one ("default_claude_max_20x"), so its 5x/20x markers win
// before the generic "max" in subscriptionType.
function normalizeTier(subscriptionType, rateLimitTier) {
  const s = String(rateLimitTier || '') + ' ' + String(subscriptionType || '');
  const l = s.toLowerCase();
  if (!l.trim()) return null;
  if (/max[_ -]?20x/.test(l)) return 'max20x';
  if (/max[_ -]?5x/.test(l)) return 'max5x';
  if (/enterprise/.test(l)) return 'enterprise';
  if (/\bteam\b/.test(l)) return 'team';
  if (/\bmax\b|claude_max/.test(l)) return 'max';
  if (/\bpro\b/.test(l)) return 'pro';
  if (/\bfree\b|\bbasic\b/.test(l)) return 'free';
  return null;
}

// A stored credential blob -> tier id | null. Never throws on junk.
function fromBlob(blob) {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    return null;
  }
  const o = parsed && parsed.claudeAiOauth;
  if (!o || typeof o !== 'object') return null;
  return normalizeTier(o.subscriptionType, o.rateLimitTier);
}

// resolve(blob, meta) -> { id, label, rank, source, known, override, families }.
// A valid `meta.tier` override wins over the credential's own claim.
function resolve(blob, meta) {
  const override = meta && typeof meta.tier === 'string' ? parseTier(meta.tier) : null;
  const fromCred = fromBlob(blob);
  const id = override || fromCred;
  if (!id) {
    return {
      id: null,
      label: 'unknown',
      rank: -1,
      source: null,
      known: false,
      override: null,
      families: [],
    };
  }
  const t = TIERS[id];
  return {
    id: id,
    label: t.label,
    rank: t.rank,
    source: override ? 'override' : 'credentials',
    known: true,
    override: override || null,
    families: t.families.slice(),
  };
}

// Claude model family from an id, or null for a non-Claude / unknown model.
function familyOf(model) {
  const s = String(model == null ? '' : model).toLowerCase();
  if (!s) return null;
  if (s.indexOf('opus') !== -1) return 'opus';
  if (s.indexOf('sonnet') !== -1) return 'sonnet';
  if (s.indexOf('haiku') !== -1) return 'haiku';
  return null;
}

// allows(tierInfo, model) -> { allowed, known, family, reason }.
// Unknown tier or non-Claude model -> allowed with known:false (permissive).
function allows(tier, model) {
  const family = familyOf(model);
  if (!tier || !tier.known || !family) return { allowed: true, known: false, family: family, reason: null };
  if (tier.families.indexOf(family) !== -1) return { allowed: true, known: true, family: family, reason: null };
  return {
    allowed: false,
    known: true,
    family: family,
    reason: tier.label + ' plan cannot use ' + family + ' models',
  };
}

// A tier id -> its human label, for CLI output. Unknown ids pass through.
function labelOf(id) {
  const t = parseTier(id);
  return t ? TIERS[t].label : String(id == null ? 'unknown' : id);
}

// applyOverride(meta, raw) -> a COPY of the profile metadata with `tier` set to a
// validated id, or removed for 'auto'/empty. Throws on an unknown tier so a typo
// never lands on disk. The caller writes the result (profiles.write).
function applyOverride(meta, raw) {
  const out = Object.assign({}, meta || {});
  const s = raw == null ? '' : String(raw).trim().toLowerCase();
  if (s === '' || s === 'auto') {
    delete out.tier;
    return out;
  }
  const id = parseTier(s);
  if (!id) throw new Error("unknown tier '" + raw + "' (use: " + TIER_IDS.join(' | ') + ' | auto)');
  out.tier = id;
  return out;
}

export {
  TIER_IDS,
  TIERS,
  ALIASES,
  parseTier,
  normalizeTier,
  fromBlob,
  resolve,
  familyOf,
  allows,
  labelOf,
  applyOverride,
};
