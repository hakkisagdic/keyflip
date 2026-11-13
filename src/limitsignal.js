// Local rate-limit signal: scan recent Claude Code session transcripts
// (<claudeDir>/projects/*/*.jsonl) for a subscription rate-limit rejection line.
// Pure and injectable (fs, clock, app-account detector); never returns or logs
// transcript message text or tokens.
import fs from 'fs';
import path from 'path';
import * as cfg from './config.js';
import * as core from './core.js';
import * as appauth from './appauth.js';
import { LIVE_SINCE_FILE, liveSincePath, writeLiveSince, readLiveSince } from './livesince.js';

const MAX_TAIL_BYTES = 256 * 1024;

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function resolveNowMs(opts) {
  return opts && typeof opts.nowMs === 'number' && isFinite(opts.nowMs) ? opts.nowMs : Date.now();
}

// Read the wall-clock parts in IANA timeZone `tz` (or the machine's local time zone when omitted) for UTC epoch `ms`.
function wallPartsInZone(ms, tz) {
  /** @type {Intl.DateTimeFormatOptions} */
  const fmtOpts = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  if (tz) fmtOpts.timeZone = tz;
  const fmt = new Intl.DateTimeFormat('en-US', fmtOpts);
  const parts = fmt.formatToParts(new Date(ms));
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type in out) out[p.type] = parseInt(p.value, 10);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

// Convert wall-clock (year, month 1..12, day, hour 0..23, minute 0..59) in IANA `tz`
// into a UTC epoch timestamp (ms). Two-pass offset refinement handles DST transitions.
function wallToUtcMs(tz, year, month, day, hour, minute) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const p1 = wallPartsInZone(targetAsUtc, tz);
  const offset1 = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second, 0) - targetAsUtc;
  const guess1 = targetAsUtc - offset1;
  const p2 = wallPartsInZone(guess1, tz);
  const offset2 = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second, 0) - guess1;
  return targetAsUtc - offset2;
}

function toHour24(hourStr, ampm) {
  const h = parseInt(hourStr, 10);
  if (!isFinite(h)) return null;
  if (!ampm) return h >= 0 && h <= 23 ? h : null;
  if (h < 1 || h > 12) return null;
  const lower = ampm.toLowerCase();
  if (lower === 'am') return h === 12 ? 0 : h;
  if (lower === 'pm') return h === 12 ? 12 : h + 12;
  return null;
}

// Parse "resets 3pm (Europe/Istanbul)", "resets 3:30pm (Europe/Istanbul)", or
// "resets Nov 16 at 9am (Europe/Istanbul)" into an ISO string for the next
// occurrence strictly after `lineMs`.
function parseResetText(text, lineMs) {
  if (typeof text !== 'string' || !text || !isFinite(lineMs)) return null;

  // Form 1: "resets Nov 16 at 9am (Europe/Istanbul)" / "resets Nov 16 at 9:30am (Europe/Istanbul)"
  const mdMatch =
    /\bresets\s+(?:on\s+)?([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+at|\s*,)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(
      text,
    );
  if (mdMatch) {
    const mon = MONTHS[mdMatch[1].toLowerCase()];
    const day = parseInt(mdMatch[2], 10);
    const hour = toHour24(mdMatch[3], mdMatch[5]);
    const minute = mdMatch[4] ? parseInt(mdMatch[4], 10) : 0;
    const tz = mdMatch[6].trim();
    if (!mon || !day || day < 1 || day > 31 || hour === null || minute < 0 || minute > 59 || !tz) return null;
    try {
      const ref = wallPartsInZone(lineMs, tz);
      let candidate = wallToUtcMs(tz, ref.year, mon, day, hour, minute);
      if (candidate <= lineMs) {
        candidate = wallToUtcMs(tz, ref.year + 1, mon, day, hour, minute);
      }
      return isFinite(candidate) ? new Date(candidate).toISOString() : null;
    } catch (e) {
      return null;
    }
  }

  // Form 2: "resets 3pm (Europe/Istanbul)" / "resets 3:30pm (Europe/Istanbul)"
  const tMatch = /\bresets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i.exec(text);
  if (tMatch) {
    const hour = toHour24(tMatch[1], tMatch[3]);
    const minute = tMatch[2] ? parseInt(tMatch[2], 10) : 0;
    const tz = tMatch[4].trim();
    if (hour === null || minute < 0 || minute > 59 || !tz) return null;
    try {
      const ref = wallPartsInZone(lineMs, tz);
      let candidate = wallToUtcMs(tz, ref.year, ref.month, ref.day, hour, minute);
      if (candidate <= lineMs) {
        candidate = wallToUtcMs(tz, ref.year, ref.month, ref.day + 1, hour, minute);
      }
      return isFinite(candidate) ? new Date(candidate).toISOString() : null;
    } catch (e) {
      return null;
    }
  }

  return null;
}

function classifyTextKind(text) {
  if (typeof text !== 'string' || !text) return 'unknown';
  if (/\bsession\s+limit\b|\b5[- ]?hour\b/i.test(text)) return 'five_hour';
  if (/\bweekly\b[\s\S]{0,40}\bopus\b|\bopus\b[\s\S]{0,40}\bweekly\b/i.test(text)) return 'seven_day_opus';
  if (/\bweekly\s+limit\b|\b7[- ]?day\b/i.test(text)) return 'seven_day';
  return 'unknown';
}

function extractMessageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  for (let i = 0; i < msg.content.length; i++) {
    const item = msg.content[i];
    if (item && typeof item.text === 'string' && item.text) return item.text;
  }
  return '';
}

function readTailUtf8(fsImpl, filePath, size) {
  if (typeof size === 'number' && size > MAX_TAIL_BYTES && typeof fsImpl.openSync === 'function') {
    let fd = null;
    try {
      fd = fsImpl.openSync(filePath, 'r');
      const buf = Buffer.allocUnsafe(MAX_TAIL_BYTES);
      const bytesRead = fsImpl.readSync(fd, buf, 0, MAX_TAIL_BYTES, size - MAX_TAIL_BYTES);
      const str = buf.subarray(0, bytesRead).toString('utf8');
      const nl = str.indexOf('\n');
      return nl !== -1 ? str.slice(nl + 1) : str;
    } finally {
      if (fd !== null) {
        try {
          fsImpl.closeSync(fd);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
  const raw = fsImpl.readFileSync(filePath);
  if (Buffer.isBuffer(raw)) {
    if (raw.length > MAX_TAIL_BYTES) {
      const str = raw.subarray(raw.length - MAX_TAIL_BYTES).toString('utf8');
      const nl = str.indexOf('\n');
      return nl !== -1 ? str.slice(nl + 1) : str;
    }
    return raw.toString('utf8');
  }
  const s = String(raw);
  if (Buffer.byteLength(s, 'utf8') > MAX_TAIL_BYTES) {
    const buf = Buffer.from(s, 'utf8');
    const sliced = buf.subarray(buf.length - MAX_TAIL_BYTES).toString('utf8');
    const nl = sliced.indexOf('\n');
    return nl !== -1 ? sliced.slice(nl + 1) : sliced;
  }
  return s;
}

function activeCliAccount(ctx, opts) {
  if (opts && typeof opts.activeAccount === 'string' && opts.activeAccount) return opts.activeAccount;
  try {
    if (ctx && ctx.store) {
      const list = core.listProfiles(ctx);
      const act = list.find(function (e) {
        return e.active;
      });
      if (act && act.name) return act.name;
    }
  } catch (e) {
    /* best-effort */
  }
  return null;
}

function desktopMatchesCli(ctx, opts) {
  opts = opts || {};
  const appFn =
    typeof opts.appAccount === 'function' ? opts.appAccount : ctx && ctx.appDataDir ? appauth.activeProfileName : null;
  if (!appFn) return true;
  let appProf = null;
  try {
    appProf = appFn(ctx);
  } catch (e) {
    appProf = null;
  }
  if (!appProf) return true; // app account unknown -> counts for CLI account
  const cliProf = activeCliAccount(ctx, opts);
  if (!cliProf) return true;
  return appProf === cliProf;
}

// Scan <ctx.claudeDir>/projects/*/*.jsonl for the newest qualifying rate-limit hit.
function recentLimitHit(ctx, opts) {
  try {
    opts = opts || {};
    const fsImpl = opts.fs || fs;
    const claudeDir =
      opts.claudeDir || (ctx && ctx.claudeDir) || (ctx && ctx.home ? path.join(ctx.home, '.claude') : null);
    if (!claudeDir) return null;

    const nowMs = resolveNowMs(opts);
    let windowMinutes = 15;
    if (typeof opts.windowMinutes === 'number' && opts.windowMinutes >= 1) {
      windowMinutes = opts.windowMinutes;
    } else if (ctx && ctx.configDir) {
      const cfgVal = Number(cfg.get(ctx, 'failover.limitSignalMinutes'));
      if (isFinite(cfgVal) && cfgVal >= 1) windowMinutes = cfgVal;
    }
    const windowStartMs = nowMs - windowMinutes * 60 * 1000;
    const liveSinceMs = readLiveSince(ctx, fsImpl);

    const projectsDir = path.join(claudeDir, 'projects');
    let projEntries;
    try {
      projEntries = fsImpl.readdirSync(projectsDir, { withFileTypes: true });
    } catch (e) {
      return null;
    }

    let desktopAllowed = null; // lazy: only computed if a claude-desktop line is seen
    let best = null;
    let bestMs = -Infinity;

    for (let i = 0; i < projEntries.length; i++) {
      const pEnt = projEntries[i];
      const pName = typeof pEnt === 'string' ? pEnt : pEnt && pEnt.name;
      if (!pName) continue;
      const pPath = path.join(projectsDir, pName);
      if (typeof pEnt === 'object' && typeof pEnt.isDirectory === 'function') {
        if (!pEnt.isDirectory()) continue;
      } else {
        try {
          if (!fsImpl.statSync(pPath).isDirectory()) continue;
        } catch (e) {
          continue;
        }
      }

      let files;
      try {
        files = fsImpl.readdirSync(pPath);
      } catch (e) {
        continue;
      }

      for (let j = 0; j < files.length; j++) {
        const fEntry = files[j];
        const fName = typeof fEntry === 'string' ? fEntry : fEntry && fEntry.name;
        if (!fName || !fName.endsWith('.jsonl')) continue;
        const fPath = path.join(pPath, fName);
        let st;
        try {
          st = fsImpl.statSync(fPath);
        } catch (e) {
          continue;
        }
        if (!st || (typeof st.isFile === 'function' && !st.isFile())) continue;
        const mtimeMs =
          typeof st.mtimeMs === 'number' && isFinite(st.mtimeMs)
            ? st.mtimeMs
            : st.mtime instanceof Date
              ? st.mtime.getTime()
              : NaN;
        if (!isFinite(mtimeMs) || mtimeMs < windowStartMs) continue;

        let content;
        try {
          content = readTailUtf8(fsImpl, fPath, st.size);
        } catch (e) {
          continue;
        }
        if (!content || content.indexOf('"isApiErrorMessage":true') === -1) continue;

        const lines = content.split('\n');
        for (let k = 0; k < lines.length; k++) {
          const line = lines[k];
          if (!line || line.indexOf('"isApiErrorMessage":true') === -1) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch (e) {
            continue;
          }
          if (!obj || obj.isApiErrorMessage !== true) continue;

          const ql = obj.quotaLimits && typeof obj.quotaLimits === 'object' ? obj.quotaLimits : null;
          const rli =
            obj.apiErrorParams &&
            typeof obj.apiErrorParams === 'object' &&
            obj.apiErrorParams.rate_limit_info &&
            typeof obj.apiErrorParams.rate_limit_info === 'object'
              ? obj.apiErrorParams.rate_limit_info
              : null;

          const isRateLimit =
            obj.error === 'rate_limit' ||
            obj.apiError === 'usage_limit_reached' ||
            (obj.apiErrorStatus === 429 && ((ql && ql.status === 'rejected') || (rli && rli.status === 'rejected')));
          if (!isRateLimit) continue;

          if (typeof obj.timestamp !== 'string' || !obj.timestamp) continue;
          const lineMs = Date.parse(obj.timestamp);
          if (!isFinite(lineMs)) continue;
          if (lineMs < windowStartMs || lineMs > nowMs) continue;
          if (liveSinceMs !== null && lineMs <= liveSinceMs) continue;

          const entrypoint = typeof obj.entrypoint === 'string' && obj.entrypoint ? obj.entrypoint : 'cli';
          if (entrypoint === 'claude-desktop') {
            if (desktopAllowed === null) desktopAllowed = desktopMatchesCli(ctx, opts);
            if (!desktopAllowed) continue;
          }

          const hasStructured = !!(
            (ql && (ql.rateLimitType || ql.resetsAt != null || ql.status)) ||
            (rli && (rli.rateLimitType || rli.resetsAt != null || rli.status))
          );
          const source = hasStructured ? 'quotaLimits' : 'text';

          const structuredKind =
            (ql && typeof ql.rateLimitType === 'string' && ql.rateLimitType) ||
            (rli && typeof rli.rateLimitType === 'string' && rli.rateLimitType) ||
            null;
          let text = null;
          let kind = structuredKind;
          if (!kind) {
            text = extractMessageText(obj.message);
            kind = classifyTextKind(text);
          }

          let resetsAt = null;
          const rawResetSec =
            ql && typeof ql.resetsAt === 'number' && isFinite(ql.resetsAt) && ql.resetsAt > 0
              ? ql.resetsAt
              : rli && typeof rli.resetsAt === 'number' && isFinite(rli.resetsAt) && rli.resetsAt > 0
                ? rli.resetsAt
                : null;
          if (rawResetSec !== null) {
            const resetMs = rawResetSec > 1e12 ? rawResetSec : rawResetSec * 1000;
            resetsAt = new Date(resetMs).toISOString();
          } else {
            if (text === null) text = extractMessageText(obj.message);
            resetsAt = parseResetText(text, lineMs);
            if (!resetsAt && kind === 'five_hour') {
              resetsAt = new Date(lineMs + 5 * 3600 * 1000).toISOString();
            }
          }

          if (resetsAt !== null) {
            const resetMs = Date.parse(resetsAt);
            if (!isFinite(resetMs) || resetMs <= nowMs) continue;
          }

          if (lineMs > bestMs) {
            bestMs = lineMs;
            best = {
              at: new Date(lineMs).toISOString(),
              resetsAt: resetsAt,
              kind: kind || 'unknown',
              entrypoint: entrypoint,
              source: source,
            };
          }
        }
      }
    }

    return best;
  } catch (e) {
    return null;
  }
}

function limitKindLabel(kind) {
  if (kind === 'seven_day') return 'weekly limit';
  if (kind === 'five_hour') return 'session limit';
  if (kind === 'seven_day_opus') return 'weekly Opus limit';
  return 'rate limit';
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function extractTimeZone(opts) {
  if (typeof opts === 'string' && opts) return opts;
  if (opts && typeof opts.timeZone === 'string' && opts.timeZone) return opts.timeZone;
  return undefined;
}

function fmtHm(iso, opts) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return null;
  const p = wallPartsInZone(ms, extractTimeZone(opts));
  return pad2(p.hour) + ':' + pad2(p.minute);
}

function fmtResetShort(iso, opts) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!isFinite(ms)) return null;
  const p = wallPartsInZone(ms, extractTimeZone(opts));
  const mon = MONTH_NAMES[p.month - 1];
  return mon + ' ' + p.day + ' ' + pad2(p.hour) + ':' + pad2(p.minute);
}

// e.g. "Claude Code hit the weekly limit at 13:00 (resets Nov 16 09:00) and no other account has headroom"
function formatLimitHitReason(hit, opts) {
  const label = limitKindLabel(hit && hit.kind);
  const atHm = hit && hit.at ? fmtHm(hit.at, opts) : null;
  const rst = hit && hit.resetsAt ? fmtResetShort(hit.resetsAt, opts) : null;
  return (
    'Claude Code hit the ' +
    label +
    (atHm ? ' at ' + atHm : '') +
    (rst ? ' (resets ' + rst + ')' : '') +
    ' and no other account has headroom'
  );
}

// e.g. "Claude Code hit the weekly limit (resets Nov 16 09:00)"
function formatLimitHitHeadline(hit, opts) {
  const label = limitKindLabel(hit && hit.kind);
  const rst = hit && hit.resetsAt ? fmtResetShort(hit.resetsAt, opts) : null;
  return 'Claude Code hit the ' + label + (rst ? ' (resets ' + rst + ')' : '');
}

export {
  LIVE_SINCE_FILE,
  MAX_TAIL_BYTES,
  liveSincePath,
  writeLiveSince,
  readLiveSince,
  parseResetText,
  recentLimitHit,
  limitKindLabel,
  fmtResetShort,
  formatLimitHitReason,
  formatLimitHitHeadline,
};
