// FLEET LAN DISCOVERY — find the other keyflip machines on the same network WITHOUT a shared
// rendezvous folder.
//
// Why: fleet's transport is a synced folder (Dropbox/iCloud/WebDAV), which needs a path the user
// sets up on every machine and a sync round-trip before peers appear. On a single LAN that is
// friction for no reason — the machines can simply announce themselves. This module is the
// zero-dependency discovery half of that: a UDP multicast beacon each machine can send, and a
// listener that reports who answered. It reuses the same mcast group/port as `lantransfer`'s
// beacon (one group, one library to reason about) but a DISTINCT tag so a fleet discovery never
// mistakes a transfer beacon for a peer.
//
// Security: the beacon carries ONLY public identity (machine id, display name, and the short
// SHA-256 FINGERPRINT of the Ed25519 origin key) — never the fleet passphrase, never a private
// key, never a command. A discovery result is therefore safe to print, and pinning still happens
// only through the existing TOFU path (`fleet trust`), which compares the fingerprint out-of-band.
// Presence on a LAN is inherently visible; this adds no authority, only a way to find peers.
import dgram from 'dgram';
import crypto from 'crypto';

const MCAST_ADDR = '239.255.41.42'; // shared with lantransfer; separate TAG keeps them apart
const MCAST_PORT = 41234;
const TAG = 'fleet-discover';
const VERSION = 1;

// Short, colon-grouped SHA-256 fingerprint of a public key — the same shape fleet.fingerprint
// produces, kept local so this module has no dependency on fleet.js (and can be unit-tested alone).
function fingerprint(pubB64) {
  try {
    return crypto
      .createHash('sha256')
      .update(Buffer.from(String(pubB64), 'base64'))
      .digest('hex')
      .replace(/(..)/g, '$1:')
      .slice(0, 23);
  } catch (e) {
    return '?';
  }
}

// Serialise this machine's advertisement. Pure, so the wire format is testable without sockets.
// `fp` may be null (a machine that has not minted a key yet) — the beacon still announces presence.
function encodeBeacon(me) {
  return Buffer.from(
    JSON.stringify({
      keyflip: TAG,
      v: VERSION,
      id: String((me && me.machineId) || ''),
      n: String((me && me.name) || '').slice(0, 80),
      fp: me && me.fp ? String(me.fp) : null,
    }),
  );
}

// Parse a datagram. Returns { machineId, name, fp } for OUR tag only, or null. Tolerates a huge or
// malformed buffer (never throws) and enforces the same id charset the bus filenames require, so a
// hostile beacon cannot inject an id that would later be interpolated into a path or a status file.
function decodeBeacon(buf) {
  let j;
  try {
    j = JSON.parse(String(buf));
  } catch (e) {
    return null;
  }
  if (!j || j.keyflip !== TAG || !j.id) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(j.id)) return null;
  return { machineId: j.id, name: typeof j.n === 'string' ? j.n.slice(0, 80) : '', fp: j.fp || null };
}

// Announce this machine every `intervalMs` until stop() is called. Binds an ephemeral port and
// only SENDS; an async socket error (network down mid-announce) is swallowed so a caller's process
// cannot crash on it. Returns { stop }.
function announce(me, opts) {
  opts = opts || {};
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const msg = encodeBeacon(me);
  const interval = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 1000;
  let timer = null;
  sock.on('error', function () {
    if (timer) clearInterval(timer);
    try {
      sock.close();
    } catch (e) {
      /* ignore */
    }
  });
  sock.bind(function () {
    try {
      sock.setBroadcast(true);
    } catch (e) {
      /* multicast may be unavailable; the periodic send just no-ops */
    }
    const tick = function () {
      try {
        sock.send(msg, 0, msg.length, MCAST_PORT, MCAST_ADDR);
      } catch (e) {
        /* ignore */
      }
    };
    tick();
    timer = setInterval(tick, interval);
    if (timer.unref) timer.unref();
  });
  return {
    stop: function () {
      if (timer) clearInterval(timer);
      timer = null;
      try {
        sock.close();
      } catch (e) {
        /* ignore */
      }
    },
  };
}

// Listen for `timeoutMs` (default 3000) and return the peers seen, deduped by machineId, newest
// sighting winning. `exclude` is this machine's own id (a multicast loopback can deliver our own
// beacon) — the caller filters itself out. Async + socket-error tolerant; resolves [] rather than
// rejecting so a machine without multicast (a locked-down VM, no route) degrades to "found nobody".
function discover(opts) {
  opts = opts || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;
  const exclude = opts.exclude ? String(opts.exclude) : null;
  return new Promise(function (resolve) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const peers = Object.create(null); // null-proto: a beacon id like __proto__ cannot pollute
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch (e) {
        /* ignore */
      }
      resolve(
        Object.keys(peers).map(function (k) {
          return peers[k];
        }),
      );
    }
    sock.on('message', function (buf, rinfo) {
      const p = decodeBeacon(buf);
      if (!p || p.machineId === exclude) return;
      peers[p.machineId] = { machineId: p.machineId, name: p.name, fp: p.fp, host: rinfo.address };
    });
    sock.on('error', finish);
    try {
      sock.bind(MCAST_PORT, function () {
        try {
          sock.addMembership(MCAST_ADDR);
        } catch (e) {
          /* multicast may be unavailable on this interface */
        }
      });
    } catch (e) {
      finish();
      return;
    }
    const t = setTimeout(finish, timeoutMs);
    if (t.unref) t.unref();
  });
}

export { encodeBeacon, decodeBeacon, discover, announce, fingerprint, MCAST_ADDR, MCAST_PORT, TAG, VERSION };
