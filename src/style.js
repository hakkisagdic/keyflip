// Minimal TTY-aware styling: enabled only on a TTY, disabled by NO_COLOR or
// TERM=dumb, forced by FORCE_COLOR. Piped/--json output stays plain.
function colorEnabled(stream) {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.TERM === 'dumb') return false;
  return !!(stream && stream.isTTY);
}

// opts.color === false hard-disables color (config ui.color=false), matching NO_COLOR. It only ever
// DISABLES — passing true never forces color into a non-TTY pipe; TTY detection still governs that.
function make(stream, opts) {
  let on = colorEnabled(stream);
  if (opts && opts.color === false) on = false;
  const wrap = function (code) {
    return function (s) {
      return on ? '\x1b[' + code + 'm' + s + '\x1b[0m' : String(s);
    };
  };
  return {
    enabled: on,
    bold: wrap('1'),
    dim: wrap('2'),
    accent: wrap('36'),
    ok: wrap('32'),
    warn: wrap('33'),
    err: wrap('31'),
  };
}

export { make, colorEnabled };
