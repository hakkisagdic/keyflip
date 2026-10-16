// #35 THREADS — keyflip's own name for "the same work", spread over accounts and surfaces.
//
// The problem is concrete on this machine: a task starts on one account, its quota runs out, the task
// continues on the next account, and Claude Code has by then written TWO transcripts. Nothing links
// them. `keyflip chat` can reach the other one by id and `keyflip sessions assign` can say which
// account owns a session, but neither names the SET — so following your own work means carrying ids
// around by hand ("parça parça oluyor çalışma hesap değiştikçe").
//
// WHY A POINTER STORE AND NOT A COPY: a thread lists session ids, chat uuids, titles and the project
// key each transcript lived under. The transcripts stay exactly where Claude Code put them
// (~/.claude/projects/<cwd-key>/<id>.jsonl), so a thread is NON-SECRET METADATA: it is git-versioned
// like the rest of keyflip's state, travels with `keyflip migrate`/`restore`, and cannot leak a token
// through it. The only thing here that puts conversation TEXT on disk is the opt-in mirror
// (`threads.mirror`), whose directory is registered in secretpaths.SECRET_DIRS — 0600, never versioned,
// never backed up, never synced. That split is the whole design: pointers are portable, prose is not.
//
// A thread is deliberately NOT a second copy of a session: a session can belong to several threads or
// to none, and `keyflip threads drop` deletes a NAME — never a conversation.
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import * as sessions from './sessions.js';
import * as sessionmap from './sessionmap.js';
import * as attrib from './attrib.js';
import * as transcript from './transcript.js';
import * as fsutil from './fsutil.js';
import * as config from './config.js';
import * as vcs from './vcs.js';

const SCHEMA_VERSION = 1;
const DIR_NAME = 'threads';
// Conversation TEXT on disk is the one threads feature that IS secret, and this name is exported for
// exactly one reason: a test asserts it is present in secretpaths.SECRET_DIRS. If that link ever
// breaks, every merged transcript silently enters the git repo `keyflip migrate` carries between
// machines.
const MIRROR_DIR_NAME = 'thread-mirror';
// The same rule sessions.list applies when it turns a filename into a session id — so a thread file
// written by hand (or imported from another machine) cannot name a path outside threads/.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHAT_ID_RE = /^[0-9a-f][0-9a-f-]{7,63}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const BAK_SUFFIX = '.keyflip-bak';
const MAX_TITLE = 200;
const MAX_NOTES = 4000;
const DEFAULT_MAX_MESSAGES = 4000; // per member
const DEFAULT_MAX_TOTAL = 20000; // merged; the oldest end is dropped first

function dir(ctx) {
  return path.join(ctx.configDir, DIR_NAME);
}
function mirrorDir(ctx) {
  return path.join(ctx.configDir, MIRROR_DIR_NAME);
}

// A slug is a FILENAME, so it is normalized rather than trusted: fold accents to their base letter
// (this user titles threads in Turkish, and a naive [^a-z0-9] fold would render "düğüm" as "d-g-m"),
// collapse every other run to '-', trim, cap. `../keys` therefore becomes `keys`.
function slugify(input) {
  return String(input == null ? '' : input)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // combining marks: 'é'→'e', 'ü'→'u', 'ğ'→'g'
    .replace(/[ıİ]/g, 'i') // the one Turkish letter NFD cannot fold
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

function fileFor(ctx, slug) {
  const s = slugify(slug);
  if (!SLUG_RE.test(s)) throw new Error('invalid thread name: ' + JSON.stringify(slug));
  return path.join(dir(ctx), s + '.json');
}
function mirrorFileFor(ctx, slug) {
  const s = slugify(slug);
  if (!SLUG_RE.test(s)) throw new Error('invalid thread name: ' + JSON.stringify(slug));
  return path.join(mirrorDir(ctx), s + '.md');
}

// ---- records -----------------------------------------------------------------

const KINDS = ['session', 'chat'];

// One member: what it points at, and (for a chat) the account whose cookie can read it. `project` is
// the encoded cwd key the transcript lived under when it was added — a fast path for finding it
// again, never a claim that it is still there.
function normalizeMember(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = KINDS.indexOf(raw.kind) !== -1 ? raw.kind : null;
  if (!kind) return null;
  const id = String(raw.id == null ? '' : raw.id).trim();
  if (!id) return null;
  if (kind === 'session' && !SESSION_ID_RE.test(id)) return null;
  if (kind === 'chat' && !CHAT_ID_RE.test(id)) return null;
  const out = { kind: kind, id: id };
  if (typeof raw.label === 'string' && raw.label.trim()) out.label = raw.label.trim().slice(0, MAX_TITLE);
  if (typeof raw.account === 'string' && raw.account.trim()) out.account = raw.account.trim().slice(0, 120);
  if (typeof raw.project === 'string' && raw.project.trim()) out.project = raw.project.trim().slice(0, 200);
  if (typeof raw.addedAt === 'string') out.addedAt = raw.addedAt;
  return out;
}

function memberKey(m) {
  return m.kind + ':' + m.id.toLowerCase();
}

// Fold a parsed (possibly hand-edited, possibly older-format) object into the shape callers may rely
// on. Garbage members are dropped but COUNTED (`droppedMembers`), because a thread that quietly lost
// three pointers would look complete.
function normalizeThread(raw, fallbackSlug) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const slug = slugify(raw.slug || fallbackSlug || '');
  if (!SLUG_RE.test(slug)) return null;
  const given = Array.isArray(raw.members) ? raw.members : [];
  const members = [];
  const seen = new Set();
  given.forEach(function (m) {
    const n = normalizeMember(m);
    if (!n) return;
    const k = memberKey(n);
    if (seen.has(k)) return; // a duplicated pointer is the same pointer
    seen.add(k);
    members.push(n);
  });
  const out = {
    schemaVersion: SCHEMA_VERSION,
    slug: slug,
    title: typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : '',
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, MAX_NOTES) : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    members: members,
  };
  if (given.length > members.length) out.droppedMembers = given.length - members.length;
  return out;
}

// Write ONLY the schema's fields. `droppedMembers` is derived at read time and must never be
// persisted (it would freeze a count of damage into the file), and a hand-added key that normalize
// did not vouch for must not silently become part of the record either.
function serialize(thread) {
  return {
    schemaVersion: SCHEMA_VERSION,
    slug: thread.slug,
    title: thread.title || '',
    notes: thread.notes || '',
    createdAt: thread.createdAt || '',
    updatedAt: thread.updatedAt || '',
    members: (thread.members || [])
      .map(function (m) {
        return normalizeMember(m);
      })
      .filter(Boolean), // a pointer normalize did not vouch for is never written back to disk
  };
}

function save(ctx, thread) {
  const out = serialize(thread);
  fsutil.writeJsonStable(fileFor(ctx, thread.slug), out, 0o600);
  return out; // callers get what is ON disk, not the in-memory object with its derived extras
}

// ---- read --------------------------------------------------------------------

// Every thread file, most recently active first. A file that does not parse is REPORTED, not hidden:
// `list` is how the user discovers a thread exists, so skipping a corrupt one would hide it forever.
function list(ctx) {
  let names = [];
  try {
    names = fs.readdirSync(dir(ctx));
  } catch (e) {
    return []; // no threads dir yet
  }
  const out = [];
  names.forEach(function (name) {
    if (name.slice(-5) !== '.json') return;
    const base = name.slice(0, -5);
    const file = path.join(dir(ctx), name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      out.push(threadRow(null, base, file, 'not valid JSON'));
      return;
    }
    const t = normalizeThread(raw, base);
    out.push(threadRow(t, base, file, t ? null : 'unrecognizable thread record'));
  });
  out.sort(function (a, b) {
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return out;
}

function threadRow(t, base, file, error) {
  if (error)
    return {
      slug: slugify(base) || base,
      file: file,
      title: '',
      members: [],
      createdAt: '',
      updatedAt: '',
      corrupt: true,
      error: error,
    };
  const row = Object.assign({}, t, { file: file, corrupt: false });
  return row;
}

// One thread by exact slug, unique slug prefix, or unique title match. Throws on an ambiguous prefix
// (the sessions.find convention) and on a corrupt file, because a caller about to WRITE must never
// mistake damage for emptiness and overwrite the user's thread.
function read(ctx, selection) {
  const exact = slugify(selection);
  if (SLUG_RE.test(exact)) {
    const file = path.join(dir(ctx), exact + '.json');
    if (fs.existsSync(file)) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        throw new Error(file + ' exists but is not valid JSON — fix or remove it before writing to it');
      }
      const t = normalizeThread(raw, exact);
      if (!t) throw new Error(file + ' is not a recognizable thread record');
      // The SAME row shape `list()` returns, exact slug or not: callers print `thread.file`, and a
      // shape that depends on how the name matched makes `threads show <exact-slug>` print undefined.
      return threadRow(t, exact, file, null);
    }
  }
  const low = String(selection == null ? '' : selection).toLowerCase();
  if (!low) return null;
  const hits = list(ctx).filter(function (r) {
    if (r.corrupt) return false;
    return r.slug.indexOf(low) === 0 || (r.title || '').toLowerCase().indexOf(low) !== -1;
  });
  if (!hits.length) return null;
  if (hits.length > 1)
    throw new Error(
      "'" +
        selection +
        "' matches several threads: " +
        hits
          .slice(0, 6)
          .map(function (r) {
            return r.slug;
          })
          .join(', '),
    );
  return hits[0];
}

// ---- write -------------------------------------------------------------------

function create(ctx, opts) {
  opts = opts || {};
  const slug = slugify(opts.slug || opts.title);
  if (!SLUG_RE.test(slug))
    throw new Error(
      'a thread needs a name of letters, digits and dashes — e.g. `keyflip threads create loganalyzer-sync`',
    );
  if (fs.existsSync(fileFor(ctx, slug)))
    throw new Error("thread '" + slug + "' already exists — add to it with: keyflip threads add " + slug + ' <id>');
  const now = ctx.now();
  const m = normalizeMember(opts.member);
  if (opts.member && !m) throw new Error('that member is not a valid session id or chat uuid');
  if (m) m.addedAt = now;
  return save(ctx, {
    slug: slug,
    title: String(opts.title || opts.slug || slug).slice(0, MAX_TITLE),
    notes: String(opts.notes || '').slice(0, MAX_NOTES),
    createdAt: now,
    updatedAt: now,
    members: m ? [m] : [],
  });
}

// Add (or re-label) a pointer. Idempotent by kind+id: adding the same session again updates it, it
// never doubles the thread.
function addMember(ctx, selection, member) {
  const t = read(ctx, selection);
  if (!t)
    throw new Error(
      "no such thread: '" + selection + "' — create it first: keyflip threads create " + (slugify(selection) || 'slug'),
    );
  const m = normalizeMember(member);
  if (!m)
    throw new Error(
      'a member is a local session id or a claude.ai chat uuid — and BOTH are UUIDs, so say which: --chat marks a cloud conversation',
    );
  const key = memberKey(m);
  const at = ctx.now();
  const i = t.members.findIndex(function (x) {
    return memberKey(x) === key;
  });
  if (i !== -1) {
    const prev = t.members[i];
    t.members[i] = Object.assign({}, prev, m, { addedAt: prev.addedAt || at });
  } else {
    m.addedAt = at;
    t.members.push(m);
  }
  t.updatedAt = at;
  return save(ctx, t);
}

// Remove one pointer. `id` may be `kind:id`, a full id, or a unique prefix. The transcript is never
// touched — this forgets a link, not a conversation.
function removeMember(ctx, selection, id) {
  const t = read(ctx, selection);
  if (!t) return null;
  const needle = String(id || '')
    .trim()
    .toLowerCase();
  if (!needle) return null;
  let kind = null;
  let want = needle;
  if (needle.indexOf('chat:') === 0) {
    kind = 'chat';
    want = needle.slice(5);
  } else if (needle.indexOf('session:') === 0) {
    kind = 'session';
    want = needle.slice(8);
  }
  const hits = t.members.filter(function (m) {
    if (kind && m.kind !== kind) return false;
    const low = m.id.toLowerCase();
    return low === want || low.indexOf(want) === 0;
  });
  if (!hits.length) return null;
  if (hits.length > 1)
    throw new Error(
      "'" +
        id +
        "' matches several members (" +
        hits
          .map(function (m) {
            return m.kind + ':' + m.id.slice(0, 8);
          })
          .join(', ') +
        ')',
    );
  const drop = memberKey(hits[0]);
  t.members = t.members.filter(function (m) {
    return memberKey(m) !== drop;
  });
  t.updatedAt = ctx.now();
  save(ctx, t);
  return { thread: t, removed: hits[0] };
}

function update(ctx, selection, patch) {
  const t = read(ctx, selection);
  if (!t) return null;
  patch = patch || {};
  if (typeof patch.title === 'string' && patch.title.trim()) t.title = patch.title.trim().slice(0, MAX_TITLE);
  if (typeof patch.notes === 'string') t.notes = patch.notes.slice(0, MAX_NOTES);
  t.updatedAt = ctx.now();
  return save(ctx, t);
}

// Forget the NAME. Never deletes a transcript, a chat, or an account assignment.
function drop(ctx, selection) {
  const t = read(ctx, selection);
  if (!t) return null;
  try {
    fs.rmSync(fileFor(ctx, t.slug), { force: true });
  } catch (e) {
    throw new Error('could not remove thread ' + t.slug + ': ' + ((e && e.message) || String(e)));
  }
  return t;
}

// Which threads name this session/chat? Asked before every add, so the user learns a session is
// ALREADY grouped instead of creating a second name for the same work.
function threadsFor(ctx, kind, id) {
  const needle = String(id || '').toLowerCase();
  if (!needle) return [];
  return list(ctx).filter(function (r) {
    if (r.corrupt) return false;
    return r.members.some(function (m) {
      if (kind && m.kind !== kind) return false;
      const low = m.id.toLowerCase();
      return low === needle || low.indexOf(needle) === 0;
    });
  });
}

// ---- resolving what a pointer points at --------------------------------------

// session id -> transcript file, over all of ~/.claude/projects, built at most once per command. A
// naive locate-per-member would readdir every project dir for every member (this machine has ~55 of
// them and 7000+ transcripts), which is one readdir storm per `keyflip threads show`.
function index(ctx) {
  const root = sessions.projectsDir(ctx);
  const map = new Map();
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch (e) {
    return map;
  }
  names.forEach(function (pd) {
    if (pd.slice(-BAK_SUFFIX.length) === BAK_SUFFIX) return; // a rebind rollback copy double-counts
    let files;
    try {
      files = fs.readdirSync(path.join(root, pd));
    } catch (e) {
      return;
    }
    files.forEach(function (f) {
      if (f.slice(-6) !== '.jsonl') return;
      const id = f.slice(0, -6);
      if (!SESSION_ID_RE.test(id)) return;
      if (map.has(id)) return; // one transcript per id is Claude Code's own rule; first key wins
      let st;
      try {
        st = fs.statSync(path.join(root, pd, f));
      } catch (e) {
        return;
      }
      map.set(id, {
        sessionId: id,
        file: path.join(root, pd, f),
        project: pd,
        mtimeMs: st.mtimeMs,
        mtime: st.mtime.toISOString(),
        sizeBytes: st.size,
      });
    });
  });
  return map;
}

function locate(ctx, sessionId, idx) {
  if (!SESSION_ID_RE.test(String(sessionId))) return null;
  const cache = idx || index(ctx);
  return cache.get(String(sessionId)) || null;
}

// A thread is a POINTER, and a pointer has to be exact to still be followable next month or on
// another machine. But every other keyflip surface lets the user name a session by a unique prefix —
// and `threads suggest` itself prints an 8-char id — so a prefix is accepted at write time and
// expanded HERE. Outcomes: exact hit (kept), unique prefix (expanded), several matches (rejected with
// the candidates, because guessing which session a thread means is not keyflip's call), or nothing
// local (kept verbatim — work on the user's other computer is still that work).
function resolveSessionId(ctx, id, idx) {
  const raw = String(id || '');
  if (!SESSION_ID_RE.test(raw)) return { id: raw, original: raw, matched: null, ambiguous: [], unknown: true };
  const cache = idx || index(ctx);
  const exact = cache.get(raw);
  if (exact) return { id: raw, original: raw, matched: exact, ambiguous: [], unknown: false };
  const low = raw.toLowerCase();
  const hits = [];
  cache.forEach(function (row, key) {
    if (key.toLowerCase().indexOf(low) === 0) hits.push(row);
  });
  if (hits.length === 1)
    return { id: hits[0].sessionId, original: raw, matched: hits[0], ambiguous: [], unknown: false };
  hits.sort(function (a, b) {
    return String(a.sessionId).localeCompare(String(b.sessionId));
  });
  if (hits.length > 1)
    return {
      id: raw,
      original: raw,
      matched: null,
      ambiguous: hits.map(function (h) {
        return h.sessionId;
      }),
      unknown: false,
    };
  return { id: raw, original: raw, matched: null, ambiguous: [], unknown: true };
}

// The live session->account map, read once per command (sessionmap re-parses its file on every get).
function assignments(ctx) {
  const out = new Map();
  let raw = {};
  try {
    raw = sessionmap.read(ctx) || {};
  } catch (e) {
    raw = {};
  }
  Object.keys(raw).forEach(function (id) {
    if (raw[id]) out.set(id, raw[id]);
  });
  return out;
}

// The account a member is attributed to. For a LOCAL session that is the live assignment, read fresh:
// a thread written before `sessions assign` must still show the right account, and a re-assignment
// must not be contradicted by the label stored at add time. member.account is the fallback (and the
// only source for a chat, whose cookie snapshot is account-bound).
function accountOf(ctx, member, assigned) {
  if (member.kind === 'session') {
    if (assigned && assigned.has(member.id)) return assigned.get(member.id);
    if (assigned) return member.account || null; // a supplied map IS the answer — do not re-read
    return sessionmap.get(ctx, member.id) || member.account || null;
  }
  return member.account || null;
}

// Enrich every member with what is true on this machine right now — file, folder, size, last write,
// account — plus a REASON when the pointer resolves to nothing (an id from another machine, a deleted
// session, a chat that lives server-side). Showing a missing member as missing is the point: a silent
// gap would read as "the work never happened there".
function expand(ctx, thread, opts) {
  opts = opts || {};
  const idx = opts.index || index(ctx);
  const assigned = opts.assigned || assignments(ctx);
  // WHY the member has an account: `stated` = the user said so (`sessions assign`), `inferred` =
  // keyflip guessed it from its own switch timeline (#50). A guess must never be shown as a fact,
  // and provenance lives in the sidecar so the live map keeps its plain id→name shape.
  const src = opts.sources || attrib.sources(ctx);
  const prov = function (m) {
    if (attrib.isAssigned(assigned, m.id)) return attrib.provenanceFor(m.id, assigned, src);
    // No live assignment but the member carries a label: that came from `threads add --account`,
    // i.e. the user named it, so it is stated, not guessed.
    return m.account ? 'stated' : null;
  };
  const rows = (thread.members || []).map(function (m) {
    const account = accountOf(ctx, m, assigned);
    if (m.kind === 'chat') {
      return {
        kind: 'chat',
        id: m.id,
        label: m.label || '',
        account: account,
        resolved: false,
        reason:
          'server-side conversation — read it with `keyflip chat get ' +
          m.id.slice(0, 8) +
          (account ? ' --as ' + account : '') +
          '`',
      };
    }
    const provenance = prov(m);
    const loc = locate(ctx, m.id, idx);
    if (!loc) {
      return {
        kind: 'session',
        id: m.id,
        label: m.label || '',
        account: account,
        provenance: provenance,
        resolved: false,
        reason: 'no transcript on this machine' + (m.project ? ' (last seen in ' + m.project + ')' : ''),
      };
    }
    // The transcript's own cwd is the only trustworthy folder: the project DIR name folds every
    // non-alphanumeric to '-', so decoding it is lossy (see sessions.list).
    const s = sessions.summarize(loc.file) || {};
    const cwd = s.cwd || sessions.decodeProjectDir(loc.project);
    return {
      kind: 'session',
      id: m.id,
      label: m.label || s.preview || '',
      account: account,
      provenance: provenance,
      resolved: true,
      file: loc.file,
      project: loc.project,
      cwd: cwd,
      cwdGone: !!(s.cwd && !fs.existsSync(s.cwd)),
      preview: s.preview || '',
      mtime: loc.mtime,
      mtimeMs: loc.mtimeMs,
      sizeBytes: loc.sizeBytes,
      resume: sessions.resumeCommand({ sessionId: m.id, cwd: cwd }),
    };
  });
  const accounts = {};
  rows.forEach(function (r) {
    const a = r.account || 'unassigned';
    accounts[a] = (accounts[a] || 0) + 1;
  });
  return {
    rows: rows,
    accounts: accounts,
    missing: rows.filter(function (r) {
      return !r.resolved;
    }).length,
  };
}

// The newest resolvable session — what `keyflip threads open` resumes, because continuing a thread
// means picking up where the work last stopped, not where it began.
function newest(rows) {
  const live = rows.filter(function (r) {
    return r.kind === 'session' && r.resolved;
  });
  if (!live.length) return null;
  return live.slice().sort(function (a, b) {
    return String(b.mtime || '').localeCompare(String(a.mtime || ''));
  })[0];
}

// ---- the merged conversation --------------------------------------------------

function mergeMaxBytes(ctx) {
  let mib = 8;
  try {
    mib = config.get(ctx, 'threads.mergeMaxMiB');
  } catch (e) {
    mib = 8; // an unknown key must never turn a read into a crash mid-show
  }
  if (!(mib > 0)) mib = 8;
  return Math.min(512, mib) * 1024 * 1024;
}

// Read a transcript into unified turns WITHOUT loading it into memory. Real transcripts here run to
// 24 MB and a thread merges several at once, so this streams: bounded bytes, bounded turns, and an
// explicit `truncated` flag — a conversation that hit a cap says so instead of ending politely.
function readMessages(file, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || 8 * 1024 * 1024;
  const maxMessages = opts.maxMessages || DEFAULT_MAX_MESSAGES;
  const messages = [];
  let cwd = null;
  let truncated = null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    return { messages: messages, cwd: null, truncated: 'unreadable' };
  }
  const push = function (line) {
    if (!line || !line.trim()) return false;
    const parsed = transcript.parse(line); // one JSONL record is a whole (1-line) transcript to it
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    for (let i = 0; i < parsed.messages.length; i++) {
      messages.push(parsed.messages[i]);
      if (messages.length >= maxMessages) return true;
    }
    return false;
  };
  try {
    const dec = new StringDecoder('utf8');
    const buf = Buffer.alloc(256 * 1024);
    let pos = 0;
    let bytes = 0;
    let carry = '';
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, pos);
      } catch (e) {
        truncated = 'unreadable';
        break;
      }
      if (!n) break;
      pos += n;
      bytes += n;
      const parts = (carry + dec.write(buf.slice(0, n))).split('\n');
      carry = parts.pop();
      let full = false;
      for (let i = 0; i < parts.length; i++) {
        if (push(parts[i])) {
          full = true;
          break;
        }
      }
      if (full) {
        truncated = 'messages';
        break;
      }
      if (bytes >= maxBytes) {
        truncated = 'bytes';
        break;
      }
    }
    if (!truncated && carry && carry.trim() && push(carry)) truncated = 'messages';
  } finally {
    try {
      fs.closeSync(fd);
    } catch (e) {
      /* ignore */
    }
  }
  return { messages: messages, cwd: cwd, truncated: truncated };
}

// One chronological view of everything the thread points at. Local sessions contribute their turns; a
// cloud chat CANNOT (claude.ai keeps it server-side and reading it is a live, cookie-bound API call),
// so it lands in `unavailable` with the command that would show it. That honesty is the difference
// between "your whole thread" and "the part of it keyflip can see offline".
function timeline(ctx, thread, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || mergeMaxBytes(ctx);
  const maxMessages = opts.maxMessages || DEFAULT_MAX_MESSAGES;
  const idx = opts.index || index(ctx);
  const exp = expand(ctx, thread, { index: idx });
  const all = [];
  const unavailable = [];
  let capped = 0;
  exp.rows.forEach(function (r) {
    if (!r.resolved || r.kind !== 'session') {
      unavailable.push({ id: r.id, kind: r.kind, account: r.account || null, reason: r.reason });
      return;
    }
    const got = readMessages(r.file, { maxBytes: maxBytes, maxMessages: maxMessages });
    if (got.truncated) capped++;
    got.messages.forEach(function (m) {
      all.push({
        // A turn with no timestamp cannot be placed, so it sorts to the FRONT as a group (stable
        // sort keeps member order) — a reader sees undated preamble, never an undated turn smuggled
        // between two decisions it did not follow.
        ts: m.ts || null,
        role: m.role,
        text: m.text,
        tools: m.tools,
        from: { kind: r.kind, id: r.id, label: r.label || r.id.slice(0, 8), account: r.account || null },
        file: r.file,
      });
    });
  });
  all.sort(function (a, b) {
    const x = a.ts || '';
    const y = b.ts || '';
    if (x === y) return 0;
    return x < y ? -1 : 1;
  });
  const cap = opts.maxTotal || DEFAULT_MAX_TOTAL;
  let dropped = 0;
  let messages = all;
  if (all.length > cap) {
    dropped = all.length - cap;
    messages = all.slice(dropped); // keep the RECENT tail: the next step needs the end of the story
  }
  const accounts = {};
  messages.forEach(function (m) {
    const a = m.from.account || 'unassigned';
    accounts[a] = (accounts[a] || 0) + 1;
  });
  return {
    messages: messages,
    unavailable: unavailable,
    members: exp.rows.length,
    sources: exp.rows.length - unavailable.length,
    cappedMembers: capped,
    accounts: accounts,
    droppedFromStart: dropped,
  };
}

// ---- rendering ---------------------------------------------------------------

function speaker(role) {
  if (role === 'assistant') return 'Claude';
  if (role === 'user') return 'You';
  // A foreign transcript sets role verbatim — clamp it the way transcript.toMarkdown does, so a
  // crafted role cannot carry markup or a newline into a document that may be shared.
  return String(role || 'agent')
    .replace(/[^\w .-]/g, '')
    .slice(0, 20);
}
function uniq(a) {
  const seen = new Set();
  return a.filter(function (x) {
    if (seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}

// The thread as ONE markdown document: who is in it, what is missing, then every turn in order with a
// divider wherever the source changes — so the account switch is visible IN the conversation rather
// than something the reader has to remember.
function toMarkdown(ctx, thread, opts) {
  opts = opts || {};
  const idx = opts.index || index(ctx);
  const assigned = opts.assigned || assignments(ctx);
  const exp = opts.expand || expand(ctx, thread, { index: idx, assigned: assigned });
  const tl = opts.timeline || timeline(ctx, thread, Object.assign({}, opts, { index: idx }));
  const lines = ['# Thread `' + thread.slug + '`'];
  if (thread.title) lines.push('', thread.title);
  if (thread.notes) lines.push('', '> ' + thread.notes);
  const accts = Object.keys(exp.accounts).sort();
  lines.push(
    '',
    '_Created ' +
      String(thread.createdAt || '?').slice(0, 10) +
      ' · updated ' +
      String(thread.updatedAt || '?').slice(0, 10) +
      ' · ' +
      exp.rows.length +
      ' member(s) across ' +
      accts.length +
      ' account(s)_',
    '',
    '## Members',
    '',
  );
  exp.rows.forEach(function (r) {
    const who = r.account ? '`' + r.account + '`' : '_unassigned_';
    if (r.kind === 'chat') {
      lines.push('- **chat** `' + r.id.slice(0, 8) + '` ' + who + (r.label ? ' — ' + r.label : ''), '  ' + r.reason);
      return;
    }
    if (!r.resolved) {
      lines.push('- **session** `' + r.id.slice(0, 8) + '` ' + who + ' — ⚠ ' + r.reason);
      return;
    }
    lines.push(
      '- **session** `' + r.id.slice(0, 8) + '` ' + who + ' — ' + (r.label || r.preview || ''),
      '  ' +
        (r.cwd || '?') +
        ' · last written ' +
        String(r.mtime || '?')
          .slice(0, 16)
          .replace('T', ' ') +
        (r.cwdGone ? ' · ⚠ folder missing' : ''),
      '  `cd ' + (r.cwd || '.') + ' && ' + r.resume.command + ' ' + r.resume.args.join(' ') + '`',
    );
  });
  lines.push('', '## Conversation', '');
  if (tl.droppedFromStart)
    lines.push(
      '> ⚠ the ' +
        tl.droppedFromStart +
        ' oldest turn(s) were dropped to stay under ' +
        (opts.maxTotal || DEFAULT_MAX_TOTAL) +
        ' messages.',
    );
  if (tl.cappedMembers)
    lines.push(
      '> ⚠ ' +
        tl.cappedMembers +
        ' transcript(s) hit the read cap — raise it with `keyflip config set threads.mergeMaxMiB <1-512>`.',
    );
  if (tl.unavailable.length)
    lines.push('> ' + tl.unavailable.length + ' member(s) contribute no turns (cloud chats are server-side).');
  let lastFrom = null;
  tl.messages.forEach(function (m) {
    const key = m.from.kind + ':' + m.from.id;
    if (key !== lastFrom) {
      lines.push(
        '',
        '---',
        '',
        '_↪ from ' +
          (m.from.account ? m.from.account + ' · ' : '') +
          m.from.kind +
          ' `' +
          m.from.id.slice(0, 8) +
          '`' +
          (m.from.label ? ' — ' + m.from.label : '') +
          '_',
        '',
      );
      lastFrom = key;
    }
    lines.push('### ' + speaker(m.role) + (m.ts ? '  `' + String(m.ts).slice(0, 16).replace('T', ' ') + '`' : ''));
    if (m.text) lines.push('', m.text, '');
    if (m.tools && m.tools.length) lines.push('_→ used ' + uniq(m.tools).join(', ') + '_', '');
  });
  if (!tl.messages.length)
    lines.push('_No local turns: every member is a cloud chat or a transcript that is not on this machine._', '');
  lines.push('---', '', '_Merged by keyflip from ' + tl.sources + ' transcript(s). Read-only; nothing uploaded._');
  return lines.join('\n') + '\n';
}

// ---- the opt-in mirror --------------------------------------------------------

// Is the state repo still provably local? keyflip NEVER pushes — but the mirror is the one file this
// module writes that contains what was actually said, and a state repo configured to sync to a hosted
// git is the one place where "it is git-ignored" is all that stands between a transcript and a public
// repo. So the mirror asks, instead of trusting the ignore forever.
function privacyCheck(ctx) {
  let remote = false;
  try {
    remote = vcs.hasRemote(ctx);
  } catch (e) {
    remote = false;
  }
  if (remote)
    return {
      ok: false,
      reason: 'remote-configured',
      detail: 'the state repo at ' + ctx.configDir + ' has a git remote configured',
      fix: 'the mirror is git-ignored either way — re-run with --force once you are sure nothing pushes it',
    };
  return { ok: true, reason: 'local-only' };
}

function mirrorEnabled(ctx) {
  try {
    return config.get(ctx, 'threads.mirror') === true;
  } catch (e) {
    return false;
  }
}

// Write the merged conversation to <configDir>/thread-mirror/<slug>.md (0600). TWO gates by design:
// the config flag is the machine-wide policy ("conversation text may exist on disk at all"), this
// call is the per-thread decision. Nothing is written when either says no, and what does get written
// is excluded from git, `keyflip backup` and `keyflip sync` by secretpaths.SECRET_DIRS.
function mirror(ctx, thread, opts) {
  opts = opts || {};
  if (!mirrorEnabled(ctx))
    return {
      ok: false,
      reason: 'disabled',
      detail: 'threads.mirror is off, so keyflip keeps only pointers on disk',
      fix: 'keyflip config set threads.mirror true',
    };
  const priv = privacyCheck(ctx);
  if (!priv.ok && !opts.force) return { ok: false, reason: priv.reason, detail: priv.detail, fix: priv.fix };
  const file = mirrorFileFor(ctx, thread.slug);
  const md = opts.markdown || toMarkdown(ctx, thread, opts);
  fsutil.atomicWrite(file, md, 0o600);
  return {
    ok: true,
    path: file,
    bytes: Buffer.byteLength(md),
    forced: !priv.ok,
    mode: '0600, never versioned or backed up',
  };
}

// Remove a mirrored conversation. The mirror is the copy that has to be deletable — "private kalması
// yeterli" is only true while you can take the prose back off the disk.
function unmirror(ctx, thread) {
  const file = mirrorFileFor(ctx, thread.slug);
  if (!fs.existsSync(file)) return { ok: true, existed: false, path: file };
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    return { ok: false, path: file, error: (e && e.message) || String(e) };
  }
  return { ok: true, existed: true, path: file };
}

// ---- finding the splits (so the user does not have to enumerate them) ---------

// "Which of my work is fragmented across accounts?", answered by itself: group recent sessions by
// project folder and keep the folders where MORE THAN ONE NAMED ACCOUNT was used. One account plus
// unassigned sessions is not fragmentation, it is an account nobody assigned, so the bar is two REAL
// names — which keeps the list short enough to act on. Sessions a thread already covers drop out, so
// the list shrinks as the user names their work.
function candidates(ctx, opts) {
  opts = opts || {};
  let rows = [];
  try {
    rows = sessions.list(ctx, { limit: opts.limit || 400 });
  } catch (e) {
    return [];
  }
  const assigned = assignments(ctx);
  const covered = new Set();
  list(ctx).forEach(function (t) {
    (t.members || []).forEach(function (m) {
      if (m.kind === 'session') covered.add(m.id);
    });
  });
  const byProject = new Map();
  rows.forEach(function (r) {
    const acct = assigned.get(r.sessionId);
    if (!acct) return; // only a NAMED account is evidence of a switch
    if (!byProject.has(r.project))
      byProject.set(r.project, {
        project: r.project,
        cwd: r.cwd || sessions.decodeProjectDir(r.project),
        accounts: new Set(),
        total: 0,
        open: [],
      });
    const g = byProject.get(r.project);
    g.accounts.add(acct);
    g.total++;
    if (!covered.has(r.sessionId))
      g.open.push({
        sessionId: r.sessionId,
        account: acct,
        mtime: r.mtime,
        preview: r.preview || '',
        cwd: r.cwd || '',
      });
  });
  const out = [];
  byProject.forEach(function (g) {
    if (g.accounts.size < 2 || !g.open.length) return;
    g.open.sort(function (a, b) {
      return String(b.mtime || '').localeCompare(String(a.mtime || ''));
    });
    out.push({
      project: g.project,
      cwd: g.cwd,
      accounts: Array.from(g.accounts).sort(),
      sessions: g.total,
      unthreaded: g.open.length,
      newest: g.open[0],
      open: g.open,
      suggestedSlug: slugify(path.basename(String(g.cwd || '').replace(/[/\\]+$/, '')) || g.project),
    });
  });
  out.sort(function (a, b) {
    if (a.accounts.length !== b.accounts.length) return b.accounts.length - a.accounts.length;
    return String(b.newest.mtime || '').localeCompare(String(a.newest.mtime || ''));
  });
  return out;
}

// ---- for `keyflip threads` (list) and doctor ----------------------------------

function summaries(ctx) {
  const assigned = assignments(ctx);
  const src = attrib.sources(ctx);
  return list(ctx).map(function (t) {
    let sess = 0;
    let chats = 0;
    // A member with no account is a pointer keyflip cannot act on: `threads open` would resume it
    // under whatever is active now, which is exactly the wrong-account bug threads exist to kill.
    let noAccount = 0;
    // Members whose account is keyflip's INFERENCE (#50), not the user's word. Listed and reported
    // so a thread assembled from guesses never reads as confirmed — and so `threads suggest` can say
    // "these accounts are inferred, check them" instead of leaving a plausible-looking lie.
    let inferred = 0;
    const accts = new Set();
    (t.members || []).forEach(function (m) {
      if (m.kind === 'session') sess++;
      else chats++;
      const a = accountOf(ctx, m, assigned);
      if (!a) noAccount++;
      if (a && m.kind === 'session' && attrib.provenanceFor(m.id, assigned, src) === 'inferred') inferred++;
      accts.add(a || 'unassigned');
    });
    return {
      slug: t.slug,
      title: t.title,
      file: t.file,
      corrupt: !!t.corrupt,
      error: t.error || null,
      members: (t.members || []).length,
      sessions: sess,
      chats: chats,
      accounts: Array.from(accts).sort(),
      noAccount: noAccount,
      inferred: inferred,
      droppedMembers: t.droppedMembers || 0,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
}

function stats(ctx) {
  const rows = summaries(ctx);
  let mirrored = 0;
  try {
    mirrored = fs.readdirSync(mirrorDir(ctx)).filter(function (n) {
      return String(n).slice(-3) === '.md';
    }).length;
  } catch (e) {
    mirrored = 0;
  }
  return {
    threads: rows.length,
    members: rows.reduce(function (n, r) {
      return n + r.members;
    }, 0),
    sessions: rows.reduce(function (n, r) {
      return n + r.sessions;
    }, 0),
    chats: rows.reduce(function (n, r) {
      return n + r.chats;
    }, 0),
    // Count + slugs for the members no account can be resolved for. `doctor` reports these: they are
    // pointers a switch cannot follow, and the fix is one command.
    noAccount: rows.reduce(function (n, r) {
      return n + (r.noAccount || 0);
    }, 0),
    // How many members' accounts are a #50 inference. Reported so `spanning` (a thread spanning two
    // accounts) can never be quietly built on two guesses.
    inferred: rows.reduce(function (n, r) {
      return n + (r.inferred || 0);
    }, 0),
    noAccountSlugs: rows
      .filter(function (r) {
        return r.noAccount > 0;
      })
      .map(function (r) {
        return r.slug;
      }),
    spanning: rows
      .filter(function (r) {
        return (
          r.accounts.filter(function (a) {
            return a !== 'unassigned';
          }).length > 1
        );
      })
      .map(function (r) {
        return r.slug;
      }),
    corrupt: rows
      .filter(function (r) {
        return r.corrupt || r.droppedMembers;
      })
      .map(function (r) {
        return r.slug;
      }),
    mirrorEnabled: mirrorEnabled(ctx),
    mirrorFiles: mirrored,
  };
}

export {
  SCHEMA_VERSION,
  DIR_NAME,
  MIRROR_DIR_NAME,
  SESSION_ID_RE,
  CHAT_ID_RE,
  DEFAULT_MAX_MESSAGES,
  dir,
  mirrorDir,
  slugify,
  fileFor,
  mirrorFileFor,
  list,
  read,
  create,
  addMember,
  removeMember,
  update,
  drop,
  threadsFor,
  index,
  locate,
  resolveSessionId,
  assignments,
  accountOf,
  expand,
  newest,
  timeline,
  toMarkdown,
  privacyCheck,
  mirrorEnabled,
  mirror,
  unmirror,
  candidates,
  summaries,
  stats,
};
