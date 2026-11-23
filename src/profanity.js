// Local profanity filter for conversation RAG chunks and embeddings.
// Zero runtime dependencies; never sends text anywhere.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const FILE_NAME = 'profanity.json';
const MASK_TOKEN = '[…]';
const FILTER_VERSION = '1';

const RAW_TR = fs.readFileSync(new URL('./profanity-tr.json', import.meta.url), 'utf8');
const RAW_EN = fs.readFileSync(new URL('./profanity-en.json', import.meta.url), 'utf8');
const DEFAULT_TR = JSON.parse(RAW_TR);
const DEFAULT_EN = JSON.parse(RAW_EN);

const SAFE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'json',
  'md',
  'py',
  'sh',
  'css',
  'html',
  'txt',
  'yml',
  'yaml',
  'xml',
  'sql',
  'log',
  'lock',
  'toml',
  'ini',
  'env',
  'com',
  'org',
  'net',
  'io',
  'tr',
  'dev',
  'app',
  'edu',
  'gov',
]);

const HAS_LETTER_RE = /\p{L}/u;
const HAS_LEET_RE = /[013457@$!]/;
const LETTERS_ONLY_RE = /^\p{L}+$/u;
const PHRASE_SEP_RE = /\s+/g;

function trLower(s) {
  return String(s || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\u0307/g, '');
}

function foldI(s) {
  return trLower(s).replace(/ı/g, 'i');
}

function foldAsciiTr(s) {
  return foldI(s).replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ç/g, 'c').replace(/ş/g, 's').replace(/ğ/g, 'g');
}

function deLeet(s) {
  return s
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
}

function squeeze3(s) {
  return s.replace(/(.)\1{2,}/gu, '$1');
}

function squeeze2(s) {
  return s.replace(/(.)\1+/gu, '$1');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function userListPath(ctxOrOpts) {
  const o = ctxOrOpts || {};
  if (o.userListPath) return String(o.userListPath);
  if (o.configDir) return path.join(String(o.configDir), FILE_NAME);
  const envDir = (o.env && o.env.KEYFLIP_CONFIG_DIR) || process.env.KEYFLIP_CONFIG_DIR;
  if (envDir) return path.join(envDir, FILE_NAME);
  if (process.env.NODE_TEST_CONTEXT) return null;
  const home = o.home || os.homedir();
  return path.join(home, '.config', 'keyflip', FILE_NAME);
}

function readUserListRaw(ctxOrOpts) {
  if (ctxOrOpts && ctxOrOpts.useUserList === false) return '';
  const file = userListPath(ctxOrOpts);
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function parseUserList(raw) {
  if (!raw) return { add: [], allow: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { add: [], allow: [] };
    return {
      add: Array.isArray(parsed.add) ? parsed.add.filter((x) => typeof x === 'string') : [],
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((x) => typeof x === 'string') : [],
    };
  } catch {
    return { add: [], allow: [] };
  }
}

function profanitySignature(ctx, enabled) {
  if (!enabled) return 'off';
  const rawUser = readUserListRaw(ctx);
  return crypto
    .createHash('sha1')
    .update(FILTER_VERSION + '\0on\0' + RAW_TR + '\0' + RAW_EN + '\0' + rawUser)
    .digest('hex')
    .slice(0, 16);
}

function addEntry(target, raw) {
  const cleaned = trLower(raw).trim().replace(PHRASE_SEP_RE, ' ');
  if (!cleaned) return;
  if (cleaned.includes(' ')) {
    target.phrases.push(cleaned);
  } else if (cleaned.length <= 2) {
    target.exact.add(foldI(cleaned));
  } else {
    target.stems.add(foldI(cleaned));
  }
}

function createFilter(opts) {
  opts = opts || {};
  const useDefaults = opts.useDefaultLists !== false;

  const exactSet = new Set();
  const stemsSet = new Set();
  const phrasesRaw = [];
  const allowExact = new Set();
  const allowStems = new Set();
  const allowPhrasesRaw = [];

  function ingestList(list) {
    if (!list) return;
    (list.exact || []).forEach((w) => {
      const f = foldI(w).trim();
      if (f) exactSet.add(f);
    });
    (list.stems || []).forEach((w) => {
      const f = foldI(w).trim();
      if (f) stemsSet.add(f);
    });
    (list.phrases || []).forEach((p) => {
      const c = trLower(p).trim().replace(PHRASE_SEP_RE, ' ');
      if (c) phrasesRaw.push(c);
    });
    (list.allow || []).forEach((w) => {
      const t = trLower(w).trim();
      if (t) allowExact.add(t);
    });
    (list.allowStems || []).forEach((w) => {
      const t = trLower(w).trim();
      if (t) allowStems.add(t);
    });
  }

  if (useDefaults) {
    ingestList(DEFAULT_TR);
    ingestList(DEFAULT_EN);
  }

  if (opts.stems || opts.exact || opts.phrases) {
    ingestList(opts);
  }

  const user = parseUserList(readUserListRaw(opts));
  const addBag = { phrases: phrasesRaw, exact: exactSet, stems: stemsSet };
  user.add.forEach((item) => addEntry(addBag, item));
  if (Array.isArray(opts.add)) {
    opts.add.forEach((item) => addEntry(addBag, item));
  }

  const allowList = user.allow.concat(Array.isArray(opts.allow) ? opts.allow : []);
  allowList.forEach((item) => {
    const cleaned = trLower(item).trim().replace(PHRASE_SEP_RE, ' ');
    if (!cleaned) return;
    if (cleaned.includes(' ')) {
      allowPhrasesRaw.push(cleaned);
    } else {
      allowExact.add(cleaned);
      allowExact.add(foldI(cleaned));
      const f = foldI(cleaned);
      exactSet.delete(f);
      stemsSet.delete(f);
    }
  });

  // Sort stems longest-first for deterministic matching.
  const stems = Array.from(stemsSet).sort((a, b) => b.length - a.length);
  const exact = Array.from(exactSet);
  const stemsMin3 = stems.filter((s) => s.length >= 3);
  const exactMin3 = exact.filter((e) => e.length >= 3);

  const squeezedStems = Array.from(new Set(stemsMin3.filter((s) => s !== 'bok').map(squeeze2))).sort(
    (a, b) => b.length - a.length,
  );
  const squeezedExact = Array.from(new Set(exactMin3.map(squeeze2)));

  const asciiStemsMin3 = Array.from(new Set(stemsMin3.map(foldAsciiTr))).sort((a, b) => b.length - a.length);
  const asciiExactMin3 = Array.from(new Set(exactMin3.map(foldAsciiTr)));

  const allowStemsArr = Array.from(allowStems).sort((a, b) => b.length - a.length);

  // Compile phrase regexes (longest first).
  function buildPhraseRegex(phrase) {
    const words = phrase.split(' ').filter(Boolean);
    if (!words.length) return null;
    const parts = words.map((w) => {
      let pat = '';
      for (const ch of w) {
        if (ch === 'i' || ch === 'ı') pat += '[iıİI]';
        else if (ch === 'o' || ch === 'ö') pat += '[oöOÖ]';
        else if (ch === 'u' || ch === 'ü') pat += '[uüUÜ]';
        else if (ch === 'c' || ch === 'ç') pat += '[cçCÇ]';
        else if (ch === 's' || ch === 'ş') pat += '[sşSŞ]';
        else if (ch === 'g' || ch === 'ğ') pat += '[gğGĞ]';
        else pat += escapeRegex(ch);
      }
      return pat;
    });
    return new RegExp('(?<![\\p{L}\\p{N}])' + parts.join('\\s+') + '(?![\\p{L}\\p{N}])', 'giu');
  }

  const allowPhraseEntries = Array.from(new Set(allowPhrasesRaw))
    .sort((a, b) => b.length - a.length)
    .map((p) => buildPhraseRegex(p))
    .filter(Boolean);

  const allowPhraseNorms = new Set(allowPhrasesRaw.map((p) => foldI(p)));

  const phraseEntries = Array.from(new Set(phrasesRaw))
    .filter((p) => !allowPhraseNorms.has(foldI(p)))
    .sort((a, b) => b.length - a.length)
    .map((p) => buildPhraseRegex(p))
    .filter(Boolean);

  function isAllowedNormal(rawLower) {
    if (allowExact.has(rawLower)) return true;
    for (const st of allowStemsArr) {
      if (rawLower.startsWith(st)) return true;
    }
    return false;
  }

  function matchesPrefixOrExact(candidate, exactList, stemList) {
    if (!candidate) return false;
    for (let i = 0; i < exactList.length; i++) {
      if (candidate === exactList[i]) return true;
    }
    for (let i = 0; i < stemList.length; i++) {
      const st = stemList[i];
      if (candidate === st) return true;
      if (candidate.startsWith(st)) {
        const rest = candidate.slice(st.length);
        if (LETTERS_ONLY_RE.test(rest)) return true;
      }
    }
    return false;
  }

  function matchesWord(token, matchOpts) {
    if (!token || !HAS_LETTER_RE.test(token)) return false;
    const minLen = (matchOpts && matchOpts.minLen) || 1;
    const rawLower = trLower(token);
    const hasLeet = HAS_LEET_RE.test(rawLower);

    // Check normal allow-list first when the token has no leet-speak symbols/digits.
    if (!hasLeet && isAllowedNormal(rawLower)) return false;

    const folded = foldI(rawLower);
    const ex = minLen >= 3 ? exactMin3 : exact;
    const st = minLen >= 3 ? stemsMin3 : stems;

    if (matchesPrefixOrExact(folded, ex, st)) return true;

    const sq3 = squeeze3(folded);
    if (sq3 !== folded) {
      if (!hasLeet && isAllowedNormal(sq3)) return false;
      if (matchesPrefixOrExact(sq3, ex, st)) return true;
    }

    const sq2 = squeeze2(folded);
    if (sq2 !== folded && sq2.length >= 3) {
      if (!hasLeet && isAllowedNormal(sq2)) return false;
      if (matchesPrefixOrExact(sq2, squeezedExact, squeezedStems)) return true;
    }

    if (hasLeet) {
      const dl = squeeze3(deLeet(folded));
      if (dl.length >= 3 && !isAllowedNormal(rawLower)) {
        if (matchesPrefixOrExact(dl, exactMin3, stemsMin3)) return true;
        if (matchesPrefixOrExact(foldAsciiTr(dl), asciiExactMin3, asciiStemsMin3)) return true;
      }
    }

    return false;
  }

  function matchesStarred(left, right) {
    if (!left || !right) return false;
    const combinedLen = left.length + 1 + right.length;
    if (combinedLen < 3) return false;
    const lAscii = foldAsciiTr(deLeet(foldI(left)));
    const rAscii = foldAsciiTr(deLeet(foldI(right)));
    const reExact = new RegExp('^' + escapeRegex(lAscii) + '\\p{L}' + escapeRegex(rAscii) + '$', 'u');
    for (const e of asciiExactMin3) {
      if (reExact.test(e)) return true;
    }
    for (const s of asciiStemsMin3) {
      if (s.length < combinedLen) {
        // Stem is shorter than left + ? + right -> check if stem matches prefix of left+?*
        if (lAscii.length >= s.length && lAscii.startsWith(s)) return true;
        continue;
      }
      if (reExact.test(s)) return true;
      // Also allow suffix after stem (e.g. s*ktirdi -> left='s', right='ktirdi', stem='siktir')
      if (s.startsWith(lAscii) && s.length > lAscii.length) {
        const tailNeeded = s.slice(lAscii.length + 1);
        if (rAscii.startsWith(tailNeeded)) {
          const rest = rAscii.slice(tailNeeded.length);
          if (!rest || LETTERS_ONLY_RE.test(rest)) return true;
        }
      }
    }
    return false;
  }

  function mask(text) {
    if (typeof text !== 'string' || !text) return { text: text == null ? '' : String(text), count: 0 };

    const protectedSpans = [];
    for (const re of allowPhraseEntries) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        protectedSpans.push([m.index, m.index + m[0].length]);
      }
    }

    const replacements = [];

    function overlaps(start, end, list) {
      for (let i = 0; i < list.length; i++) {
        if (start < list[i][1] && end > list[i][0]) return true;
      }
      return false;
    }

    function canPlace(start, end) {
      return !overlaps(start, end, protectedSpans) && !overlaps(start, end, replacements);
    }

    // 1. Multi-word profane phrases.
    for (const re of phraseEntries) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (canPlace(start, end)) replacements.push([start, end]);
      }
    }

    // 2. Spaced single-letter obfuscations (e.g. "s i k t i r", "o s i k t i r").
    const spacedRe = /(?<![\p{L}\p{N}])[\p{L}\d](?:[ \t]+[\p{L}\d]){2,}(?![\p{L}\p{N}])/gu;
    let sm;
    while ((sm = spacedRe.exec(text)) !== null) {
      const base = sm.index;
      if (!canPlace(base, base + sm[0].length)) continue;
      const pieces = [];
      const pieceRe = /[\p{L}\d]/gu;
      let pm;
      while ((pm = pieceRe.exec(sm[0])) !== null) {
        pieces.push({ ch: pm[0], s: base + pm.index, e: base + pm.index + pm[0].length });
      }
      let i = 0;
      while (i <= pieces.length - 3) {
        let matchedEnd = -1;
        for (let j = pieces.length - 1; j >= i + 2; j--) {
          const joined = pieces
            .slice(i, j + 1)
            .map((p) => p.ch)
            .join('');
          if (matchesWord(joined, { minLen: 3 })) {
            matchedEnd = j;
            break;
          }
        }
        if (matchedEnd !== -1) {
          const start = pieces[i].s;
          const end = pieces[matchedEnd].e;
          if (canPlace(start, end)) replacements.push([start, end]);
          i = matchedEnd + 1;
        } else {
          i++;
        }
      }
    }

    // 3. Intra-word separator obfuscations (3+ single chars: s.i.k.t.i.r, a.m.k, s-i-k-t-i-r).
    const sep3Re = /(?<![\p{L}\p{N}])[\p{L}\d](?:[.\-_*][\p{L}\d]){2,}(?![\p{L}\p{N}])/gu;
    let s3m;
    while ((s3m = sep3Re.exec(text)) !== null) {
      const start = s3m.index;
      const end = start + s3m[0].length;
      if (!canPlace(start, end)) continue;
      const joined = s3m[0].replace(/[.\-_*]/g, '');
      if (matchesWord(joined, { minLen: 3 })) replacements.push([start, end]);
    }

    // 4. Two-part dot or asterisk obfuscations (si.ktir, s*ktir, f*ck), skipping paths/emails/file extensions.
    const sep2Re =
      /(?<![\p{L}\p{N}/\\@])([\p{L}\d@$]+(?:![\p{L}\d@$]+)*)([.*])([\p{L}\d@$]+(?:![\p{L}\d@$]+)*)(?![\p{L}\p{N}/\\@])/gu;
    let s2m;
    while ((s2m = sep2Re.exec(text)) !== null) {
      const start = s2m.index;
      const end = start + s2m[0].length;
      if (!canPlace(start, end)) continue;
      const left = s2m[1];
      const sep = s2m[2];
      const right = s2m[3];
      if (sep === '.') {
        if (SAFE_EXTENSIONS.has(trLower(right))) continue;
        if (matchesWord(left + right, { minLen: 3 })) replacements.push([start, end]);
      } else if (sep === '*') {
        if (matchesStarred(left, right)) replacements.push([start, end]);
      }
    }

    // 5. Standard single-word tokens (including Turkish letters and leet substitutions; trailing '!' stays punctuation).
    const wordRe = /[\p{L}\p{N}@$]+(?:![\p{L}\p{N}@$]+)*/gu;
    let wm;
    while ((wm = wordRe.exec(text)) !== null) {
      const start = wm.index;
      const end = start + wm[0].length;
      if (!canPlace(start, end)) continue;
      if (matchesWord(wm[0], { minLen: 1 })) replacements.push([start, end]);
    }

    if (!replacements.length) return { text: text, count: 0 };

    replacements.sort((a, b) => a[0] - b[0]);
    let out = '';
    let cursor = 0;
    for (let i = 0; i < replacements.length; i++) {
      const [start, end] = replacements[i];
      if (start < cursor) continue;
      out += text.slice(cursor, start) + MASK_TOKEN;
      cursor = end;
    }
    out += text.slice(cursor);
    return { text: out, count: replacements.length };
  }

  return { mask };
}

function maskProfanity(text, opts) {
  return createFilter(opts).mask(text);
}

export { FILE_NAME, MASK_TOKEN, userListPath, createFilter, maskProfanity, profanitySignature };
