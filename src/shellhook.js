// SHELL AUTO-ACTIVATION for directory→account pins (a direnv for keyflip): emit a
// tiny shell snippet the user pastes into their rc file. On each prompt / directory
// change the snippet asks `keyflip link` for the account pinned to the CWD (see
// src/links.js) and, when it changes, switches to it for interactive use.
//
// PURE string generation — this module touches NO files, NO clock, NO network. It
// only builds shell source text, so it takes no ctx. All the runtime state (last
// CWD, last activated account) lives in SHELL variables, never on disk.
//
// SAFETY: the snippet NEVER `eval`s the CLI's output. It captures `keyflip link`
// into a variable, VALIDATES it against the account-name charset ([A-Za-z0-9._-],
// leading alnum — mirrors profiles.NAME_RE), and only then passes it as a single
// quoted argument. Anything else (empty, spaces, shell metacharacters, human-
// readable text, multi-line) fails validation and is ignored — so a hostile or
// unexpected output can never inject a command or switch to a bogus account.

const SUPPORTED = ['bash', 'zsh', 'fish'];

// Exported env var the snippet keeps in sync with the active pinned account — also
// its de-dupe key (only re-switch when the resolved account actually changes).
const MARKER = 'KEYFLIP_SHELL_ACCOUNT';
const LASTPWD = '__keyflip_last_pwd'; // internal (not exported): skip work when CWD is unchanged
const FN = '__keyflip_hook';

// The binary name is embedded verbatim into shell source, so it must be a bare,
// safe command token — never a path, never metacharacters. Same shape as an
// account name (profiles.NAME_RE).
const BIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function binOf(opts) {
  const bin = (opts && opts.bin) || 'keyflip';
  if (!BIN_RE.test(bin)) throw new Error('unsafe bin name: ' + bin);
  return bin;
}

function supported() {
  return SUPPORTED.slice();
}
function isSupported(shell) {
  return SUPPORTED.indexOf(shell) !== -1;
}

// Two-line install instruction shown as a comment header on the emitted snippet.
function installLine(shell, bin) {
  if (shell === 'fish') return bin + ' shell-init fish | source';
  return 'eval "$(' + bin + ' shell-init ' + shell + ')"';
}
function header(shell, bin) {
  return [
    '# keyflip shell auto-activation (' + shell + ') — pins your account to the current directory.',
    '# Add this to your ' + rcFile(shell) + ':',
    '#   ' + installLine(shell, bin),
    '',
  ].join('\n');
}
function rcFile(shell) {
  return shell === 'zsh' ? '~/.zshrc' : shell === 'fish' ? '~/.config/fish/config.fish' : '~/.bashrc';
}

// Shared bash/zsh hook body. Both support `local`, `case` globs, `$( )` and `[ ]`.
// Guarded on CWD so the (process-spawning) `keyflip link` call runs only when the
// directory actually changed, not on every single prompt.
function posixBody(bin) {
  return [
    FN + '() {',
    '  [ "$PWD" = "${' + LASTPWD + ':-}" ] && return',
    '  ' + LASTPWD + '="$PWD"',
    '  local __kf_want',
    '  __kf_want="$(' + bin + ' link --porcelain 2>/dev/null)"',
    '  case "$__kf_want" in',
    "    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) __kf_want='' ;;",
    '  esac',
    '  if [ "$__kf_want" != "${' + MARKER + ':-}" ]; then',
    '    [ -n "$__kf_want" ] && ' + bin + ' "$__kf_want" >/dev/null 2>&1',
    '    export ' + MARKER + '="$__kf_want"',
    '  fi',
    '}',
  ].join('\n');
}

function bash(bin) {
  return [
    posixBody(bin),
    '# Register on the prompt (idempotent: never double-appends to PROMPT_COMMAND).',
    'case "${PROMPT_COMMAND:-}" in',
    '  *' + FN + '*) ;;',
    '  *) PROMPT_COMMAND="' + FN + '${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;',
    'esac',
    '',
  ].join('\n');
}

function zsh(bin) {
  return [
    posixBody(bin),
    '# Register on the precmd hook (add-zsh-hook is idempotent).',
    'autoload -Uz add-zsh-hook 2>/dev/null',
    'if (( ${+functions[add-zsh-hook]} )); then',
    '  add-zsh-hook precmd ' + FN,
    'else',
    '  case " ${precmd_functions[*]} " in',
    '    *" ' + FN + ' "*) ;;',
    '    *) precmd_functions+=(' + FN + ') ;;',
    '  esac',
    'fi',
    '',
  ].join('\n');
}

function fish(bin) {
  return [
    // Redefining the function replaces the old one, so re-sourcing never stacks handlers.
    'function ' + FN + ' --on-variable PWD',
    '    if test "$PWD" = "$' + LASTPWD + '"',
    '        return',
    '    end',
    '    set -g ' + LASTPWD + ' "$PWD"',
    '    set -l __kf_want (' + bin + ' link --porcelain 2>/dev/null)',
    '    set __kf_want $__kf_want[1]',
    '    if not string match -rq \'^[A-Za-z0-9][A-Za-z0-9._-]*$\' -- "$__kf_want"',
    "        set __kf_want ''",
    '    end',
    '    if test "$__kf_want" != "$' + MARKER + '"',
    '        if test -n "$__kf_want"',
    '            ' + bin + ' "$__kf_want" >/dev/null 2>&1',
    '        end',
    '        set -gx ' + MARKER + ' "$__kf_want"',
    '    end',
    'end',
    FN + ' # evaluate the current directory now (the event only fires on later cd)',
    '',
  ].join('\n');
}

// hook(shell[, opts]) -> the shell source to add to the rc file. opts.bin overrides
// the CLI name ('keyflip'). Throws on an unsupported shell or an unsafe bin.
function hook(shell, opts) {
  if (!isSupported(shell))
    throw new Error("unsupported shell: '" + shell + "' (supported: " + SUPPORTED.join(', ') + ')');
  const bin = binOf(opts);
  const body = shell === 'bash' ? bash(bin) : shell === 'zsh' ? zsh(bin) : fish(bin);
  return header(shell, bin) + body;
}

export { hook, supported, isSupported, installLine, MARKER };
