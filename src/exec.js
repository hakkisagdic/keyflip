// Tiny synchronous process runner. Never throws; returns a normalized result.
import { spawnSync } from 'child_process';
import path from 'path';
import { refuseCommand, active, isTempKeychainFile } from './spawnguard.js';

// KEYFLIP_KEYCHAIN_FILE (documented; set by the test setup to a throwaway file) sends every item-level
// `security` call that names no keychain to that one file instead of the login Keychain.
const ITEM_CMDS = new Set(['find-generic-password', 'add-generic-password', 'delete-generic-password']);
// The variable only counts under the test guard or when it names a keychain file under the temp dir.
function confinedFile() {
  const file = process.env.KEYFLIP_KEYCHAIN_FILE;
  return file && (active() || isTempKeychainFile(file)) ? file : null;
}
function withKeychainFile(cmd, args) {
  const file = confinedFile();
  if (!file || path.basename(String(cmd)) !== 'security' || !Array.isArray(args) || !ITEM_CMDS.has(args[0]))
    return args;
  if (args.some((a) => /\.keychain(-db)?$/.test(String(a)))) return args;
  return args.concat([file]);
}

// The same redirection for `security -i`, whose commands arrive on stdin one per line.
function withKeychainFileInput(cmd, args, input) {
  const file = confinedFile();
  if (!file || path.basename(String(cmd)) !== 'security' || !Array.isArray(args) || args[0] !== '-i') return input;
  if (typeof input !== 'string' || /\.keychain(-db)?\b/.test(input.split('\n').slice(0, 1).join(''))) return input;
  const q = '"' + file.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return input
    .split('\n')
    .map(function (line, i) {
      return i === 0 && ITEM_CMDS.has(line.split(' ')[0]) ? line + ' ' + q : line;
    })
    .join('\n');
}

function run(cmd, args, input, opts) {
  opts = opts || {};
  input = withKeychainFileInput(cmd, args, input);
  args = withKeychainFile(cmd, args);
  // A test run never opens, quits or notifies through a real desktop tool (see spawnguard.js).
  const refusal = refuseCommand(cmd, args, input, opts);
  if (refusal) return refusal;
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

export { run, withKeychainFile, withKeychainFileInput };
