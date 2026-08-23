// NOTIFICATIONS / WEBHOOKS on key events (quota breach, account switch, fleet
// reply) so keyflip isn't purely pull-based. State lives in <configDir>/notify.json
// = { webhook: url|null, events: [...], desktop: bool }. Delivery is best-effort and
// out-of-band: a POST to the webhook and/or a macOS `osascript` desktop banner.
// Both `fetch` and the subprocess runner are injectable so tests need no network/OS.
// SECURITY: a payload is a NON-SECRET summary only. Before anything leaves the
// machine we defensively strip any key that looks like a token/key/credential/
// password (recursively, at every level), and the webhook URL is restricted to
// http(s). Nothing here ever reads ctx.store or logs a secret.
import fs from 'fs';
import path from 'path';
import { atomicWrite, readJsonForWrite } from './fsutil.js';
import * as _exec from './exec.js';

let VERSION = '0.0.0';
try { VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch (e) { /* ignore */ }

// The events keyflip knows how to emit; a user may enable arbitrary extra names.
const KNOWN_EVENTS = ['quota', 'switch', 'fleet-reply'];
// A sane event token: alnum start, then [a-z0-9._-], bounded. Keeps the list tidy
// and render-safe (an event name can reach an osascript string / a JSON body).
const EVENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Any object key whose name CONTAINS one of these (case-insensitive) is dropped
// from a payload before it is sent — defence in depth against a caller that
// accidentally threads a secret through the "summary".
const SECRET_KEY_RE = /(token|key|credential|password|passphrase|secret|bearer|cookie|auth)/i;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g; // strip control chars (newlines/ANSI ESC) from text we render

function notifyPath(ctx) { return path.join(ctx.configDir, 'notify.json'); }

// Dedupe + validate a user-supplied events array. The dedupe map is null-proto so
// an event literally named '__proto__' can never pollute a prototype (mirrors fleet).
function sanitizeEvents(list) {
  if (!Array.isArray(list)) return KNOWN_EVENTS.slice();
  const seen = Object.create(null);
  const out = [];
  list.forEach(function (e) {
    const s = String(e == null ? '' : e).trim();
    if (!EVENT_RE.test(s) || seen[s]) return;
    seen[s] = true; out.push(s);
  });
  return out;
}

// Only http(s) webhooks — never file:/data:/etc. Returns the normalized URL or null.
function sanitizeWebhook(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}

// Coerce any raw disk object into the canonical config shape (never throws).
function normalize(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    webhook: sanitizeWebhook(r.webhook),
    events: sanitizeEvents(r.events),
    desktop: r.desktop === true,
  };
}

// Read-only, never throws — safe on the hot path (send).
function getConfig(ctx) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(notifyPath(ctx), 'utf8')); } catch (e) { raw = null; }
  return normalize(raw);
}

// Merge a patch into the on-disk config and persist (0600). Recognized keys:
//   webhook (string | null to clear), events (array), desktop (bool).
// Uses readJsonForWrite so a CORRUPT file THROWS instead of being silently
// clobbered (a merge must never destroy real config it failed to parse).
function setConfig(ctx, patch) {
  patch = patch || {};
  const cur = normalize(readJsonForWrite(notifyPath(ctx)));
  if ('webhook' in patch) cur.webhook = patch.webhook == null ? null : sanitizeWebhook(patch.webhook);
  if ('events' in patch) cur.events = sanitizeEvents(patch.events);
  if ('desktop' in patch) cur.desktop = patch.desktop === true;
  atomicWrite(notifyPath(ctx), JSON.stringify(cur, null, 2), 0o600);
  return cur;
}

function isEnabled(cfg, event) { return cfg.events.indexOf(event) !== -1; }

// Deep-clone `value` into a plain, JSON-safe object with every secret-looking key
// removed at EVERY level. Scalars pass through; functions/undefined are dropped.
// Depth- and width-bounded so a hostile/huge payload can't blow the stack or the
// request body. __proto__/prototype/constructor keys are never carried.
function stripSecrets(value, depth) {
  depth = depth || 0;
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return undefined; // function / undefined / symbol
  if (depth >= 6) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const arr = [];
    value.slice(0, 1000).forEach(function (v) { arr.push(stripSecrets(v, depth + 1)); });
    return arr;
  }
  const out = {};
  Object.keys(value).forEach(function (k) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') return;
    if (SECRET_KEY_RE.test(k)) return; // drop token/key/credential/password/…
    const c = stripSecrets(value[k], depth + 1);
    if (c !== undefined) out[k] = c;
  });
  return out;
}

function scrub(s, max) { return String(s == null ? '' : s).replace(CTRL, ' ').slice(0, max || 180); }
// Escape a string for embedding inside an AppleScript double-quoted literal, after
// stripping control chars so a payload can't inject newlines or break out of the
// literal into arbitrary AppleScript.
function asAppleScript(s) { return scrub(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// A short human line for the desktop banner, from the ALREADY secret-stripped payload.
function summarize(event, payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.message === 'string' && payload.message) return payload.message;
    const parts = [];
    Object.keys(payload).forEach(function (k) {
      const v = payload[k];
      if (v == null || typeof v === 'object') return;
      parts.push(k + ': ' + v);
    });
    if (parts.length) return parts.join(', ');
  } else if (payload != null && typeof payload !== 'object') {
    return String(payload);
  }
  return event || 'notification';
}

// Fire a notification for `event` with a non-secret `payload`. Channels tried
// (each best-effort, independent):
//   - webhook: POST { event, payload, at } as JSON via opts.fetch || global fetch
//   - desktop: a macOS `osascript` banner via opts.run || exec.run
// Returns { sent, event, at, channels[, reason] }. `sent` is true if ANY channel
// delivered. opts.force bypasses the enabled-list check (used by test()).
async function send(ctx, event, payload, opts) {
  opts = opts || {};
  event = String(event == null ? '' : event);
  const cfg = getConfig(ctx);
  if (!opts.force && !isEnabled(cfg, event)) return { sent: false, event: event, reason: 'event-disabled', channels: [] };
  const at = ctx.now();
  const safe = stripSecrets(payload); // NEVER send the raw payload past this point
  const channels = [];

  // --- webhook ---
  if (cfg.webhook) {
    const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) channels.push({ channel: 'webhook', ok: false, reason: 'no-fetch' });
    else {
      try {
        const res = await doFetch(cfg.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'keyflip/' + VERSION },
          body: JSON.stringify({ event: event, payload: safe === undefined ? null : safe, at: at }),
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 5000) : undefined,
        });
        const status = res && typeof res.status === 'number' ? res.status : null;
        const ok = !!(res && (res.ok || (status != null && status < 400)));
        channels.push({ channel: 'webhook', ok: ok, httpStatus: status, reason: ok ? undefined : (status != null ? 'http-' + status : 'no-response') });
      } catch (e) { channels.push({ channel: 'webhook', ok: false, reason: (e && e.message) || 'network-error' }); }
    }
  }

  // --- desktop (macOS only) ---
  if (cfg.desktop) {
    if (ctx.platform !== 'darwin') channels.push({ channel: 'desktop', ok: false, reason: 'not-macos' });
    else {
      const runner = opts.run || _exec.run;
      try {
        const script = 'display notification "' + asAppleScript(summarize(event, safe)) +
          '" with title "keyflip" subtitle "' + asAppleScript(event) + '"';
        const r = runner('/usr/bin/osascript', ['-e', script], undefined, { timeoutMs: 5000 });
        const ok = !!(r && r.code === 0);
        channels.push({ channel: 'desktop', ok: ok, reason: ok ? undefined : ((r && (r.stderr || (r.error && r.error.message))) || 'osascript-failed') });
      } catch (e) { channels.push({ channel: 'desktop', ok: false, reason: (e && e.message) || 'osascript-error' }); }
    }
  }

  const sent = channels.some(function (c) { return c.ok; });
  const out = { sent: sent, event: event, at: at, channels: channels };
  if (!sent) out.reason = channels.length ? 'delivery-failed' : 'no-sink';
  return out;
}

// Fire a synthetic 'test' event so the user can verify webhook/desktop wiring.
// Forced (bypasses the enabled list) but still honours the configured sinks.
async function test(ctx, opts) {
  return send(ctx, 'test', { message: 'keyflip test notification' }, Object.assign({}, opts, { force: true }));
}

export { getConfig, setConfig, send, test, isEnabled, stripSecrets, sanitizeWebhook, sanitizeEvents, KNOWN_EVENTS, notifyPath };