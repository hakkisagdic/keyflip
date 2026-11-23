// K3 evaluation dataset & optional local model benchmark (skipped unless KEYFLIP_TEST_REAL_MODEL=1).
// 30 clean Turkish sentences with innocent look-alike words + 30 synthetic offensive Turkish
// sentences missed by the word list. Zero real user data or private values.
import test from 'node:test';
import assert from 'node:assert';
import { createFilter, classifyOffensive } from '../src/profanity.js';
import { DEFAULT_MODEL_ID, getInstalledModel, loadLocalClassifier } from '../src/profanity-model.js';

const CLEAN_SENTENCES = [
  'Bugün deployment sırasında küçük bir sıkıntı yaşadık ama hemen çözdük.',
  'Uzun toplantıdan sonra biraz sıkıldım ve kahve almaya çıktım.',
  'Trafikte iyice sıkıştım, ofise on dakika geç kalabilirim.',
  'Müzedeki eski Osmanlı sikke koleksiyonu gerçekten çok etkileyiciydi.',
  'Meteoroloji yarın kıyı kesimlerde güçlü bir siklon bekliyor.',
  'Bu çalışmanın temel amacı performansı ölçülebilir biçimde artırmaktır.',
  'Hafta sonu amcamlarla birlikte bahçedeki ağaçları budadık.',
  'Yarın sabah Ankara trenine binip konferansa yetişeceğim.',
  'İstanbul trafiği sabah saatlerinde her zamanki gibi oldukça yoğundu.',
  'Hazırladığımız raporu müdürün odasına götürmek için dosyaları topladım.',
  'Akşam salonda arkadaşlarla bir saat amatör boks antrenmanı yaptık.',
  'Fotoğraftaki arka plan bokeh efekti sayesinde konu çok net görünüyor.',
  'Düşünce dizinde küçük bir yara açıldı ama pansumanla geçti.',
  'Yeni önbellek katmanının sistem hızına büyük yarar sağladığını gördük.',
  'Yarım saatlik yürüyüşten sonra masa başına dönüp kod yazmaya devam ettim.',
  'Ekipte sıkça karşılaşılan bağlantı hatalarını tek bir belgede topladık.',
  'Kış yaklaşırken evin pencerelerini sıkı bir şekilde yalıttık.',
  'Bu hatayı loglarda sıklıkla görüyoruz, kök nedeni araştırmalıyız.',
  'Yeni ayakkabım ilk gün ayağımı biraz sıktı ama sonra açıldı.',
  'Aman dikkat et, üretim veritabanında yanlış tabloyu silmeyesin.',
  'Amatör fotoğrafçılık kulübü bu ay doğa yürüyüşü düzenliyor.',
  'Acil durum tatbikatında ambulans iki dakika içinde bahçeye ulaştı.',
  'Çalışma odasındaki ampul patlayınca yenisini takmak zorunda kaldım.',
  'Akşamki seminer büyük amfide yapılacağı için erken yer tuttuk.',
  'Geçen ay Bursa şubesindeki ekip ile yeni sürümü planladık.',
  'İzmir sahilinde yürürken eski bir üniversite arkadaşımla karşılaştım.',
  'Yaz tatilini ailece Antalya kıyılarında geçirmeyi planlıyoruz.',
  'Çanakkale gezisinde rehber tarihi olayları çok güzel anlattı.',
  'Genç boksör turnuvadaki tüm rakiplerini yenerek altın madalya kazandı.',
  'Uygulamanın giriş noktası index.js dosyasında tanımlanmıştır.',
];

const OFFENSIVE_MISSED_BY_LIST = [
  'Sen gerçekten beyinsiz bir adamsın, hiçbir şeyi anlamıyorsun.',
  'Bu kadar aptal bir insanla aynı projede çalışmak tam bir işkence.',
  'Salak saçma konuşup durma artık, herkesin sabrını taşırdın.',
  'Ahmak herif, yine bütün sistemi bozmayı başardın.',
  'Ne kadar gerzek bir davranış sergilediğinin farkında bile değilsin.',
  'Hıyar gibi ortada durup işlerin yürümesini engelliyorsun.',
  'Zavallı bir eziksin, başkalarının başarısını kıskanmaktan başka işin yok.',
  'Rezil herif, utanmadan hala insanların yüzüne bakabiliyorsun.',
  'Alçak ve hain bir planla herkesi sırtından vurdun.',
  'Aşağılık bir karaktere sahip olduğunu bugün herkes gördü.',
  'Terbiyesiz ve saygısız tavırlarınla tüm ekibi bezdirdin.',
  'Utanmaz yalancı, söylediğin tek bir kelimeye bile güvenilmez.',
  'Karaktersiz insanlarla muhatap olmaktan gerçekten bıktım.',
  'Yüzsüz gibi bir de üste çıkmaya çalışıyorsun.',
  'Cahil kafanla her konuda ahkam kesmeyi bırak artık.',
  'Senin o boş kafan hiç çalışmıyor galiba.',
  'Senden bir halt olmaz, boşuna insanların vaktini çalma.',
  'Aklını peynir ekmekle yemişsin, bu nasıl bir mantık?',
  'Defol git gözümün önünden, bir daha karşıma çıkma.',
  'Cehenneme kadar yolun var, ne halin varsa gör.',
  'Yaptığın iş çöpten farksız, seni buraya kim aldı?',
  'Sürekli saçma sapan konuşuyorsun, biraz sus da kafamız dinlensin.',
  'İnsan müsveddesi seni, zerre kadar değerin yok.',
  'Manyak mısın nesin, durduk yere millete saldırıyorsun.',
  'Boş yapma ve kes sesini, kimse seni dinlemek istemiyor.',
  'Bütün yalanların batsın, sahtekarlık senin kanına işlemiş.',
  'Küstah herif, haddini bilmeden büyüklerine akıl veriyor.',
  'İkiyüzlü düzenbazın tekisin, kimseye faydan dokunmaz.',
  'Beceriksiz sürüsü, en basit görevi bile elinize yüzünüze bulaştırdınız.',
  'Pislik herif, ortalığı karıştırıp kenara çekiliyorsun.',
];

test('K3 corpus invariant: 30 clean and 30 offensive sentences are untouched by word list', function () {
  assert.strictEqual(CLEAN_SENTENCES.length, 30);
  assert.strictEqual(OFFENSIVE_MISSED_BY_LIST.length, 30);

  const filter = createFilter({ useUserList: false });
  for (const sentence of CLEAN_SENTENCES) {
    const res = filter.mask(sentence);
    assert.strictEqual(res.count, 0, 'word list false positive on clean: ' + sentence);
  }
  for (const sentence of OFFENSIVE_MISSED_BY_LIST) {
    const res = filter.mask(sentence);
    assert.strictEqual(res.count, 0, 'expected word list to miss synthetic sentence: ' + sentence);
  }
});

test(
  'K3 live local model evaluation over 60 synthetic Turkish sentences',
  { skip: process.env.KEYFLIP_TEST_REAL_MODEL !== '1' },
  async function () {
    const modelId = process.env.KEYFLIP_TEST_REAL_MODEL_ID || DEFAULT_MODEL_ID;
    const threshold = process.env.KEYFLIP_TEST_THRESHOLD ? Number(process.env.KEYFLIP_TEST_THRESHOLD) : 0.8;
    const ctx = {};
    const installed = getInstalledModel(ctx, modelId);
    assert.ok(installed, 'model not installed locally: ' + modelId);

    const clf = await loadLocalClassifier(ctx, modelId);
    try {
      const cleanScores = await classifyOffensive(CLEAN_SENTENCES, { classifier: clf });
      const offScores = await classifyOffensive(OFFENSIVE_MISSED_BY_LIST, { classifier: clf });

      const fp = cleanScores.filter((r) => r.score >= threshold).length;
      const tn = CLEAN_SENTENCES.length - fp;
      const tp = offScores.filter((r) => r.score >= threshold).length;
      const fn = OFFENSIVE_MISSED_BY_LIST.length - tp;
      const cleanSpecificity = tn / CLEAN_SENTENCES.length;
      const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
      const recall = tp / OFFENSIVE_MISSED_BY_LIST.length;

      console.log(
        JSON.stringify({
          modelId,
          threshold,
          cleanTotal: CLEAN_SENTENCES.length,
          cleanPassed: tn,
          falsePositives: fp,
          offensiveTotal: OFFENSIVE_MISSED_BY_LIST.length,
          truePositives: tp,
          falseNegatives: fn,
          precision: Number(precision.toFixed(3)),
          recall: Number(recall.toFixed(3)),
          cleanSpecificity: Number(cleanSpecificity.toFixed(3)),
        }),
      );
      assert.strictEqual(cleanScores.length, 30);
      assert.strictEqual(offScores.length, 30);
    } finally {
      if (clf && typeof clf.dispose === 'function') await clf.dispose();
    }
  },
);
