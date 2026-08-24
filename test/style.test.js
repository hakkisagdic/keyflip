// Minimal styler + the config ui.color=false hard-disable (make(stream, {color:false})).
// Env (NO_COLOR/FORCE_COLOR/TERM) is neutralized so the assertions are deterministic in any CI.
import test from 'node:test';
import assert from 'node:assert';
import * as style from '../src/style.js';

function withCleanEnv(fn) {
  const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR, TERM: process.env.TERM };
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
  process.env.TERM = 'xterm';
  try {
    fn();
  } finally {
    Object.keys(saved).forEach(function (k) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  }
}

test('make: opts.color===false hard-disables color even on a TTY (config ui.color=false)', function () {
  withCleanEnv(function () {
    const tty = { isTTY: true };
    assert.strictEqual(style.make(tty).enabled, true, 'TTY → color on by default');
    const off = style.make(tty, { color: false });
    assert.strictEqual(off.enabled, false, 'opts.color=false forces off');
    assert.strictEqual(off.ok('x'), 'x', 'disabled → no ANSI');
    assert.strictEqual(style.make(tty).ok('x').indexOf('\x1b['), 0, 'enabled → ANSI-wrapped');
  });
});

test('make: opts.color===true never forces color into a non-TTY pipe', function () {
  withCleanEnv(function () {
    const pipe = { isTTY: false };
    assert.strictEqual(style.make(pipe, { color: true }).enabled, false, 'true does not force color into a pipe');
    assert.strictEqual(style.make(pipe).enabled, false, 'pipe → off');
  });
});

test('NO_COLOR still wins regardless of opts', function () {
  const saved = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    assert.strictEqual(style.make({ isTTY: true }, { color: true }).enabled, false, 'NO_COLOR forces off');
  } finally {
    if (saved === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved;
  }
});
