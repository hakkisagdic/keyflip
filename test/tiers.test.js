import test from 'node:test';
import assert from 'node:assert';
import * as tiers from '../src/tiers.js';

test('normalizeTier reads the specific rate-limit string before the generic plan', function () {
  assert.strictEqual(tiers.normalizeTier('max', 'default_claude_max_20x'), 'max20x');
  assert.strictEqual(tiers.normalizeTier('max', 'default_claude_max_5x'), 'max5x');
  assert.strictEqual(tiers.normalizeTier('max', ''), 'max');
  assert.strictEqual(tiers.normalizeTier('pro', null), 'pro');
  assert.strictEqual(tiers.normalizeTier('free', ''), 'free');
  assert.strictEqual(tiers.normalizeTier('team', 'default_claude_team'), 'team');
  assert.strictEqual(tiers.normalizeTier('enterprise', ''), 'enterprise');
  // A future plan name we do not know is NOT guessed into a known tier.
  assert.strictEqual(tiers.normalizeTier('ultra', 'default_claude_ultra'), null);
  assert.strictEqual(tiers.normalizeTier(null, undefined), null);
});

test('fromBlob tolerates junk and reads only the OAuth block', function () {
  assert.strictEqual(tiers.fromBlob('not json'), null);
  assert.strictEqual(tiers.fromBlob(JSON.stringify({})), null);
  assert.strictEqual(tiers.fromBlob(JSON.stringify({ claudeAiOauth: null })), null);
  assert.strictEqual(
    tiers.fromBlob(
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' } }),
    ),
    'max5x',
  );
});

test('resolve: a valid meta override wins over the credential; auto is ignored', function () {
  const blob = JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } });
  const cred = tiers.resolve(blob, null);
  assert.strictEqual(cred.id, 'max20x');
  assert.strictEqual(cred.source, 'credentials');
  assert.strictEqual(cred.known, true);

  const pinned = tiers.resolve(blob, { tier: 'free' });
  assert.strictEqual(pinned.id, 'free');
  assert.strictEqual(pinned.source, 'override');
  assert.strictEqual(pinned.override, 'free');

  const auto = tiers.resolve(blob, { tier: 'auto' });
  assert.strictEqual(auto.id, 'max20x');
  assert.strictEqual(auto.source, 'credentials');

  const unknown = tiers.resolve(null, null);
  assert.strictEqual(unknown.id, null);
  assert.strictEqual(unknown.known, false);
  assert.deepStrictEqual(unknown.families, []);
});

test('familyOf understands Claude ids and ignores everything else', function () {
  assert.strictEqual(tiers.familyOf('claude-opus-4-8'), 'opus');
  assert.strictEqual(tiers.familyOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'sonnet');
  assert.strictEqual(tiers.familyOf('claude-haiku-4-5'), 'haiku');
  assert.strictEqual(tiers.familyOf('gpt-5'), null);
  assert.strictEqual(tiers.familyOf(''), null);
  assert.strictEqual(tiers.familyOf(null), null);
});

test('allows: Free cannot use Opus, every paid plan can, unknown never blocks', function () {
  const free = tiers.resolve(JSON.stringify({ claudeAiOauth: { subscriptionType: 'free' } }));
  const max = tiers.resolve(JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } }));
  const unknown = tiers.resolve(null);

  const f = tiers.allows(free, 'claude-opus-4-8');
  assert.strictEqual(f.allowed, false);
  assert.match(f.reason, /Free plan cannot use opus/);
  assert.strictEqual(tiers.allows(free, 'claude-sonnet-4-5').allowed, true);
  assert.strictEqual(tiers.allows(free, 'claude-haiku-4-5').allowed, true);

  assert.strictEqual(tiers.allows(max, 'claude-opus-4-8').allowed, true);
  assert.strictEqual(tiers.allows(unknown, 'claude-opus-4-8').allowed, true);
  assert.strictEqual(tiers.allows(unknown, 'claude-opus-4-8').known, false);

  // A non-Claude model is not a tier question at all.
  const other = tiers.allows(free, 'gpt-5');
  assert.strictEqual(other.allowed, true);
  assert.strictEqual(other.known, false);
});

test('parseTier accepts aliases and rejects typos', function () {
  assert.strictEqual(tiers.parseTier('Max_20x'), 'max20x');
  assert.strictEqual(tiers.parseTier('20x'), 'max20x');
  assert.strictEqual(tiers.parseTier('5x'), 'max5x');
  assert.strictEqual(tiers.parseTier('basic'), 'free');
  assert.strictEqual(tiers.parseTier('nope'), null);
  assert.strictEqual(tiers.labelOf('max5x'), 'Max 5x');
});

test('applyOverride sets, clears and refuses an unknown tier', function () {
  const meta = { name: 'a', email: 'a@x.com' };
  const set = tiers.applyOverride(meta, 'max');
  assert.strictEqual(set.tier, 'max');
  assert.strictEqual(meta.tier, undefined); // input is never mutated

  const cleared = tiers.applyOverride(set, 'auto');
  assert.strictEqual(cleared.tier, undefined);
  assert.strictEqual(cleared.name, 'a');
  assert.strictEqual(tiers.applyOverride(meta, '').tier, undefined);

  assert.throws(function () {
    tiers.applyOverride(meta, 'ultra');
  }, /unknown tier/);
});
