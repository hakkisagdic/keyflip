// A minimal, zero-dependency YAML SUBSET reader — enough for config/session files (block
// mappings + sequences, indentation nesting, plain/quoted scalars, `[..]`/`{..}` flow, comments,
// scalar coercion). NOT a full YAML engine: no anchors/aliases, tags, multi-doc, or block
// scalars (| >). Isolated + fixture-tested; used best-effort for other agents' YAML.

function parse(text) {
  const lines = [];
  String(text == null ? '' : text)
    .split('\n')
    .forEach(function (raw) {
      const line = stripComment(raw);
      if (!line.trim()) return; // blank / comment-only
      if (/^(---|\.\.\.)\s*$/.test(line.trim())) return; // document markers
      lines.push({ indent: raw.match(/^\s*/)[0].replace(/\t/g, '  ').length, content: line.trim() });
    });
  let i = 0,
    depth = 0;
  const MAX_DEPTH = 200; // untrusted YAML: cap nesting so deep indentation can't overflow the stack

  function nodeAt(minIndent) {
    if (i >= lines.length || lines[i].indent < minIndent) return null;
    if (depth >= MAX_DEPTH) {
      i++;
      return null;
    } // bail on pathological nesting, keep advancing
    depth++;
    const r = lines[i].content[0] === '-' ? seqAt(lines[i].indent) : mapAt(lines[i].indent);
    depth--;
    return r;
  }
  function mapAt(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && lines[i].content[0] !== '-') {
      const kv = splitKV(lines[i].content);
      i++;
      safeSet(obj, kv.key, childOf(kv.value, indent));
    }
    return obj;
  }
  function seqAt(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].content[0] === '-') {
      const rest = lines[i].content.slice(1).replace(/^\s+/, '');
      if (rest === '') {
        i++;
        arr.push(nodeAt(indent + 1));
        continue;
      }
      if (isKV(rest)) {
        // an inline mapping on the dash line ("- key: value"): the dash + spaces add to indent
        const childIndent = indent + (lines[i].content.length - lines[i].content.slice(1).replace(/^\s+/, '').length);
        const kv = splitKV(rest);
        i++;
        const obj = {};
        safeSet(obj, kv.key, childOf(kv.value, childIndent));
        while (i < lines.length && lines[i].indent === childIndent && lines[i].content[0] !== '-') {
          const kv2 = splitKV(lines[i].content);
          i++;
          safeSet(obj, kv2.key, childOf(kv2.value, childIndent));
        }
        arr.push(obj);
      } else {
        i++;
        arr.push(scalar(rest));
      }
    }
    return arr;
  }
  // Resolve a `key:` value: inline scalar/flow, or a nested block on deeper lines, or null.
  function childOf(value, indent) {
    if (value !== '') return scalar(value);
    if (i < lines.length && lines[i].indent > indent) return nodeAt(indent + 1);
    return null;
  }
  return nodeAt(0);
}
// Store a key WITHOUT triggering the `__proto__` (or constructor/prototype) setter — a hostile
// YAML key would otherwise replace the object's prototype instead of adding a property.
function safeSet(obj, key, val) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype')
    Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
  else obj[key] = val;
}

function isKV(s) {
  return /^(?:"[^"]*"|'[^']*'|[^:{[][^:]*?):(?:\s|$)/.test(s) && s.indexOf(':') !== -1;
}
function splitKV(s) {
  // key up to the first ': ' or trailing ':', honoring quoted keys
  let key, rest;
  const m = s.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?):\s?([\s\S]*)$/);
  if (m) {
    key = unquote(m[1].trim());
    rest = m[2];
  } else {
    key = s.replace(/:$/, '');
    rest = '';
  }
  return { key: String(key), value: rest.trim() };
}
function stripComment(line) {
  // remove a `#` comment that is at line start or preceded by whitespace and not inside quotes
  let inS = false,
    inD = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (k === 0 || /\s/.test(line[k - 1]))) return line.slice(0, k);
  }
  return line;
}
function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"')
    return s.slice(1, -1).replace(/\\(["\\nt])/g, function (m, c) {
      return c === 'n' ? '\n' : c === 't' ? '\t' : c;
    });
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
function scalar(v) {
  v = v.trim();
  if (v[0] === '"' || v[0] === "'") return unquote(v);
  if (v[0] === '[') return flowSeq(v);
  if (v[0] === '{') return flowMap(v);
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}
function splitFlow(inner) {
  // split top-level commas, honoring nested []{}"" ''
  const out = [];
  let depth = 0,
    inS = false,
    inD = false,
    cur = '';
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    else if (!inS && !inD && c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function flowSeq(v) {
  return splitFlow(v.replace(/^\[/, '').replace(/\]$/, '')).map(scalar);
}
function flowMap(v) {
  const obj = {};
  splitFlow(v.replace(/^\{/, '').replace(/\}$/, '')).forEach(function (pair) {
    const kv = splitKV(pair);
    safeSet(obj, kv.key, scalar(kv.value));
  });
  return obj;
}

export { parse };
