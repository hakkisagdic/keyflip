import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as api from '../src/apicredits.js';
import { MemoryStore } from '../src/stores/index.js';
import { makeCtx } from './helpers.js';

// Fixed clock: 2026-10-17T12:00:00Z — inside a cycle anchored on the 8th.
const NOW_MS = Date.UTC(2026, 9, 17, 12, 0, 0);
const KEY = 'sk-ant-admin01-hermetic-test-key';

// HERMETIC by default: fetch THROWS so any un-injected network call fails loudly, and every
// status test passes its own MemoryStore so the real Keychain / creds dir is never touched.
function noNet() {
  throw new Error('test attempted a real network call (inject a fetch stub)');
}
function deps(over) {
  return Object.assign(
    {
      now: function () {
        return NOW_MS;
      },
      fetch: noNet,
    },
    over || {},
  );
}
function storeWith(key) {
  const s = new MemoryStore();
  if (key) s.setProfile(api.KEY_PROFILE, key);
  return s;
}
function acct(over) {
  return api.normalizeAccount(Object.assign({ id: 'hakkisagdic', plan: 'max20x', cycleDay: 8 }, over || {}));
}
// One cost-report page shaped like the Admin API answers.
function costPage(rows, more) {
  return {
    data: [{ starting_at: '2026-10-08T00:00:00Z', results: rows }],
    has_more: !!more,
    next_page: more ? 'page-2' : undefined,
  };
}

// ---------------------------------------------------------------------------
// grant / cycle math
// ---------------------------------------------------------------------------
test('grantFor: the plans carry $100 / $200 / unknown, and an explicit grant wins', function () {
  assert.strictEqual(api.grantFor(acct({ plan: 'max5x', grant: null })), 100);
  assert.strictEqual(api.grantFor(acct({ plan: 'max20x', grant: null })), 200);
  assert.strictEqual(api.grantFor(acct({ plan: 'team', grant: 500 })), 500);
  // A team record with no grant cannot come from normalizeAccount, but an older saved one can.
  assert.strictEqual(api.grantFor({ id: 'a', plan: 'team', grant: null }), null);
  assert.strictEqual(api.grantFor(acct({ plan: null, grant: 42 })), 42);
});

test('normalizeAccount: team without a grant is refused, bad ids/plans/days/uuids are refused', function () {
  assert.throws(function () {
    return api.normalizeAccount({ id: 'a', plan: 'team', grant: null });
  }, /grant/);
  assert.throws(function () {
    return api.normalizeAccount({ id: 'bad id!', plan: 'max20x' });
  }, /account id/);
  assert.throws(function () {
    return api.normalizeAccount({ id: 'a', plan: 'pro' });
  }, /plan/);
  assert.throws(function () {
    return api.normalizeAccount({ id: 'a', plan: 'max20x', grant: -1 });
  }, /grant/);
  assert.throws(function () {
    return api.normalizeAccount({ id: 'a', cycleDay: 29 });
  }, /cycle-day/);
  assert.throws(function () {
    return api.normalizeAccount({ id: 'a', orgUuid: 'nope' });
  }, /org uuid/);
  const okAcct = api.normalizeAccount({ id: 'Y_ahoo.mail-1', plan: 'max20x', cycleDay: '8' });
  assert.strictEqual(okAcct.id, 'Y_ahoo.mail-1');
  assert.strictEqual(okAcct.cycleDay, 8);
});

test('cycleBounds: the 8th anchors Oct 8 → Nov 8; before the 8th the cycle started Sep 8', function () {
  const b = api.cycleBounds(acct({}), NOW_MS);
  assert.strictEqual(b.startISO, '2026-10-08T00:00:00.000Z');
  assert.strictEqual(b.resetsISO, '2026-11-08T00:00:00.000Z');
  const early = api.cycleBounds(acct({}), Date.UTC(2026, 9, 5, 1, 0, 0));
  assert.strictEqual(early.startISO, '2026-09-08T00:00:00.000Z');
  assert.strictEqual(early.resetsISO, '2026-10-08T00:00:00.000Z');
  const first = api.cycleBounds(acct({ cycleDay: null }), NOW_MS);
  assert.strictEqual(first.startISO, '2026-10-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// config: metadata only, never a key
// ---------------------------------------------------------------------------
test('config roundtrip: accounts survive a write/read, a missing file is empty, a corrupt one throws', function () {
  const ctx = makeCtx();
  let cfg = api.readConfig(ctx);
  assert.deepStrictEqual(cfg.accounts, []);
  cfg.accounts.push(acct({}));
  api.writeConfig(ctx, cfg);
  const again = api.readConfig(ctx);
  assert.strictEqual(again.accounts.length, 1);
  assert.strictEqual(again.accounts[0].id, 'hakkisagdic');
  fs.writeFileSync(path.join(ctx.configDir, api.CONFIG_FILE), '{ not json');
  assert.throws(function () {
    return api.readConfig(ctx);
  }, SyntaxError);
});

test('addAccount writes no secret anywhere in the metadata file', function () {
  const ctx = makeCtx();
  const cfg = api.readConfig(ctx);
  cfg.accounts.push(acct({}));
  api.writeConfig(ctx, cfg);
  const raw = fs.readFileSync(path.join(ctx.configDir, api.CONFIG_FILE), 'utf8');
  assert.ok(raw.indexOf(KEY) === -1 && raw.indexOf('sk-ant') === -1, 'no key material in api-accounts.json');
});

// ---------------------------------------------------------------------------
// readStatus: the estimate, the headers, and never the key
// ---------------------------------------------------------------------------
test('readStatus ok: grant − spent this cycle, USD rows only, the key stays out of the result', async function () {
  let seen;
  const fakeFetch = async function (url, opts) {
    seen = { url: String(url), headers: opts.headers };
    return {
      ok: true,
      status: 200,
      json: async function () {
        return costPage([
          { amount: '12.345', currency: 'USD' },
          { amount: '99', currency: 'EUR' }, // not the credit's currency: never summed
          { cost_usd: '0.655' }, // the older field name, still a row
        ]);
      },
    };
  };
  const r = await api.readStatus(makeCtx(), acct({}), deps({ fetch: fakeFetch, store: storeWith(KEY) }));
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.grant, 200);
  assert.strictEqual(r.used, 13);
  assert.strictEqual(r.remaining, 187);
  assert.strictEqual(r.usedPct, 6.5);
  assert.strictEqual(seen.url.indexOf('starting_at=2026-10-08T00%3A00%3A00.000Z') !== -1, true, seen.url);
  assert.strictEqual(seen.url.indexOf('ending_at=2026-11-08T00%3A00%3A00.000Z') !== -1, true, seen.url);
  assert.strictEqual(seen.url.indexOf('bucket_width=1d') !== -1, true, seen.url);
  assert.strictEqual(seen.headers['x-api-key'], KEY);
  assert.strictEqual(JSON.stringify(r).indexOf(KEY) === -1, true, 'the key must never appear in a result');
});

test('readStatus follows has_more/next_page', async function () {
  let pages = 0;
  const fakeFetch = async function () {
    pages++;
    const first = pages === 1;
    return {
      ok: true,
      status: 200,
      json: async function () {
        return first ? costPage([{ amount: '10' }], true) : costPage([{ amount: '5' }], false);
      },
    };
  };
  const r = await api.readStatus(makeCtx(), acct({}), deps({ fetch: fakeFetch, store: storeWith(KEY) }));
  assert.strictEqual(pages, 2);
  assert.strictEqual(r.used, 15);
});

test('readStatus degrades without throwing: no key, non-admin key, 401, network error, wrong shape', async function () {
  let r = await api.readStatus(makeCtx(), acct({}), deps({ store: storeWith(null) }));
  assert.strictEqual(r.status, 'no-key');
  r = await api.readStatus(makeCtx(), acct({}), deps({ store: storeWith('sk-ant-api03-not-admin') }));
  assert.strictEqual(r.status, 'unknown');
  assert.ok(/not an Admin API key/.test(r.error));
  r = await api.readStatus(
    makeCtx(),
    acct({}),
    deps({
      store: storeWith(KEY),
      fetch: async function () {
        return {
          ok: false,
          status: 401,
          json: async function () {
            return {};
          },
        };
      },
    }),
  );
  assert.strictEqual(r.status, 'unauthenticated');
  r = await api.readStatus(
    makeCtx(),
    acct({}),
    deps({
      store: storeWith(KEY),
      fetch: async function () {
        throw new Error('EAI_AGAIN');
      },
    }),
  );
  assert.strictEqual(r.status, 'unknown');
  assert.ok(/network: EAI_AGAIN/.test(r.error));
  assert.strictEqual(r.error.indexOf(KEY) === -1, true, 'no key in the error');
  r = await api.readStatus(
    makeCtx(),
    acct({}),
    deps({
      store: storeWith(KEY),
      fetch: async function () {
        return {
          ok: true,
          status: 200,
          json: async function () {
            return { surprise: 1 };
          },
        };
      },
    }),
  );
  assert.strictEqual(r.status, 'unknown');
  assert.ok(/unexpected response shape/.test(r.error));
});

test('readStatus: a team account with no saved grant is asked for one before any network call', async function () {
  const r = await api.readStatus(
    makeCtx(),
    { id: 'hakkisagdic', plan: 'team', grant: null, cycleDay: 8 },
    deps({ store: storeWith(KEY) }),
  );
  assert.strictEqual(r.status, 'grant-unknown');
  assert.ok(/--grant/.test(r.error));
});

// ---------------------------------------------------------------------------
// listOrgs
// ---------------------------------------------------------------------------
test('listOrgs: maps id+name, keeps errors shaped and key-free', async function () {
  const fakeFetch = async function (url, opts) {
    assert.ok(String(url).indexOf('/v1/organizations') !== -1, String(url));
    assert.strictEqual(opts.headers['x-api-key'], KEY);
    return {
      ok: true,
      status: 200,
      json: async function () {
        return { data: [{ id: 'org_a', name: 'Hakkı' }, { id: 'org_b' }] };
      },
    };
  };
  let r = await api.listOrgs(makeCtx(), 'a', deps({ fetch: fakeFetch, store: storeWith(KEY) }));
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.orgs, [
    { id: 'org_a', name: 'Hakkı' },
    { id: 'org_b', name: undefined },
  ]);
  r = await api.listOrgs(makeCtx(), 'a', deps({ store: storeWith(null) }));
  assert.strictEqual(r.status, 'no-key');
  assert.ok(/api add/.test(r.error));
});

// ---------------------------------------------------------------------------
// Manual mode (individual orgs have no Admin API — the readings are the balance)
// ---------------------------------------------------------------------------
test('appendEntry: rounds, stamps, chains prev, caps at 200, refuses garbage', function () {
  const ctx = makeCtx();
  const cfg = api.readConfig(ctx);
  const a = acct({});
  let r = api.appendEntry(ctx, cfg, a, 200, NOW_MS);
  assert.strictEqual(r.entry.usd, 200);
  assert.strictEqual(r.prev, null);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.entry.at));
  r = api.appendEntry(ctx, cfg, a, 137.256, NOW_MS + 60000);
  assert.strictEqual(r.entry.usd, 137.26); // rounded to cents
  assert.strictEqual(r.prev.usd, 200);
  // the written account carries the entries and the config still holds no secret material
  const back = api.accountById(api.readConfig(ctx), 'hakkisagdic');
  assert.strictEqual(back.entries.length, 2);
  assert.ok(!/sk-ant/.test(fs.readFileSync(api.configPath(ctx), 'utf8')));
  for (let i = 0; i < 210; i++) api.appendEntry(ctx, cfg, a, 100 + i, NOW_MS + i * 1000);
  assert.strictEqual(api.accountById(api.readConfig(ctx), 'hakkisagdic').entries.length, 200);
  assert.throws(function () {
    api.appendEntry(ctx, cfg, a, -5, NOW_MS);
  }, /balance must be a USD number/);
});

test('readStatus manual: the last reading is the balance, the trend spans the last two', async function () {
  const ctx = makeCtx();
  const cfg = api.readConfig(ctx);
  const a = acct({});
  api.appendEntry(ctx, cfg, a, 200, NOW_MS - 86400000);
  api.appendEntry(ctx, cfg, a, 162.58, NOW_MS);
  const r = await api.readStatus(makeCtx(), acct({ entries: a.entries }), deps({ store: storeWith(null) }));
  assert.strictEqual(r.status, 'manual');
  assert.strictEqual(r.balanceUsd, 162.58);
  assert.strictEqual(r.remaining, 162.58);
  assert.strictEqual(r.used, 37.42);
  assert.strictEqual(r.usedPct, 18.7);
  assert.strictEqual(r.trendUsd, -37.42);
  assert.strictEqual(r.entriesCount, 2);
  assert.strictEqual(r.resetsISO, '2026-11-08T00:00:00.000Z');
  assert.ok(/last reading/.test(r.error) && /entered by hand/.test(r.error));
  assert.ok(!/sk-ant/.test(JSON.stringify(r)));
});

test('readStatus manual needs no network and works with an unknown grant (balance only)', async function () {
  const a = acct({ plan: null, entries: [{ at: '2026-10-17T10:00:00.000Z', usd: 50 }] });
  const r = await api.readStatus(makeCtx(), a, deps({}));
  assert.strictEqual(r.status, 'manual');
  assert.strictEqual(r.remaining, 50);
  assert.strictEqual(r.used, null);
  assert.strictEqual(r.usedPct, null);
  assert.ok(!('trendUsd' in r));
});

test('readStatus with neither a key nor any readings still teaches the api set route', async function () {
  const r = await api.readStatus(makeCtx(), acct({}), deps({ store: storeWith(null) }));
  assert.strictEqual(r.status, 'no-key');
  assert.ok(/api set/.test(r.error));
});

test('manualStatus: false when there are no entries, so --offline stays shaped', function () {
  const out = { resetsISO: '2026-11-08T00:00:00.000Z', status: 'offline', error: null };
  assert.strictEqual(api.manualStatus(acct({}), out), false);
  assert.strictEqual(out.status, 'offline');
  const a = acct({ entries: [{ at: '2026-10-17T10:00:00.000Z', usd: 137.2 }] });
  assert.strictEqual(api.manualStatus(a, out), true);
  assert.strictEqual(out.status, 'manual');
  assert.strictEqual(out.balanceUsd, 137.2);
});
