// READER for the action/audit log that src/log.js appends to
// <configDir>/logs/keyflip.log (each line: "<ISO-ts> <message>"). log.js only
// writes; this module only reads. Strictly read-only: it never creates the file
// or its directory, so a query on a machine that has never logged leaves no trace.
// Guards against an unbounded log by reading only the trailing MAX_BYTES.
import fs from 'fs';
import path from 'path';

const MAX_BYTES = 256 * 1024; // only ever process the tail of the file (anti-OOM)
// Ceiling for an explicit `opts.bytes` request. Deep enough to reconstruct a switch timeline
// on a normal install, small enough that no caller can turn a read-only query into a memory
// incident by asking for "everything" on a log that grew past its retention.
const HARD_MAX_BYTES = 8 * 1024 * 1024;

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

// Shared worker for tail()/scan(): the newest `opts.limit` (default 50) matching entries
// [{ ts, msg }], newest-LAST (append order preserved), plus whether the read had to skip
// bytes at the FRONT of the file. Optional filters:
//   opts.grep  — case-insensitive substring match on the message
//   opts.since — ISO timestamp; only entries at/after it (an unparseable `since`
//                is ignored rather than hiding everything)
//   opts.bytes — read deeper than MAX_BYTES (still bounded by HARD_MAX_BYTES). A plain
//                `keyflip log` view wants the cheap tail; a caller that reconstructs a
//                timeline from the whole file must ask for it explicitly.
// `truncated` is the whole point of scan(): a timeline caller must be able to say "history
// before <ts> is not visible to me" instead of inventing an unlogged beginning.
// A missing/unreadable log yields no entries. Never writes.
function collect(ctx, opts) {
  opts = opts || {};
  const n = Number(opts.limit);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;

  const b = Number(opts.bytes);
  const maxBytes = Number.isFinite(b) && b > 0 ? Math.min(b, HARD_MAX_BYTES) : MAX_BYTES;
  const chunk = readTailBytes(logPath(ctx), maxBytes);
  if (!chunk) return { entries: [], truncated: false, maxBytes: maxBytes }; // missing / unreadable

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
  return { entries: out.slice(-limit), truncated: chunk.truncated, maxBytes: maxBytes }; // newest last
}

function tail(ctx, opts) {
  return collect(ctx, opts).entries;
}

// Same as tail() but keeps the coverage flags: { entries, truncated, maxBytes }.
function scan(ctx, opts) {
  return collect(ctx, opts);
}

export { logPath as path, tail, scan, MAX_BYTES, HARD_MAX_BYTES };
