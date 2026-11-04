// Unified capture/switch/status/backup adapter for file-backed CLI agent surfaces:
//   - grok   (Grok CLI):     ~/.grok/settings.json
//   - qwen   (Qwen Code):    ~/.qwen/oauth_creds.json
//   - kimi   (Kimi CLI):     ~/.kimi/credentials.json
//   - hermes (Hermes Agent): ~/.hermes/auth.json
//
// Modeled on src/commandcode.js:
//   1. Credentials live in <configDir>/surfaces/<surfaceId>/<slug>/<bundleFile> (0600) —
//      covered by SECRET_DIRS ('surfaces') in secretpaths.js so git and metadata backups
//      never touch raw tokens or API keys.
//   2. Non-secret metadata lives alongside in meta.json (userId, userName, email, model,
//      capturedAt, bytes) — never raw tokens or keys.
//   3. Switching backs up the outgoing live file under <configDir>/surfaces/<surfaceId>/.backups/
//      and auto-captures an unsaved outgoing identity before overwriting.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as fsutil from './fsutil.js';

const MAX_BACKUPS = 10;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x1f\x7f]/g;

function cleanStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(CTRL, '').trim();
  return s ? s.slice(0, max || 120) : null;
}

function shortHash(raw) {
  return crypto
    .createHash('sha256')
    .update(String(raw || ''), 'utf8')
    .digest('hex')
    .slice(0, 8);
}

// Decode a non-secret JWT payload claim (email/sub/name) without exposing the token.
function jwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch (e) {
    return null;
  }
}

// Secret-bearing field names whose values we use ONLY for a one-way SHA-256 fingerprint
// when no human-readable username/email/userId is present in the JSON file.
const SECRET_KEYS = [
  'apiKey',
  'api_key',
  'xaiApiKey',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
  'token',
  'key',
  'secret',
];

function extractSecretFingerprint(obj, prefix) {
  if (!obj || typeof obj !== 'object') return null;
  for (let i = 0; i < SECRET_KEYS.length; i++) {
    const k = SECRET_KEYS[i];
    if (typeof obj[k] === 'string' && obj[k].trim()) {
      return prefix + ':' + shortHash(obj[k].trim());
    }
  }
  // Check nested common containers (e.g. oauth, auth, credentials, providers)
  const nested = ['oauth', 'auth', 'credentials', 'user', 'account'];
  for (let i = 0; i < nested.length; i++) {
    const sub = obj[nested[i]];
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
      for (let j = 0; j < SECRET_KEYS.length; j++) {
        const k = SECRET_KEYS[j];
        if (typeof sub[k] === 'string' && sub[k].trim()) {
          return prefix + ':' + shortHash(sub[k].trim());
        }
      }
    }
  }
  return prefix + ':' + shortHash(JSON.stringify(obj));
}

function genericIdentity(obj, prefix) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const userObj = obj.user && typeof obj.user === 'object' ? obj.user : {};
  const acctObj = obj.account && typeof obj.account === 'object' ? obj.account : {};
  const claims = jwtClaims(obj.id_token || obj.idToken || (obj.oauth && obj.oauth.id_token)) || {};

  const email = cleanStr(obj.email) || cleanStr(userObj.email) || cleanStr(acctObj.email) || cleanStr(claims.email);
  const userName =
    cleanStr(obj.userName) ||
    cleanStr(obj.username) ||
    cleanStr(obj.name) ||
    cleanStr(userObj.username) ||
    cleanStr(userObj.name) ||
    cleanStr(acctObj.name) ||
    cleanStr(claims.preferred_username) ||
    cleanStr(claims.name) ||
    email;
  const rawId =
    cleanStr(obj.userId) ||
    cleanStr(obj.user_id) ||
    cleanStr(obj.accountId) ||
    cleanStr(obj.account_id) ||
    cleanStr(userObj.id) ||
    cleanStr(acctObj.id) ||
    cleanStr(claims.sub) ||
    email ||
    userName ||
    extractSecretFingerprint(obj, prefix);
  if (!rawId) return null;
  const model = cleanStr(obj.model) || cleanStr(obj.defaultModel) || cleanStr(obj.default_model) || null;
  return {
    userId: rawId,
    userName: userName || rawId,
    email: email || null,
    model: model,
  };
}

const ADAPTER_SPECS = Object.freeze({
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok CLI',
    bin: 'grok',
    binary: 'grok',
    authRel: Object.freeze(['.grok', 'settings.json']),
    bundleFile: 'settings.json',
    envKeys: Object.freeze(['XAI_API_KEY', 'GROK_API_KEY']),
  }),
  qwen: Object.freeze({
    id: 'qwen',
    label: 'Qwen Code',
    bin: 'qwen',
    binary: 'qwen',
    authRel: Object.freeze(['.qwen', 'oauth_creds.json']),
    bundleFile: 'oauth_creds.json',
    envKeys: Object.freeze(['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY']),
  }),
  kimi: Object.freeze({
    id: 'kimi',
    label: 'Kimi CLI',
    bin: 'kimi',
    binary: 'kimi',
    authRel: Object.freeze(['.kimi', 'credentials.json']),
    bundleFile: 'credentials.json',
    envKeys: Object.freeze(['MOONSHOT_API_KEY', 'KIMI_API_KEY']),
  }),
  hermes: Object.freeze({
    id: 'hermes',
    label: 'Hermes Agent',
    bin: 'hermes',
    binary: 'hermes',
    authRel: Object.freeze(['.hermes', 'auth.json']),
    bundleFile: 'auth.json',
    envKeys: Object.freeze(['NOUS_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']),
  }),
});

const SUPPORTED_IDS = Object.freeze(Object.keys(ADAPTER_SPECS));

function getSpec(surfaceId) {
  const spec = typeof surfaceId === 'string' ? ADAPTER_SPECS[surfaceId] : null;
  if (!spec) {
    throw new Error("unsupported CLI surface: '" + surfaceId + "' (supported: " + SUPPORTED_IDS.join(', ') + ')');
  }
  return spec;
}

function authPath(ctx, surfaceId) {
  const spec = getSpec(surfaceId);
  return path.join.apply(path, [ctx.home].concat(spec.authRel));
}

function storeRoot(ctx, surfaceId) {
  const spec = getSpec(surfaceId);
  return path.join(ctx.configDir, 'surfaces', spec.id);
}

function backupsDir(ctx, surfaceId) {
  return path.join(storeRoot(ctx, surfaceId), '.backups');
}

function safeSlug(s) {
  const cleaned = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.indexOf('.backups') === 0) return null;
  return cleaned;
}

function accountDir(ctx, surfaceId, slug) {
  const s = safeSlug(slug);
  if (!s) throw new Error('invalid account name: ' + slug);
  return path.join(storeRoot(ctx, surfaceId), s);
}

function readLiveAuth(ctx, surfaceId) {
  const spec = getSpec(surfaceId);
  const p = authPath(ctx, surfaceId);
  let raw, st;
  try {
    st = fs.statSync(p);
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { present: false, path: p, error: null, identity: null, bytes: 0, mode: null };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return {
      present: true,
      path: p,
      error: spec.bundleFile + ' is not valid JSON',
      identity: null,
      bytes: raw.length,
      mode: st.mode & 0o777,
    };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length === 0) {
    return {
      present: true,
      path: p,
      error: spec.bundleFile + ' is empty',
      identity: null,
      bytes: raw.length,
      mode: st.mode & 0o777,
    };
  }
  const id = genericIdentity(obj, spec.id);
  return {
    present: true,
    path: p,
    error: id ? null : spec.bundleFile + ' has no recognizable identity or credential',
    identity: id,
    bytes: raw.length,
    mode: st.mode & 0o777,
  };
}

function listAccounts(ctx, surfaceId) {
  const spec = getSpec(surfaceId);
  const root = storeRoot(ctx, surfaceId);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const out = [];
  entries.forEach(function (d) {
    if (!d.isDirectory() || d.name[0] === '.') return;
    const dir = path.join(root, d.name);
    const credFile = path.join(dir, spec.bundleFile);
    const metaFile = path.join(dir, 'meta.json');
    let st;
    try {
      st = fs.statSync(credFile);
    } catch (e) {
      return;
    }
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {};
    } catch (e) {
      meta = {};
    }
    out.push({
      name: d.name,
      surface: spec.id,
      userId: cleanStr(meta.userId),
      userName: cleanStr(meta.userName),
      email: cleanStr(meta.email),
      model: cleanStr(meta.model),
      capturedAt: cleanStr(meta.capturedAt),
      bytes: st.size,
    });
  });
  out.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  return out;
}

function resolveAccount(ctx, surfaceId, q) {
  const spec = getSpec(surfaceId);
  const list = listAccounts(ctx, surfaceId);
  if (!list.length) {
    throw new Error('no ' + spec.label + ' accounts saved yet — run `keyflip ' + spec.id + ' capture` first');
  }
  const s = String(q || '').trim();
  if (/^\d+$/.test(s)) {
    const idx = parseInt(s, 10) - 1;
    if (idx < 0 || idx >= list.length) {
      throw new Error('account number out of range (1..' + list.length + ')');
    }
    return list[idx].name;
  }
  const slug = safeSlug(s);
  const exact = list.find(function (a) {
    return a.name === slug || a.name === s;
  });
  if (exact) return exact.name;
  const low = s.toLowerCase();
  const byUser = list.filter(function (a) {
    return (
      (a.userName && a.userName.toLowerCase() === low) ||
      (a.email && a.email.toLowerCase() === low) ||
      (a.userId && a.userId.toLowerCase() === low)
    );
  });
  if (byUser.length === 1) return byUser[0].name;
  throw new Error(
    'no saved ' +
      spec.label +
      " account matches '" +
      s +
      "' (have: " +
      list
        .map(function (a) {
          return a.name;
        })
        .join(', ') +
      ')',
  );
}

function capture(ctx, surfaceId, opts) {
  opts = opts || {};
  const spec = getSpec(surfaceId);
  const live = readLiveAuth(ctx, surfaceId);
  if (!live.present) {
    throw new Error(
      'no ' +
        spec.label +
        ' login at ' +
        live.path +
        ' — sign in with `' +
        spec.bin +
        '` first, then re-run `keyflip ' +
        spec.id +
        ' capture`',
    );
  }
  if (!live.identity) {
    throw new Error('cannot capture ' + live.path + ': ' + (live.error || 'unreadable'));
  }
  const raw = fs.readFileSync(live.path, 'utf8');
  const preferred = opts.name || live.identity.email || live.identity.userName || live.identity.userId;
  const slug = safeSlug(preferred);
  if (!slug) {
    throw new Error('cannot derive a safe account name — pass one: `keyflip ' + spec.id + ' capture <name>`');
  }
  const dir = accountDir(ctx, surfaceId, slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destAuth = path.join(dir, spec.bundleFile);
  fsutil.atomicWrite(destAuth, raw, 0o600);
  const meta = {
    schema: 1,
    surface: spec.id,
    name: slug,
    userId: live.identity.userId,
    userName: live.identity.userName,
    email: live.identity.email,
    model: live.identity.model,
    capturedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(raw, 'utf8'),
  };
  fsutil.atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 0o600);
  return { slug: slug, dir: dir, meta: meta };
}

function writeBackup(ctx, surfaceId, raw) {
  const spec = getSpec(surfaceId);
  const dir = backupsDir(ctx, surfaceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, stamp + '.' + spec.bundleFile);
  fsutil.atomicWrite(file, raw, 0o600);
  try {
    const suffix = '.' + spec.bundleFile;
    const all = fs
      .readdirSync(dir)
      .filter(function (f) {
        return f.endsWith(suffix);
      })
      .sort();
    while (all.length > MAX_BACKUPS) {
      const drop = all.shift();
      try {
        fs.unlinkSync(path.join(dir, drop));
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return file;
}

function listBackups(ctx, surfaceId) {
  const spec = getSpec(surfaceId);
  const dir = backupsDir(ctx, surfaceId);
  const suffix = '.' + spec.bundleFile;
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter(function (f) {
        return f.endsWith(suffix);
      })
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
  return files.map(function (f) {
    const full = path.join(dir, f);
    let userName = null,
      bytes = 0;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      bytes = raw.length;
      const id = genericIdentity(JSON.parse(raw), spec.id);
      userName = id ? id.userName || id.userId : null;
    } catch (e) {
      /* corrupt backup */
    }
    return {
      file: f,
      at: f.slice(0, f.length - suffix.length),
      userName: userName,
      bytes: bytes,
    };
  });
}

function restoreBackup(ctx, surfaceId, ref, opts) {
  opts = opts || {};
  const spec = getSpec(surfaceId);
  const list = listBackups(ctx, surfaceId);
  if (!list.length) throw new Error('no ' + spec.label + ' backups to restore');
  const s = String(ref || '').trim();
  let chosen = null;
  if (/^\d+$/.test(s)) {
    const idx = parseInt(s, 10) - 1;
    if (idx < 0 || idx >= list.length) {
      throw new Error('backup number out of range (1..' + list.length + ')');
    }
    chosen = list[idx];
  } else {
    chosen = list.find(function (b) {
      return b.file === s || b.at === s;
    });
  }
  if (!chosen) throw new Error("no backup matches '" + s + "'");
  const srcPath = path.join(backupsDir(ctx, surfaceId), chosen.file);
  const raw = fs.readFileSync(srcPath, 'utf8');
  const r = applyAuthBlob(ctx, surfaceId, raw, {
    label: 'backup:' + chosen.file,
    dryRun: !!opts.dryRun,
    noVerify: !!opts.noVerify,
  });
  if (r.switched) r.restored = chosen.file;
  return r;
}

function applyAuthBlob(ctx, surfaceId, raw, opts) {
  opts = opts || {};
  const spec = getSpec(surfaceId);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('stored ' + spec.bundleFile + ' for ' + opts.label + ' is not valid JSON — refusing to write');
  }
  const targetId = genericIdentity(parsed, spec.id);
  if (!targetId) {
    throw new Error('stored ' + spec.bundleFile + ' for ' + opts.label + ' has no identity — refusing to write');
  }

  const dest = authPath(ctx, surfaceId);
  const live = readLiveAuth(ctx, surfaceId);
  const plan = {
    surface: spec.id,
    slug: opts.label,
    target: opts.label,
    userName: targetId.userName,
    userId: targetId.userId,
    file: dest,
    live: live.identity ? { userName: live.identity.userName, userId: live.identity.userId } : null,
    willBackupLive: live.present && live.bytes > 0,
    write: { path: dest, bytes: Buffer.byteLength(raw, 'utf8'), mode: '0600' },
  };
  if (opts.dryRun) return { switched: false, dryRun: true, plan: plan };

  let backupFile = null;
  let capturedOutgoing = null;
  if (live.present && live.bytes > 0) {
    try {
      const liveRaw = fs.readFileSync(dest, 'utf8');
      if (liveRaw !== raw) backupFile = writeBackup(ctx, surfaceId, liveRaw);
      if (live.identity && live.identity.userId && live.identity.userId !== targetId.userId) {
        const known = listAccounts(ctx, surfaceId).some(function (a) {
          return a.userId === live.identity.userId;
        });
        if (!known) {
          try {
            capturedOutgoing = capture(ctx, surfaceId, {}).slug;
          } catch (e) {
            /* best effort */
          }
        }
      }
    } catch (e) {
      /* best effort */
    }
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fsutil.atomicWrite(dest, raw, 0o600);

  if (!opts.noVerify) {
    const after = readLiveAuth(ctx, surfaceId);
    if (!after.identity || after.identity.userId !== targetId.userId) {
      if (backupFile) {
        try {
          fsutil.atomicWrite(dest, fs.readFileSync(backupFile, 'utf8'), 0o600);
        } catch (e) {
          /* ignore */
        }
      }
      throw new Error(
        spec.label +
          ' switch read-back failed (expected ' +
          targetId.userId +
          ', got ' +
          (after.identity ? after.identity.userId : 'nothing') +
          ') — rolled back',
      );
    }
  }

  return {
    switched: true,
    surface: spec.id,
    slug: opts.label,
    identity: targetId,
    backup: backupFile,
    capturedOutgoing: capturedOutgoing,
    verified: !opts.noVerify,
  };
}

function switchTo(ctx, surfaceId, target, opts) {
  opts = opts || {};
  const spec = getSpec(surfaceId);
  const slug = resolveAccount(ctx, surfaceId, target);
  const srcPath = path.join(accountDir(ctx, surfaceId, slug), spec.bundleFile);
  let raw;
  try {
    raw = fs.readFileSync(srcPath, 'utf8');
  } catch (e) {
    throw new Error('saved account ' + slug + ' has no ' + spec.bundleFile);
  }
  const r = applyAuthBlob(ctx, surfaceId, raw, {
    label: slug,
    dryRun: !!opts.dryRun,
    noVerify: !!opts.noVerify,
  });
  if (r.switched) r.restored = slug;
  return r;
}

function removeAccount(ctx, surfaceId, q, opts) {
  opts = opts || {};
  const spec = getSpec(surfaceId);
  if (!opts.force) {
    throw new Error(
      'removing a saved ' +
        spec.label +
        ' account deletes its stored ' +
        spec.bundleFile +
        ' — pass --force (or confirm=true)',
    );
  }
  const slug = resolveAccount(ctx, surfaceId, q);
  fs.rmSync(accountDir(ctx, surfaceId, slug), { recursive: true, force: true });
  return { removed: slug, surface: spec.id };
}

function status(ctx, surfaceId, opts) {
  opts = opts || {};
  const spec = getSpec(surfaceId);
  const live = readLiveAuth(ctx, surfaceId);
  const accounts = listAccounts(ctx, surfaceId);
  const env = opts.env || process.env || {};
  const activeEnvKey =
    spec.envKeys.find(function (k) {
      return Boolean(env[k] && String(env[k]).trim());
    }) || null;

  let activeAccount = null;
  if (live.identity) {
    const match = accounts.find(function (a) {
      return (
        (a.userId && live.identity.userId && a.userId === live.identity.userId) ||
        (a.userName && live.identity.userName && a.userName === live.identity.userName)
      );
    });
    activeAccount = match ? match.name : live.identity.email || live.identity.userName || live.identity.userId;
  }

  return {
    surface: spec.id,
    label: spec.label,
    bin: spec.bin,
    bundleFile: spec.bundleFile,
    present: live.present,
    signedIn: Boolean(live.present && live.identity),
    path: live.path,
    file: live.path,
    error: live.error,
    identity: live.identity,
    activeAccount: activeAccount,
    envOverride: Boolean(activeEnvKey),
    envKey: activeEnvKey || spec.envKeys[0],
    accounts: accounts,
  };
}

export {
  ADAPTER_SPECS,
  SUPPORTED_IDS,
  getSpec,
  authPath,
  storeRoot,
  backupsDir,
  readLiveAuth,
  listAccounts,
  resolveAccount,
  capture,
  switchTo,
  listBackups,
  restoreBackup,
  removeAccount,
  status,
};
