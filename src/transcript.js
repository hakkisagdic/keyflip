'use strict';
// Turn a Claude Code session transcript (JSONL of message events) into a clean, shareable
// document — markdown or a self-contained HTML chat view — for offline review, archiving, or
// sharing. Zero-dep; tool noise is summarized ("used Read, Bash"), not dumped.

// Parse a transcript's JSONL into { messages: [{role, text, tools, ts}], cwd, counts }.
function parse(jsonl) {
  const messages = [];
  let cwd = null;
  String(jsonl == null ? '' : jsonl).split('\n').forEach(function (line) {
    if (!line.trim()) return;
    let j; try { j = JSON.parse(line); } catch (e) { return; }
    if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
    const m = j.message;
    if (!m || (j.type !== 'user' && j.type !== 'assistant')) return;
    const role = m.role || j.type;
    const c = m.content;
    let text = '';
    const tools = [];
    if (typeof c === 'string') { text = c; }
    else if (Array.isArray(c)) {
      c.forEach(function (b) {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text' && b.text) text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use' && b.name) tools.push(b.name);
      });
    }
    text = text.trim();
    if (!text && !tools.length) return; // pure tool-result turns are noise — skip
    messages.push({ role: role, text: text, tools: tools, ts: (typeof j.timestamp === 'string') ? j.timestamp : null });
  });
  const counts = { messages: messages.length, user: messages.filter(function (m) { return m.role === 'user'; }).length, assistant: messages.filter(function (m) { return m.role === 'assistant'; }).length };
  return { messages: messages, cwd: cwd, counts: counts };
}

function who(role) { return role === 'assistant' ? 'Claude' : role === 'user' ? 'You' : role; }
function shortTs(ts) { return ts ? String(ts).slice(0, 16).replace('T', ' ') : ''; }

// Render as Markdown. opts: { id }.
function toMarkdown(parsed, opts) {
  opts = opts || {};
  const lines = ['# Session ' + (opts.id ? '`' + opts.id.slice(0, 8) + '`' : '') ];
  const meta = [];
  if (parsed.cwd) meta.push(parsed.cwd);
  meta.push(parsed.counts.messages + ' messages (' + parsed.counts.user + ' you / ' + parsed.counts.assistant + ' Claude)');
  lines.push('> ' + meta.join(' · '), '');
  parsed.messages.forEach(function (m) {
    lines.push('### ' + who(m.role) + (m.ts ? '  ' + '`' + shortTs(m.ts) + '`' : ''));
    if (m.text) lines.push('', m.text);
    if (m.tools.length) lines.push('', '_→ used ' + dedupe(m.tools).join(', ') + '_');
    lines.push('');
  });
  return lines.join('\n');
}
function dedupe(a) { const seen = {}; return a.filter(function (x) { if (seen[x]) return false; seen[x] = 1; return true; }); }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

// Render as a self-contained HTML chat view (no script, no external assets).
function toHtml(parsed, opts) {
  opts = opts || {};
  const bubbles = parsed.messages.map(function (m) {
    const cls = m.role === 'assistant' ? 'a' : 'u';
    const tools = m.tools.length ? '<div class="tools">→ used ' + esc(dedupe(m.tools).join(', ')) + '</div>' : '';
    const body = m.text ? '<div class="body">' + esc(m.text).replace(/\n/g, '<br>') + '</div>' : '';
    return '<div class="msg ' + cls + '"><div class="who">' + who(m.role) + (m.ts ? ' <span class="ts">' + esc(shortTs(m.ts)) + '</span>' : '') + '</div>' + body + tools + '</div>';
  }).join('');
  const sub = [parsed.cwd ? esc(parsed.cwd) : null, parsed.counts.messages + ' messages'].filter(Boolean).join(' · ');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>keyflip session ' + esc((opts.id || '').slice(0, 8)) + '</title>' +
    '<style>' + HTML_STYLE + '</style></head><body>' +
    '<header><h1>⚡ keyflip <span class="dim">session ' + esc((opts.id || '').slice(0, 8)) + '</span></h1><div class="dim">' + sub + '</div></header>' +
    '<main>' + (bubbles || '<p class="dim">No messages.</p>') + '</main>' +
    '<footer class="dim">Exported by keyflip · read-only</footer></body></html>';
}

const HTML_STYLE = [
  ':root{--bg:#0f1115;--u:#1e3a5f;--a:#1a1d24;--fg:#e6e8ec;--dim:#8b909a;--bar:#2a2e37}',
  '@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--u:#dbeafe;--a:#fff;--fg:#1a1d24;--dim:#6b7280;--bar:#e5e7eb}}',
  '*{box-sizing:border-box}body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}',
  'header{padding:16px 22px;border-bottom:1px solid var(--bar);position:sticky;top:0;background:var(--bg)}header h1{font-size:17px;margin:0}',
  'main{padding:18px 22px;max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:12px}',
  '.msg{border:1px solid var(--bar);border-radius:12px;padding:12px 14px}.msg.u{background:var(--u)}.msg.a{background:var(--a)}',
  '.who{font-weight:600;font-size:12px;margin-bottom:6px}.ts{color:var(--dim);font-weight:400}',
  '.body{white-space:normal;word-wrap:break-word;overflow-wrap:anywhere}.tools{margin-top:8px;font-size:12px;color:var(--dim);font-style:italic}',
  '.dim{color:var(--dim)}footer{padding:14px 22px;border-top:1px solid var(--bar);font-size:12px}',
  '@media(max-width:600px){header{padding:12px 14px}header h1{font-size:15px}main{padding:12px 14px;gap:10px}.msg{padding:10px 12px}footer{padding:12px 14px}}',
].join('');

module.exports = { parse: parse, toMarkdown: toMarkdown, toHtml: toHtml };
