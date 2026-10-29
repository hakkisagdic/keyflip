// The headless-LLM seam used by distill / dream / recall --answer: send an instruction plus a
// (possibly huge) body of text, get the model's prose back.
//
// Two things live here, and the second is the reason this module exists at all:
//
//  1. `claude -p` — shells the Claude Code CLI. Zero-dep, uses whatever account the machine is on,
//     and it WORKS, but every call is billed against that subscription. Dreaming over 40 old
//     transcripts is a background chore; paying Max-plan quota for it is the wrong trade.
//  2. A provider layer — the same call routed to Ollama (local, free) or any OpenAI-compatible
//     endpoint (a gateway on an API key). Selected by config, so `keyflip dream --apply` spends
//     what the user chose, and `keyflip llm` says which that is before the first call.
//
// SECURITY: an endpoint key is NEVER stored by keyflip. `llm.key_env` holds the NAME of an
// environment variable, and the value is read from the process environment at call time only. It
// never appears in a return value, a log line, the state repo, or an error message — the keyflip
// state directory is a git repo, and a committed key is a leaked key.
import { run } from './exec.js';
import http from 'http';
import https from 'https';
import * as config from './config.js';

// Every provider keyflip can route a completion through. `cost` is what the CLI prints BEFORE the
// first call, because "which quota is this burning" is the question a background job must answer.
const PROVIDERS = {
  claude: {
    label: 'claude -p',
    cost: "spends the ACTIVE Claude account's quota",
    needsKey: false,
    model: '', // the CLI's own default model
    baseUrl: '',
  },
  ollama: {
    label: 'ollama',
    cost: 'runs locally — no subscription quota, nothing leaves the machine',
    needsKey: false,
    model: 'qwen2.5:7b-instruct',
    baseUrl: 'http://127.0.0.1:11434/v1',
  },
  openai: {
    label: 'openai-compatible',
    cost: 'spends the ENDPOINT account (keyflip stores only the env var NAME, never the key)',
    needsKey: true,
    model: '',
    baseUrl: '',
  },
};

// Resolve the provider to use. Precedence: explicit opt > KEYFLIP_LLM_* env > config.json — so a
// cron job or a one-off shell can reroute without editing shared state.
function resolve(ctx, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const get = function (key, fallback) {
    if (opts[key] !== undefined && opts[key] !== null && opts[key] !== '') return String(opts[key]);
    return (
      env['KEYFLIP_LLM_' + key.toUpperCase()] ||
      (ctx && ctx.configDir ? String(config.get(ctx, 'llm.' + key) || '') : '') ||
      fallback ||
      ''
    );
  };
  let provider = (
    opts.provider ||
    env.KEYFLIP_LLM_PROVIDER ||
    (ctx && ctx.configDir ? String(config.get(ctx, 'llm.provider') || '') : '') ||
    'claude'
  ).toLowerCase();
  if (!PROVIDERS[provider]) provider = 'claude'; // an unknown/typo provider must not break a command
  const meta = PROVIDERS[provider];
  const model = get('model', meta.model);
  const baseUrl = get('base_url', meta.baseUrl);
  const keyEnv = get('key_env', '');
  return {
    provider: provider,
    model: model,
    baseUrl: baseUrl,
    keyEnv: keyEnv,
    needsKey: meta.needsKey,
    label: meta.label,
    cost: meta.cost,
    // The CLI prints this instead of guessing from the provider name alone.
    display:
      provider +
      (model ? ' ' + model : '') +
      (baseUrl ? ' @ ' + baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : ''),
  };
}

// Is the key present? Presence only — the value is never read into a return value.
function hasKey(p, env) {
  if (!p.needsKey) return true;
  if (!p.keyEnv) return false;
  return !!(env || process.env)[p.keyEnv];
}

// A config-level verdict, without touching the network: is this provider even usable as configured?
// Returns {ok:true} or {ok:false, reason, fix} so callers can `fail()` with an actionable line.
function availability(ctx, opts) {
  const p = resolve(ctx, opts);
  if (p.provider === 'claude') return { ok: true, provider: p };
  if (!p.baseUrl)
    return {
      ok: false,
      provider: p,
      reason: 'no-base-url',
      fix: 'keyflip llm set --base-url https://gateway.example.com/v1 (or --provider ollama for the local default)',
    };
  if (p.needsKey && !p.keyEnv)
    return {
      ok: false,
      provider: p,
      reason: 'no-key-env',
      fix: 'keyflip llm set --key-env MY_KEY_NAME — keyflip stores the NAME, never the key',
    };
  if (p.needsKey && !hasKey(p, opts && opts.env))
    return {
      ok: false,
      provider: p,
      reason: 'key-env-unset',
      fix: 'export ' + p.keyEnv + '=<the key> (keyflip never stores it)',
    };
  return { ok: true, provider: p };
}

// Claude Code on PATH (or, for an HTTP provider, "usable as configured"). Sync, no network.
// `ctx` may be omitted — then this is exactly the pre-provider question, "is `claude` installed?",
// so an old call site keeps its meaning instead of silently guessing a provider.
function available(ctx, opts) {
  opts = opts || {};
  // A bare function argument is the LEGACY shape — available(runner) — so an old call site keeps
  // its meaning instead of being mistaken for a ctx (which would make the runner never run).
  const runner = typeof ctx === 'function' ? ctx : typeof opts.run === 'function' ? opts.run : undefined;
  const c = ctx && typeof ctx === 'object' ? ctx : undefined;
  const a = availability(c && c.configDir ? c : undefined, opts);
  if (!a.ok) return false;
  if (a.provider.provider === 'claude') return claudeInstalled(runner);
  return true;
}

function claudeInstalled(runner) {
  const r = runner || run;
  try {
    // Windows resolves a global npm bin through a `claude.cmd` shim, and Node refuses to spawn a
    // `.cmd` without a shell (CVE-2024-27980), so go through cmd — which also applies PATHEXT.
    if (process.platform === 'win32') {
      const w = r('cmd', ['/c', 'claude', '--version']);
      if (w && w.code === 0) return true;
    }
    const v = r('claude', ['--version']);
    return !!(v && v.code === 0);
  } catch (e) {
    return false;
  }
}

// Zero-dep JSON POST, with the ONE place an endpoint key is ever read. Injectable `post` for tests.
function postJson(url, body, headers, timeoutMs) {
  return new Promise(function (resolve_, reject) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('bad llm URL: ' + url));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const hdrs = Object.assign(
      { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      headers || {},
    );
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: hdrs,
        timeout: timeoutMs || 120000,
      },
      function (res) {
        let b = '';
        res.on('data', function (d) {
          b += d;
          if (b.length > 64 * 1024 * 1024) req.destroy(new Error('llm response too large'));
        });
        res.on('end', function () {
          if (res.statusCode >= 300) {
            // Never echo a server body blindly past a truncation: it can quote the request back,
            // and the request carries the Authorization header.
            return reject(new Error('http ' + res.statusCode + ' from the llm endpoint'));
          }
          try {
            resolve_(JSON.parse(b));
          } catch (e) {
            reject(new Error('llm endpoint returned invalid JSON'));
          }
        });
      },
    );
    req.on('timeout', function () {
      // Phrased so the `error` handler below wraps it once, not twice.
      req.destroy(new Error('timed out after ' + (timeoutMs || 120000) + 'ms'));
    });
    req.on('error', function (e) {
      reject(new Error('llm endpoint unreachable (' + ((e && e.message) || 'error') + ')'));
    });
    req.end(payload);
  });
}

// Pull the prose out of the shapes in the wild: OpenAI chat completions, OpenAI legacy text, and
// Ollama's native /api/generate (which Ollama also returns under /v1 when asked natively).
function extractText(res) {
  if (!res || typeof res !== 'object') return null;
  const choice = Array.isArray(res.choices) ? res.choices[0] : null;
  if (choice) {
    if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
    if (typeof choice.text === 'string') return choice.text;
  }
  if (typeof res.response === 'string') return res.response;
  if (res.message && typeof res.message.content === 'string') return res.message.content;
  return null;
}

async function httpComplete(p, instruction, text, opts) {
  const post = opts.post || postJson;
  const base = String(p.baseUrl).replace(/\/+$/, '');
  const url = /\/(chat\/completions|completions|generate)$/.test(base)
    ? base
    : base + (p.provider === 'ollama' && /\/api$/.test(base) ? '/generate' : '/chat/completions');
  const headers = {};
  if (p.needsKey && p.keyEnv) {
    const v = (opts.env || process.env)[p.keyEnv];
    if (v) headers.authorization = 'Bearer ' + v;
  }
  // OpenAI-style messages; the instruction leads as the system turn so the body is never mistaken
  // for the task. The transcript goes in the user turn, exactly as it went on claude's stdin.
  const body = p.model
    ? {
        model: p.model,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: String(text || '') },
        ],
      }
    : {
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: String(text || '') },
        ],
      };
  try {
    const res = await post(url, body, headers, opts.timeoutMs || 120000);
    const out = String(extractText(res) || '').trim();
    if (!out) return { ok: false, reason: 'empty-output', provider: p.provider, model: p.model };
    return { ok: true, text: out, provider: p.provider, model: p.model, endpoint: url };
  } catch (e) {
    return {
      ok: false,
      reason: 'endpoint-failed',
      detail: String((e && e.message) || e).slice(0, 200),
      provider: p.provider,
      model: p.model,
    };
  }
}

// THE entry point every background/chore caller should use: route through the configured provider
// and always say which one ran. Returns {ok, text, provider, model, cost} or {ok:false, reason, fix}.
async function complete(ctx, instruction, text, opts) {
  opts = opts || {};
  const a = availability(ctx, opts);
  if (!a.ok) return { ok: false, reason: a.reason, fix: a.fix, provider: a.provider.provider };
  const p = a.provider;
  if (p.provider === 'claude') {
    const r = summarize(instruction, text, {
      run: opts.run,
      model: opts.model || p.model || undefined,
      skipCheck: !!opts.skipCheck,
      timeoutMs: opts.timeoutMs,
    });
    return {
      ok: r.ok,
      text: r.text,
      reason: r.reason,
      detail: r.detail,
      provider: 'claude',
      model: p.model,
      cost: p.cost,
    };
  }
  const r = await httpComplete(p, instruction, text, opts);
  return Object.assign({}, r, { cost: p.cost });
}

// Summarize `text` with `instruction` through the Claude Code CLI. Returns { ok:true, text } or
// { ok:false, reason }. NOTE: this spends the ACTIVE account's quota — callers must make that
// explicit and get consent. Runner is injectable for tests. The instruction is a non-secret
// positional arg; the (possibly huge) transcript goes on stdin so it never hits argv limits.
function summarize(instruction, text, opts) {
  opts = opts || {};
  const runner = opts.run || run;
  if (!opts.skipCheck && !claudeInstalled(runner)) return { ok: false, reason: 'claude-not-installed' };
  const args = ['-p', String(instruction)];
  if (opts.model) args.push('--model', String(opts.model));
  const r = runner('claude', args, String(text || ''), { timeoutMs: opts.timeoutMs || 180000 });
  if (!r || r.code !== 0) return { ok: false, reason: 'claude-failed', detail: r && r.stderr };
  const out = String(r.stdout || '').trim();
  if (!out) return { ok: false, reason: 'empty-output' };
  return { ok: true, text: out };
}

export { PROVIDERS, resolve, availability, available, summarize, complete, postJson, extractText, claudeInstalled };
