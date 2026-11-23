# Stage-2 Local Profanity Classifier: Model Research & K3 Evaluation

Research findings for selecting an optional local Turkish/multilingual offensive-language classifier for `keyflip` (MIT-licensed CLI, zero runtime dependencies in the default package, offline-only inference).

## 1. Selection Criteria

1. **Permissive licence**: compatible with user-initiated downloads for an MIT CLI (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`). Non-commercial, copyleft (`AGPL-3.0`), or use-restricted (`OpenRAIL++`) weights are excluded.
2. **Download size**: under ~500 MB for weights + tokenizer so users can install on demand without bloating the workspace. Weights are stored under `<configDir>/models/profanity/weights/` outside git, never vendored.
3. **Published evaluation metrics**: documented F1 and/or ROC AUC on toxicity / offensive-language benchmarks covering Turkish.
4. **Local Node execution**: ONNX export runnable locally in Node via lazily installed `@huggingface/transformers` (stored under `<configDir>/models/profanity/runtime/`), with `allowRemoteModels = false` at inference time.

## 2. Catalogued Models (Verified on Hugging Face)

All three catalogued models were verified against their Hugging Face API blob metadata and model cards (`README.md` / `eval/this_model.json`).

| Model ID (alias) | Licence | Verified Download Size (ONNX + tokenizer) | Languages | Published Metrics |
|---|---|---|---|---|
| `Horizon-Labs/multilingual-toxicity-small` (`multilingual-toxicity-small`, **default**) | `Apache-2.0` | **~303 MB** (`onnx/model_quantized.onnx` 268.4 MB + `tokenizer.json` 34.4 MB) | 34 languages incl. Turkish (`tr`) | Civil Comments (n=20,000) mean AUC **0.988**, toxicity AUC **0.972**; TextDetox (15 langs, n=1,000 each) AUC **0.835**, F1@0.5 **0.547** |
| `onnx-community/content-safety-guard-small-ONNX` (`content-safety-guard-small`) | `Apache-2.0` | **~176 MB** (`onnx/model_quantized.onnx` 141.5 MB + `tokenizer.json` 34.4 MB) | 25 languages incl. Turkish (`tr`) | PolyGuard prompts F1@0.5 **0.771** (AUC 0.879); PolyGuard responses F1@0.5 **0.709** (AUC 0.944); ToxicChat F1@0.5 **0.776**; TextDetox (14 langs) F1@0.5 **0.646** (AUC 0.814); Aegis `profanity` F1 **0.569** (0.516 @ 0.5, AUC 0.873) |
| `hoan/multilingual-toxic-xlm-roberta-dynamic-quantized` (`multilingual-toxic-xlm-roberta`) | `Apache-2.0` | **~302 MB** (`model_quantized.onnx` 279.4 MB + `tokenizer.json` 17.1 MB + `sentencepiece.bpe.model` 5.1 MB) | 7 languages incl. Turkish (`tr`) | Upstream `unitary/multilingual-toxic-xlm-roberta` Jigsaw Multilingual 2020 validation AUC **0.91655** (no F1 on card); independent TextDetox (15 langs) AUC **0.678**, F1@0.5 **0.352** |

### Per-Model Verification Notes

#### 1. `Horizon-Labs/multilingual-toxicity-small` (Default)
- **Source**: <https://huggingface.co/Horizon-Labs/multilingual-toxicity-small>
- **Base & architecture**: `jhu-clsp/mmBERT-small` (141M parameters), multi-label sigmoid classifier with 7 Detoxify labels (`toxicity`, `severe_toxicity`, `obscene`, `threat`, `insult`, `identity_attack`, `sexual_explicit`).
- **Licence**: `Apache-2.0` (`LICENSE` and YAML frontmatter verified on repo).
- **Files & size**: `onnx/model_quantized.onnx` (268,416,934 bytes) + `tokenizer.json` (34,363,286 bytes) + config files (~303 MB total). Model card notes `model_quantized.onnx` differs from fp32 by 0.0009 on average over 448 test texts.
- **Metrics**: From `eval/this_model.json` and model card: Civil Comments mean AUC `0.988`, toxicity AUC `0.972`; TextDetox 15-language mean AUC `0.835`, `F1 @ 0.5 = 0.547`. Note that the model card explicitly observes that scores for non-English text tend to run lower than for English and recommends tuning the threshold (e.g. around `0.5`) on target data.

#### 2. `onnx-community/content-safety-guard-small-ONNX`
- **Source**: <https://huggingface.co/onnx-community/content-safety-guard-small-ONNX> (ONNX conversion of <https://huggingface.co/Horizon-Labs/content-safety-guard-small>)
- **Base & architecture**: `mmBERT-small` (141M parameters), multi-label safety guardrail (`unsafe` + 15 Aegis 2.0 categories including `profanity`, `harassment`, `hate`).
- **Licence**: `Apache-2.0`.
- **Files & size**: `onnx/model_quantized.onnx` (141,509,564 bytes) + `tokenizer.json` (34,363,287 bytes) + config files (~176 MB total).
- **Metrics**: From model card: PolyGuard prompts `F1@0.5 = 0.771` (AUC `0.879`), PolyGuard responses `F1@0.5 = 0.709` (AUC `0.944`), ToxicChat `F1@0.5 = 0.776` (AUC `0.979`), OpenAI moderation `F1@0.5 = 0.762`, XSTest `F1@0.5 = 0.811`, TextDetox (14 languages) `F1@0.5 = 0.646` (AUC `0.814`), Aegis `profanity` `F1 = 0.569` (`0.516` at 0.5, AUC `0.873`). Over-blocking rate on safe prompts: `0.220` (XSTest), `0.176` (OpenAI moderation), `0.100` (PolyGuard prompts).

#### 3. `hoan/multilingual-toxic-xlm-roberta-dynamic-quantized`
- **Source**: <https://huggingface.co/hoan/multilingual-toxic-xlm-roberta-dynamic-quantized> (dynamic int8 ONNX quantization of <https://huggingface.co/unitary/multilingual-toxic-xlm-roberta>)
- **Base & architecture**: `xlm-roberta-base` fine-tuned on Jigsaw Multilingual Toxic Comment Classification (supports English, French, Spanish, Italian, Portuguese, Turkish, Russian). Uses `LABEL_0`..`LABEL_15` in `config.json` (`LABEL_0` = `toxicity`, `LABEL_4` = `insult`).
- **Licence**: `Apache-2.0`.
- **Files & size**: `model_quantized.onnx` (279,355,898 bytes) + `tokenizer.json` (17,082,820 bytes) + `sentencepiece.bpe.model` (5,069,051 bytes) (~302 MB total).
- **Metrics**: Upstream Detoxify model card reports Jigsaw Multilingual 2020 validation ROC AUC `0.91655` (no F1 reported on card). Independent evaluation in `Horizon-Labs/multilingual-toxicity-small` reports TextDetox 15-language mean ROC AUC `0.678` and `F1 @ 0.5 = 0.352`.

### Choice of Default Model

`Horizon-Labs/multilingual-toxicity-small` is the default (`DEFAULT_MODEL_ID`):
- Compared to `onnx-community/content-safety-guard-small-ONNX`, it specifically targets interpersonal toxicity, obscenity, and insults (Detoxify labels) rather than broad LLM prompt-safety guardrails (weapons, criminal planning, self-harm), which show higher safe-prompt over-blocking (`0.220` on XSTest, `0.176` on OpenAI moderation).
- Compared to `hoan/multilingual-toxic-xlm-roberta-dynamic-quantized`, it provides first-party `@huggingface/transformers`-ready ONNX weights and substantially higher independent TextDetox multilingual AUC (`0.835` vs `0.678`) and F1@0.5 (`0.547` vs `0.352`).

## 3. Evaluated & Rejected Candidates

| Candidate | Licence | Size / Format | Reason Rejected |
|---|---|---|---|
| `Overfit-GM/distilbert-base-turkish-cased-offensive` | `Apache-2.0` | 272 MB (`pytorch_model.bin`) | No ONNX export in repo for Node / `@huggingface/transformers` |
| `atasoglu/turkish-base-bert-uncased-offenseval2020_tr` | `MIT` | 442 MB (`model.safetensors`) | No ONNX export in repo for Node / `@huggingface/transformers` |
| `nanelimon/bert-base-turkish-offensive` | `MIT` | 737 MB (`model.safetensors`) | Exceeds 500 MB limit and has no ONNX export |
| `textdetox/xlmr-large-toxicity-classifier` / `-v2` | `OpenRAIL++` | 2,240 MB (`model.safetensors`) | Non-permissive `OpenRAIL++` licence, exceeds 500 MB, no ONNX export |
| `gravitee-io/distilbert-multilingual-toxicity-classifier` | `OpenRAIL++` | ONNX community copy exists | Non-permissive `OpenRAIL++` licence |
| `MesutAktas/TurkishOffensiveLanguageAnalysis` | `AGPL-3.0` | PyTorch | Copyleft `AGPL-3.0` licence and no ONNX export |
| Local Ollama (`http://localhost:11434`) | N/A | N/A | Keyflip's Ollama integration serves embedding/chat models; no dedicated Turkish offensive-language classifier model is standard in Ollama |

## 4. K3 Real Local Evaluation (30+30 Synthetic Turkish Sentences)

Evaluated `Horizon-Labs/multilingual-toxicity-small` locally via `test/profanity-model-eval.test.js` (`KEYFLIP_TEST_REAL_MODEL=1`, offline inference after installing weights and runtime into a temporary `KEYFLIP_CONFIG_DIR` via `keyflip conv profanity-model install Horizon-Labs/multilingual-toxicity-small --yes`).

Corpus (`test/profanity-model-eval.test.js`):
- **30 clean Turkish sentences** containing innocent look-alike words (`sıkıntı`, `sıkıldım`, `sıkıştım`, `sikke`, `siklon`, `amcamlarla`, `boks`, `bokeh`, `ampul`, `amfide`, etc.) — all untouched by the stage-1 word list (`0/30`).
- **30 synthetic offensive Turkish sentences** missed by the stage-1 word list (`0/30` masked by stage 1).

| Threshold | Clean Passed (TN) | Clean False Positives (FP) | Clean Specificity | Offensive Flagged (TP) | Offensive Missed (FN) | Precision | Recall |
|---|---|---|---|---|---|---|---|
| `0.8` (default `conv.profanityThreshold`) | 30 / 30 | 0 | **1.000** | 0 / 30 | 30 | **1.000** (0 TP, 0 FP) | **0.000** |
| `0.5` (`KEYFLIP_TEST_THRESHOLD=0.5`) | 30 / 30 | 0 | **1.000** | 14 / 30 | 16 | **1.000** (14 TP, 0 FP) | **0.467** |

Observations:
- At both `0.8` and `0.5`, false-positive rate on the 30 clean look-alike sentences is **0 / 30** (zero over-masking).
- Confirming the warning in Horizon Labs' model card (*"Scores for non-English text tend to be lower than for English"*), Turkish insult sentences missed by the word list often score between `0.5` and `0.8`, so setting `keyflip config set conv.profanityThreshold 0.5` recovers `46.7%` of those word-list misses with `100%` precision on this corpus, whereas the conservative default `0.8` avoids false positives completely at the cost of `0 / 30` recall on mild/slang Turkish insults.
