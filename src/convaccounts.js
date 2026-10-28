// @ts-check
// WHICH ACCOUNT WORKED ON THIS CONVERSATION?
//
// The conversation index knows WHICH tool a chat came from and WHEN it was written. It did not
// know WHICH ACCOUNT — and on a machine with two accounts per surface that is the first
// question: "which of my two Kiro accounts wrote this?"
//
// Two answers, in this order:
//   1. STATED — the user said so. `keyflip sessions assign <session> <account>` writes it into
//      the live assignment map, and a stated assignment is never overwritten by a guess.
//   2. INFERRED — keyflip's own action log. `active -> <profile>` (Claude), `kiro -> <slug>`
//      and `codex -> <slug>` are the switch boundaries; a conversation's life span
//      [createdAt, updatedAt] falls inside one account's window, and the account that held
//      most of that time is the answer.
//
// The guess is always LABELLED. `source` says it is an inference and not the user's word;
// `confidence` says how sure it is (high = the whole visible life sits inside one account's
// window, medium = the opening is older than the log, low = the conversation spans a switch);
// `why` says which window it landed in. A tool keyflip does not manage (Qoder, Gemini) has no
// account here — `account` stays null rather than being filled with a name that means nothing
// for that tool.
import * as attrib from './attrib.js';
import * as sessionmap from './sessionmap.js';
import * as profiles from './profiles.js';
import * as kiro from './kiro.js';
import * as codex from './codex.js';

// Which keyflip-managed surface owns an app's conversations. `claude` is the Claude Code
// transcript store (the claude.ai cloud chats live in `keyflip chat`, not here).
const SURFACE_OF_APP = {
  claude: 'claude',
  codex: 'codex',
  kiro: 'kiro',
};

function surfaceOf(conv) {
  const app = String((conv && conv.app) || '').toLowerCase();
  return SURFACE_OF_APP[app] || null;
}

// The session id inside a conversation id: `claude:local:<sessionId>` → `<sessionId>`. Only
// Claude Code sessions can be STATED: the assignment map is keyed by the Claude Code session
// id, and a Kiro/Codex conversation has no such id to point at.
function sessionIdOf(conv) {
  const m = /^claude:local:(.+)$/.exec(String((conv && conv.id) || ''));
  return m ? m[1] : null;
}

function none(why) {
  return { account: null, source: null, confidence: null, why: why };
}

// The account the SOURCE itself names. A claude.ai cloud chat knows the cookie that owns it,
// so it is not a guess and the timeline must never overrule it.
//
// On a freshly parsed conversation `account` holds that value and `accountSource` is not set
// yet. On a STORED manifest row `account` holds the PREVIOUS pass's answer and `accountSource`
// IS set — so reading `account` there would relabel an inference as the user's word on the
// second build. The parser's value is therefore kept separately, as `parserAccount`.
function parserAccountOf(conv) {
  if (!conv) return null;
  if (conv.parserAccount != null) return String(conv.parserAccount);
  if (conv.accountSource === undefined && conv.account) return String(conv.account);
  return null;
}

// The accounts that still exist. An account that was deleted must not be named: the timeline
// remembers the switch, but the credentials it pointed at are gone.
function knownAccounts(ctx) {
  const out = { claude: {}, kiro: {}, codex: {} };
  try {
    profiles.list(ctx.configDir).forEach(function (n) {
      out.claude[n] = true;
    });
  } catch (e) {
    /* no profiles yet */
  }
  try {
    kiro.listAccounts(ctx).forEach(function (a) {
      out.kiro[a.name] = true;
    });
  } catch (e) {
    /* no kiro accounts yet */
  }
  try {
    codex.listCaptures(ctx).forEach(function (c) {
      out.codex[c.slug] = true;
    });
  } catch (e) {
    /* no codex captures yet */
  }
  return out;
}

// One attributor for one run: the timelines and the account lists are read ONCE, because the
// index build asks about ~1900 conversations and re-reading the log for each of them would
// turn a seconds-long pass into minutes.
function attributor(ctx) {
  const timelines = {
    claude: attrib.timeline(ctx),
    kiro: attrib.surfaceTimeline(ctx, 'kiro'),
    codex: attrib.surfaceTimeline(ctx, 'codex'),
  };
  const known = knownAccounts(ctx);
  const assigned = sessionmap.read(ctx);

  function accountOf(conv) {
    // The source names the account itself → that is the user's own fact, not a guess.
    const parser = parserAccountOf(conv);
    if (parser) {
      return {
        account: parser,
        source: 'stated',
        confidence: 'high',
        why: 'the source itself names this account',
      };
    }

    const surface = surfaceOf(conv);
    if (!surface) return none('keyflip does not manage accounts for ' + (conv && conv.app ? conv.app : 'this tool'));

    const sid = sessionIdOf(conv);
    if (sid && assigned[sid]) {
      return {
        account: assigned[sid],
        source: 'stated',
        confidence: 'high',
        why: 'assigned by hand (keyflip sessions assign)',
      };
    }

    const tl = timelines[surface];
    if (!tl || !tl.boundaries.length) {
      return none('the action log holds no ' + surface + ' switch yet');
    }
    const end = Date.parse(String((conv && conv.updatedAt) || ''));
    if (Number.isNaN(end)) return none('the conversation carries no timestamp to place it on the timeline');
    const startedRaw = Date.parse(String((conv && conv.createdAt) || ''));
    const v = attrib.verdict(tl, {
      mtimeMs: end,
      startedAtMs: Number.isNaN(startedRaw) ? null : startedRaw,
    });
    if (!v.account) return none(v.why);
    if (!known[surface][v.account]) {
      return none('the account it points at (' + v.account + ') is no longer saved');
    }
    return { account: v.account, source: 'inferred', confidence: v.confidence, why: v.why };
  }

  // The manifest fields. The explanation is NOT stored: it is derived from the timeline and
  // would have to be rewritten for every row on every pass. `conv show` recomputes it.
  function fields(conv) {
    const a = accountOf(conv);
    return {
      account: a.account || null,
      accountSource: a.account ? a.source : null,
      accountConfidence: a.account ? a.confidence : null,
    };
  }

  return { accountOf: accountOf, fields: fields, timelines: timelines };
}

// The account of a conversation, with the reason — the read-only answer `conv show` prints.
function explain(ctx, conv) {
  return attributor(ctx).accountOf(conv);
}

export { attributor, explain, surfaceOf, sessionIdOf, parserAccountOf, SURFACE_OF_APP };
