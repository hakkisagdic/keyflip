// A minimal, READ-ONLY, zero-dependency SQLite file reader — just enough to pull rows out of a
// table B-tree (used to read Cursor's `cursorDiskKV` chat store for epic F). Implements the
// parts of the file format we need: the 100-byte header, table B-tree pages (interior + leaf),
// the record format (varints + serial types), and OVERFLOW-page chains (essential — Cursor's
// conversation values are large JSON that spills off the leaf page). NOT a general SQLite engine:
// no index scans, no writes. Verified against sqlite3-CLI-produced fixtures in test/.
//
// Two input shapes are accepted everywhere:
//   - a Buffer holding the whole database image (what src/foreign.js has already read), and
//   - a handle from openFile(), which reads PAGE BY PAGE from an open fd with a small cache and
//     overlays a `-wal` sidecar's committed pages. A real Cursor store is routinely 100 MB and can
//     reach tens of gigabytes; materialising one to read a few thousand chats would OOM the process,
//     so the chat readers use the handle form.
import fs from 'fs';
import * as _walmerge from './walmerge.js';

function u16(b, o) {
  return (b[o] << 8) | b[o + 1];
}
function u32(b, o) {
  return b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

// SQLite varint: 1–9 bytes, big-endian, high bit = "more"; the 9th byte contributes all 8 bits.
function varint(b, o) {
  let result = 0,
    i = 0;
  for (; i < 8; i++) {
    const byte = b[o + i];
    result = result * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return { value: result, len: i + 1 };
  }
  result = result * 256 + b[o + 8]; // 9th byte: full 8 bits
  return { value: result, len: 9 };
}

function headerOf(buf) {
  if (buf.length < 100 || buf.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('not a SQLite database');
  let pageSize = u16(buf, 16);
  if (pageSize === 1) pageSize = 65536; // the spec's escape for a 64 KiB page
  if (pageSize < 512 || pageSize > 65536 || pageSize & (pageSize - 1)) throw new Error('implausible page size');
  const reserved = buf[20];
  return { pageSize: pageSize, usable: pageSize - reserved, reserved: reserved };
}

function open(buf) {
  return headerOf(buf);
}

// A cell's payload can be larger than the page it lives on; the record format says how much stays
// on the page before the rest spills into the overflow chain (SQLite's own X/M/K arithmetic; every
// term is in terms of the USABLE bytes, so the raw page size is not needed).
function onPagePayloadBytes(payloadSize, usable) {
  const X = usable - 35;
  if (payloadSize <= X) return payloadSize;
  const M = Math.floor(((usable - 12) * 32) / 255) - 23;
  let K = M + ((payloadSize - M) % (usable - 4));
  if (K > X) K = M;
  return K;
}

// SECURITY: a record header size and payload size are attacker-controlled varints. A 2^40 payload
// would otherwise make the overflow walk spin forever or allocate forever, so a cell bigger than
// this is refused (and its row simply does not decode). Real chat rows are KBs; a composer state
// document can be a few MB.
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

// ---- views -----------------------------------------------------------------------------------
// Both views expose the same four operations: `size`, `byte(o)`, `u16(o)`/`u32(o)` on a small
// integer, and `read(off, len)` for a contiguous run. Everything above them is view-agnostic.

function bufferView(buf) {
  return {
    kind: 'buffer',
    size: buf.length,
    byte: function (o) {
      return buf[o];
    },
    u16: function (o) {
      return u16(buf, o);
    },
    u32: function (o) {
      return u32(buf, o);
    },
    read: function (off, len) {
      if (off < 0 || len <= 0) return Buffer.alloc(0);
      return buf.subarray(Math.min(off, buf.length), Math.min(off + len, buf.length));
    },
    close: function () {},
  };
}

const PAGE_CACHE_MAX = 256; // pages held at once: a few MB even at 64 KiB pages

// File view: read page-by-page through an fd, with the WAL's committed pages shadowing the file.
function makeFileView(fd, cx, walPages, logicalPages) {
  const cache = new Map();
  const ps = cx.pageSize;
  const view = {
    kind: 'file',
    size: logicalPages * ps,
    pageSize: ps,
    byte: function (o) {
      const p = page(Math.floor(o / ps) + 1);
      return p ? p[o % ps] : undefined;
    },
    u16: function (o) {
      const b = view.read(o, 2);
      return b.length === 2 ? u16(b, 0) : 0;
    },
    u32: function (o) {
      const b = view.read(o, 4);
      return b.length === 4 ? u32(b, 0) : 0;
    },
    read: function (off, len) {
      if (off < 0 || len <= 0) return Buffer.alloc(0);
      const first = Math.floor(off / ps) + 1;
      const last = Math.floor((off + len - 1) / ps) + 1;
      const parts = [];
      let need = len;
      for (let n = first; n <= last && need > 0; n++) {
        const p = page(n);
        if (!p) break;
        const start = n === first ? off - (n - 1) * ps : 0;
        const take = Math.min(need, p.length - start);
        if (take <= 0) break;
        parts.push(p.subarray(start, start + take));
        need -= take;
      }
      return parts.length === 1 ? parts[0] : Buffer.concat(parts);
    },
    close: function () {
      cache.clear();
    },
  };
  function page(n) {
    if (n < 1 || n > logicalPages) return null;
    if (walPages && walPages[n]) return walPages[n];
    const hit = cache.get(n);
    if (hit) return hit;
    const buf = Buffer.alloc(ps);
    const got = fs.readSync(fd, buf, 0, ps, (n - 1) * ps);
    if (got <= 0) return null; // past EOF and not in the WAL: the page does not exist
    const out = got === ps ? buf : buf.subarray(0, got);
    if (cache.size >= PAGE_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(n, out);
    return out;
  }
  return view;
}

function viewOf(src) {
  if (Buffer.isBuffer(src)) return bufferView(src);
  if (src && src.view) return src.view;
  throw new Error('expected a SQLite Buffer or an openFile() handle');
}

// Open a database file for page-wise reading. `opts.walFile` is folded in as a page overlay (the
// committed frames only; see src/walmerge.js) — a live Cursor keeps its newest writes there.
// Returns `{ view, cx, close, walPages }`; the caller MUST close() when done with the handle.
function openFile(file, opts) {
  opts = opts || {};
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(100); // a file shorter than the header simply fails the magic check
    if (size >= 100) fs.readSync(fd, head, 0, 100, 0);
    const cx = headerOf(head);
    const pagesInFile = Math.ceil(size / cx.pageSize);
    let walPages = null;
    let walPagesDeclared = 0;
    let walBytes = 0;
    let walTooBig = false;
    if (opts.walFile) {
      try {
        const walStat = fs.statSync(opts.walFile);
        walBytes = walStat.size;
        if (walBytes > (opts.maxWalBytes || 256 * 1024 * 1024)) {
          walTooBig = true;
        } else if (walBytes > 0) {
          const rec = _walmerge.recover(fs.readFileSync(opts.walFile), cx.pageSize);
          if (Object.keys(rec.pages).length) {
            walPages = rec.pages;
            walPagesDeclared = rec.size;
          }
        }
      } catch {
        /* no readable -wal: the main file alone is the truth */
      }
    }
    // SECURITY: a planted WAL can declare an enormous database. The page count is clamped to what
    // the bytes could really hold; pages past it read as absent rather than allocating anything.
    const logicalPages = Math.max(pagesInFile, Math.min(walPagesDeclared, pagesInFile + 4096));
    const view = makeFileView(fd, cx, walPages, logicalPages);
    return {
      fd: fd,
      view: view,
      cx: cx,
      file: file,
      pages: logicalPages,
      walFile: opts.walFile || null,
      walBytes: walBytes,
      walPages: walPages ? Object.keys(walPages).length : 0,
      walUnreadable: walTooBig,
      closed: false,
      close: closeHandle,
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function closeHandle() {
  if (this.closed) return;
  this.closed = true;
  try {
    this.view.close();
  } catch {
    /* cache cleanup is best-effort */
  }
  fs.closeSync(this.fd);
}

// ---- record decoding -------------------------------------------------------------------------

// Decode a record (the payload of a table-leaf cell) into an array of column values. With `want`
// finite, only that many leading columns are decoded and the walk stops — that is how a filtered
// scan reads a row's KEY without touching a multi-megabyte value. `strict` refuses a payload that
// ends mid-column instead of inventing values, so a truncated peek can be retried in full.
function decodeColumns(payload, want, strict) {
  const hdr = varint(payload, 0);
  // SECURITY: the header size is an attacker-controlled varint (up to ~2^63). Clamp it to the
  // real payload so a hostile record can't spin billions of iterations (past EOF varint() would
  // otherwise return {value:0,len:1} forever) and OOM the process.
  const headerEnd = Math.min(hdr.value, payload.length);
  const types = [];
  let p = hdr.len;
  while (p < headerEnd && p < payload.length && (want === Infinity || types.length < want)) {
    const v = varint(payload, p);
    types.push(v.value);
    p += v.len || 1;
  }
  const values = [];
  let body = headerEnd;
  for (const t of types) {
    let size = 0;
    let val;
    if (t === 0) {
      val = null;
    } else if (t >= 1 && t <= 6) {
      size = [0, 1, 2, 3, 4, 6, 8][t];
      val = readInt(payload, body, size);
    } else if (t === 7) {
      size = 8;
      val = payload.readDoubleBE(body);
    } else if (t === 8) {
      val = 0;
    } else if (t === 9) {
      val = 1;
    } else if (t >= 12 && t % 2 === 0) {
      size = (t - 12) / 2;
      val = payload.slice(body, body + size);
    } // BLOB
    else {
      size = (t - 13) / 2;
      val = payload.toString('utf8', body, body + size);
    } // TEXT
    if (strict && body + size > payload.length) return null; // the peek did not have the whole column
    values.push(val);
    body += size;
    if (want !== Infinity && values.length >= want) break;
  }
  return values;
}

function parseRecord(payload) {
  return decodeColumns(payload, Infinity, false);
}

// First `count` columns, or null when `payload` is a truncated image that does not hold them.
function peekColumns(payload, count) {
  try {
    return decodeColumns(payload, count, true);
  } catch {
    return null; // readDoubleBE past the end of a short image
  }
}

function readInt(b, o, n) {
  // big-endian two's-complement signed integer of n bytes
  if (n === 0) return 0;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + (b[o + i] || 0);
  const max = Math.pow(2, n * 8);
  if (v >= max / 2) v -= max;
  return v;
}

// ---- B-tree walking --------------------------------------------------------------------------

// Read a leaf cell's whole payload, following the overflow chain when it spills off the page.
function readCellPayload(view, cx, payloadSize, payloadStart) {
  if (payloadSize > MAX_PAYLOAD_BYTES) return Buffer.alloc(0);
  const K = onPagePayloadBytes(payloadSize, cx.usable);
  const head = view.read(payloadStart, K);
  if (payloadSize <= K) return head;
  const parts = [head];
  let next = view.u32(payloadStart + K); // overflow page number stored right after the on-page bytes
  let remaining = payloadSize - K;
  const seen = Object.create(null);
  let guard = 0;
  while (next !== 0 && remaining > 0 && !seen[next] && guard++ < 100000) {
    seen[next] = 1;
    const base = (next - 1) * cx.pageSize;
    const nextPtr = view.u32(base);
    const take = Math.min(remaining, cx.usable - 4);
    parts.push(view.read(base + 4, take));
    remaining -= take;
    next = nextPtr;
  }
  return Buffer.concat(parts);
}

// Walk a table B-tree, invoking onCell(payloadSize, payloadStart, rowid) for each leaf row. The
// caller decides whether the payload is worth reading at all — that is the whole point of a
// filtered scan over a store whose rows are mostly not chats.
function walkCells(view, cx, rootPage, onCell) {
  const stack = [rootPage];
  const seen = Object.create(null);
  while (stack.length) {
    const pageNum = stack.pop();
    if (seen[pageNum]) continue;
    seen[pageNum] = 1;
    // The page header is 8 bytes on a leaf and 12 on an interior page (the extra 4 are the
    // right-most child pointer); page 1 puts the 100-byte database header in front of it.
    const header = view.read((pageNum - 1) * cx.pageSize, (pageNum === 1 ? 100 : 0) + 12);
    if (header.length < 8) continue;
    const hoff = pageNum === 1 ? 100 : 0; // page 1 carries the 100-byte db header
    const type = header[hoff];
    if (type !== 0x0d && type !== 0x05) continue; // only table leaf/interior
    const numCells = u16(header, hoff + 3);
    if (numCells > Math.floor(cx.usable / 4)) continue; // no page holds that many cells: refuse it
    const interior = type === 0x05;
    if (interior) {
      const right = u32(header, hoff + 8);
      if (right > 0) stack.push(right);
    }
    const cellPtrBase = (pageNum - 1) * cx.pageSize + hoff + (interior ? 12 : 8);
    for (let i = 0; i < numCells; i++) {
      const ptrBuf = view.read(cellPtrBase + i * 2, 2);
      if (ptrBuf.length < 2) break;
      const cellOff = (pageNum - 1) * cx.pageSize + u16(ptrBuf, 0);
      if (interior) {
        const child = view.read(cellOff, 4);
        if (child.length === 4 && u32(child, 0) > 0) stack.push(u32(child, 0)); // left child
      } else {
        const lead = view.read(cellOff, 18); // at most 9 + 9 varint bytes: payload size, then rowid
        if (lead.length < 2) continue;
        const ps = varint(lead, 0);
        const rowid = varint(lead, ps.len);
        // A varint that ran out of window means the row sits on a truncated tail; reading it would
        // put payloadStart inside the header and invent a record, so the row is dropped instead.
        if (lead.length < 18 && ps.len + rowid.len >= lead.length) continue;
        onCell(ps.value, cellOff + ps.len + rowid.len, rowid.value);
      }
    }
  }
}

function walkTable(view, cx, rootPage, cb) {
  walkCells(view, cx, rootPage, function (payloadSize, payloadStart, rowid) {
    cb(parseRecord(readCellPayload(view, cx, payloadSize, payloadStart)), rowid);
  });
}

function contextOf(src) {
  return { view: viewOf(src), cx: Buffer.isBuffer(src) ? headerOf(src) : src.cx };
}

// Find a table's root page, CREATE statement and column names from sqlite_master (root page 1).
// Columns: type,name,tbl_name,rootpage,sql.
function tableMeta(view, cx, tableName) {
  let root = -1;
  let sql = null;
  walkTable(view, cx, 1, function (rec) {
    if (rec[0] === 'table' && rec[1] === tableName && typeof rec[3] === 'number') {
      root = rec[3];
      sql = typeof rec[4] === 'string' ? rec[4] : null;
    }
  });
  if (root < 0) return null;
  return { root: root, sql: sql, columns: columnsOf(sql) };
}

// Column names in declaration order, from a CREATE TABLE statement. Enough to map a row's positional
// values onto names; table constraints (PRIMARY KEY …) are not columns and are dropped.
function columnsOf(sql) {
  if (typeof sql !== 'string') return [];
  const open_ = sql.indexOf('(');
  if (open_ < 0) return [];
  let depth = 0;
  let body = '';
  for (let i = open_; i < sql.length; i++) {
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        body = sql.slice(open_ + 1, i);
        break;
      }
    }
  }
  const out = [];
  let part = '';
  let d = 0;
  const parts = [];
  for (const c of body) {
    if (c === '(') d++;
    if (c === ')') d--;
    if (c === ',' && d === 0) {
      parts.push(part);
      part = '';
    } else part += c;
  }
  if (part.trim()) parts.push(part);
  parts.forEach(function (p) {
    const t = p.trim();
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(t)) return;
    const m = t.match(/^("([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w]*))/);
    if (!m) return;
    out.push(m[2] || m[3] || m[4] || m[5] || '');
  });
  return out;
}

// Public: read all rows of a table as arrays of column values. Throws if the table is absent.
function readTable(src, tableName) {
  const ctx = contextOf(src);
  const meta = tableMeta(ctx.view, ctx.cx, tableName);
  if (!meta) throw new Error('no such table: ' + tableName);
  const rows = [];
  walkTable(ctx.view, ctx.cx, meta.root, function (rec) {
    rows.push(rec);
  });
  return rows;
}

// Public: a table's column names, in declaration order — enough to decode a row positionally
// against a schema that has drifted between releases. [] when the table is absent.
function tableColumns(src, tableName) {
  const ctx = contextOf(src);
  const meta = tableMeta(ctx.view, ctx.cx, tableName);
  return meta ? meta.columns : [];
}

// Convenience for a 2-column (key,value) store like Cursor's cursorDiskKV. Null-prototype map
// so an attacker-controlled DB key like `__proto__` can't mutate a prototype.
function readKV(src, tableName) {
  const map = Object.create(null);
  readTable(src, tableName).forEach(function (r) {
    const val = Buffer.isBuffer(r[1]) ? r[1].toString('utf8') : r[1];
    if (r[0] != null) map[String(r[0])] = val;
  });
  return map;
}

// Filtered, memory-bounded key scan — the shape a chat store the size of a database needs.
// For every leaf row it decodes ONLY the key column (never the value) and keeps `cell` descriptors
// for the rows whose key `want(key)` accepted. A Cursor store is mostly non-chat state (request
// caches, diffs, renderer hints), so this turns "decode a million rows into a map" into "remember
// where the few thousand rows we came for live". The values are NOT read here: pass a cell back to
// cellValue() when you actually want one, which is what keeps a large store's memory flat while
// many chats are enumerated.
// Returns `{ cells, rows, matched, aborted }`; `aborted` says `opts.maxRows`/`opts.maxBytes` stopped
// the walk, so a caller reports a partial read instead of a silently short one.
function scanCells(src, tableName, want, opts) {
  opts = opts || {};
  const ctx = contextOf(src);
  const meta = tableMeta(ctx.view, ctx.cx, tableName);
  if (!meta) throw new Error('no such table: ' + tableName);
  const maxRows = opts.maxRows || Infinity;
  const maxBytes = opts.maxBytes || Infinity;
  const maxPayload = opts.maxPayloadBytes || MAX_PAYLOAD_BYTES;
  const cells = [];
  const state = { cells: cells, rows: 0, matched: 0, bytes: 0, aborted: false };
  walkCells(ctx.view, ctx.cx, meta.root, function (payloadSize, payloadStart, rowid) {
    if (state.rows >= maxRows || state.bytes >= maxBytes) {
      state.aborted = true;
      return;
    }
    state.rows++;
    state.bytes += payloadSize;
    if (payloadSize > maxPayload) return; // a value this big is not the row we came for
    // Read only the bytes on this page and decode only the FIRST column: that is the key, and the
    // key is what decides whether the (possibly megabyte) value is worth following at all. A row
    // whose key itself spills off the page decodes to null and is skipped — no chat key is that long.
    const K = onPagePayloadBytes(payloadSize, ctx.cx.usable);
    const peek = peekColumns(ctx.view.read(payloadStart, Math.min(K, payloadSize)), 1);
    if (!peek || peek[0] == null) return;
    const key = Buffer.isBuffer(peek[0]) ? peek[0].toString('utf8') : String(peek[0]);
    if (!want(key)) return;
    state.matched++;
    // `keyBuf` keeps the UNconverted first column: a binary primary key is lossy through `key`
    // (UTF-8 decoding replaces each invalid byte run with U+FFFD), so a caller that matches
    // content-addressed blob ids against hex references needs the raw bytes back.
    cells.push({ key: key, keyBuf: peek[0], rowid: rowid, payloadSize: payloadSize, payloadStart: payloadStart });
  });
  return state;
}

// Read one column of a cell found by scanCells. `col` defaults to 1 (the value of a key/value row);
// pass withBuffer to get the raw bytes (a BLOB-affinity column arrives as a Buffer either way).
function cellValue(src, cell, col, withBuffer) {
  const ctx = contextOf(src);
  const rec = parseRecord(readCellPayload(ctx.view, ctx.cx, cell.payloadSize, cell.payloadStart));
  const v = rec[col == null ? 1 : col];
  if (Buffer.isBuffer(v)) return withBuffer ? v : v.toString('utf8');
  return withBuffer ? (v == null ? null : Buffer.from(String(v), 'utf8')) : v;
}

export {
  open,
  readTable,
  readKV,
  parseRecord,
  peekColumns,
  varint,
  openFile,
  scanCells,
  cellValue,
  tableColumns,
  bufferView,
  MAX_PAYLOAD_BYTES,
};
