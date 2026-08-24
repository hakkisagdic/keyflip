// READER for the action/audit log that src/log.js appends to
// <configDir>/logs/keyflip.log (each line: "<ISO-ts> <message>"). log.js only
// writes; this module only reads. Strictly read-only: it never creates the file
// or its directory, so a query on a machine that has never logged leaves no trace.
// Guards against an unbounded log by reading only the trailing MAX_BYTES.
import fs from 'fs';
import path from 'path';

const MAX_BYTES = 256 * 1024; // only ever process the tail of the file (anti-OOM)

// Absolute path of the audit log for this ctx. (Named logPath internally so the
// node `path` module stays reachable; exported as `path` per the module API.)
function logPath(ctx) {
  return path.join(ctx.configDir, 'logs', 'keyflip.log');
}

// Read at most `maxBytes` from the END of a file WITHOUT loading the whole thing.
// Returns { text, truncated } or null if the file is missing/unreadable. Never
// creates the file (opened 'r'). `truncated` = we did not start at byte 0, so the
// first (partial) line must be discarded by the caller.
function readTailBytes(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return { text: '', truncated: false };
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, start + read);
      if (n <= 0) break; // truncated under us / EOF
      read += n;
    }
    return { text: buf.toString('utf8', 0, read), truncated: start > 0 };
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* ignore */
    }
  }
}

// "<ts> <msg>" -> { ts, msg }. Splits on the FIRST space only, so a message that
// itself contains spaces is preserved. Tolerates a trailing CR (CRLF files) and a
// line with no space (whole line becomes the ts, empty msg).
function parseLine(line) {
  const clean = line.replace(/\r$/, '');
  if (!clean.trim()) return null; // blank / whitespace-only line
  const idx = clean.indexOf(' ');
  if (idx === -1) return { ts: clean, msg: '' };
  return { ts: clean.slice(0, idx), msg: clean.slice(idx + 1) };
}

// Epoch ms for an ISO-ish timestamp, or null if it does not parse.
function parseTs(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Last `opts.limit` (default 50) parsed entries [{ ts, msg }], newest-LAST
// (append order preserved). Optional filters:
//   opts.grep  — case-insensitive substring match on the message
//   opts.since — ISO timestamp; only entries at/after it (an unparseable `since`
//                is ignored rather than hiding everything)
// Returns [] when the log file does not exist. Never writes.
function tail(ctx, opts) {
  opts = opts || {};
  const n = Number(opts.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;

  const chunk = readTailBytes(logPath(ctx), MAX_BYTES);
  if (!chunk) return []; // missing / unreadable

  let lines = chunk.text.split('\n');
  if (chunk.truncated && lines.length) lines = lines.slice(1); // drop the partial first line

  const grep = opts.grep != null && String(opts.grep) !== '' ? String(opts.grep).toLowerCase() : null;
  const sinceMs = opts.since != null && opts.since !== '' ? parseTs(opts.since) : null;

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const e = parseLine(lines[i]);
    if (!e) continue;
    if (sinceMs !== null) {
      const ems = parseTs(e.ts);
      if (ems === null || ems < sinceMs) continue; // exclude undatable / older entries
    }
    if (grep !== null && e.msg.toLowerCase().indexOf(grep) === -1) continue;
    out.push(e);
  }
  return out.slice(-limit); // keep the newest `limit`, newest last
}

export { logPath as path, tail, MAX_BYTES };
