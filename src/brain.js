// brain.js — an OPT-IN, SUGGEST+APPROVE planner. It turns a natural-language
// intent into a VALIDATED PLAN of keyflip commands and PROPOSES it to the CALLER
// (the CLI), which is the ONLY thing that ever approves + executes. This module
// has NO code path that runs a keyflip command, spawns a process, or invokes any
// tool.run — it is pure suggestion.
//
// SECURITY MODEL (load-bearing):
//   1. OFF BY DEFAULT. Nothing happens unless BOTH process.env.KEYFLIP_BRAIN is
//      enabled ("1"/"true"/"on") AND an API key is present (env GEMINI_API_KEY or
//      an injected deps.apiKey). enabled(ctx, deps) -> bool.
//   2. PROPOSE ONLY. We return a plan; we never execute it. No require of
//      cli.js / mcp.js run paths.
//   3. SECRET NON-LEAK. The ONLY thing sent to Gemini is the intent + the command
//      CATALOG (names/desc — already non-secret) + caller-provided state, ALL run
//      through secretscan first (redactOutbound). The API key rides ONLY the
//      request URL/header — never a log, never the returned plan, never echoed.
//   4. PLAN VALIDATION. Model output is UNTRUSTED: parsed defensively, and only
//      steps whose command is a REAL catalog entry survive. Each kept step is
//      marked mutating = (entry.safe !== true). The plan is capped. Junk / prose /
//      no-JSON -> { ok:false, reason } — never a throw.

import * as secretscan from './secretscan.js';
import * as _commands from './commands.js';

// Hard cap on how many steps a proposed plan may contain. A hostile model that
// returns a 10k-step plan is truncated to this.
const MAX_STEPS = 12;
const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_TIMEOUT_MS = 20000;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ---- env gate ----------------------------------------------------------------
// Same "1"/"true"/"on" pattern as license.enforcementEnabled().
function envOn(v) {
  return v === '1' || v === 'true' || v === 'on';
}

// The API key comes from an injected dep first (tests), then the environment.
// It is read here and NEVER stored on any returned object.
function resolveApiKey(deps) {
  deps = deps || {};
  if (typeof deps.apiKey === 'string' && deps.apiKey.trim()) return deps.apiKey.trim();
  const env = process.env.GEMINI_API_KEY;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return null;
}

// enabled(ctx, deps) -> bool. Requires BOTH the env gate AND a present key.
function enabled(ctx, deps) {
  if (!envOn(process.env.KEYFLIP_BRAIN)) return false;
  return resolveApiKey(deps) != null;
}

// ---- outbound scrubbing ------------------------------------------------------
// redactOutbound(obj|string) -> a scrubbed COPY safe to send to Gemini. Objects
// are round-tripped through secretscan.redactJson (deep key+shape redaction);
// strings are scanned and any secret-shaped token is replaced with REDACTED.
function redactOutbound(input) {
  if (input == null) return input;
  if (typeof input === 'string') {
    // A string that is actually serialized JSON must get the SAME key-name-aware scrub as an object
    // (redactJson catches a non-shape secret under a `password`/`token` key — the shape scan alone
    // would miss it and POST it to Gemini). Only genuinely free-form text falls back to shape scrub.
    const trimmed = input.trim();
    if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
      const red = secretscan.redactJson(input);
      if (red && typeof red.text === 'string') return red.text;
    }
    let out = input;
    secretscan.SECRET_PATTERNS.forEach(function (p) {
      out = out.replace(new RegExp(p.re.source, 'g'), secretscan.REDACTED);
    });
    return out;
  }
  // Object / array: JSON round-trip through the deep redactor. If it somehow
  // isn't JSON-serializable, fail closed to an empty object rather than leak.
  let text;
  try {
    text = JSON.stringify(input);
  } catch (e) {
    return {};
  }
  const red = secretscan.redactJson(text);
  if (!red) return {};
  try {
    return JSON.parse(red.text);
  } catch (e) {
    return {};
  }
}

// ---- catalog access ----------------------------------------------------------
function resolveCatalog(deps) {
  deps = deps || {};
  if (deps.catalog && typeof deps.catalog.get === 'function') return deps.catalog;
  return _commands;
}

// A compact, non-secret view of the catalog for the prompt: name + safe + desc.
// (No usage strings — names + descriptions are enough for planning and keep the
// payload small.)
function catalogForPrompt(catalog) {
  const list = Array.isArray(catalog.CATALOG) ? catalog.CATALOG : [];
  return list.map(function (e) {
    return { command: e.name, safe: e.safe === true, group: e.group, desc: e.desc };
  });
}

// ---- prompt ------------------------------------------------------------------
function buildPrompt(intent, catalogView, state) {
  const sys = [
    'You are a planner for the keyflip CLI. Given a user intent, produce a short',
    'ordered plan of keyflip commands drawn ONLY from the provided catalog.',
    'You MUST reply with STRICT JSON and nothing else, in exactly this shape:',
    '{"plan":[{"command":"<catalog command name>","args":"<optional arg string>","rationale":"<why>"}]}',
    'Rules: use ONLY command names that appear in the catalog; never invent a',
    'command; prefer the fewest steps; put read-only/status steps before mutating',
    'ones; do NOT include secrets, tokens, or credentials in any field.',
  ].join(' ');
  const payload = {
    intent: intent,
    catalog: catalogView,
    state: state == null ? null : state,
  };
  return sys + '\n\nINPUT:\n' + JSON.stringify(payload);
}

// ---- robust JSON extraction --------------------------------------------------
// Pull the FIRST balanced {...} object out of arbitrary model text and parse it.
// Returns the parsed value or null (never throws). Brace-matching is
// string/escape aware so a `}` inside a JSON string doesn't end the object early.
function extractFirstJsonObject(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

// ---- Gemini adapter (zero-dep REST) ------------------------------------------
// callGemini(apiKey, prompt, deps) -> parsed model JSON object | null. Fails
// CLOSED: any non-200, timeout, thrown error, or malformed body returns null and
// NEVER throws. deps.fetch is injected (tests never hit the network).
async function callGemini(apiKey, prompt, deps) {
  deps = deps || {};
  const fetchFn = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchFn !== 'function') return null;
  const model = typeof deps.model === 'string' && deps.model.trim() ? deps.model.trim() : DEFAULT_MODEL;
  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };

  // Optional timeout via AbortController, when available.
  let signal, timer;
  const timeoutMs = typeof deps.timeoutMs === 'number' ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (typeof AbortController === 'function' && timeoutMs > 0) {
    const ac = new AbortController();
    signal = ac.signal;
    timer = setTimeout(function () {
      try {
        ac.abort();
      } catch (e) {
        /* noop */
      }
    }, timeoutMs);
  }

  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal,
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    return null; // network error / timeout / abort
  }
  if (timer) clearTimeout(timer);

  try {
    if (!res || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) return null;
    const data = typeof res.json === 'function' ? await res.json() : null;
    if (!data || typeof data !== 'object') return null;
    // Gemini shape: candidates[0].content.parts[].text
    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : null;
    if (!parts) return null;
    let text = '';
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] && typeof parts[i].text === 'string') text += parts[i].text;
    }
    if (!text) return null;
    return extractFirstJsonObject(text);
  } catch (e) {
    return null;
  }
}

// ---- plan validation ---------------------------------------------------------
// Turn the UNTRUSTED model object into a validated plan. Keeps ONLY steps whose
// command is a real catalog entry; everything else is dropped (recorded in
// `dropped`). Each kept step is marked safe/mutating from the catalog, NOT from
// anything the model claimed. Caps the plan at MAX_STEPS.
function validatePlan(modelObj, catalog) {
  const plan = [];
  const dropped = [];
  const rawSteps = modelObj && Array.isArray(modelObj.plan) ? modelObj.plan : null;
  if (!rawSteps) return { plan: plan, dropped: dropped, hadArray: false };

  for (let i = 0; i < rawSteps.length && plan.length < MAX_STEPS; i++) {
    const step = rawSteps[i];
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      dropped.push('<non-object step>');
      continue;
    }
    const name = typeof step.command === 'string' ? step.command : '';
    const entry = catalog.get(name); // null-proto safe; unknown/inherited -> null
    if (!entry) {
      dropped.push(name || '<missing command>');
      continue;
    }
    const kept = {
      command: entry.name,
      rationale: typeof step.rationale === 'string' ? step.rationale : '',
    };
    if (typeof step.args === 'string' && step.args.length) kept.args = step.args;
    else if (step.args != null && typeof step.args !== 'object') kept.args = String(step.args);
    // The catalog's `safe` flag holds ONLY for the bare, NO-ARG form of a command — many safe
    // entries (cache, config, budget, route, sessions, policy, checkpoint…) have MUTATING
    // subcommands. So a step is safe only if the catalog marks it safe AND the model attached no
    // args; any args at all force it to be treated as mutating (needing explicit approval).
    kept.safe = entry.safe === true && kept.args == null;
    kept.mutating = !kept.safe;
    plan.push(kept);
  }
  // Note any steps beyond the cap as dropped (for transparency).
  if (rawSteps.length > MAX_STEPS) {
    for (let j = MAX_STEPS; j < rawSteps.length; j++) {
      const s = rawSteps[j];
      const nm = s && typeof s.command === 'string' ? s.command : '<over-cap step>';
      dropped.push(nm);
    }
  }
  return { plan: plan, dropped: dropped, hadArray: true };
}

// ---- propose -----------------------------------------------------------------
// propose(ctx, intent, deps) -> {
//   ok, enabled, plan:[{command,args?,rationale,mutating,safe}], dropped?, reason?
// }. Never throws. When disabled, returns immediately without any network call.
async function propose(ctx, intent, deps) {
  deps = deps || {};
  const isOn = enabled(ctx, deps);
  if (!isOn) {
    return { ok: false, enabled: false, plan: [], reason: 'brain-disabled' };
  }
  if (typeof intent !== 'string' || !intent.trim()) {
    return { ok: false, enabled: true, plan: [], reason: 'empty-intent' };
  }

  const apiKey = resolveApiKey(deps); // used ONLY for the request; never returned
  const catalog = resolveCatalog(deps);

  // Scrub EVERYTHING outbound. The intent is user text; state is caller-provided;
  // the catalog view is non-secret but we scrub it too for defense in depth.
  const safeIntent = redactOutbound(intent);
  const safeState = deps.state != null ? redactOutbound(deps.state) : null;
  const safeCatalog = redactOutbound(catalogForPrompt(catalog));
  const prompt = buildPrompt(safeIntent, safeCatalog, safeState);

  let modelObj;
  try {
    modelObj = await callGemini(apiKey, prompt, deps);
  } catch (e) {
    // callGemini is already fail-closed, but belt-and-suspenders: never throw.
    modelObj = null;
  }
  if (!modelObj) {
    return { ok: false, enabled: true, plan: [], reason: 'model-unavailable' };
  }

  const v = validatePlan(modelObj, catalog);
  if (!v.hadArray) {
    return { ok: false, enabled: true, plan: [], reason: 'no-plan-in-output' };
  }
  if (!v.plan.length) {
    return { ok: false, enabled: true, plan: [], dropped: v.dropped, reason: 'no-valid-steps' };
  }
  const out = { ok: true, enabled: true, plan: v.plan };
  if (v.dropped.length) out.dropped = v.dropped;
  return out;
}

// ---- formatPlan --------------------------------------------------------------
// A small human-readable rendering for the CLI to show before approval. Contains
// NO secrets (it only reads the already-validated plan) and NO api key.
function formatPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return '(no steps)';
  const lines = plan.map(function (step, i) {
    const tag = step.mutating ? '[mutating]' : '[safe]';
    const args = typeof step.args === 'string' && step.args.length ? ' ' + step.args : '';
    let line = i + 1 + '. ' + tag + ' keyflip ' + step.command + args;
    if (step.rationale) line += '\n     ↳ ' + step.rationale;
    return line;
  });
  return lines.join('\n');
}

export {
  enabled,
  propose,
  redactOutbound,
  formatPlan,
  callGemini,
  validatePlan,
  extractFirstJsonObject,
  MAX_STEPS,
  DEFAULT_MODEL,
};
