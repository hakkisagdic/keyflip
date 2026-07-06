'use strict';
// The headless-Claude seam used by distill / dream: run `claude -p "<instruction>"` with
// the transcript on STDIN and return the model's text. Zero-dep (shells the Claude Code
// CLI); degrades to a clear error if `claude` isn't installed. NOTE: this spends the ACTIVE
// account's quota — callers must make that explicit and get consent. Runner is injectable
// for tests. The instruction is a non-secret positional arg; the (possibly huge) transcript
// goes on stdin so it never hits argv limits.
const { run } = require('./exec');

function available(runner) { try { const r = (runner || run)('claude', ['--version']); return !!(r && r.code === 0); } catch (e) { return false; } }

// Summarize `text` with `instruction`. Returns { ok:true, text } or { ok:false, reason }.
function summarize(instruction, text, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (!opts.skipCheck && !available(runner)) return { ok: false, reason: 'claude-not-installed' };
  const args = ['-p', String(instruction)];
  if (opts.model) args.push('--model', String(opts.model));
  const r = runner('claude', args, String(text || ''), { timeoutMs: opts.timeoutMs || 180000 });
  if (!r || r.code !== 0) return { ok: false, reason: 'claude-failed', detail: r && r.stderr };
  const out = String(r.stdout || '').trim();
  if (!out) return { ok: false, reason: 'empty-output' };
  return { ok: true, text: out };
}

module.exports = { available: available, summarize: summarize };
