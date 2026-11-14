#!/usr/bin/env node
// keyflip — switch between multiple Anthropic / Claude Code accounts.
// Cross-platform entry point. See src/ for the implementation.
import { main } from '../src/cli.js';
import { redact } from '../src/redact.js';
main(process.argv.slice(2)).catch(function (err) {
  const msg = redact(err && err.message ? String(err.message) : String(err));
  process.stderr.write('❌ ' + msg + '\n');
  process.exit(1);
});
