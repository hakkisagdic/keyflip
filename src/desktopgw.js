'use strict';
// #17 Claude Desktop third-party gateway switching. Points the desktop app at a
// provider profile's gateway by setting deploymentMode:'3p' in
// claude_desktop_config.json of BOTH config dirs (Claude and Claude-3p on macOS;
// %LOCALAPPDATA%\Claude on Windows) and writing a fixed keyflip gateway profile
// into configLibrary/. Restoring flips back to '1p' and removes what we added.
// All edits are wrapped in the multi-file rollback so a mid-way failure never
// leaves the app half-configured.
const fs = require('fs');
const path = require('path');
const { writeJsonStable } = require('./fsutil');
const provider = require('./provider');
const txn = require('./txn');

const KEYFLIP_PROFILE_ID = 'keyflip-gateway-0000-0000-0000-000000000001'; // fixed id we own
const META = '.keyflip-gateway.json';

// The desktop config dirs to keep in sync (main + the -3p sibling on macOS).
function configDirs(ctx) {
  if (!ctx.appDataDir) return [];
  const dirs = [ctx.appDataDir];
  if (ctx.platform === 'darwin') dirs.push(ctx.appDataDir + '-3p'); // "Claude-3p"
  return dirs;
}
function cfgPath(dir) { return path.join(dir, 'claude_desktop_config.json'); }
function profilePath(dir) { return path.join(dir, 'configLibrary', KEYFLIP_PROFILE_ID + '.json'); }
function metaPath(ctx) { return path.join(ctx.configDir, META); }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch (e) { return {}; } }

// Switch the desktop app to provider <name>'s gateway.
function use(ctx, name) {
  const meta = provider.read(ctx, name);
  if (!meta) throw new Error("no such provider: '" + name + "'");
  const dirs = configDirs(ctx);
  if (!dirs.length) throw new Error('the Claude desktop app is only manageable on macOS/Windows');
  let key = null; try { key = ctx.store.getProfile('provider__' + name); } catch (e) { key = null; }

  const touched = [];
  dirs.forEach(function (d) { touched.push(cfgPath(d), profilePath(d)); });
  touched.push(metaPath(ctx));

  txn.withRollback(touched, function () {
    dirs.forEach(function (d) {
      fs.mkdirSync(path.join(d, 'configLibrary'), { recursive: true });
      // gateway profile
      writeJsonStable(profilePath(d), {
        id: KEYFLIP_PROFILE_ID,
        inferenceProvider: 'gateway',
        inferenceGatewayBaseUrl: meta.baseUrl,
        inferenceGatewayApiKey: key || '',
        inferenceGatewayAuthScheme: meta.authScheme === 'api-key' ? 'api-key' : 'bearer',
        inferenceModels: Object.keys(meta.models || {}).map(function (k) { return meta.models[k]; }),
        managedBy: 'keyflip',
      }, 0o600);
      // config: deploymentMode 3p + point at our profile
      const cfg = readJson(cfgPath(d));
      cfg.deploymentMode = '3p';
      cfg.enterpriseConfig = Object.assign({}, cfg.enterpriseConfig, { activeConfigId: KEYFLIP_PROFILE_ID });
      writeJsonStable(cfgPath(d), cfg, 0o600);
    });
    writeJsonStable(metaPath(ctx), { provider: name, profileId: KEYFLIP_PROFILE_ID, at: ctx.now() }, 0o600);
  });
  return { provider: name, dirs: dirs.length };
}

// Restore the desktop app to first-party (Anthropic) mode.
function restore(ctx) {
  const dirs = configDirs(ctx);
  if (!dirs.length) return { restored: false };
  const touched = dirs.map(cfgPath).concat(dirs.map(profilePath)).concat([metaPath(ctx)]);
  txn.withRollback(touched, function () {
    dirs.forEach(function (d) {
      const cfg = readJson(cfgPath(d));
      cfg.deploymentMode = '1p';
      if (cfg.enterpriseConfig) { delete cfg.enterpriseConfig.activeConfigId; if (!Object.keys(cfg.enterpriseConfig).length) delete cfg.enterpriseConfig; }
      writeJsonStable(cfgPath(d), cfg, 0o600);
      try { fs.rmSync(profilePath(d), { force: true }); } catch (e) { /* */ }
    });
    try { fs.rmSync(metaPath(ctx), { force: true }); } catch (e) { /* */ }
  });
  return { restored: true };
}

function active(ctx) { const m = readJson(metaPath(ctx)); return m && m.provider ? m : null; }

module.exports = { use: use, restore: restore, active: active, configDirs: configDirs, KEYFLIP_PROFILE_ID: KEYFLIP_PROFILE_ID };
