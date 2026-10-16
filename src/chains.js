// @ts-check
// CREDENTIAL-CHAIN map (#39): what one "login" is actually MADE of, and who can keep it alive.
//
// An account is never one file. It is a live credential plus every copy keyflip has taken out of
// it: a Keychain/`.cred` profile, the desktop app's token cache AND its session cookie, a browser
// cookie snapshot, a provider API key, a third-party `surfaces/` capture. Those copies form a
// graph, and three properties of that graph decide whether a switch will work:
//
//   1. RENEWAL — who can renew each node. The app re-mints its own token cache; nothing renews a
//      claude.ai session cookie but a human. So the cookie is the chain's real root and its death
//      is the account's death, however healthy the token blob looks. (That is exactly the
//      "switched account opens the onboarding screen" incident, seen live.)
//   2. STALENESS — a capture is a copy of a store that kept moving. If the source's mtime is newer
//      than the capture's, the capture is already the past and restoring it cannot log anyone in.
//   3. SHARING — one browser profile / one app cookie jar holds exactly ONE account's session.
//      Every capture taken from the same single-tenant source competes with all the others: using
//      Chrome as account A silently makes A's snapshot of B untrue. (The Kiro IDE/CLI shared-token
//      conflict is the same shape.)
//
// INVARIANTS — this module is a pure, read-only derivation:
//   - it STATS secret files (size/mtime/mode), it never reads their CONTENT;
//   - it never spawns `security … -w`, so Keychain items are reported `exists: null` (unprobed)
//     instead of being fetched;
//   - it writes NOTHING into the git-versioned state repo, so no fingerprint of a secret value can
//     ever be committed by it — the graph is recomputed on demand from paths and stats;
//   - results carry paths relative to the state repo (`app/yahoo.cookies`) or to $HOME
//     (`~/.claude/.credentials.json`), never file contents, never tokens.
import fs from 'fs';
import path from 'path';
import * as _profiles from './profiles.js';
import * as _browser from './browser.js';
import * as _appauth from './appauth.js';
import * as _provider from './provider.js';
import * as _secretpaths from './secretpaths.js';
import { SERVICE_LIVE, PROFILE_PREFIX } from './stores/keychain.js';

// Who renews a node once it dies. `human` is the honest answer for a cookie or an API key: no
// amount of automation renews it, which is what makes it the chain's bottleneck.
const RENEW = Object.freeze({
  human: 'a human login/rotation',
  app: 'the tool itself',
  keyflip: 'keyflip, on switch',
  recapture: 'a fresh capture only',
  metadata: 'nothing — not time-bound',
});

// kind -> { renew, secret, tenant }. `tenant: 'single'` marks a store that can only hold ONE
// account's session at a time, so captures of it contend by construction.
const KINDS = Object.freeze({
  'interactive-login': { renew: 'human', secret: false },
  'live-credential': { renew: 'app', secret: true, tenant: 'single' },
  'oauth-profile': { renew: 'keyflip', secret: true },
  'identity-metadata': { renew: 'metadata', secret: false },
  'session-cookie-db': { renew: 'human', secret: true, tenant: 'single' },
  'token-cache': { renew: 'app', secret: true },
  'app-cookie-snapshot': { renew: 'recapture', secret: true },
  'app-token-snapshot': { renew: 'recapture', secret: true },
  'browser-cookie-db': { renew: 'human', secret: true, tenant: 'single' },
  'browser-cookie-snapshot': { renew: 'recapture', secret: true },
  'provider-key': { renew: 'human', secret: true },
  'provider-meta': { renew: 'metadata', secret: false },
  'env-mirror': { renew: 'keyflip', secret: true },
  'surface-file': { renew: 'recapture', secret: true },
  'surface-dir': { renew: 'recapture', secret: true },
  unknown: { renew: 'recapture', secret: true },
});

// A capture of one of these sources competes with every other capture of the same source.
const SINGLE_TENANT = ['live-credential', 'session-cookie-db', 'browser-cookie-db'];

const MAX_WALK = 12; // cycle/depth guard for rootOf()

function kindMeta(kind) {
  return KINDS[kind] || KINDS.unknown;
}

// Is this path INSIDE the git-versioned state repo (and not it itself)? Used to bound every
// "keyflip is responsible for this artifact" judgement — and to bound the one write.
function insideRepo(ctx, abs) {
  const rel = path.relative(ctx.configDir, abs);
  return !!rel && !path.isAbsolute(rel) && rel.slice(0, 2) !== '..';
}

function statSafe(abs) {
  try {
    const st = fs.statSync(abs);
    return {
      exists: true,
      dir: st.isDirectory(),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      mtime: new Date(st.mtimeMs).toISOString(),
      mode: (st.mode & 0o777).toString(8),
    };
  } catch (e) {
    return { exists: false, dir: false, bytes: 0, mtimeMs: 0, mtime: null, mode: null };
  }
}

// State-repo-relative when inside it, $HOME-relative otherwise — readable, and never a secret.
// The "is it inside" test is a `..` prefix test, NOT a leading-dot test: the CLI credential lives at
// `~/.claude/.credentials.json`, and a dot check would reject every dot-directory and print a raw
// absolute $HOME path into a report that is meant to be pasteable.
function display(ctx, abs) {
  if (!abs) return null;
  const rel = function (base) {
    const r = path.relative(base, abs);
    if (!r || path.isAbsolute(r) || r.slice(0, 2) === '..') return null;
    return r.split(path.sep).join('/');
  };
  const inside = rel(ctx.configDir);
  if (inside) return inside;
  const home = rel(ctx.home);
  if (home) return '~/' + home;
  return abs;
}

// One graph node: a place a credential (or the identity metadata that points at it) lives.
function mk(ctx, spec) {
  const meta = kindMeta(spec.kind);
  /** @type {any} */
  const n = {
    id: spec.id,
    account: spec.account || null,
    product: spec.product || 'claude',
    kind: spec.kind,
    renew: meta.renew,
    secret: !!meta.secret,
    tenant: meta.tenant || null,
    synthetic: !!spec.synthetic,
    file: null,
    abs: spec.abs || null,
    exists: false,
    dir: false,
    bytes: 0,
    mtime: null,
    mtimeMs: 0,
    mode: null,
    probed: true,
    source: spec.source || null, // the node this file was COPIED from (staleness)
    dependsOn: spec.dependsOn || [], // nodes whose death makes this one unrenewable
    note: spec.note || null,
  };
  if (spec.synthetic) {
    n.exists = true;
    n.note = n.note || 'a human has to do this; keyflip can only carry the result';
    return n;
  }
  if (spec.keychain) {
    // Existence of a Keychain item would take `security -g`, which prints the secret. Refuse.
    n.file = 'keychain:' + spec.keychain.service;
    n.exists = null;
    n.probed = false;
    n.note = (n.note ? n.note + ' — ' : '') + 'Keychain item (existence unprobed)';
    return n;
  }
  if (!spec.abs) {
    n.exists = null; // no such store on this platform (e.g. no desktop app data dir on Linux)
    n.probed = false;
    n.note = n.note || 'not applicable on this platform';
    return n;
  }
  n.file = display(ctx, spec.abs);
  const st = statSafe(spec.abs);
  n.exists = st.exists;
  n.dir = st.dir;
  n.bytes = st.bytes;
  n.mtime = st.mtime;
  n.mtimeMs = st.mtimeMs;
  n.mode = st.mode;
  // A directory reads as a store, not a file: mark it so the render never implies one blob.
  if (st.dir && n.file) n.file = n.file + '/';
  return n;
}

// Everything keyflip (and the tools it mirrors) keeps for this machine, as one node list.
function collect(ctx) {
  const out = [];
  const add = function (spec) {
    out.push(mk(ctx, spec));
  };

  // ---- the human roots: every chain bottoms out in a login nothing automates ----
  add({
    id: 'login:claude-web',
    kind: 'interactive-login',
    product: 'claude',
    note: 'sign in at claude.ai in a browser — the source of the CLI OAuth token',
    synthetic: true,
  });
  add({
    id: 'login:claude-app',
    kind: 'interactive-login',
    product: 'claude',
    note: 'sign in inside the desktop app — mints the claude.ai session cookie',
    synthetic: true,
  });

  // ---- Claude Code's live credential: what the CLI actually reads ----
  // The file store wins when it exists (any OS, and any macOS version that fell back to a file);
  // otherwise the live item is in the Keychain and is reported unprobed.
  const credsFile = ctx.credsFilePath;
  if (fs.existsSync(credsFile)) {
    add({
      id: 'live:claude',
      kind: 'live-credential',
      abs: credsFile,
      dependsOn: ['login:claude-web'],
      note: 'the credential Claude Code reads and refreshes',
    });
  } else if (ctx.platform === 'darwin') {
    add({
      id: 'live:claude',
      kind: 'live-credential',
      keychain: { service: SERVICE_LIVE, account: ctx.account },
      dependsOn: ['login:claude-web'],
      note: 'the credential Claude Code reads and refreshes',
    });
  } else {
    add({
      id: 'live:claude',
      kind: 'live-credential',
      abs: credsFile,
      dependsOn: ['login:claude-web'],
      note: 'no live credential file yet',
    });
  }

  // ---- per-account: identity metadata, the stored profile, the desktop-app pair ----
  const accounts = _profiles.list(ctx.configDir);
  const known = Object.create(null);
  accounts.forEach(function (name) {
    known[name] = true;
  });

  add({
    id: 'live:app-cookies',
    kind: 'session-cookie-db',
    product: 'claude-app',
    abs: _appauth.cookiesPath(ctx),
    dependsOn: ['login:claude-app'],
    note: "the desktop app's claude.ai sessionKey cookie — the app's real login",
  });
  add({
    id: 'live:app-config',
    kind: 'token-cache',
    product: 'claude-app',
    abs: _appauth.configPath(ctx),
    dependsOn: ['live:app-cookies'],
    note: 'derived: the app re-mints this from the session cookie on launch — it renews nobody',
  });

  accounts.forEach(function (name) {
    add({
      id: 'meta:' + name,
      kind: 'identity-metadata',
      account: name,
      abs: _profiles.metaPath(ctx.configDir, name),
      note: 'who this account is — carries no credential',
    });
    const credFile = path.join(ctx.configDir, 'creds', name + '.cred');
    if (fs.existsSync(credFile) || ctx.platform !== 'darwin') {
      add({
        id: 'profile:' + name,
        kind: 'oauth-profile',
        account: name,
        abs: credFile,
        source: 'live:claude',
        note: 'keyflip copy of the CLI credential; restored by `keyflip switch`',
      });
    } else {
      add({
        id: 'profile:' + name,
        kind: 'oauth-profile',
        account: name,
        keychain: { service: PROFILE_PREFIX + name, account: ctx.account },
        source: 'live:claude',
        note: 'keyflip copy of the CLI credential; restored by `keyflip switch`',
      });
    }
    add({
      id: 'app-cookies:' + name,
      kind: 'app-cookie-snapshot',
      account: name,
      product: 'claude-app',
      abs: _appauth.profileCookiesPath(ctx, name),
      source: 'live:app-cookies',
      dependsOn: ['login:claude-app'],
      note: 'a frozen copy of the app cookie jar — the only thing that can re-sign-in the app without a human',
    });
    add({
      id: 'app-token:' + name,
      kind: 'app-token-snapshot',
      account: name,
      product: 'claude-app',
      abs: _appauth.profilePath(ctx, name),
      source: 'live:app-config',
      dependsOn: ['app-cookies:' + name],
      note: 'token cache copy; useless alone — the app needs a live cookie to re-mint it',
    });
  });

  // ---- browser cookie snapshots: <account>__<browser>.sql, copied from that browser's cookie DB ----
  const cat = _browser.catalog(ctx.home);
  const bdir = path.join(ctx.configDir, 'browser-sessions');
  readdir(bdir)
    .filter(function (f) {
      return f.slice(-4) === '.sql';
    })
    .forEach(function (f) {
      const base = f.slice(0, -4);
      const sep = base.lastIndexOf('__');
      const account = sep > 0 ? base.slice(0, sep) : base;
      const browserId = sep > 0 ? base.slice(sep + 2) : 'chrome';
      const b = cat[browserId];
      const liveId = 'live:' + browserId + '-cookies';
      // The source node comes first: a capture is only interpretable against what it was taken from.
      if (!nodeSeen(out, liveId)) {
        add({
          id: liveId,
          kind: 'browser-cookie-db',
          product: b ? b.name : browserId,
          abs: b ? b.cookies : null,
          dependsOn: ['login:claude-web'],
          note: 'the live browser session store (one profile holds exactly one account)',
        });
      }
      add({
        id: 'browser:' + f,
        kind: 'browser-cookie-snapshot',
        account: account,
        product: b ? b.name : browserId,
        abs: path.join(bdir, f),
        source: liveId,
        note:
          'a frozen copy of ' +
          (b ? b.name : browserId) +
          "'s cookie DB — the extension inherits the browser, so this IS that account's web login",
      });
    });

  // ---- third-party tool captures: surfaces/<tool>/<account>/... ----
  const sdir = path.join(ctx.configDir, 'surfaces');
  readdir(sdir).forEach(function (tool) {
    const tdir = path.join(sdir, tool);
    if (!isDir(tdir)) return;
    readdir(tdir).forEach(function (acct) {
      const adir = path.join(tdir, acct);
      if (!isDir(adir)) return;
      readdir(adir).forEach(function (f) {
        const abs = path.join(adir, f);
        const isDirectory = isDir(abs);
        add({
          id: 'surface:' + tool + '/' + acct + '/' + (isDirectory ? f + '/' : f),
          kind: isDirectory ? 'surface-dir' : 'surface-file',
          account: acct,
          product: tool,
          abs: abs,
          note: isDirectory
            ? 'a whole opaque store copied out of ' + tool + ' — keyflip cannot interpret or renew it'
            : 'a ' + tool + ' credential captured by keyflip; renewal is whatever ' + tool + ' does with it',
        });
      });
    });
  });

  // ---- providers: an API key in the credential store, mirrored in plaintext into settings.json ----
  _provider.list(ctx).forEach(function (name) {
    add({
      id: 'provider-meta:' + name,
      kind: 'provider-meta',
      account: null,
      product: 'provider:' + name,
      abs: _provider.metaPath(ctx, name),
      note: 'endpoint config — holds no key',
    });
    const keyFile = path.join(ctx.configDir, 'creds', _provider.keyStoreName(name) + '.cred');
    if (fs.existsSync(keyFile) || ctx.platform !== 'darwin') {
      add({
        id: 'provider-key:' + name,
        kind: 'provider-key',
        product: 'provider:' + name,
        abs: keyFile,
        dependsOn: ['login:provider:' + name],
        note: 'the provider API key; only the vendor console renews it',
      });
    } else {
      add({
        id: 'provider-key:' + name,
        kind: 'provider-key',
        product: 'provider:' + name,
        keychain: { service: PROFILE_PREFIX + _provider.keyStoreName(name), account: ctx.account },
        dependsOn: ['login:provider:' + name],
        note: 'the provider API key; only the vendor console renews it',
      });
    }
    add({
      id: 'login:provider:' + name,
      kind: 'interactive-login',
      product: 'provider:' + name,
      synthetic: true,
      note: 'rotate/issue the key in the vendor console',
    });
  });
  // The active provider's env block IS a plaintext copy of that key — a second place it lives.
  const active = _provider.readActive(ctx);
  if (active && active.name) {
    add({
      id: 'env-mirror',
      kind: 'env-mirror',
      product: 'provider:' + active.name,
      abs: ctx.claudeSettingsPath,
      dependsOn: ['provider-key:' + active.name],
      note: 'the key Claude Code actually uses, written in plaintext into settings.json by keyflip',
    });
  }

  return out;
}

function readdir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (e) {
    return [];
  }
}
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}
function nodeSeen(list, id) {
  return list.some(function (n) {
    return n.id === id;
  });
}

function index(nodes) {
  const m = Object.create(null); // null-proto: a node id like '__proto__' can never poison it
  nodes.forEach(function (n) {
    m[n.id] = n;
  });
  return m;
}

// The upstream of a node: what it was copied from, or what keeps it alive.
function upstream(n) {
  if (n.dependsOn && n.dependsOn.length) return n.dependsOn;
  return n.source ? [n.source] : [];
}

// Walk up to the root — the thing that dies first and takes this node with it.
function rootOf(n, map) {
  let cur = n;
  const seen = Object.create(null);
  for (let i = 0; i < MAX_WALK; i++) {
    const ups = upstream(cur).map(function (id) {
      return map[id];
    });
    const next = ups.filter(Boolean)[0];
    if (!next) return cur;
    if (seen[next.id]) return cur; // a cycle stops here rather than spinning
    seen[next.id] = true;
    cur = next;
  }
  return cur;
}

// ---- risks -----------------------------------------------------------------------

// A secret readable by anyone but its owner. Scoped to keyflip's OWN state repo on purpose: the
// mode of a store keyflip copied out is keyflip's responsibility, while Chrome's own Cookies DB
// being 644 is normal (macOS protects it above the filesystem layer) and warning about it would
// train the user to ignore the warning. On Windows file modes are not meaningful.
function looseModeRisks(ctx, nodes) {
  if (ctx.platform === 'win32') return [];
  const risky = nodes.filter(function (n) {
    // Files only: a 755 directory merely lists names, and its secret CONTENT is caught per file —
    // flagging dirs would make every ordinary `~/.config/keyflip` look exposed.
    if (!(n.exists === true && n.secret && !n.dir && n.mode && n.abs)) return false;
    if (!insideRepo(ctx, n.abs)) return false;
    return (parseInt(n.mode, 8) & 0o077) !== 0;
  });
  return risky.map(function (n) {
    return {
      kind: 'loose-mode',
      severity: 'high',
      nodes: [n.id],
      // Which accounts this touches. A scoped report needs a rule that does not depend on parsing
      // prose — and "this risk names a machine-wide store" must not become "this risk is every
      // account's risk".
      accounts: n.account ? [n.account] : [],
      file: n.file,
      // The write needs the real path; risks keep it so no caller has to re-derive it from text.
      abs: n.abs,
      mode: n.mode,
      detail: n.file + ' is a ' + n.kind + ' with mode ' + n.mode + ' — readable beyond your user',
      fix: 'keyflip chains --tighten (chmod 600, state-repo secrets only)',
    };
  });
}

// The store this was copied from has moved on since.
function staleRisks(nodes, map) {
  const out = [];
  nodes.forEach(function (n) {
    if (!n.source || !(n.exists === true)) return;
    const src = map[n.source];
    if (!src || !(src.exists === true) || !src.mtimeMs) return;
    if (src.mtimeMs <= n.mtimeMs) return;
    const hours = Math.max(1, Math.round((src.mtimeMs - n.mtimeMs) / 3600000));
    out.push({
      kind: 'stale-snapshot',
      severity: 'warn',
      nodes: [n.id, n.source],
      accounts: n.account ? [n.account] : [],
      file: n.file,
      detail:
        n.file + ' was captured ' + hours + 'h before ' + src.file + ' last changed — restoring it restores the past',
      fix: 're-capture it while that account is actually logged in',
    });
  });
  return out;
}

// The source store is gone: the capture is now the only copy and can never be refreshed.
function lostSourceRisks(nodes, map) {
  const out = [];
  nodes.forEach(function (n) {
    if (!n.source || !(n.exists === true)) return;
    const src = map[n.source];
    if (!src || src.exists !== false) return;
    out.push({
      kind: 'lost-source',
      severity: 'warn',
      nodes: [n.id],
      accounts: n.account ? [n.account] : [],
      file: n.file,
      detail:
        n.file +
        ' is a copy of ' +
        (src.file || n.source) +
        ', which no longer exists — this capture is now the only copy',
      fix: 'treat it as durable state (back it up) or re-create the source store',
    });
  });
  return out;
}

// Two accounts, one single-tenant store: only one of them can be the live session.
function sharedSourceRisks(nodes, map) {
  const bySource = Object.create(null);
  nodes.forEach(function (n) {
    if (!n.source || !(n.exists === true) || !n.account) return;
    const src = map[n.source];
    if (!src || SINGLE_TENANT.indexOf(src.kind) === -1) return;
    (bySource[n.source] || (bySource[n.source] = [])).push(n);
  });
  return Object.keys(bySource)
    .map(function (id) {
      const list = bySource[id];
      const accts = unique(list.map(claimant));
      if (accts.length < 2) return null;
      const src = map[id];
      return {
        kind: 'shared-source',
        severity: 'high',
        nodes: list.map(function (n) {
          return n.id;
        }),
        accounts: accts,
        file: src.file,
        detail:
          accts.length +
          ' captures (' +
          accts.join(', ') +
          ') all come from the one store ' +
          src.file +
          ', which holds a single account — signing in as one makes the others stale',
        fix: 're-capture each account right after logging into it, or keep them on separate browser profiles',
      };
    })
    .filter(Boolean);
}

// A capture whose account keyflip does not know, or an account with nothing captured.
function coverageRisks(ctx, nodes) {
  const out = [];
  const accounts = _profiles.list(ctx.configDir);
  const known = Object.create(null);
  accounts.forEach(function (a) {
    known[a] = true;
  });
  const orphans = Object.create(null);
  nodes.forEach(function (n) {
    if (!n.account || known[n.account] || !(n.exists === true)) return;
    if (!n.secret) return;
    (orphans[n.account] || (orphans[n.account] = [])).push(n.file);
  });
  Object.keys(orphans).forEach(function (a) {
    out.push({
      kind: 'orphan-capture',
      severity: 'warn',
      nodes: [],
      accounts: [a],
      file: a,
      detail:
        orphans[a].length +
        ' capture(s) are filed under account "' +
        a +
        '" but there is no <configDir>/' +
        a +
        '.json profile for it — `keyflip list` will never show them',
      fix: 'keyflip add ' + a + ' (or move the capture under an account that exists)',
    });
  });
  accounts.forEach(function (a) {
    const has = nodes.some(function (n) {
      return n.account === a && n.exists === true && n.secret;
    });
    if (has) return;
    out.push({
      kind: 'uncaptured-account',
      severity: 'warn',
      nodes: [],
      accounts: [a],
      file: a,
      detail:
        'account "' + a + '" has a profile but no credential stored anywhere — switching to it has nothing to restore',
      fix: 'log in as ' + a + ' and run: keyflip add ' + a,
    });
  });
  return out;
}

function claimant(n) {
  return n.account || n.product;
}
function unique(arr) {
  const seen = Object.create(null);
  return arr.filter(function (x) {
    if (seen[x]) return false;
    seen[x] = true;
    return true;
  });
}

// One pass: the graph plus everything wrong about it.
function chains(ctx, opts) {
  opts = opts || {};
  const nodes = collect(ctx);
  const map = index(nodes);
  const risks = []
    .concat(looseModeRisks(ctx, nodes))
    .concat(sharedSourceRisks(nodes, map))
    .concat(staleRisks(nodes, map))
    .concat(lostSourceRisks(nodes, map))
    .concat(coverageRisks(ctx, nodes));
  risks.sort(function (a, b) {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return String(a.file) < String(b.file) ? -1 : 1;
  });

  // One entry per account: what it owns, where it bottoms out, and who can keep it alive.
  const byAccount = Object.create(null);
  nodes.forEach(function (n) {
    if (n.synthetic || n.account === null) return;
    const k = n.account;
    (byAccount[k] || (byAccount[k] = [])).push(n);
  });
  const owners = Object.keys(byAccount).sort();
  const perAccount = owners.map(function (a) {
    const mine = byAccount[a];
    const live = mine.filter(function (n) {
      return n.exists === true && n.secret;
    });
    // Only credentials have a chain: an identity-metadata file is a record of WHO, not a thing that
    // can expire, so letting it be a "root" would invent a chain that does not exist. And a capture
    // with NO recorded upstream (a third-party file keyflip copied but cannot interpret) has no
    // traceable origin — reporting the file as its own root would be a fiction.
    const roots = unique(
      mine
        .filter(function (n) {
          return n.secret && upstream(n).length > 0;
        })
        .map(function (n) {
          return rootOf(n, map).id;
        }),
    );
    return {
      account: a,
      held: live.map(function (n) {
        return n.id;
      }),
      present: live.length,
      missing: mine.filter(function (n) {
        return n.exists === false;
      }).length,
      unprobed: mine.filter(function (n) {
        return n.exists === null;
      }).length,
      // Who can renew what keyflip actually holds for this account right now.
      renewableBy: unique(
        live.map(function (n) {
          return RENEW[n.renew] || n.renew;
        }),
      ),
      // Where the chain bottoms out — and therefore what its lifetime really is. If a root is an
      // interactive login, no automated refresh can outlive it: that is the number that decides
      // what keyflip is allowed to keep warm (#36).
      roots: roots,
    };
  });

  const present = nodes.filter(function (n) {
    return n.exists === true;
  }).length;
  const result = {
    ok: true,
    configDir: display(ctx, ctx.configDir) || ctx.configDir,
    nodes: nodes,
    risks: risks,
    accounts: perAccount,
    renewLegend: RENEW,
    summary: {
      nodes: nodes.length,
      present: present,
      missing: nodes.length - present,
      unprobed: nodes.filter(function (n) {
        return n.exists === null;
      }).length,
      high: risks.filter(function (r) {
        return r.severity === 'high';
      }).length,
      warn: risks.filter(function (r) {
        return r.severity === 'warn';
      }).length,
    },
  };
  return opts.account ? filterAccount(result, String(opts.account)) : result;
}

// ---- the one write: tightening a loose secret ------------------------------------
// Refuses anything that is not a secret, and anything outside the state repo. A chmod on the
// user's own files is not destructive, but "only ever touch what keyflip owns and what is secret"
// is the rule that keeps a helper from quietly breaking somebody else's app.
function tighten(ctx, opts) {
  opts = opts || {};
  const apply = !!opts.apply;
  const risks = looseModeRisks(ctx, collect(ctx));
  const changed = [];
  const refused = [];
  risks.forEach(function (r) {
    const abs = r.abs;
    if (!abs) return;
    if (!insideRepo(ctx, abs)) {
      refused.push({ file: r.file, reason: 'outside the keyflip state repo — not ours to chmod' });
      return;
    }
    const rel = path.relative(ctx.configDir, abs);
    const underSecretDir = _secretpaths.SECRET_DIRS.some(function (d) {
      return rel === d || rel.slice(0, d.length + 1) === d + '/';
    });
    if (!underSecretDir && !_secretpaths.isSecretFile(path.basename(abs))) {
      refused.push({ file: r.file, reason: 'not in the secret path set — leaving it alone' });
      return;
    }
    if (!apply) {
      changed.push({ file: r.file, from: r.mode, to: '600', applied: false });
      return;
    }
    try {
      fs.chmodSync(abs, 0o600);
      changed.push({ file: r.file, from: r.mode, to: '600', applied: true });
    } catch (e) {
      refused.push({ file: r.file, reason: 'chmod failed: ' + (e && e.message) });
    }
  });
  // Prove it, the same way scrub-history re-scans: report what is STILL loose after applying.
  const remaining = apply ? looseModeRisks(ctx, collect(ctx)).length : risks.length;
  return { ok: true, applied: apply, changed: changed, refused: refused, remaining: remaining };
}

// Narrow a result to one account, keeping the stores it hangs off (they are the explanation). The
// summary is recomputed for what is actually in scope, so a filtered report cannot imply it looked
// at the whole store when it did not.
function filterAccount(c, account) {
  const keep = Object.create(null);
  c.nodes.forEach(function (n) {
    if (n.account === account || n.synthetic || n.account === null) keep[n.id] = true;
  });
  const nodes = c.nodes.filter(function (n) {
    return keep[n.id];
  });
  const risks = c.risks.filter(function (r) {
    // "About this account" is decided by the accounts the risk names, NOT by whether any of its
    // nodes survived the node filter: every chain hangs off machine-wide stores, so a node-id test
    // would pull ALL FOUR accounts' stale captures into a one-account report.
    if (r.accounts && r.accounts.length) return r.accounts.indexOf(account) !== -1;
    return true; // a finding about a store nobody owns (env-mirror, a shared browser DB) is everyone's
  });
  return {
    ok: c.ok,
    scoped: account,
    configDir: c.configDir,
    nodes: nodes,
    risks: risks,
    accounts: c.accounts.filter(function (a) {
      return a.account === account;
    }),
    renewLegend: c.renewLegend,
    summary: {
      nodes: nodes.length,
      present: nodes.filter(function (n) {
        return n.exists === true;
      }).length,
      missing: nodes.filter(function (n) {
        return n.exists === false;
      }).length,
      unprobed: nodes.filter(function (n) {
        return n.exists === null;
      }).length,
      high: risks.filter(function (r) {
        return r.severity === 'high';
      }).length,
      warn: risks.filter(function (r) {
        return r.severity === 'warn';
      }).length,
    },
  };
}

// ---- MCP tools ---------------------------------------------------------------------
const confirmProp = {
  confirm: { type: 'boolean', description: 'Must be true — set it only after the user has agreed.' },
};
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const MUT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

// What a node looks like on the way out: no absolute paths, no bytes of content — the shape is the
// whole point, and a transcript of this result must stay safe to paste into a chat.
function publicNode(n) {
  return {
    id: n.id,
    account: n.account,
    product: n.product,
    kind: n.kind,
    file: n.file,
    exists: n.exists,
    bytes: n.bytes,
    mode: n.mode,
    mtime: n.mtime,
    renew: n.renew,
    tenant: n.tenant,
    source: n.source,
    dependsOn: n.dependsOn,
    note: n.note,
  };
}

// A risk on the way out: keep everything a human or an agent needs to act (kind, severity, the
// relative path, the prose, the fix) and drop `abs`. The absolute path is for tighten(), which
// recomputes the list itself — a result that is meant to be pasted into a chat or committed to a
// log must not map the user's filesystem.
function publicRisk(r) {
  /** @type {any} */
  const out = {};
  Object.keys(r).forEach(function (k) {
    if (k !== 'abs') out[k] = r[k];
  });
  return out;
}

const mcpTools = [
  {
    name: 'keyflip_chains',
    title: 'Map what one account’s login is made of',
    description:
      'Read-only structural map of every credential keyflip holds per account and how they depend on each other: which store each was copied from, who can renew it (the tool itself, keyflip on switch, a fresh capture, or only a human login), and the risks that follow — captures that are already stale, several accounts sharing one single-tenant store (only one can really be signed in), captures whose account profile is missing, secret files with a loose file mode, and chains that bottom out in a human login nothing can refresh. Never reads the content of any secret and never touches the Keychain; results carry paths, kinds, sizes, modes and mtimes only.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Limit the map to one account slug.' },
      },
      additionalProperties: false,
    },
    annotations: RO,
    run: async function (ctx, args) {
      const c = chains(ctx, args && args.account ? { account: String(args.account) } : {});
      return {
        accounts: c.accounts,
        risks: c.risks.map(publicRisk),
        nodes: c.nodes.map(publicNode),
        summary: c.summary,
      };
    },
  },
  {
    name: 'keyflip_chains_tighten',
    title: 'chmod 600 the state-repo secrets that are readable by others',
    description:
      'Fix the one risk class that is a live exposure rather than a future inconvenience: a secret file inside the keyflip state repo whose mode grants access beyond the owner (a captured cookie DB at 644 is world-readable). Refuses anything outside the state repo and anything not in the secret path set, then re-scans and reports what is still loose. Needs confirm: true.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, confirmProp),
      required: ['confirm'],
      additionalProperties: false,
    },
    annotations: MUT,
    run: async function (ctx, args) {
      if (!args || args.confirm !== true) throw new Error('confirmation required: pass confirm: true');
      const t = tighten(ctx, { apply: true });
      return { changed: t.changed, refused: t.refused, remaining: t.remaining };
    },
  },
];

export {
  RENEW,
  KINDS,
  SINGLE_TENANT,
  chains,
  collect,
  rootOf,
  index,
  filterAccount,
  publicNode,
  publicRisk,
  display,
  tighten,
  looseModeRisks,
  mcpTools,
};
