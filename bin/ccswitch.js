#!/usr/bin/env node
'use strict';
// ccswitch — switch between multiple Anthropic / Claude Code accounts.
// Cross-platform entry point. See src/ for the implementation.
require('../src/cli').main(process.argv.slice(2)).catch(function (err) {
  process.stderr.write('❌ ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
});
