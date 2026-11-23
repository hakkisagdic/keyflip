// Local offline offensive-language model loader & registry for stage-2 profanity filtering.
// Contains zero network code and zero URLs: inference loads only local weights and runtime.
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const MANIFEST_NAME = 'manifest.json';
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const PERMISSIVE_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause'];
const DEFAULT_MODEL_ID = 'Horizon-Labs/multilingual-toxicity-small';

const MODEL_CATALOG = [
  {
    id: 'Horizon-Labs/multilingual-toxicity-small',
    alias: 'multilingual-toxicity-small',
    license: 'Apache-2.0',
    approxSizeMB: 268,
    dtype: 'q8',
    subfolder: 'onnx',
    modelFile: 'model_quantized.onnx',
    offensiveLabels: ['toxicity', 'severe_toxicity', 'obscene', 'insult', 'threat', 'identity_attack'],
    languages: '34 languages incl. Turkish (mmBERT-small, 141M params)',
    metrics: 'Evaluated on Civil Comments ROC AUC and TextDetox (15 langs) ROC AUC / F1@0.5',
  },
  {
    id: 'onnx-community/content-safety-guard-small-ONNX',
    alias: 'content-safety-guard-small',
    license: 'Apache-2.0',
    approxSizeMB: 268,
    dtype: 'q8',
    subfolder: 'onnx',
    modelFile: 'model_quantized.onnx',
    offensiveLabels: ['profanity', 'harassment', 'hate', 'unsafe'],
    languages: '20 languages incl. Turkish (mmBERT-small, 141M params)',
    metrics: 'Mean harm F1 ~0.758 on WildGuardTest / CircleGuardBench; PolyGuard & TextDetox',
  },
  {
    id: 'hoan/multilingual-toxic-xlm-roberta-dynamic-quantized',
    alias: 'multilingual-toxic-xlm-roberta',
    license: 'Apache-2.0',
    approxSizeMB: 279,
    dtype: 'q8',
    subfolder: '',
    modelFile: 'model_quantized.onnx',
    modelFileName: 'model_quantized',
    offensiveLabels: [
      'toxicity',
      'severe_toxicity',
      'obscene',
      'insult',
      'threat',
      'identity_attack',
      'LABEL_0',
      'LABEL_1',
      'LABEL_2',
      'LABEL_3',
      'LABEL_4',
    ],
    languages: 'Multilingual incl. Turkish (XLM-RoBERTa, Jigsaw Multilingual)',
    metrics: 'Jigsaw Multilingual validation AUC ~0.916, Turkish cross-lingual AUC ~0.94',
  },
];

function resolveConfigDir(ctxOrOpts) {
  const o = ctxOrOpts || {};
  if (o.configDir) return String(o.configDir);
  const envDir = (o.env && o.env.KEYFLIP_CONFIG_DIR) || process.env.KEYFLIP_CONFIG_DIR;
  if (envDir) return String(envDir);
  if (process.env.NODE_TEST_CONTEXT) return null;
  const home = o.home || os.homedir();
  return path.join(home, '.config', 'keyflip');
}

function normalizeModelId(raw) {
  if (raw == null) return 'off';
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'off') return 'off';
  const entry = resolveCatalogModel(trimmed);
  return entry ? entry.id : trimmed;
}

function resolveCatalogModel(idOrAlias) {
  if (typeof idOrAlias !== 'string') return null;
  const target = idOrAlias.trim();
  if (!target) return null;
  const lower = target.toLowerCase();
  for (const entry of MODEL_CATALOG) {
    if (entry.id.toLowerCase() === lower || entry.alias.toLowerCase() === lower) return entry;
  }
  return null;
}

function safeRepoSegments(id) {
  const parts = String(id || '').split('/');
  if (parts.length !== 2) return null;
  if (!SEGMENT_RE.test(parts[0]) || !SEGMENT_RE.test(parts[1])) return null;
  if (parts[0] === '.' || parts[0] === '..' || parts[1] === '.' || parts[1] === '..') return null;
  return parts;
}

function modelsRootDir(ctxOrOpts) {
  const cfg = resolveConfigDir(ctxOrOpts);
  return cfg ? path.join(cfg, 'models', 'profanity') : null;
}

function runtimeDir(ctxOrOpts) {
  const root = modelsRootDir(ctxOrOpts);
  return root ? path.join(root, 'runtime') : null;
}

function weightsRootDir(ctxOrOpts) {
  const root = modelsRootDir(ctxOrOpts);
  return root ? path.join(root, 'weights') : null;
}

function modelDir(ctxOrOpts, idOrAlias) {
  const weightsRoot = weightsRootDir(ctxOrOpts);
  if (!weightsRoot) return null;
  const canonical = normalizeModelId(idOrAlias);
  if (canonical === 'off') return null;
  const parts = safeRepoSegments(canonical);
  if (!parts) return null;
  return path.join(weightsRoot, parts[0], parts[1]);
}

function manifestPath(ctxOrOpts, idOrAlias) {
  const dir = modelDir(ctxOrOpts, idOrAlias);
  return dir ? path.join(dir, MANIFEST_NAME) : null;
}

function runtimePackageEntry(ctxOrOpts) {
  const rtDir = runtimeDir(ctxOrOpts);
  if (!rtDir) return null;
  return path.join(rtDir, 'node_modules', '@huggingface', 'transformers', 'package.json');
}

function isRuntimeInstalled(ctxOrOpts) {
  const entry = runtimePackageEntry(ctxOrOpts);
  return !!(entry && fs.existsSync(entry));
}

function expectedModelFilePath(dir, manifest, catalogEntry) {
  const sub =
    manifest && typeof manifest.subfolder === 'string'
      ? manifest.subfolder
      : (catalogEntry && catalogEntry.subfolder) || '';
  const file = (manifest && manifest.modelFile) || (catalogEntry && catalogEntry.modelFile) || 'model_quantized.onnx';
  const rel = sub ? path.join(sub, file) : file;
  const full = path.resolve(dir, rel);
  const resolvedDir = path.resolve(dir) + path.sep;
  if (!full.startsWith(resolvedDir)) return null;
  return full;
}

function getInstalledModel(ctxOrOpts, idOrAlias) {
  const canonical = normalizeModelId(idOrAlias);
  if (canonical === 'off') return null;
  const dir = modelDir(ctxOrOpts, canonical);
  const mPath = manifestPath(ctxOrOpts, canonical);
  if (!dir || !mPath || !fs.existsSync(mPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.id !== canonical) return null;
  const catalogEntry = resolveCatalogModel(canonical);
  const onnxPath = expectedModelFilePath(dir, parsed, catalogEntry);
  if (!onnxPath || !fs.existsSync(onnxPath)) return null;
  return {
    id: parsed.id,
    alias: (catalogEntry && catalogEntry.alias) || parsed.alias || null,
    hash: String(parsed.hash || ''),
    version: String(parsed.version || '1'),
    license: String(parsed.license || (catalogEntry && catalogEntry.license) || ''),
    dir: dir,
    installedAt: parsed.installedAt || null,
    modelFile: parsed.modelFile || (catalogEntry && catalogEntry.modelFile) || 'model_quantized.onnx',
    modelFileName: parsed.modelFileName || (catalogEntry && catalogEntry.modelFileName) || null,
    subfolder: typeof parsed.subfolder === 'string' ? parsed.subfolder : (catalogEntry && catalogEntry.subfolder) || '',
    dtype: parsed.dtype || (catalogEntry && catalogEntry.dtype) || 'q8',
    offensiveLabels: Array.isArray(parsed.offensiveLabels)
      ? parsed.offensiveLabels
      : (catalogEntry && catalogEntry.offensiveLabels) || [],
  };
}

function listInstalledModels(ctxOrOpts) {
  const root = weightsRootDir(ctxOrOpts);
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  let orgs;
  try {
    orgs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const org of orgs) {
    if (!SEGMENT_RE.test(org) || org.startsWith('.')) continue;
    const orgDir = path.join(root, org);
    let repos;
    try {
      if (!fs.statSync(orgDir).isDirectory()) continue;
      repos = fs.readdirSync(orgDir);
    } catch {
      continue;
    }
    for (const repo of repos) {
      if (!SEGMENT_RE.test(repo) || repo.startsWith('.')) continue;
      const inst = getInstalledModel(ctxOrOpts, org + '/' + repo);
      if (inst) out.push(inst);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

const CLEAN_LABELS = new Set(['neutral', 'non-toxic', 'nontoxic', 'not', 'safe', 'clean', 'ok', 'other']);

function scoreFromOutputs(item, offensiveLabels) {
  const list = Array.isArray(item) ? item : item && typeof item === 'object' ? [item] : [];
  if (!list.length) return { score: 0 };
  const targets = new Set((offensiveLabels || []).map((l) => String(l).toLowerCase()));
  let matchedMax = null;
  let nonCleanMax = null;
  let cleanMax = null;

  for (const entry of list) {
    if (!entry || typeof entry.score !== 'number' || !Number.isFinite(entry.score)) continue;
    const label = String(entry.label || '').toLowerCase();
    if (targets.has(label)) {
      if (matchedMax === null || entry.score > matchedMax) matchedMax = entry.score;
    } else if (CLEAN_LABELS.has(label)) {
      if (cleanMax === null || entry.score > cleanMax) cleanMax = entry.score;
    } else {
      if (nonCleanMax === null || entry.score > nonCleanMax) nonCleanMax = entry.score;
    }
  }

  if (matchedMax !== null) return { score: clamp01(matchedMax) };
  if (nonCleanMax !== null) return { score: clamp01(nonCleanMax) };
  if (cleanMax !== null) return { score: clamp01(1 - cleanMax) };
  return { score: 0 };
}

async function loadLocalClassifier(ctxOrOpts, idOrAlias, loadOpts) {
  loadOpts = loadOpts || {};
  const manifest = getInstalledModel(ctxOrOpts, idOrAlias);
  if (!manifest) {
    const err = new Error('profanity model not installed locally: ' + String(idOrAlias || 'off'));
    err.code = 'MODEL_NOT_INSTALLED';
    throw err;
  }

  if (typeof loadOpts.runtimeLoader === 'function') {
    return await loadOpts.runtimeLoader({
      manifest,
      weightsRoot: weightsRootDir(ctxOrOpts),
      runtimeDir: runtimeDir(ctxOrOpts),
    });
  }

  const rtDir = runtimeDir(ctxOrOpts);
  if (!rtDir || !isRuntimeInstalled(ctxOrOpts)) {
    const err = new Error('profanity model runtime not installed locally');
    err.code = 'RUNTIME_NOT_INSTALLED';
    throw err;
  }

  const req = createRequire(path.join(rtDir, 'package.json'));
  const resolved = req.resolve('@huggingface/transformers');
  const mod = await import(pathToFileURL(resolved).href);
  const weightsRoot = weightsRootDir(ctxOrOpts);

  // Strictly offline local inference: disable all remote model fetches.
  mod.env.allowRemoteModels = false;
  mod.env.allowLocalModels = true;
  mod.env.localModelPath = weightsRoot;
  mod.env.cacheDir = weightsRoot;
  mod.env.useBrowserCache = false;

  const pipeOpts = manifest.modelFileName
    ? { local_files_only: true, subfolder: manifest.subfolder || '', model_file_name: manifest.modelFileName }
    : { local_files_only: true, dtype: manifest.dtype || 'q8' };

  const pipe = await mod.pipeline('text-classification', manifest.id, pipeOpts);
  const batchSize = typeof loadOpts.batchSize === 'number' && loadOpts.batchSize > 0 ? loadOpts.batchSize : 16;

  async function classify(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (!list.length) return [];
    const out = [];
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize).map((t) => String(t == null ? '' : t));
      const raw = await pipe(batch, { top_k: null, truncation: true });
      const rows = Array.isArray(raw) ? raw : [raw];
      for (let j = 0; j < batch.length; j++) {
        out.push(scoreFromOutputs(rows[j], manifest.offensiveLabels));
      }
    }
    return out;
  }

  classify.dispose = async function () {
    if (typeof pipe.dispose === 'function') await pipe.dispose();
  };

  return classify;
}

export {
  MANIFEST_NAME,
  MODEL_CATALOG,
  DEFAULT_MODEL_ID,
  PERMISSIVE_LICENSES,
  normalizeModelId,
  resolveCatalogModel,
  modelsRootDir,
  runtimeDir,
  weightsRootDir,
  modelDir,
  manifestPath,
  isRuntimeInstalled,
  getInstalledModel,
  listInstalledModels,
  scoreFromOutputs,
  loadLocalClassifier,
};
