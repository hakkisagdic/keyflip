// Lightweight action log for postmortems. Key events (switch/add/clean/errors)
// are appended to <configDir>/logs/keyflip.log — the directory is only created
// on the first record, so read-only runs leave no artifacts. --debug additionally
// echoes records to stderr. Never logs secrets.
import fs from 'fs';
import path from 'path';
import { redact } from './redact.js';

const state = { dir: null, debug: false, ready: false };

function init(configDir, debug) {
  state.dir = configDir ? path.join(configDir, 'logs') : null;
  state.debug = !!debug;
  state.ready = false;
}

function log(msg) {
  const safe = redact(String(msg == null ? '' : msg));
  if (state.debug) {
    try {
      process.stderr.write('[debug] ' + safe + '\n');
    } catch {
      /* ignore */
    }
  }
  if (!state.dir) return;
  try {
    if (!state.ready) {
      fs.mkdirSync(state.dir, { recursive: true });
      state.ready = true;
    }
    fs.appendFileSync(path.join(state.dir, 'keyflip.log'), new Date().toISOString() + ' ' + safe + '\n', {
      mode: 0o600,
    });
  } catch {
    /* logging must never break the tool */
  }
}

function debugEnabled() {
  return state.debug;
}

export { init, log, debugEnabled };
