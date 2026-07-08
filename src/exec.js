'use strict';
// Tiny synchronous process runner. Never throws; returns a normalized result.
const { spawnSync } = require('child_process');

function run(cmd, args, input, opts) {
  opts = opts || {};
  const res = spawnSync(cmd, args || [], {
    input: input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeoutMs,
    cwd: opts.cwd, // undefined => inherit; orchestrator jobs must run in the job's own cwd
    env: opts.env, // undefined => inherit process.env
  });
  return {
    code: typeof res.status === 'number' ? res.status : 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error || null,
    timedOut: !!(res.error && res.error.code === 'ETIMEDOUT'),
  };
}

module.exports = { run };
