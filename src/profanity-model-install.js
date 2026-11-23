// Consent-gated installer/remover for the optional local profanity classifier runtime and weights.
// Downloads only into <configDir>/models/profanity/; never touches the repo or package.json.
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { pathToFileURL } from 'url';
import * as _fsutil from './fsutil.js';
import {
  MANIFEST_NAME,
  PERMISSIVE_LICENSES,
  resolveCatalogModel,
  runtimeDir,
  weightsRootDir,
  modelDir,
  manifestPath,
  isRuntimeInstalled,
  getInstalledModel,
  normalizeModelId,
} from './profanity-model.js';

const RUNTIME_PACKAGE = '@huggingface/transformers';
const RUNTIME_APPROX_MB = 190;

function installPlan(ctx, idOrAlias) {
  const entry = resolveCatalogModel(idOrAlias);
  if (!entry) {
    const err = new Error('unknown profanity model: ' + String(idOrAlias || ''));
    err.code = 'UNKNOWN_MODEL';
    throw err;
  }
  if (!PERMISSIVE_LICENSES.includes(entry.license)) {
    const err = new Error('model licence is not permissive: ' + entry.license);
    err.code = 'INCOMPATIBLE_LICENSE';
    throw err;
  }
  const rtInstalled = isRuntimeInstalled(ctx);
  const installed = getInstalledModel(ctx, entry.id);
  return {
    entry: entry,
    runtimeInstalled: rtInstalled,
    modelInstalled: !!installed,
    downloadSizeMB: entry.approxSizeMB + (rtInstalled ? 0 : RUNTIME_APPROX_MB),
    dir: modelDir(ctx, entry.id),
    runtimeDir: runtimeDir(ctx),
  };
}

function defaultInstallRuntime({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    _fsutil.atomicWrite(
      pkgPath,
      JSON.stringify({ name: 'keyflip-profanity-runtime', private: true, version: '1.0.0' }, null, 2) + '\n',
      0o600,
    );
  }
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmBin, ['install', '--no-audit', '--no-fund', '--omit=dev', RUNTIME_PACKAGE], {
    cwd: dir,
    encoding: 'utf8',
    shell: false,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error('failed to install ' + RUNTIME_PACKAGE + ': ' + (res.stderr || res.stdout || 'exit ' + res.status));
  }
}

async function defaultDownloadModel({ rtDir, weightsRoot, entry }) {
  const req = createRequire(path.join(rtDir, 'package.json'));
  const resolved = req.resolve(RUNTIME_PACKAGE);
  const mod = await import(pathToFileURL(resolved).href);

  mod.env.allowRemoteModels = true;
  mod.env.allowLocalModels = true;
  mod.env.localModelPath = weightsRoot;
  mod.env.cacheDir = weightsRoot;
  mod.env.useBrowserCache = false;

  const pipeOpts = entry.modelFileName
    ? { subfolder: entry.subfolder || '', model_file_name: entry.modelFileName }
    : { dtype: entry.dtype || 'q8' };

  const pipe = await mod.pipeline('text-classification', entry.id, pipeOpts);
  try {
    await pipe('test', { top_k: null, truncation: true });
  } finally {
    if (typeof pipe.dispose === 'function') await pipe.dispose();
  }
}

function computeDirHash(dir) {
  const h = crypto.createHash('sha1');
  function walk(cur, relBase) {
    const entries = fs.readdirSync(cur).sort();
    for (const name of entries) {
      if (name === MANIFEST_NAME) continue;
      const full = path.join(cur, name);
      const rel = relBase ? relBase + '/' + name : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
      } else {
        h.update(rel + ':' + st.size + '\n');
      }
    }
  }
  walk(dir, '');
  return h.digest('hex').slice(0, 16);
}

async function installModel(ctx, idOrAlias, opts) {
  opts = opts || {};
  const plan = installPlan(ctx, idOrAlias);
  const entry = plan.entry;
  const rtDir = plan.runtimeDir;
  const weightsRoot = weightsRootDir(ctx);
  const mDir = plan.dir;
  const mPath = manifestPath(ctx, entry.id);

  if (!rtDir || !weightsRoot || !mDir || !mPath) {
    throw new Error('cannot resolve keyflip config directory for profanity model install');
  }

  const hasCustomRuntime = typeof opts.installRuntimeFn === 'function';
  const hasCustomDownload = typeof opts.downloadModelFn === 'function';
  if (process.env.KEYFLIP_TEST_OFFLINE === '1' && (!hasCustomRuntime || !hasCustomDownload)) {
    throw new Error('refusing network model download in offline test mode');
  }

  if (!isRuntimeInstalled(ctx)) {
    if (hasCustomRuntime) {
      await opts.installRuntimeFn({ dir: rtDir, packageName: RUNTIME_PACKAGE });
    } else {
      defaultInstallRuntime({ dir: rtDir });
    }
  }

  fs.mkdirSync(mDir, { recursive: true });
  if (hasCustomDownload) {
    await opts.downloadModelFn({ rtDir, weightsRoot, entry, dir: mDir });
  } else {
    await defaultDownloadModel({ rtDir, weightsRoot, entry });
  }

  const onnxRel = entry.subfolder ? path.join(entry.subfolder, entry.modelFile) : entry.modelFile;
  const onnxFull = path.join(mDir, onnxRel);
  if (!fs.existsSync(onnxFull)) {
    throw new Error('downloaded model weights missing expected file: ' + onnxFull);
  }

  const hash = computeDirHash(mDir);
  const manifest = {
    id: entry.id,
    alias: entry.alias,
    license: entry.license,
    version: '1',
    hash: hash,
    dtype: entry.dtype,
    subfolder: entry.subfolder,
    modelFile: entry.modelFile,
    modelFileName: entry.modelFileName || null,
    offensiveLabels: entry.offensiveLabels,
    installedAt: new Date().toISOString(),
  };
  _fsutil.atomicWrite(mPath, JSON.stringify(manifest, null, 2) + '\n', 0o600);

  return getInstalledModel(ctx, entry.id);
}

function removeModel(ctx, idOrAlias) {
  const canonical = normalizeModelId(idOrAlias);
  if (canonical === 'off') return { removed: false, id: 'off', dir: null };
  const weightsRoot = weightsRootDir(ctx);
  const dir = modelDir(ctx, canonical);
  if (!weightsRoot || !dir) return { removed: false, id: canonical, dir: null };
  const resolvedRoot = path.resolve(weightsRoot) + path.sep;
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedRoot)) {
    throw new Error('refusing to remove directory outside weights root');
  }
  const existed = fs.existsSync(resolvedDir);
  if (existed) {
    fs.rmSync(resolvedDir, { recursive: true, force: true });
  }
  return { removed: existed, id: canonical, dir: resolvedDir };
}

export { RUNTIME_PACKAGE, RUNTIME_APPROX_MB, installPlan, installModel, removeModel };
