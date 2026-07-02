'use strict';
// Append-only logs (#7 event log, #12 usage history) as JSONL, pruned to a max
// line count so they never grow unbounded. Failure to log never breaks a command.
const fs = require('fs');
const path = require('path');

const MAX_LINES = 5000;

function eventsFile(ctx) { return path.join(ctx.configDir, 'events.jsonl'); }
function usageFile(ctx) { return path.join(ctx.configDir, 'usage-history.jsonl'); }

function append(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
    // Cheap periodic prune: if the file grows large, keep only the last MAX_LINES.
    const st = fs.statSync(file);
    if (st.size > MAX_LINES * 200) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_LINES) fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n', { mode: 0o600 });
    }
  } catch (e) { /* logging must never break the tool */ }
}

function read(file, limit) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const slice = limit ? lines.slice(-limit) : lines;
    return slice.map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// Record a failover / breaker event: { at, kind, from, to, reason }.
function recordEvent(ctx, ev) { append(eventsFile(ctx), Object.assign({ at: ctx.now() }, ev)); }
function readEvents(ctx, limit) { return read(eventsFile(ctx), limit); }

// Record a usage sample: { at, account, status, fiveHour, sevenDay }.
function recordUsage(ctx, account, info) {
  const u = info && info.usage;
  append(usageFile(ctx), {
    at: ctx.now(), account: account, status: info && info.status,
    fiveHour: u && u.fiveHour ? u.fiveHour.pct : null,
    sevenDay: u && u.sevenDay ? u.sevenDay.pct : null,
  });
}
function readUsage(ctx, limit) { return read(usageFile(ctx), limit); }

module.exports = { recordEvent: recordEvent, readEvents: readEvents, recordUsage: recordUsage, readUsage: readUsage, eventsFile: eventsFile, usageFile: usageFile };
