// CHAT INTEGRATIONS (Slack / Discord): push keyflip status + events to where people
// already work, richly formatted per platform. Inbound bots need hosting (out of
// scope), so this is OUTBOUND-only: given a webhook URL we detect the platform from
// its host and POST a Slack Block Kit message or a Discord embed (a generic JSON
// envelope for anything else). This complements notify.js — notify.js is the event
// HOOK (fire-and-forget on quota/switch/…), while this gives pretty, per-platform
// payloads you can post on demand (`keyflip post`).
//
// SECURITY: every payload is SECRET-STRIPPED before it leaves the machine — we reuse
// notify.stripSecrets so token/key/credential/password/secret keys are dropped deep,
// at every level, and prototype-polluting keys are neutralised. The webhook URL is
// restricted to http(s) (notify.sanitizeWebhook). Nothing here reads ctx.store or
// logs a secret; the on-disk delivery log records only platform/event/status — never
// the URL and never the payload. All IO/time is injectable (opts.fetch, opts.clock)
// so tests need no network.
import fs from 'fs';
import path from 'path';
import { atomicWrite, readJsonForWrite } from './fsutil.js';
import * as _notify from './notify.js';
import * as _core from './core.js';
import * as _usage from './usage.js';
const notify = _notify; // reuse stripSecrets + sanitizeWebhook (same discipline)

let VERSION = '0.0.0';
try { VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch (e) { /* ignore */ }

// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g; // strip control chars (newlines / ANSI ESC) from any rendered text
function scrub(s, max) { return String(s == null ? '' : s).replace(CTRL, ' ').slice(0, max || 300); }
// Escape the three characters Slack treats specially inside mrkdwn text.
function mrkdwn(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s); }
function safeCall(fn, d) { try { return fn(); } catch (e) { return d; } }

// Per-event presentation. NULL-PROTOTYPE so a user-supplied event name (e.g.
// '__proto__' / 'constructor') can never reach a prototype during lookup — an
// unknown key just falls through to the default.
const EVENTS = Object.create(null);
EVENTS.quota = { emoji: '📊', title: 'Quota alert', color: 0xE01E5A };      // 📊
EVENTS.switch = { emoji: '🔀', title: 'Account switched', color: 0x2EB67D }; // 🔀
EVENTS['fleet-reply'] = { emoji: '💬', title: 'Fleet reply', color: 0x36C5F0 }; // 💬
EVENTS.status = { emoji: '🔑', title: 'keyflip status', color: 0x5865F2 };   // 🔑
EVENTS.test = { emoji: '🧪', title: 'keyflip test', color: 0x99AAB5 };       // 🧪
EVENTS.note = { emoji: '📝', title: 'keyflip', color: 0x99AAB5 };            // 📝
const DEFAULT_COLOR = 0x5865F2;
function metaFor(event) { return EVENTS[event] || null; }
function titleFor(event) {
  const m = metaFor(event);
  return scrub(m ? m.emoji + ' ' + m.title : '🔔 ' + (event || 'notification'), 240); // 🔔
}

// --- webhook host -> platform ---------------------------------------------------
// Detect the target platform from the webhook host alone. Slack incoming webhooks
// live on hooks.slack.com (any *.slack.com); Discord on discord.com/discordapp.com
// (incl. ptb./canary. subdomains). Anything else — or an unparseable URL — is generic.
function detect(url) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (e) { return 'generic'; }
  if (host === 'slack.com' || host.slice(-10) === '.slack.com') return 'slack';
  if (host === 'discord.com' || host.slice(-12) === '.discord.com' ||
      host === 'discordapp.com' || host.slice(-15) === '.discordapp.com') return 'discord';
  return 'generic';
}

// --- payload -> display pieces ---------------------------------------------------
// The one-line summary: a `message` string if present, else empty (fields carry the rest).
function summaryOf(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.message === 'string' && payload.message) return scrub(payload.message, 1000);
    return '';
  }
  if (payload != null && typeof payload !== 'object') return scrub(String(payload), 1000);
  return '';
}
// Flatten a payload's TOP-LEVEL scalar entries into label/value fields (message/at
// are handled separately). Nested objects/arrays and null are skipped; count-bounded.
function fieldsOf(payload, max) {
  const out = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return out;
  const keys = Object.keys(payload);
  for (let i = 0; i < keys.length && out.length < (max || 20); i++) {
    const k = keys[i];
    if (k === 'message' || k === 'at') continue;
    const v = payload[k];
    if (v == null) continue;
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
    out.push({ name: scrub(k, 60), value: scrub(String(v), 300) });
  }
  return out;
}

// --- Slack Block Kit ------------------------------------------------------------
// A Slack message object ({ blocks: [...] }), postable verbatim to an incoming
// webhook. Header + (optional) summary section + (optional) fields section + a
// context footer. Payload is secret-stripped defensively (idempotent when the
// caller — post() — already stripped it) so a direct caller is protected too.
function formatSlack(event, payload, at) {
  event = String(event == null ? '' : event);
  const safe = notify.stripSecrets(payload);
  const blocks = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: scrub(titleFor(event), 148), emoji: true } });
  const summary = summaryOf(safe);
  if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mrkdwn(summary).slice(0, 2900) } });
  const fields = fieldsOf(safe, 10).map(function (f) {
    return { type: 'mrkdwn', text: '*' + mrkdwn(f.name) + '*\n' + mrkdwn(f.value) };
  });
  if (fields.length) blocks.push({ type: 'section', fields: fields });
  const when = at || (safe && typeof safe === 'object' && safe.at) || null;
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn',
    text: 'keyflip' + (event ? ' • ' + mrkdwn(event) : '') + (when ? ' • ' + mrkdwn(String(when)) : '') }] });
  return { blocks: blocks };
}

// --- Discord embed --------------------------------------------------------------
// A single Discord embed object; post() wraps it as { embeds: [embed] } for the
// webhook. Title + colour + (optional) description + (optional) inline fields +
// footer + (optional) ISO timestamp. Payload is secret-stripped defensively.
function formatDiscord(event, payload, at) {
  event = String(event == null ? '' : event);
  const safe = notify.stripSecrets(payload);
  const m = metaFor(event);
  const embed = { title: titleFor(event).slice(0, 256), color: m ? m.color : DEFAULT_COLOR };
  const summary = summaryOf(safe);
  if (summary) embed.description = summary.slice(0, 4000);
  const fields = fieldsOf(safe, 25).map(function (f) {
    return { name: (f.name.slice(0, 256) || '—'), value: (f.value.slice(0, 1024) || '—'), inline: true };
  });
  if (fields.length) embed.fields = fields;
  embed.footer = { text: scrub('keyflip' + (event ? ' • ' + event : ''), 2000) };
  const when = at || (safe && typeof safe === 'object' && safe.at) || null;
  if (isIso(when)) embed.timestamp = when; // Discord requires ISO8601
  return embed;
}

// --- delivery log (NON-SECRET) --------------------------------------------------
// Persisted at <configDir>/integrations.json: only platform/event/status/time — never
// the webhook URL, never the payload. Bounded ring so it can't grow unboundedly.
const MAX_LOG = 50;
function statePath(ctx) { return path.join(ctx.configDir, 'integrations.json'); }
function normalizeState(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const deliveries = Array.isArray(r.deliveries)
    ? r.deliveries.filter(function (d) { return d && typeof d === 'object' && !Array.isArray(d); }).slice(0, MAX_LOG)
    : [];
  return { deliveries: deliveries };
}
// Read-modify-write via readJsonForWrite so a CORRUPT file THROWS (caller swallows)
// rather than being silently clobbered.
function record(ctx, entry) {
  const cur = normalizeState(readJsonForWrite(statePath(ctx)));
  cur.deliveries.unshift(entry);
  if (cur.deliveries.length > MAX_LOG) cur.deliveries.length = MAX_LOG;
  atomicWrite(statePath(ctx), JSON.stringify(cur, null, 2), 0o600);
  return cur;
}
// Read-only, never throws — safe for a status/diagnostic read.
function history(ctx) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(statePath(ctx), 'utf8')); } catch (e) { raw = null; }
  return normalizeState(raw).deliveries;
}

// --- post -----------------------------------------------------------------------
// POST the right per-platform format for the webhook URL. Order of operations:
//   1. sanitize the URL (http(s) only) — bail with 'bad-webhook' otherwise;
//   2. SECRET-STRIP the payload (before it is ever formatted or serialised);
//   3. render Slack blocks / Discord embed / generic envelope;
//   4. POST via opts.fetch || ctx.fetch || global fetch (best-effort, never throws);
//   5. append a NON-SECRET line to the delivery log.
// Returns { ok, sent, platform, httpStatus, at[, reason] }. Never throws.
async function post(ctx, spec, opts) {
  opts = opts || {};
  spec = spec || {};
  const at = opts.clock ? opts.clock() : ctx.now();
  const url = notify.sanitizeWebhook(spec.url);
  if (!url) return { ok: false, sent: false, reason: 'bad-webhook', platform: null, httpStatus: null, at: at };
  const platform = detect(url);
  const event = String(spec.event == null ? '' : spec.event);
  const safe = notify.stripSecrets(spec.payload); // NEVER format/send the raw payload past this point

  let body;
  if (platform === 'slack') body = formatSlack(event, safe, at);
  else if (platform === 'discord') body = { embeds: [formatDiscord(event, safe, at)] };
  else body = { event: event, payload: safe === undefined ? null : safe, at: at };

  const doFetch = opts.fetch || (ctx && ctx.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
  let result;
  if (!doFetch) {
    result = { ok: false, sent: false, reason: 'no-fetch', platform: platform, httpStatus: null, at: at };
  } else {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'keyflip/' + VERSION },
        body: JSON.stringify(body),
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(opts.timeoutMs || 5000) : undefined,
      });
      const status = res && typeof res.status === 'number' ? res.status : null;
      const ok = !!(res && (res.ok || (status != null && status < 400)));
      result = { ok: ok, sent: ok, platform: platform, httpStatus: status, at: at,
        reason: ok ? undefined : (status != null ? 'http-' + status : 'no-response') };
    } catch (e) {
      result = { ok: false, sent: false, platform: platform, httpStatus: null, at: at, reason: (e && e.message) || 'network-error' };
    }
  }
  // NON-SECRET delivery log (no url, no payload) — best-effort, never fatal.
  try { record(ctx, { at: at, platform: platform, event: scrub(event, 64), ok: !!result.ok, httpStatus: result.httpStatus == null ? null : result.httpStatus }); }
  catch (e) { /* corrupt/locked log — skip, never clobber */ }
  return result;
}

// --- status summary -------------------------------------------------------------
// A NON-SECRET summary suitable to post: the active account, how many accounts are
// saved, and the active account's remaining quota headroom (read from the local
// usage cache — no network here). Includes `at` so the formatters can stamp it.
function statusMessage(ctx) {
  const core = _core;
  const usage = _usage;
  const list = safeCall(function () { return core.listProfiles(ctx); }, []);
  const active = list.filter(function (p) { return p.active; })[0] || null;
  let cache = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ctx.configDir, '.usage-cache.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed;
  } catch (e) { cache = {}; }
  let headroomPct = null, usageStr = null;
  const c = active && Object.prototype.hasOwnProperty.call(cache, active.name) ? cache[active.name] : null;
  if (c && c.usage) {
    const h = usage.headroom(c.usage);
    if (typeof h === 'number') headroomPct = Math.round(h);
    usageStr = usage.fmt(c.usage);
  }
  return {
    active: active ? (active.email || active.name) : null,
    activeName: active ? active.name : null,
    accounts: list.length,
    headroomPct: headroomPct,
    usage: usageStr,
    at: ctx.now(),
  };
}

// --- CLI: keyflip post ----------------------------------------------------------
// Parses `--to <webhook-url> [--status] [--event <name>] [--message <text>]` and
// posts. Default (and with --status) posts the current status; --message posts a
// one-line note. Returns the post result plus a human `text` line. The parent wires
// this to `keyflip post` and prints text (or the object under --json).
function flagVal(argv, flag) { const i = argv.indexOf(flag); return (i !== -1 && i + 1 < argv.length) ? argv[i + 1] : null; }
async function cli(ctx, argv, opts) {
  argv = argv || [];
  const to = flagVal(argv, '--to');
  const wantStatus = argv.indexOf('--status') !== -1;
  const eventArg = flagVal(argv, '--event');
  const messageArg = flagVal(argv, '--message');
  if (!to) {
    return { ok: false, error: 'usage: keyflip post --to <webhook-url> [--status] [--event <name>] [--message <text>]' };
  }
  let event, payload;
  if (messageArg && !wantStatus) { event = eventArg || 'note'; payload = { message: messageArg }; }
  else { event = eventArg || 'status'; payload = statusMessage(ctx); }
  const r = await post(ctx, { url: to, event: event, payload: payload }, opts || {});
  const platform = r.platform || detect(to);
  r.text = r.ok
    ? 'posted ' + event + ' to ' + platform + (r.httpStatus ? ' (HTTP ' + r.httpStatus + ')' : '')
    : 'post failed (' + platform + '): ' + (r.reason || 'unknown');
  return r;
}

// --- MCP tool: keyflip_post_status (MUT + confirm) ------------------------------
// Posts the current NON-SECRET status to a webhook. Network + mutating (it sends
// data off-machine), so it requires confirm=true. Honours ctx.fetch when present
// (test seam); otherwise global fetch.
const mcpTools = [
  {
    name: 'keyflip_post_status',
    title: 'Post keyflip status to Slack/Discord',
    description: 'Post the current keyflip status (active account, number of saved accounts, remaining quota headroom) to a Slack or Discord incoming webhook, richly formatted for that platform. The payload is a NON-SECRET summary and is secret-stripped before sending. This sends data to an external service — ask the user before calling, then set confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The Slack/Discord (or generic) incoming-webhook URL to post to (http(s) only).' },
        confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed to post.' },
      },
      required: ['url', 'confirm'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async function (ctx, args) {
      if (!args || args.confirm !== true) {
        throw new Error('confirmation required: ask the user first, then call again with confirm=true');
      }
      const url = notify.sanitizeWebhook(String((args && args.url) || ''));
      if (!url) throw new Error('a valid http(s) webhook url is required');
      const platform = detect(url);
      const status = statusMessage(ctx);
      const r = await post(ctx, { url: url, event: 'status', payload: status }, {});
      if (!r.ok) throw new Error('post failed (' + platform + '): ' + (r.reason || 'unknown'));
      return { posted: { platform: platform, httpStatus: r.httpStatus == null ? null : r.httpStatus, at: r.at }, status: status };
    },
  },
];

export { detect, formatSlack, formatDiscord, post, statusMessage, cli, history, statePath, mcpTools, EVENTS };