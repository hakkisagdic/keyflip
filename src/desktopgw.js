// #17 Claude Desktop gateway cleanup & experimental manual gateway helper.
// By default Claude Desktop NEVER goes onto a third-party gateway (it ignores
// settings.json ANTHROPIC_BASE_URL and ignored 3p configLibrary at launch).
// `restore(ctx)` returns every Desktop config dir to its recorded deploymentMode
// (or deletes deploymentMode if none was recorded), deletes keyflip-gateway-*.json
// profiles from configLibrary/, and deletes .keyflip-gateway.json.
import fs from 'fs';
import path from 'path';
import { writeJsonStable, readJsonForWrite } from './fsutil.js';
import * as provider from './provider.js';
import * as txn from './txn.js';
import { registerSecret } from './redact.js';

const KEYFLIP_PROFILE_ID = 'keyflip-gateway-0000-0000-0000-000000000001'; // fixed id we own
const META = '.keyflip-gateway.json';

// The desktop config dirs to keep in sync (main + the -3p sibling on macOS).
function configDirs(ctx) {
  if (!ctx || !ctx.appDataDir) return [];
  const dirs = [ctx.appDataDir];
  if (ctx.platform === 'darwin') dirs.push(ctx.appDataDir + '-3p'); // "Claude-3p"
  return dirs;
}
function cfgPath(dir) {
  return path.join(dir, 'claude_desktop_config.json');
}
function profilePath(dir) {
  return path.join(dir, 'configLibrary', KEYFLIP_PROFILE_ID + '.json');
}
function metaPath(ctx) {
  return path.join(ctx.configDir, META);
}

function gatewayProfileFiles(dir) {
  const lib = path.join(dir, 'configLibrary');
  let entries;
  try {
    entries = fs.readdirSync(lib);
  } catch {
    return [];
  }
  return entries
    .filter(function (f) {
      return /^keyflip-gateway-.*\.json$/.test(f);
    })
    .map(function (f) {
      return path.join(lib, f);
    });
}

// Missing -> {}; exists-but-corrupt -> throw (the txn wrapper then restores the
// original bytes instead of clobbering the user's desktop config with {}).
function readJson(p) {
  return readJsonForWrite(p) || {};
}

// Experimental-only manual switch (`keyflip desktop gateway-experimental <provider>`).
// Refuses unless opts.experimental === true, and refuses when the provider has no key.
function use(ctx, name, opts) {
  opts = opts || {};
  if (!opts.experimental) {
    throw new Error(
      'Desktop third-party gateway mode is disabled (experimental only: keyflip desktop gateway-experimental <provider>)',
    );
  }
  const meta = provider.read(ctx, name);
  if (!meta) throw new Error("no such provider: '" + name + "'");
  const dirs = configDirs(ctx);
  if (!dirs.length) throw new Error('the Claude desktop app is only manageable on macOS/Windows');
  let key = null;
  try {
    key = registerSecret(ctx.store.getProfile('provider__' + name));
  } catch {
    key = null;
  }
  if (!key || !String(key).trim()) {
    throw new Error("provider '" + name + "' has no stored API key");
  }

  let prevMeta = null;
  try {
    prevMeta = readJson(metaPath(ctx));
  } catch {
    prevMeta = null;
  }
  const previousModes = Object.assign(
    {},
    prevMeta && prevMeta.previousModes && typeof prevMeta.previousModes === 'object' ? prevMeta.previousModes : {},
  );

  const touched = [];
  dirs.forEach(function (d) {
    touched.push(cfgPath(d), profilePath(d));
  });
  touched.push(metaPath(ctx));

  txn.withRollback(touched, function () {
    dirs.forEach(function (d) {
      // Read existing config first so corrupt JSON throws before any writes.
      const cfg = readJson(cfgPath(d));
      if (!Object.prototype.hasOwnProperty.call(previousModes, d)) {
        previousModes[d] =
          typeof cfg.deploymentMode === 'string' && cfg.deploymentMode && cfg.deploymentMode !== '3p'
            ? cfg.deploymentMode
            : null;
      }
      fs.mkdirSync(path.join(d, 'configLibrary'), { recursive: true });
      writeJsonStable(
        profilePath(d),
        {
          id: KEYFLIP_PROFILE_ID,
          inferenceProvider: 'gateway',
          inferenceGatewayBaseUrl: meta.baseUrl,
          inferenceGatewayApiKey: key,
          inferenceGatewayAuthScheme: meta.authScheme === 'api-key' ? 'api-key' : 'bearer',
          inferenceModels: Object.keys(meta.models || {})
            .map(function (k) {
              return meta.models[k];
            })
            .filter(function (m, i, all) {
              return m && all.indexOf(m) === i;
            }),
          managedBy: 'keyflip',
        },
        0o600,
      );
      cfg.deploymentMode = '3p';
      cfg.enterpriseConfig = Object.assign({}, cfg.enterpriseConfig, { activeConfigId: KEYFLIP_PROFILE_ID });
      writeJsonStable(cfgPath(d), cfg, 0o600);
    });
    const prevDefault =
      prevMeta && typeof prevMeta.previousDeploymentMode === 'string' && prevMeta.previousDeploymentMode !== '3p'
        ? prevMeta.previousDeploymentMode
        : previousModes[dirs[0]] !== undefined
          ? previousModes[dirs[0]]
          : null;
    writeJsonStable(
      metaPath(ctx),
      {
        provider: name,
        profileId: KEYFLIP_PROFILE_ID,
        previousDeploymentMode: prevDefault,
        previousModes: previousModes,
        at: ctx.now(),
      },
      0o600,
    );
  });
  return { provider: name, dirs: dirs.length };
}

function recordedModeForDir(gwMeta, dir) {
  if (!gwMeta || typeof gwMeta !== 'object') return null;
  let m = null;
  if (gwMeta.previousModes && Object.prototype.hasOwnProperty.call(gwMeta.previousModes, dir)) {
    m = gwMeta.previousModes[dir];
  } else if (typeof gwMeta.previousDeploymentMode === 'string') {
    m = gwMeta.previousDeploymentMode;
  } else if (typeof gwMeta.deploymentMode === 'string') {
    m = gwMeta.deploymentMode;
  }
  if (typeof m !== 'string' || !m || m === '3p') return null;
  return m;
}

// Restore every Desktop config dir to its recorded deploymentMode (else delete
// deploymentMode), delete configLibrary/keyflip-gateway-*.json, and delete .keyflip-gateway.json.
function restore(ctx) {
  const cleaned = [];
  if (!ctx || !ctx.configDir) return { restored: false, cleaned: cleaned };
  const dirs = configDirs(ctx);
  const mp = metaPath(ctx);
  let gwMeta = null;
  const hadMetaFile = fs.existsSync(mp);
  if (hadMetaFile) {
    try {
      gwMeta = readJson(mp);
    } catch {
      gwMeta = {};
    }
  }
  if (!dirs.length) {
    if (hadMetaFile) {
      try {
        fs.rmSync(mp, { force: true });
        cleaned.push(mp);
      } catch {
        /* ignore */
      }
    }
    return { restored: cleaned.length > 0, cleaned: cleaned };
  }

  const profFilesByDir = {};
  const touched = [];
  dirs.forEach(function (d) {
    const cp = cfgPath(d);
    if (fs.existsSync(cp)) touched.push(cp);
    const pfs = gatewayProfileFiles(d);
    profFilesByDir[d] = pfs;
    pfs.forEach(function (pf) {
      touched.push(pf);
    });
    const fixedPf = profilePath(d);
    if (touched.indexOf(fixedPf) === -1) touched.push(fixedPf);
  });
  touched.push(mp);

  txn.withRollback(touched, function () {
    dirs.forEach(function (d) {
      const cp = cfgPath(d);
      if (fs.existsSync(cp)) {
        const cfg = readJson(cp);
        const recorded = recordedModeForDir(gwMeta, d);
        const had3p = cfg.deploymentMode === '3p';
        const hadKeyflipId = !!(
          cfg.enterpriseConfig &&
          typeof cfg.enterpriseConfig.activeConfigId === 'string' &&
          /^keyflip-gateway-/.test(cfg.enterpriseConfig.activeConfigId)
        );
        if (had3p || hadKeyflipId || hadMetaFile) {
          if (recorded) cfg.deploymentMode = recorded;
          else if (had3p || hadMetaFile) delete cfg.deploymentMode;
          if (cfg.enterpriseConfig && (hadKeyflipId || hadMetaFile)) {
            delete cfg.enterpriseConfig.activeConfigId;
            if (!Object.keys(cfg.enterpriseConfig).length) delete cfg.enterpriseConfig;
          }
          writeJsonStable(cp, cfg, 0o600);
          cleaned.push(cp);
        }
      }
      const pfs = profFilesByDir[d] || [];
      pfs.forEach(function (pf) {
        try {
          fs.rmSync(pf, { force: true });
          cleaned.push(pf);
        } catch {
          /* ignore */
        }
      });
    });
    if (hadMetaFile) {
      try {
        fs.rmSync(mp, { force: true });
        cleaned.push(mp);
      } catch {
        /* ignore */
      }
    }
  });
  return { restored: cleaned.length > 0, cleaned: cleaned };
}

function hasLeftovers(ctx) {
  if (!ctx || !ctx.configDir) return false;
  if (fs.existsSync(metaPath(ctx))) return true;
  const dirs = configDirs(ctx);
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    if (gatewayProfileFiles(d).length > 0) return true;
    const cp = cfgPath(d);
    if (!fs.existsSync(cp)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (cfg && cfg.deploymentMode === '3p') return true;
      if (
        cfg &&
        cfg.enterpriseConfig &&
        typeof cfg.enterpriseConfig.activeConfigId === 'string' &&
        /^keyflip-gateway-/.test(cfg.enterpriseConfig.activeConfigId)
      ) {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function active(ctx) {
  try {
    const m = readJson(metaPath(ctx));
    return m && m.provider ? m : null;
  } catch {
    return null;
  }
}

export { use, restore, active, hasLeftovers, configDirs, KEYFLIP_PROFILE_ID, META };
