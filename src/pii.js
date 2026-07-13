'use strict';
// PII detector/redactor. keyflip already refuses to carry SECRETS (secretscan.js); this
// widens the net to PERSONAL data — emails, phones, national IDs, cards, IBANs, IPs — so a
// transcript or config can be scrubbed before it leaves the machine. The design bias is
// FALSE-POSITIVE-AVERSE: every category that can be checksum-validated (TCKN, credit card via
// Luhn, IBAN via ISO 7064 mod-97) IS validated, so a random 11-digit number or a long invoice
// number is never mistaken for an identity. It is pure + deterministic (no clock, no network)
// with a single, explicit exception: scrubViaLLM(), which only reaches out when the caller
// hands it a URL and an injected fetch. Secret/token detection is delegated to secretscan —
// this module does NOT reinvent it.
const fs = require('fs');
const path = require('path');
const secretscan = require('./secretscan');

// ---- Built-in patterns (kept NON-global; collect() clones them with the /g flag) ----------

// email — conservative local@domain.tld.
const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/;

// phone — Turkish mobile (+90 5xx / 0(5xx)), Turkish landline (0(2xx)-(5xx)) and generic E.164.
// Turkish alternatives come first so E.164 never eats a partial national number. Separators
// allowed between groups: space, dot, dash, and parens around the area/operator code.
const PHONE = new RegExp([
  '\\+90[\\s.\\-]*\\(?5\\d{2}\\)?[\\s.\\-]*\\d{3}[\\s.\\-]*\\d{2}[\\s.\\-]*\\d{2}', // +90 5xx xxx xx xx
  '0\\s*\\(?[2-5]\\d{2}\\)?[\\s.\\-]*\\d{3}[\\s.\\-]*\\d{2}[\\s.\\-]*\\d{2}',        // 0(5xx)/0(2xx) ...
  '\\+[1-9]\\d{7,14}',                                                                // E.164
].join('|'));

// tckn — an 11-digit candidate (first digit non-zero); validated by validateTckn().
const TCKN = /\b[1-9]\d{10}\b/;

// passport / generic national-id — DELIBERATELY conservative: 1-2 uppercase letters + 6-9
// digits (compact form). Being uppercase-only cuts most incidental matches; still, this
// category has no checksum and may miss real docs or catch look-alikes — keep it opt-in-ish.
const PASSPORT = /\b[A-Z]{1,2}\d{6,9}\b/;

// creditCard — 13-19 digits (optional single space/dash between digits); validated by Luhn.
// The word-boundary anchors mean a longer digit run (e.g. a 25-digit id) will NOT match.
// A card is EITHER a solid 13-19 digit run OR four groups joined by ONE consistent separator
// (4-4-4-2..4, via the \1 backreference). The earlier /\b\d(?:[ -]?\d){12,18}\b/ anchored on a
// lone preceding digit, so "192.168.1.1 4111111111111111" (or "row 7 4111…") bridged the space
// and Luhn ran over the over-match, FAILED, and the real card leaked. These two tight branches
// never absorb a stray leading digit; Luhn (which strips separators) then gates the result.
const CREDIT_CARD = /\b\d{4}([ -])\d{4}\1\d{4}\1\d{2,4}\b|\b\d{13,19}\b/;

// iban — country code + 2 check digits + BBAN, optionally grouped by spaces; validated mod-97.
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){11,30}\b/;

// ipv4 — octets constrained to 0-255 in the pattern itself.
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;

// ipv6 — full, compressed (::) and boundary forms.
const IPV6 = new RegExp([
  '(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}',
  '(?:[A-Fa-f0-9]{1,4}:){1,7}:',
  '(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}',
  '(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}',
  '(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}',
  '(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}',
  '(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}',
  '[A-Fa-f0-9]{1,4}:(?::[A-Fa-f0-9]{1,4}){1,6}',
  ':(?:(?::[A-Fa-f0-9]{1,4}){1,7}|:)',
].join('|'));

// address — BEST-EFFORT, LOW-CONFIDENCE, OFF BY DEFAULT. Street-number + name + a street-type
// keyword (EN + a few TR). It WILL both over-match ("12 Angry Men Street" in prose) and
// under-match (any address it has no keyword for). Enable only via opts.categories:['address'].
const ADDRESS = /\b\d{1,5}\s+(?:[A-Z][A-Za-z.]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Square|Sq|Cadde(?:si)?|Cad|Sokak|Sok|Mahalle(?:si)?|Mah|Bulvar(?:ı)?)\b\.?/;

const BUILTIN = {
  email: { re: EMAIL },
  phone: { re: PHONE },
  tckn: { re: TCKN, validate: validateTckn },
  passport: { re: PASSPORT },
  creditCard: { re: CREDIT_CARD, validate: luhnValid },
  iban: { re: IBAN, validate: validateIban },
  ipv4: { re: IPV4 },
  ipv6: { re: IPV6 },
  address: { re: ADDRESS },
};

// Full list of built-in category names. 'secret' is delegated to secretscan.SECRET_PATTERNS.
const CATEGORIES = ['email', 'phone', 'tckn', 'passport', 'creditCard', 'iban', 'ipv4', 'ipv6', 'secret', 'address'];
// Enabled by default = everything except the noisy, opt-in 'address'.
const DEFAULT_CATEGORIES = CATEGORIES.filter(function (c) { return c !== 'address'; });

// ---- Validators -------------------------------------------------------------------------

// Turkish national ID (TCKN): 11 digits, d1 != 0, and two trailing check digits.
//   d10 = ((d1+d3+d5+d7+d9)*7 - (d2+d4+d6+d8)) mod 10
//   d11 = (d1+..+d10) mod 10
function validateTckn(s) {
  if (!/^\d{11}$/.test(s)) return false;
  const d = s.split('').map(Number);
  if (d[0] === 0) return false;
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const d10 = (((odd * 7 - even) % 10) + 10) % 10;
  if (d10 !== d[9]) return false;
  let sum10 = 0;
  for (let i = 0; i < 10; i++) sum10 += d[i];
  return sum10 % 10 === d[10];
}

// Luhn (mod-10) check for a 13-19 digit card number (separators tolerated).
function luhnValid(s) {
  const digits = String(s).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// IBAN ISO 7064 mod-97: rearrange (move first 4 chars to the end), letters -> A=10..Z=35,
// then the resulting big number mod 97 must equal 1.
function validateIban(s) {
  const iban = String(s).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const re = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (let i = 0; i < re.length; i++) {
    const c = re.charCodeAt(i);
    const chunk = (c >= 48 && c <= 57) ? String(c - 48) : String(c - 55); // '0'..'9' or A=10..Z=35
    for (let j = 0; j < chunk.length; j++) rem = (rem * 10 + (chunk.charCodeAt(j) - 48)) % 97;
  }
  return rem === 1;
}

// ---- Match collection -------------------------------------------------------------------

function collect(text, re, label, validate) {
  const out = [];
  const src = re.source;
  const flags = re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags;
  const g = new RegExp(src, flags);
  let m;
  while ((m = g.exec(text)) !== null) {
    const match = m[0];
    if (match === '') { g.lastIndex++; continue; } // never spin on a zero-width match
    if (validate && !validate(match, m)) continue;
    out.push({ start: m.index, end: m.index + match.length, label: label, match: match });
  }
  return out;
}

// detect(text, opts) -> [{ start, end, label, match }] across every enabled category + custom.
//   opts.categories  subset of CATEGORIES to run (default: all but 'address')
//   opts.custom      array of { label, re } (e.g. from loadCustom) merged under their label
function detect(text, opts) {
  const s = text == null ? '' : String(text);
  opts = opts || {};
  const requested = Array.isArray(opts.categories) ? opts.categories : DEFAULT_CATEGORIES;
  const matches = [];
  requested.forEach(function (cat) {
    if (cat === 'secret') {
      secretscan.SECRET_PATTERNS.forEach(function (p) {
        Array.prototype.push.apply(matches, collect(s, p.re, 'secret'));
      });
    } else if (BUILTIN[cat]) {
      Array.prototype.push.apply(matches, collect(s, BUILTIN[cat].re, cat, BUILTIN[cat].validate));
    }
  });
  const custom = Array.isArray(opts.custom) ? opts.custom : [];
  custom.forEach(function (c) {
    if (c && c.re && typeof c.label === 'string') {
      Array.prototype.push.apply(matches, collect(s, c.re, c.label));
    }
  });
  matches.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
  return matches;
}

// ---- Redaction --------------------------------------------------------------------------

// Resolve overlaps: keep the OUTERMOST/LONGEST span, never double-redact. Greedy over spans
// sorted by (start asc, end desc): accept a span only if it starts at/after the last accepted
// span's end. A nested or partially-overlapping shorter span is dropped.
function resolve(matches) {
  const sorted = matches.slice().sort(function (a, b) { return a.start - b.start || b.end - a.end; });
  const kept = [];
  let lastEnd = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].start >= lastEnd) { kept.push(sorted[i]); lastEnd = sorted[i].end; }
  }
  return kept;
}

function apply(text, kept) {
  let out = '';
  let pos = 0;
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i];
    out += text.slice(pos, m.start) + '[REDACTED:' + m.label + ']';
    pos = m.end;
  }
  return out + text.slice(pos);
}

// redactString(text, matches) -> redacted string. Handles overlap resolution; stable, greppable
// '[REDACTED:<label>]' markers. Exposed so callers can redact spans they gathered elsewhere.
function redactString(text, matches) {
  const s = text == null ? '' : String(text);
  return apply(s, resolve(matches || []));
}

// scrub(text, opts) -> { text, counts:{<label>:n} }. Detects every enabled category + custom,
// resolves overlaps, and replaces each surviving span with '[REDACTED:<label>]'.
function scrub(text, opts) {
  const s = text == null ? '' : String(text);
  const kept = resolve(detect(s, opts));
  const counts = Object.create(null);
  for (let i = 0; i < kept.length; i++) counts[kept[i].label] = (counts[kept[i].label] || 0) + 1;
  return { text: apply(s, kept), counts: counts };
}

// ---- User-extensible custom patterns ----------------------------------------------------

const MAX_LABEL = 40;
const MAX_REGEX = 300; // cap source length (anti-DoS / anti-garbage)
const MAX_CUSTOM = 64; // cap how many custom patterns we load (a second DoS multiplier)
// Reject the classic catastrophic-backtracking shape: a group whose body already contains an
// UNBOUNDED quantifier and is ITSELF quantified — (a+)+, (a*)*, (\d+)*, (x{1,})+ … These run in
// exponential time and would wedge the SYNCHRONOUS scrub path (there is no zero-dep way to
// interrupt a running regex, so we refuse them up front). Overlapping-alternation ReDoS
// ((a|aa)+) needs a full analyzer and is not caught here; the length + count caps bound the rest.
const NESTED_QUANT = /\([^()]*(?:[+*]|\{\d+,\})[^()]*\)\s*(?:[+*]|\{\d+,\})/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _\-]{0,39}$/;
const SAFE_FLAGS = /^[gimsuy]*$/;

// loadCustom(ctx) -> [{ label, re }] read from <ctx.configDir>/pii-patterns.json, an array of
// { label, regex, flags? }. Every entry is validated: label is a short safe string, flags are
// a subset of gimsuy, the regex source is non-empty and <= MAX_REGEX chars and COMPILES. Any
// malformed entry (or a missing/corrupt file) is ignored rather than throwing.
function loadCustom(ctx) {
  try {
    const p = path.join(ctx.configDir, 'pii-patterns.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (let i = 0; i < arr.length && out.length < MAX_CUSTOM; i++) {
      const item = arr[i];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.label !== 'string' || item.label.length > MAX_LABEL || !SAFE_LABEL.test(item.label)) continue;
      if (typeof item.regex !== 'string' || item.regex.length === 0 || item.regex.length > MAX_REGEX) continue;
      if (NESTED_QUANT.test(item.regex)) continue; // refuse ReDoS-prone nested unbounded quantifiers
      let flags = typeof item.flags === 'string' ? item.flags : '';
      if (!SAFE_FLAGS.test(flags)) continue;
      if (flags.indexOf('g') === -1) flags += 'g';
      let re;
      try { re = new RegExp(item.regex, flags); } catch (e) { continue; }
      out.push({ label: item.label, re: re });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// ---- Optional local-LLM redaction hook --------------------------------------------------

function safeLabel(l) { return (typeof l === 'string' && SAFE_LABEL.test(l)) ? l : 'pii'; }

// Turn an LLM response into spans and redact. Documented contract — the endpoint returns JSON
// with EITHER of:
//   { spans:      [ { start:<int>, end:<int>, label?:<str> } ] }   char offsets into `text`
//   { redactions: [ { text:<str>,             label?:<str> } ] }   literal substrings to redact
// Anything else (or out-of-range offsets) is ignored; the text is returned unchanged.
function applyLLMResult(text, data) {
  if (!data || typeof data !== 'object') return text;
  const matches = [];
  if (Array.isArray(data.spans)) {
    data.spans.forEach(function (sp) {
      if (sp && Number.isInteger(sp.start) && Number.isInteger(sp.end) &&
          sp.start >= 0 && sp.end <= text.length && sp.end > sp.start) {
        matches.push({ start: sp.start, end: sp.end, label: safeLabel(sp.label), match: text.slice(sp.start, sp.end) });
      }
    });
  } else if (Array.isArray(data.redactions)) {
    data.redactions.forEach(function (r) {
      if (!r || typeof r.text !== 'string' || r.text.length === 0) return;
      let idx = 0;
      while ((idx = text.indexOf(r.text, idx)) !== -1) {
        matches.push({ start: idx, end: idx + r.text.length, label: safeLabel(r.label), match: r.text });
        idx += r.text.length;
      }
    });
  }
  if (matches.length === 0) return text;
  return redactString(text, matches);
}

// scrubViaLLM(text, opts) -> Promise<string>. OPT-IN and OFFLINE-FRIENDLY: it does NOTHING
// unless opts.url is set (then it POSTs { text, model } to that local endpoint — e.g. Ollama —
// using opts.fetch or the global fetch). It applies the returned spans/redactions (see
// applyLLMResult contract). It FAILS OPEN and LOG-FREE: on a missing url, missing fetch,
// non-ok response, timeout (opts.timeoutMs, default 5000ms) or ANY thrown error it returns the
// ORIGINAL text unchanged, so an unreachable model never blocks a scrub. Never called for you
// by scrub()/detect() — the caller invokes it explicitly.
function scrubViaLLM(text, opts) {
  const s = text == null ? '' : String(text);
  opts = opts || {};
  if (!opts.url) return Promise.resolve(s); // hard gate: no url => never reaches out
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return Promise.resolve(s);
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : 5000;

  return (async function () {
    let timer = null;
    let signal;
    try {
      if (typeof AbortController !== 'undefined') {
        const ac = new AbortController();
        signal = ac.signal;
        timer = setTimeout(function () { ac.abort(); }, timeoutMs);
        if (timer && timer.unref) timer.unref();
      }
      let res;
      try {
        res = await doFetch(opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: s, model: opts.model }),
          signal: signal,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!res || res.ok === false) return s;
      const data = await res.json();
      return applyLLMResult(s, data);
    } catch (e) {
      return s; // fail-open, log-free
    }
  })();
}

module.exports = {
  CATEGORIES: CATEGORIES,
  DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
  detect: detect,
  scrub: scrub,
  redactString: redactString,
  loadCustom: loadCustom,
  scrubViaLLM: scrubViaLLM,
  // validators (exposed for reuse/testing)
  validateTckn: validateTckn,
  luhnValid: luhnValid,
  validateIban: validateIban,
};
