# 20261117-keyflip-migrate-v3: Taşıma kabı v3 ve sözleşme bayrakları

## Bugün ne var
- `src/migrate-stream.js` (640 satır): kap v2 (`KEYFLIP-MIGRATE-STREAM/2`), AES-256-GCM kayıt başına, zincirli AAD
  (önceki tag + seq), `scryptSync(pass, salt, 32)` varsayılan N=2^14, başlıkta parametre yok. `writeBundle`/`importBundle`
  kap mantığı ile keyflip içeriği (meta, `tx`/`chunk`/`tx-end`, `TranscriptSink`, `applyBundle`) iç içe.
- Başlık kimliklendirilmemiş (kayıt 0 AAD'si 16 sıfır bayt). `fromHome`/`fromUser` hiç yok.
- Parola verilse bile düz (şifresiz) paket içe alınır (düşürme saldırısı). `--require-encrypted`, `--bundle-id`,
  `--expect-bundle-id`, `--dry-run` yok. `migrate manifest` / `migrate doctor` yok (`src/cli.js` ~5236-5450).
- `src/backup.js` yalnız gizli olmayan üstveri yedekler (`secretpaths` ile kimlik bilgilerini ATLAR); içe aktarımda dosya
  yedeği yok (yalnız WebDAV pull yedekler).
- Testler: `test/migrate-stream.test.js`, `migrate-cli.test.js`, `migrate.test.js`, `transfer.test.js`, `fleet*.test.js`.
  `transfer.js` kabı `migrate-stream` üzerinden kullanıyor (davranış değişmeyecek).

## Ne değişecek
1. Yeni `src/migrate-container.js`: yalnız Node yerleşikleri, keyflip importu yok. Satır okuma, v2/v3 başlık, KDF,
   kayıt şifreleme/çözme, sıra/seq/zincir, `blob-start{name,bytes,sha256}`/`chunk`/`blob-end`, `end` toplamları.
   Başka araçlar dosyayı bayt bayt kopyalar; `migrate-stream.js` bunu kullanır (keyflip kayıt türleri orada kalır).
2. v3: sihirli satır `/3`; başlık `kdf{name:'scrypt',N:131072,r:8,p:1}`, `bundleId`, `tool`, `toolVersion`, `createdAt`;
   scrypt `maxmem` 256 MiB; `fromHome`/`fromUser` ilk şifreli kayda; AAD(0)=SHA-256(sihir+"\n"+başlık satırı).
   Okuyucu v2+v3 kabul eder, v3'te N dışı 2^15..2^20 ret; yazıcı yalnız v3.
3. `src/cli.js`: içe aktarımda parola varken düz paket ret, `--require-encrypted` ile her zaman ret; `export --bundle-id`;
   `import --expect-bundle-id`; `import --dry-run` (yalnız isimler: hesap, sağlayıcı, bellek dosyası, ayar, MCP,
   transkript sayısı; new/exists-kept/conflict); dosya içe aktarımında ilk yazıdan önce yedek, yolu yazdırılır.
4. `keyflip migrate manifest [--json]`, `keyflip migrate doctor` (isim, var/yok, uzunluk). Çıkış kodları 0/2/3/4/5.
5. `test/vectors/container-v3/`: valid, flipped-record, flipped-header, truncated, plaintext, N=2^14 (uydurma parola).

## Kabul kontrolleri
- K1: Given geçici HOME, when `keyflip migrate export b --passphrase-file p`, then `head -1 b` = `KEYFLIP-MIGRATE-STREAM/3`,
  2. satırda `kdf.N=131072`, `bundleId`, `tool`, `toolVersion` var; `fromHome`/`fromUser` başlıkta YOK (`grep` boş).
- K2: Given v2 paketler (mevcut test fikstürleri), when içe aktarım, then başarılı (eski testler yeşil).
- K3: Given `test/vectors/container-v3/`, when her vektör okunur, then valid=0; flipped-record, flipped-header,
  truncated, plaintext, N=2^14 = çıkış 3 ve hedef HOME değişmemiş (önce/sonra dosya özeti eşit).
- K4: Given şifresiz paket, when `import --passphrase-file p`, then çıkış 3; ve `--require-encrypted` ile parolasız da 3.
- K5: Given `export --bundle-id A`, when `import --expect-bundle-id B`, then çıkış 3, hedef değişmedi; `A` ile 0.
- K6: Given `import --dry-run`, then yalnız isimler + new/exists-kept/conflict basılır, hedefte hiçbir dosya yazılmaz;
  çakışma varsa çıkış 4.
- K7: Given dolu hedef HOME, when gerçek import, then ilk yazıdan önce yedek dizini (0700) oluşur, yolu basılır,
  içinde dokunulacak dosyalar (kimlik bilgisi dosyaları dahil) vardır.
- K8: Given `manifest --json` ve `doctor`, then isim/var-yok/uzunluk basılır; değer yok; geçici anahtarlıkla çalışır.
- K9: Given canary sır (`CANARY-<uuid>`) içeren fikstür, when export+import+dry-run+doctor, then stdout, stderr, günlük
  ve paket dosyasında canary (düz, base64, hex) 0 kez geçer.
- K10: Given parola yalnız `/dev/fd/3` borusunda, when export ve import, then çalışır; parola argv/çıktıda yok.
- K11: `npm test` (migrate, transfer, fleet dahil) yeşil; `migrate-container.js` içinde keyflip importu yok (`grep`).

## Riskler
- Gerileme: v2 içe aktarım yolu, `transfer serve/pull` ve fleet kabı kullanıyor; davranış değişmemeli (regresyon: K2, K11,
  mevcut transfer/fleet testleri). Kap/içerik ayrımı sırasında `TranscriptSink` ve `applyBundle` sırası bozulmamalı
  ("meta yalnız `end` doğrulanınca uygulanır").
- Gizli veri: bu kap sahibin tüm anahtarlarını taşır; her hata mesajı dosya içeriği alıntılamamalı. Kriptografi
  hatası geri alınamaz: aynı kap diğer araçlarca bayt bayt kullanılacak, biçim sonradan değişirse hepsi bozulur.
- Erişim: düşürme saldırısı kapatılıyor; yanlış parola ile kurcalama aynı çıkış kodu (3) olmalı.
- Bellek: scrypt N=2^17 ~128 MiB; `maxmem` verilmezse ERR ile düşer.
- Yedek: `backup.js` kimlik bilgilerini ATLAR; "mevcut yedek kodu"nu olduğu gibi kullanmak sırları yedeksiz bırakır.

## Kararlar
- Yedek için `backup.js`'in dizin/damga/retention yardımcıları kullanılır ama migrate'e özel bir "dokunulacak dosyaları
  kopyala" yolu eklenir (`<configDir>/migrate-backups/<damga>/`, 0700, dosyalar 0600); sır dosyaları dahil.
- `fromHome`/`fromUser` ilk şifreli kayıtta (DESIGN'ın önerisi); v2 paketlerde bu alan yok, yeniden yazma yapılmaz.
- Çıkış kodları: 2 kullanım, 3 paket reddi (parola yanlış/kurcalama/kesik/id/düz), 4 çakışma ve hiçbir şey yazılmadı,
  5 önkoşul eksik. Mevcut `fail()` yolu 1 döndürüyorsa yalnız `migrate` alt komutları için eşlenir.
- Anahtarlık yazma/okuma bu işte YOK (yalnız dosya ve keyflip içeriği); `--keychain` testlerde geçici anahtarlık içindir.
- Fikstür adları uydurma (`alice`, `example-provider`); özel dosyadan ad kopyalanmaz.
- transfer/fleet davranışı değişmez; kap yalnız yeniden düzenlenir.
- Tam suit öncesi `machine-resources.sh check`.

## Sahibe sorular
- Yok. (Parola uzunluk kuralı umbrella'nın işi, bu iş değil.)

## Boyut
L: tek geliştirici diliminden büyük (yeni modül + biçim + 3 CLI alanı + vektörler + testler), tahmini 800+ satır.
Risk: gizli veri, biçim göçü (migration), erişim (düşürme kapatma) işaretli; gözden geçiren ve yedek şart.
