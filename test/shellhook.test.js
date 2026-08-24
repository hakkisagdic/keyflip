// shellhook: PURE shell-source generation for direnv-style account auto-activation.
// Pure-string tests always run; the shell tests (syntax-check + a real behavioral
// drive of the emitted hook under bash/zsh) run only when that shell is installed.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cp from 'child_process';
import * as shellhook from '../src/shellhook.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kf-shellhook-'));
}
function have(bin, args) {
  try {
    cp.execFileSync(bin, args || ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// ---- pure string generation (always runs) ----------------------------------

test('supported() lists the three shells and returns a fresh copy', function () {
  assert.deepStrictEqual(shellhook.supported(), ['bash', 'zsh', 'fish']);
  const a = shellhook.supported();
  a.push('nu');
  assert.deepStrictEqual(
    shellhook.supported(),
    ['bash', 'zsh', 'fish'],
    'mutating the result does not leak into the module',
  );
});

test('isSupported reflects the list', function () {
  ['bash', 'zsh', 'fish'].forEach(function (s) {
    assert.ok(shellhook.isSupported(s));
  });
  ['sh', 'nu', 'powershell', '', null, undefined].forEach(function (s) {
    assert.ok(!shellhook.isSupported(s));
  });
});

test('hook() throws on an unsupported shell', function () {
  assert.throws(function () {
    shellhook.hook('sh');
  }, /unsupported shell/);
  assert.throws(function () {
    shellhook.hook('powershell');
  }, /unsupported shell/);
  assert.throws(function () {
    shellhook.hook('');
  }, /unsupported shell/);
});

test('hook() throws on an unsafe bin name (never interpolate metacharacters into shell source)', function () {
  ['ke yflip', 'keyflip; rm -rf /', '../keyflip', '/usr/bin/keyflip', '$(evil)', 'key`x`', '-rf', '.hidden'].forEach(
    function (bad) {
      assert.throws(
        function () {
          shellhook.hook('bash', { bin: bad });
        },
        /unsafe bin/,
        'rejects bin: ' + bad,
      );
    },
  );
});

test('every shell snippet: validates output, never evals it, quotes the value, exports the marker', function () {
  shellhook.supported().forEach(function (sh) {
    const s = shellhook.hook(sh);
    assert.ok(s.length > 0);
    // it must consult `keyflip link`
    assert.ok(s.indexOf('keyflip link') !== -1, sh + ': calls keyflip link');
    // it must carry the account-name charset validation (case-glob for posix, regex for fish)
    assert.ok(/A-Za-z0-9\._-|A-Za-z0-9\.\_-|A-Za-z0-9/.test(s), sh + ': has a charset guard');
    // the exported marker/de-dupe var
    assert.ok(s.indexOf('KEYFLIP_SHELL_ACCOUNT') !== -1, sh + ': exports the marker');
    // SAFETY: the captured link output is NEVER eval'd / sourced.
    assert.ok(s.indexOf('eval "$(keyflip link') === -1, sh + ': does not eval link output');
    assert.ok(s.indexOf('eval $(') === -1, sh + ': no bare eval of a subshell');
    assert.ok(!/\beval\b[^\n]*__kf_want/.test(s), sh + ': never evals the resolved value');
    // the value is only ever used quoted
    assert.ok(s.indexOf('"$__kf_want"') !== -1, sh + ': uses the value quoted');
  });
});

test('bash/zsh snippets register idempotently on the prompt', function () {
  const b = shellhook.hook('bash');
  assert.ok(b.indexOf('PROMPT_COMMAND') !== -1, 'bash uses PROMPT_COMMAND');
  assert.ok(b.indexOf('*__keyflip_hook*') !== -1, 'bash guards against double-append');
  const z = shellhook.hook('zsh');
  assert.ok(z.indexOf('add-zsh-hook precmd') !== -1, 'zsh registers a precmd hook');
});

test('fish snippet binds to PWD changes and evaluates the current dir once', function () {
  const f = shellhook.hook('fish');
  assert.ok(f.indexOf('--on-variable PWD') !== -1, 'fish binds to PWD');
  assert.ok(f.indexOf('string match -rq') !== -1, 'fish validates with a regex');
  assert.ok(
    /\n__keyflip_hook /.test(f) || f.trimEnd().endsWith('__keyflip_hook') || /__keyflip_hook #/.test(f),
    'fish calls the hook once at source time',
  );
});

test('install header carries the right instruction per shell', function () {
  assert.ok(shellhook.hook('bash').indexOf('eval "$(keyflip shell-init bash)"') !== -1);
  assert.ok(shellhook.hook('zsh').indexOf('eval "$(keyflip shell-init zsh)"') !== -1);
  assert.ok(shellhook.hook('fish').indexOf('keyflip shell-init fish | source') !== -1);
  assert.strictEqual(shellhook.installLine('fish', 'keyflip'), 'keyflip shell-init fish | source');
  assert.strictEqual(shellhook.installLine('zsh', 'keyflip'), 'eval "$(keyflip shell-init zsh)"');
});

test('opts.bin is substituted everywhere the CLI is invoked', function () {
  const s = shellhook.hook('bash', { bin: 'kf' });
  assert.ok(s.indexOf('kf link') !== -1, 'uses the custom bin for link');
  assert.ok(s.indexOf('kf "$__kf_want"') !== -1, 'uses the custom bin for the switch');
  assert.ok(s.indexOf('keyflip link') === -1, 'no stray default bin');
});

// ---- syntax check under each shell (only if installed) ----------------------

function syntaxOk(shellBin, args, snippet) {
  const dir = tmp();
  const f = path.join(dir, 'hook');
  fs.writeFileSync(f, snippet);
  cp.execFileSync(shellBin, args.concat([f]), { stdio: 'pipe' });
}

test('bash parses the emitted hook (bash -n)', { skip: !have('bash') }, function () {
  syntaxOk('bash', ['-n'], shellhook.hook('bash'));
});
test('zsh parses the emitted hook (zsh -n)', { skip: !have('zsh') }, function () {
  syntaxOk('zsh', ['-n'], shellhook.hook('zsh'));
});
test('fish parses the emitted hook (fish --no-execute)', { skip: !have('fish') }, function () {
  syntaxOk('fish', ['--no-execute'], shellhook.hook('fish'));
});

// ---- end-to-end behavioral drive under bash/zsh ----------------------------
// Stand up a FAKE `keyflip` on PATH: `keyflip link` prints the `.kflink` file in
// the CWD (or nothing); any other call is a "switch" and is appended to KF_LOG.
// Then source the real emitted hook and cd around, calling the hook function
// directly (PROMPT_COMMAND/precmd don't fire in a non-interactive shell).

function stage() {
  const base = tmp();
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(binDir);
  const fake = [
    '#!/usr/bin/env bash',
    'if [ "$1" = "link" ]; then',
    '  [ -f .kflink ] && cat .kflink',
    '  exit 0',
    'fi',
    'printf "%s\\n" "$1" >> "$KF_LOG"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'keyflip'), fake, { mode: 0o755 });
  fs.chmodSync(path.join(binDir, 'keyflip'), 0o755);
  const mk = function (name, link) {
    const d = path.join(base, name);
    fs.mkdirSync(d);
    if (link !== null && link !== undefined) fs.writeFileSync(path.join(d, '.kflink'), link);
    return d;
  };
  const dirs = {
    A: mk('A', 'work'), // valid pin
    B: mk('B', null), // unlinked
    C: mk('C', 'bad name!'), // invalid: space + !
    D: mk('D', ';touch PWNED'), // command-injection attempt
    E: mk('E', '-rf'), // leading-dash / option-injection attempt
  };
  return { base: base, binDir: binDir, dirs: dirs, log: path.join(base, 'switch.log') };
}

function driveScript(hookFile, d) {
  return [
    'source "' + hookFile + '"',
    'cd "' + d.dirs.A + '"; __keyflip_hook; echo "s1=[$KEYFLIP_SHELL_ACCOUNT]"',
    '__keyflip_hook; echo "s2=[$KEYFLIP_SHELL_ACCOUNT]"',
    'cd "' + d.dirs.B + '"; __keyflip_hook; echo "s3=[$KEYFLIP_SHELL_ACCOUNT]"',
    'cd "' + d.dirs.A + '"; __keyflip_hook; echo "s4=[$KEYFLIP_SHELL_ACCOUNT]"',
    'cd "' + d.dirs.C + '"; __keyflip_hook; echo "s5=[$KEYFLIP_SHELL_ACCOUNT]"',
    'cd "' + d.dirs.D + '"; __keyflip_hook; echo "s6=[$KEYFLIP_SHELL_ACCOUNT]"',
    'cd "' + d.dirs.E + '"; __keyflip_hook; echo "s7=[$KEYFLIP_SHELL_ACCOUNT]"',
    'true',
    '',
  ].join('\n');
}

function runDrive(shellBin, shellName) {
  const d = stage();
  const hookFile = path.join(d.base, 'hook.' + shellName);
  fs.writeFileSync(hookFile, shellhook.hook(shellName, { bin: 'keyflip' }));
  const driver = path.join(d.base, 'drive.sh');
  fs.writeFileSync(driver, driveScript(hookFile, d));
  const out = cp.execFileSync(shellBin, [driver], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: d.binDir + path.delimiter + process.env.PATH, KF_LOG: d.log }),
  });
  const markers = {};
  out.split('\n').forEach(function (line) {
    const m = /^(s\d)=\[(.*)\]$/.exec(line);
    if (m) markers[m[1]] = m[2];
  });
  const log = fs.existsSync(d.log) ? fs.readFileSync(d.log, 'utf8').split('\n').filter(Boolean) : [];
  return { markers: markers, log: log, base: d.base, dirs: d.dirs };
}

function assertBehavior(r, shellName) {
  // valid pin activates; a second prompt in the same dir does NOT re-switch (CWD gate)
  assert.strictEqual(r.markers.s1, 'work', shellName + ': A activates work');
  assert.strictEqual(r.markers.s2, 'work', shellName + ': same dir keeps marker');
  // unlinked dir clears the marker but does not switch anything
  assert.strictEqual(r.markers.s3, '', shellName + ': unlinked clears marker');
  // returning to A re-activates
  assert.strictEqual(r.markers.s4, 'work', shellName + ': re-entering A re-activates');
  // hostile/invalid outputs are all rejected -> marker cleared, nothing run
  assert.strictEqual(r.markers.s5, '', shellName + ': invalid name rejected');
  assert.strictEqual(r.markers.s6, '', shellName + ': injection rejected');
  assert.strictEqual(r.markers.s7, '', shellName + ': leading-dash rejected');
  // exactly two REAL switches happened, both to work (s1 and s4)
  assert.deepStrictEqual(r.log, ['work', 'work'], shellName + ': only the valid pin was ever switched to');
  // the injection never executed
  assert.ok(!fs.existsSync(path.join(r.dirs.D, 'PWNED')), shellName + ': no command injection');
  assert.ok(
    r.log.indexOf('-rf') === -1 && r.log.indexOf(';touch PWNED') === -1,
    shellName + ': no hostile arg reached the CLI',
  );
}

test('bash: emitted hook auto-activates pins and rejects hostile output', { skip: !have('bash') }, function () {
  assertBehavior(runDrive('bash', 'bash'), 'bash');
});
test('zsh: emitted hook auto-activates pins and rejects hostile output', { skip: !have('zsh') }, function () {
  assertBehavior(runDrive('zsh', 'zsh'), 'zsh');
});
