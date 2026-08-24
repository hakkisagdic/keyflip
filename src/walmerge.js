// Zero-dep SQLite WAL (-wal) replayer. src/sqliteread.js only walks the committed B-tree pages of
// the main DB file, so writes still parked in the write-ahead log are invisible to it — and Cursor
// keeps its chat DB in WAL mode, so the NEWEST conversations routinely live only in the -wal file.
// This overlays the WAL's committed frames onto the DB image so the reader sees them.
//
// WAL format (all multi-byte fields big-endian): a 32-byte header — magic 0x377f0682/0x377f0683
// (low bit picks the checksum byte order), page size @8, salt-1 @16, salt-2 @20, checksum-1 @24,
// checksum-2 @28 — then a run of frames, each a 24-byte frame header (page# @0, db-size-after-commit
// @4 which is NONZERO on a COMMIT frame, salt-1 @8, salt-2 @12, checksum-1 @16, checksum-2 @20)
// followed by one page of data. We apply ONLY frames up to AND INCLUDING the last commit; a frame
// whose salt != the header salt belongs to an older/checkpointed generation and stops the scan; and
// every frame is verified with SQLite's running checksum so a torn or garbage tail is rejected.
//
// Never throws: absent/short/garbage input yields an empty overlay. No CLI/MCP of its own — it is a
// helper for src/foreign.js, which should call applyOverlay(dbBuf, walBuf) when a <db>-wal sibling
// exists and then run sqliteread over the merged image.

const WAL_MAGIC = 0x377f0682;

function u32(b, o) {
  return b.readUInt32BE(o);
}
function pow2InRange(n) {
  return n >= 512 && n <= 65536 && (n & (n - 1)) === 0;
} // legal SQLite page size

// SQLite's WAL checksum: walk 8-byte blocks as two 32-bit words (byte order chosen by the header
// magic's low bit), accumulating s1/s2 with 32-bit wrap-around. The pair is carried from the header
// through every frame, so each frame's checksum depends on all prior ones. Returns [s1, s2].
function checksum(buf, start, nByte, bigEnd, s1, s2) {
  for (let i = 0; i < nByte; i += 8) {
    const w1 = bigEnd ? buf.readUInt32BE(start + i) : buf.readUInt32LE(start + i);
    const w2 = bigEnd ? buf.readUInt32BE(start + i + 4) : buf.readUInt32LE(start + i + 4);
    s1 = (s1 + w1 + s2) >>> 0;
    s2 = (s2 + w2 + s1) >>> 0;
  }
  return [s1, s2];
}

function sameBytes(buf, a, b, n) {
  for (let i = 0; i < n; i++) if (buf[a + i] !== buf[b + i]) return false;
  return true;
}

// Core recovery. Returns { pages, size, pageSize }: `pages` is a null-prototype map of pageNumber ->
// page Buffer for every COMMITTED frame (last write wins), `size` is the db page count declared by
// the last commit frame, `pageSize` is the resolved page size. Empty overlay on any problem.
function recover(walBuf, pageSize) {
  const empty = { pages: Object.create(null), size: 0, pageSize: 0 };
  try {
    if (!Buffer.isBuffer(walBuf) || walBuf.length < 32) return empty;
    const magic = u32(walBuf, 0);
    if ((magic & 0xfffffffe) !== WAL_MAGIC) return empty; // not a WAL header
    const bigEnd = magic & 1;
    let ps = Number(pageSize);
    if (!pow2InRange(ps)) {
      ps = u32(walBuf, 8);
      if (ps === 1) ps = 65536;
    } // fall back to the header's size
    if (!pow2InRange(ps)) return empty;
    // The header checksum covers its own first 24 bytes and seeds the running checksum for frames.
    let [s1, s2] = checksum(walBuf, 0, 24, bigEnd, 0, 0);
    if (s1 !== u32(walBuf, 24) || s2 !== u32(walBuf, 28)) return empty; // corrupt/foreign header
    const frameSize = 24 + ps;
    const committed = Object.create(null); // pageNumber (user/attacker-controlled) -> Buffer
    let pending = Object.create(null); // frames seen since the last commit, folded in on commit
    let size = 0;
    for (let off = 32; off + frameSize <= walBuf.length; off += frameSize) {
      if (!sameBytes(walBuf, 16, off + 8, 8)) break; // salt != header salt -> older generation
      const pgno = u32(walBuf, off);
      if (pgno === 0) break; // page 0 never exists -> invalid frame
      [s1, s2] = checksum(walBuf, off, 8, bigEnd, s1, s2); // first 8 bytes of the frame header ...
      [s1, s2] = checksum(walBuf, off + 24, ps, bigEnd, s1, s2); // ... then the page payload
      if (s1 !== u32(walBuf, off + 16) || s2 !== u32(walBuf, off + 20)) break; // torn/garbage frame -> stop
      pending[pgno] = Buffer.from(walBuf.subarray(off + 24, off + 24 + ps));
      const dbSize = u32(walBuf, off + 4);
      if (dbSize !== 0) {
        // COMMIT frame: fold pending -> committed
        for (const k in pending) committed[k] = pending[k];
        size = dbSize;
        pending = Object.create(null);
      }
    }
    return { pages: committed, size: size, pageSize: ps };
  } catch (e) {
    return empty;
  }
}

// overlay(walBuf, pageSize) -> null-prototype map of pageNumber -> latest committed page Buffer.
function overlay(walBuf, pageSize) {
  return recover(walBuf, pageSize).pages;
}

// applyOverlay(dbBuf, walBuf) -> a NEW db Buffer with the WAL's committed pages written over the DB
// image (grown to the committed page count if the WAL extended the file). The page size comes from
// the DB header (offset 16), falling back to the WAL header. Returns dbBuf unchanged when there is
// nothing to apply, so callers can hand the result straight to sqliteread.
function applyOverlay(dbBuf, walBuf) {
  try {
    if (!Buffer.isBuffer(dbBuf)) return dbBuf;
    let ps = 0;
    if (dbBuf.length >= 18) {
      ps = dbBuf.readUInt16BE(16);
      if (ps === 1) ps = 65536;
    }
    if (!pow2InRange(ps)) ps = 0;
    const rec = recover(walBuf, ps || undefined);
    ps = rec.pageSize;
    const keys = Object.keys(rec.pages);
    if (!keys.length || !ps) return dbBuf;
    // SECURITY: `rec.size` (commit frame's db-size) and the page numbers are attacker-controlled u32s
    // inside a self-checksummed WAL. Never grow the output beyond what the DB+WAL bytes could really
    // hold — otherwise a ~4KB planted -wal declaring page 250000 forces a ~GB Buffer.alloc (DoS via the
    // no-confirm `keyflip foreign`). Cap to the physical input size; over-cap pages are simply dropped.
    const cap = Math.ceil((dbBuf.length + (Buffer.isBuffer(walBuf) ? walBuf.length : 0)) / ps) + 8;
    let maxPage = Math.min(rec.size, cap);
    keys.forEach(function (k) {
      const n = +k;
      if (n > maxPage && n <= cap) maxPage = n;
    });
    const totalPages = Math.max(Math.ceil(dbBuf.length / ps), maxPage);
    const out = Buffer.alloc(totalPages * ps);
    dbBuf.copy(out, 0, 0, Math.min(dbBuf.length, out.length));
    keys.forEach(function (k) {
      const off = (+k - 1) * ps;
      if (off >= 0 && off + ps <= out.length) rec.pages[k].copy(out, off);
    });
    return out;
  } catch (e) {
    return dbBuf;
  }
}

export { overlay, applyOverlay };
