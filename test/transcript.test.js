// Tests for session export (src/transcript.js): parse the Claude Code JSONL into a clean
// conversation, render markdown/HTML. Tool noise is summarized, not dumped.
import test from 'node:test';
import assert from 'node:assert';
import * as transcript from '../src/transcript.js';

const JSONL = [
  '{"type":"user","cwd":"/Users/me/proj","timestamp":"2026-07-07T09:00:00Z","message":{"role":"user","content":"Fix the login bug"}}',
  '{"type":"assistant","timestamp":"2026-07-07T09:00:05Z","message":{"role":"assistant","content":[{"type":"text","text":"Looking at the auth code."},{"type":"tool_use","name":"Read"},{"type":"tool_use","name":"Read"},{"type":"tool_use","name":"Grep"}]}}',
  '{"type":"user","timestamp":"2026-07-07T09:00:06Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"...500 lines..."}]}}',
  '{"type":"assistant","timestamp":"2026-07-07T09:00:10Z","message":{"role":"assistant","content":[{"type":"text","text":"Fixed the null check."}]}}',
  '{"type":"summary","summary":"a meta line to ignore"}',
].join('\n');

test('parse: extracts the conversation, skips tool-result turns + meta lines', function () {
  const p = transcript.parse(JSONL);
  assert.strictEqual(p.cwd, '/Users/me/proj');
  assert.strictEqual(p.counts.messages, 3, 'the pure tool-result turn and the summary line are elided');
  assert.strictEqual(p.counts.user, 1);
  assert.strictEqual(p.counts.assistant, 2);
  assert.strictEqual(p.messages[0].text, 'Fix the login bug');
  assert.deepStrictEqual(p.messages[1].tools, ['Read', 'Read', 'Grep']);
});

test('parse: handles string content and array content; tolerates bad lines', function () {
  const p = transcript.parse(
    'not json\n{"type":"user","message":{"role":"user","content":"hi"}}\n\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}',
  );
  assert.strictEqual(p.counts.messages, 2);
  assert.strictEqual(p.messages[0].text, 'hi');
  assert.strictEqual(p.messages[1].text, 'yo');
});

test('parse: empty / whitespace input yields no messages, never throws', function () {
  assert.strictEqual(transcript.parse('').counts.messages, 0);
  assert.strictEqual(transcript.parse(null).counts.messages, 0);
  assert.strictEqual(transcript.parse('   \n  \n').counts.messages, 0);
});

test('toMarkdown: renders roles, dedupes tool names, includes counts', function () {
  const md = transcript.toMarkdown(transcript.parse(JSONL), { id: 'sess1234abcd' });
  assert.ok(md.indexOf('# Session `sess1234`') !== -1);
  assert.ok(md.indexOf('3 messages (1 you / 2 Claude)') !== -1);
  assert.ok(md.indexOf('### You') !== -1 && md.indexOf('### Claude') !== -1);
  assert.ok(md.indexOf('_→ used Read, Grep_') !== -1, 'tool names de-duplicated (one Read, not two)');
  assert.ok(md.indexOf('Fix the login bug') !== -1);
});

test('toHtml: self-contained (no script/fetch), escapes content, preserves newlines', function () {
  const evil = transcript.parse(
    '{"type":"user","message":{"role":"user","content":"<script>alert(1)</script>\\nline2"}}',
  );
  const html = transcript.toHtml(evil, { id: 'x' });
  assert.ok(/^<!doctype html>/i.test(html));
  assert.strictEqual(html.indexOf('<script>alert(1)'), -1, 'user content is HTML-escaped (no injection)');
  assert.ok(html.indexOf('&lt;script&gt;') !== -1);
  assert.ok(html.indexOf('line2') !== -1 && html.indexOf('<br>') !== -1, 'newlines become <br>');
  assert.strictEqual(html.indexOf('/api/'), -1, 'no network calls');
});

test('toHtml: user vs assistant get distinct bubble classes', function () {
  const html = transcript.toHtml(transcript.parse(JSONL), { id: 'x' });
  assert.ok(html.indexOf('class="msg u"') !== -1 && html.indexOf('class="msg a"') !== -1);
});

// SECURITY (review P0): a foreign JSONL sets `role` verbatim — it must not inject HTML.
test('toHtml sanitizes+escapes an attacker-controlled role (no XSS)', function () {
  const html = transcript.toHtml(
    transcript.parse('{"type":"user","message":{"role":"<img src=x onerror=alert(1)>","content":"hi"}}'),
    { id: 'x' },
  );
  const whoDiv = html.match(/<div class="who">([\s\S]*?)<\/div>/)[1].replace(/<span[\s\S]*/, '');
  assert.ok(
    whoDiv.indexOf('<') === -1 && whoDiv.indexOf('>') === -1 && whoDiv.indexOf('=') === -1,
    'no raw markup/attribute chars survive in the role label',
  );
  assert.strictEqual(html.indexOf('<img src=x'), -1);
});
