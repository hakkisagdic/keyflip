'use strict';
// Tests for keyflip's own memory store (src/memory.js) + the claude -p seam (src/llm.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const memory = require('../src/memory');
const llm = require('../src/llm');
const { makeCtx } = require('./helpers');

test('memory.save writes a keepsake with frontmatter; read/has/list/remove work', function () {
  const ctx = makeCtx();
  const p = memory.save(ctx, 'sess-abc', '- did a thing\n', { session: 'sess-abc', cwd: '/x' });
  assert.ok(fs.existsSync(p));
  const txt = memory.read(ctx, 'sess-abc');
  assert.ok(txt.indexOf('session: sess-abc') !== -1, 'frontmatter present');
  assert.ok(txt.indexOf('- did a thing') !== -1);
  assert.strictEqual(memory.has(ctx, 'sess-abc'), true);
  const rows = memory.list(ctx);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].key, 'sess-abc');
  assert.strictEqual(memory.remove(ctx, 'sess-abc'), true);
  assert.strictEqual(memory.has(ctx, 'sess-abc'), false);
});

test('memory.safeKey neutralizes path separators (no traversal)', function () {
  assert.strictEqual(memory.safeKey('../../etc/passwd'), '.._.._etc_passwd');
  const ctx = makeCtx();
  const p = memory.save(ctx, '../evil', 'x');
  assert.ok(p.indexOf(path.join(ctx.configDir, 'memory')) === 0, 'stays under the memory store');
});

test('llm.summarize builds `claude -p <instr>`, pipes text on stdin, returns output', function () {
  let seen = null;
  const runner = function (cmd, args, input) {
    if (args && args[0] === '--version') return { code: 0, stdout: 'claude 1' };
    seen = { cmd: cmd, args: args, input: input };
    return { code: 0, stdout: '  a tidy summary  \n' };
  };
  const r = llm.summarize('Summarize this.', 'THE TRANSCRIPT', { run: runner, model: 'claude-haiku-4-5' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'a tidy summary');
  assert.strictEqual(seen.cmd, 'claude');
  assert.deepStrictEqual(seen.args, ['-p', 'Summarize this.', '--model', 'claude-haiku-4-5']);
  assert.strictEqual(seen.input, 'THE TRANSCRIPT'); // transcript on STDIN, not argv
});

test('llm.summarize reports claude-not-installed / failure / empty cleanly', function () {
  const absent = function () { return { code: 127, stdout: '' }; };
  assert.strictEqual(llm.summarize('x', 'y', { run: absent }).reason, 'claude-not-installed');
  const failing = function (cmd, args) { return args[0] === '--version' ? { code: 0 } : { code: 1, stderr: 'boom' }; };
  assert.strictEqual(llm.summarize('x', 'y', { run: failing }).reason, 'claude-failed');
  const empty = function (cmd, args) { return args[0] === '--version' ? { code: 0 } : { code: 0, stdout: '   ' }; };
  assert.strictEqual(llm.summarize('x', 'y', { run: empty }).reason, 'empty-output');
});
