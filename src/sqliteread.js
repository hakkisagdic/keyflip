// A minimal, READ-ONLY, zero-dependency SQLite file reader — just enough to pull rows out of a
// table B-tree (used to read Cursor's `cursorDiskKV` chat store for epic F). Implements the
// parts of the file format we need: the 100-byte header, table B-tree pages (interior + leaf),
// the record format (varints + serial types), and OVERFLOW-page chains (essential — Cursor's
// conversation values are large JSON that spills off the leaf page). NOT a general SQLite engine:
// no indexes, no WAL, no writes. Verified against sqlite3-CLI-produced fixtures in test/.

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

function open(buf) {
  if (buf.length < 100 || buf.toString('latin1', 0, 15) !== 'SQLite format 3') throw new Error('not a SQLite database');
  let pageSize = u16(buf, 16);
  if (pageSize === 1) pageSize = 65536; // the spec's escape for a 64 KiB page
  const reserved = buf[20];
  return { pageSize: pageSize, usable: pageSize - reserved, reserved: reserved };
}

// Decode a record (the payload of a table-leaf cell) into an array of column values.
function parseRecord(payload) {
  const hdr = varint(payload, 0);
  // SECURITY: the header size is an attacker-controlled varint (up to ~2^63). Clamp it to the
  // real payload so a hostile record can't spin billions of iterations (past EOF varint() would
  // otherwise return {value:0,len:1} forever) and OOM the process.
  const headerEnd = Math.min(hdr.value, payload.length);
  const types = [];
  let p = hdr.len;
  while (p < headerEnd && p < payload.length) {
    const v = varint(payload, p);
    types.push(v.value);
    p += v.len || 1;
  }
  const values = [];
  let body = headerEnd;
  types.forEach(function (t) {
    if (t === 0) {
      values.push(null);
    } else if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      values.push(readInt(payload, body, n));
      body += n;
    } else if (t === 7) {
      values.push(payload.readDoubleBE(body));
      body += 8;
    } else if (t === 8) {
      values.push(0);
    } else if (t === 9) {
      values.push(1);
    } else if (t >= 12 && t % 2 === 0) {
      const n = (t - 12) / 2;
      values.push(payload.slice(body, body + n));
      body += n;
    } // BLOB
    else {
      const n = (t - 13) / 2;
      values.push(payload.toString('utf8', body, body + n));
      body += n;
    } // TEXT
  });
  return values;
}
function readInt(b, o, n) {
  // big-endian two's-complement signed integer of n bytes
  if (n === 0) return 0;
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  const max = Math.pow(2, n * 8);
  if (v >= max / 2) v -= max;
  return v;
}

// Read a cell's full payload, following the overflow chain if it spills off the page.
function readOverflowPayload(buf, payloadSize, firstBytesOffset, usable, pageSize) {
  // Table-leaf spill threshold (SQLite "usableSize" arithmetic).
  const X = usable - 35;
  if (payloadSize <= X) return buf.slice(firstBytesOffset, firstBytesOffset + payloadSize);
  const M = Math.floor(((usable - 12) * 32) / 255) - 23;
  let K = M + ((payloadSize - M) % (usable - 4));
  if (K > X) K = M;
  const parts = [buf.slice(firstBytesOffset, firstBytesOffset + K)];
  let next = u32(buf, firstBytesOffset + K); // overflow page number stored right after the on-page bytes
  let remaining = payloadSize - K;
  const seen = {};
  while (next !== 0 && remaining > 0 && !seen[next]) {
    seen[next] = 1;
    const base = (next - 1) * pageSize;
    const nextPtr = u32(buf, base);
    const take = Math.min(remaining, usable - 4);
    parts.push(buf.slice(base + 4, base + 4 + take));
    remaining -= take;
    next = nextPtr;
  }
  return Buffer.concat(parts);
}

// Walk a table B-tree from its root page, invoking cb(record) for each leaf row.
function walkTable(buf, rootPage, cx, cb) {
  const stack = [rootPage];
  const seen = {};
  while (stack.length) {
    const pageNum = stack.pop();
    if (seen[pageNum]) continue;
    seen[pageNum] = 1;
    const base = (pageNum - 1) * cx.pageSize;
    const hoff = pageNum === 1 ? 100 : 0; // page 1 carries the 100-byte db header
    const type = buf[base + hoff];
    if (type !== 0x0d && type !== 0x05) continue; // only table leaf/interior
    const numCells = u16(buf, base + hoff + 3);
    const interior = type === 0x05;
    const cellPtrBase = base + hoff + (interior ? 12 : 8);
    if (interior) {
      const right = u32(buf, base + hoff + 8);
      stack.push(right);
    }
    for (let i = 0; i < numCells; i++) {
      const cellOff = base + u16(buf, cellPtrBase + i * 2);
      if (interior) {
        stack.push(u32(buf, cellOff)); // left child; rowid varint follows (unused)
      } else {
        const ps = varint(buf, cellOff);
        const rowid = varint(buf, cellOff + ps.len);
        const payloadStart = cellOff + ps.len + rowid.len;
        const payload = readOverflowPayload(buf, ps.value, payloadStart, cx.usable, cx.pageSize);
        cb(parseRecord(payload));
      }
    }
  }
}

// Find a table's root page from sqlite_master (root page 1). Columns: type,name,tbl_name,rootpage,sql.
function rootPageOf(buf, cx, tableName) {
  let root = -1;
  walkTable(buf, 1, cx, function (rec) {
    if (rec[0] === 'table' && rec[1] === tableName && typeof rec[3] === 'number') root = rec[3];
  });
  return root;
}

// Public: read all rows of a table as arrays of column values. Throws if the table is absent.
function readTable(buf, tableName) {
  const cx = open(buf);
  const root = rootPageOf(buf, cx, tableName);
  if (root < 0) throw new Error('no such table: ' + tableName);
  const rows = [];
  walkTable(buf, root, cx, function (rec) {
    rows.push(rec);
  });
  return rows;
}

// Convenience for a 2-column (key,value) store like Cursor's cursorDiskKV. Null-prototype map
// so an attacker-controlled DB key like `__proto__` can't mutate a prototype.
function readKV(buf, tableName) {
  const map = Object.create(null);
  readTable(buf, tableName).forEach(function (r) {
    const val = Buffer.isBuffer(r[1]) ? r[1].toString('utf8') : r[1];
    if (r[0] != null) map[String(r[0])] = val;
  });
  return map;
}

export { open, readTable, readKV, parseRecord, varint };
