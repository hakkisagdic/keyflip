// Local profanity filter (K1): Turkish-aware case folding, inflected/suffixed stems,
// simple obfuscations (repeats, dots, spaces, digit-for-letter, internal '*'), allow-lists,
// and user overrides at <configDir>/profanity.json.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { tmpdir } from './helpers.js';
import {
  FILE_NAME,
  MASK_TOKEN,
  userListPath,
  createFilter,
  maskProfanity,
  profanitySignature,
} from '../src/profanity.js';

const TURKISH_PROFANITY_CASES = [
  ['bare siktir', 'bu siktir iş', 'bu […] iş'],
  ['bare orospu', 'tam orospu işi', 'tam […] işi'],
  ['bare piç', 'o piç geldi', 'o […] geldi'],
  ['bare göt', 'koca göt var', 'koca […] var'],
  ['bare bok', 'tam bok oldu', 'tam […] oldu'],
  ['bare yarrak', 'ne yarrak iş', 'ne […] iş'],
  ['bare amk', 'bu ne amk ya', 'bu ne […] ya'],
  ['bare aq', 'olmaz aq böyle', 'olmaz […] böyle'],
  ['bare oç', 'tam oç çıktı', 'tam […] çıktı'],
  ['inflected siktirgit', 'hadi siktirgit buradan', 'hadi […] buradan'],
  ['inflected sikeyim', 'böyle işi sikeyim ben', 'böyle işi […] ben'],
  ['inflected sikerim', 'şimdi sikerim ha', 'şimdi […] ha'],
  ['inflected siktiğim', 'bu siktiğim sistem', 'bu […] sistem'],
  ['inflected sikilmiş', 'kod sikilmiş iyice', 'kod […] iyice'],
  ['inflected orospular', 'bütün orospular toplandı', 'bütün […] toplandı'],
  ['inflected piçlik', 'bu piçlik yapılmaz', 'bu […] yapılmaz'],
  ['inflected götüne', 'al götüne sokma', 'al […] sokma'],
  ['inflected boktan', 'çok boktan bir hata', 'çok […] bir hata'],
  ['inflected yavşağın', 'o yavşağın teki', 'o […] teki'],
  ['inflected şerefsizler', 'bu şerefsizler yüzünden', 'bu […] yüzünden'],
  ['inflected gerizekalılar', 'böyle gerizekalılar var', 'böyle […] var'],
  ['uppercase SIKTIR', 'SIKTIR GIT BURADAN', '[…] BURADAN'],
  ['uppercase SİKTİR', 'SİKTİR!', '[…]!'],
  ['uppercase İBNE', 'İBNE HERİF', '[…] HERİF'],
  ['uppercase OR0SPU', 'OR0SPU İŞİ', '[…] İŞİ'],
  ['repeated siiiktir', 'bu siiiktir hata', 'bu […] hata'],
  ['repeated boook', 'tam boook çıktı', 'tam […] çıktı'],
  ['repeated ammmk', 'ne ammmk bu', 'ne […] bu'],
  ['dotted s.i.k.t.i.r', 'bu s.i.k.t.i.r kod', 'bu […] kod'],
  ['dotted a.m.k', 'ne a.m.k ya', 'ne […] ya'],
  ['dotted si.ktir', 'hadi si.ktir ol', 'hadi […] ol'],
  ['spaced s i k t i r', 'o s i k t i r oldu', 'o […] oldu'],
  ['spaced o r o s p u', 'tam o r o s p u', 'tam […]'],
  ['leet s1kt1r', 'hadi s1kt1r ya', 'hadi […] ya'],
  ['leet y4rr4k', 'ne y4rr4k şey', 'ne […] şey'],
  ['leet g0t', 'koca g0t', 'koca […]'],
  ['asterisk s*ktir', 'bu s*ktir şey', 'bu […] şey'],
  ['phrase amına koyayım', 'böyle işin amına koyayım.', 'böyle işin […].'],
  ['phrase piç kurusu', 'tam piç kurusu bu', 'tam […] bu'],
];

test('K1: masks at least 30 Turkish profanity forms (bare, inflected, upper, obfuscated, phrases)', function () {
  assert.ok(TURKISH_PROFANITY_CASES.length >= 30, 'expected >= 30 Turkish profanity cases');
  for (const [label, input, expected] of TURKISH_PROFANITY_CASES) {
    const res = maskProfanity(input, { useUserList: false });
    assert.strictEqual(res.text, expected, label + ': got ' + JSON.stringify(res.text));
    assert.ok(res.count >= 1, label + ': expected count >= 1');
  }
});

const INNOCENT_WORDS = [
  'sıkıntı',
  'sıkıntılar',
  'SIKINTI',
  'sikinti',
  'sıkı',
  'sıkıldım',
  'sıkıcı',
  'sıkıştım',
  'sıklıkla',
  'sıkça',
  'sık',
  'sıktı',
  'sikke',
  'siklon',
  'amaç',
  'amacı',
  'ama',
  'aman',
  'amca',
  'ami',
  'Ankara',
  "Ankara'da",
  'İstanbul',
  'İzmir',
  'Bursa',
  'Antalya',
  'Çanakkale',
  'götürmek',
  'götürdüm',
  'boks',
  'boksör',
  'book',
  'books',
  'bokeh',
  'got',
  'picture',
  'yara',
  'yarar',
  'yarat',
  'yarasa',
  'yarım',
  'Scunthorpe',
  'assistant',
  'classic',
  'shell',
  '5g',
  'd48f71c',
  'index.js',
  '**bold**',
];

test('K1: leaves at least 30 innocent look-alike words and place names untouched', function () {
  assert.ok(INNOCENT_WORDS.length >= 30, 'expected >= 30 innocent look-alike cases');
  for (const word of INNOCENT_WORDS) {
    const sentence = 'Bugün ' + word + ' hakkında konuştuk.';
    const res = maskProfanity(sentence, { useUserList: false });
    assert.strictEqual(res.count, 0, 'false positive on ' + word + ': ' + res.text);
    assert.strictEqual(res.text, sentence, 'mutated innocent word ' + word);
  }
});

test('masks English profanity forms and obfuscations without breaking innocent words', function () {
  const cases = [
    ['fuck this bug', '[…] this bug', 1],
    ['fucking broken build', '[…] broken build', 1],
    ['f.u.c.k that', '[…] that', 1],
    ['f u c k off', '[…] off', 1],
    ['total sh1t show', 'total […] show', 1],
    ['bitch please', '[…] please', 1],
    ['complete asshole move', 'complete […] move', 1],
    ['pure bullshit', 'pure […]', 1],
    ['piece of shit code', '[…] code', 1],
    ['shiitake mushroom cocktail in Scunthorpe', 'shiitake mushroom cocktail in Scunthorpe', 0],
  ];
  for (const [input, expected, count] of cases) {
    const res = maskProfanity(input, { useUserList: false });
    assert.strictEqual(res.text, expected, input);
    assert.strictEqual(res.count, count, input);
  }
  assert.strictEqual(MASK_TOKEN, '[…]');
  assert.strictEqual(FILE_NAME, 'profanity.json');
});

test('preserves surrounding whitespace, punctuation, and empty/non-string inputs', function () {
  assert.deepStrictEqual(maskProfanity('', { useUserList: false }), { text: '', count: 0 });
  assert.deepStrictEqual(maskProfanity(null, { useUserList: false }), { text: '', count: 0 });
  const res = maskProfanity('  "Siktir," dedi!\nVe   gitti. ', { useUserList: false });
  assert.strictEqual(res.text, '  "[…]," dedi!\nVe   gitti. ');
  assert.strictEqual(res.count, 1);
});

test('user profanity.json supports add and allow overrides and updates profanitySignature', function (t) {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const ctx = { configDir: dir };
  assert.strictEqual(userListPath(ctx), path.join(dir, 'profanity.json'));

  const sigOff = profanitySignature(ctx, false);
  assert.strictEqual(sigOff, 'off');
  const sigBase = profanitySignature(ctx, true);
  assert.notStrictEqual(sigBase, 'off');

  // Default masks "piç kurusu" and "bok"; user list adds "zırva" and allows "piç kurusu" + "bok"
  assert.strictEqual(maskProfanity('tam piç kurusu ve zırva', { configDir: dir }).text, 'tam […] ve zırva');

  fs.writeFileSync(
    path.join(dir, 'profanity.json'),
    JSON.stringify({
      add: ['zırva', 'kötü laf'],
      allow: ['piç kurusu', 'bok'],
    }),
  );

  const sigCustom = profanitySignature(ctx, true);
  assert.notStrictEqual(sigCustom, sigBase, 'profanitySignature must reflect user list edits');

  const filter = createFilter({ configDir: dir });
  assert.strictEqual(filter.mask('tam piç kurusu bu').text, 'tam piç kurusu bu');
  assert.strictEqual(filter.mask('bu bok değil').text, 'bu bok değil');
  assert.strictEqual(filter.mask('tam zırva ve kötü laf!').text, 'tam […] ve […]!');

  // Malformed JSON is ignored safely without throwing
  fs.writeFileSync(path.join(dir, 'profanity.json'), '{not-valid-json');
  assert.strictEqual(maskProfanity('bu bok işi', { configDir: dir }).text, 'bu […] işi');
});
