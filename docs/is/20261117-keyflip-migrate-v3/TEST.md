# TEST: 20261117-keyflip-migrate-v3

Dal: `is/20261117-keyflip-migrate-v3`. Mod: function (arayüz yok, ekran görüntüsü yok). Her test geçici HOME ve geçici
yapılandırma dizininde, uydurma sırlarla çalıştı; gerçek anahtarlığa ve gerçek HOME'a dokunulmadı.
Bağımsız testler: `test/migrate-v3-qa.test.js` (CLI üzerinden kara kutu). Geliştiricinin `test/migrate-v3.test.js` dosyası ayrıca koşturuldu.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 başlık v3, kdf N=131072, bundleId, tool, toolVersion; fromHome/fromUser yok | geçti | `migrate-v3-qa.test.js` "K1 ..." |
| K2 v2 paketler (düz ve şifreli) içe aktarılır | geçti | "K2 v2 vectors ..." ve mevcut migrate/transfer/fleet testleri |
| K3 valid=0; flipped-record, flipped-header, truncated, plaintext, n14 = çıkış 3, hedef değişmez | geçti | "K3 vectors ..." (önce/sonra SHA-256 özeti eşit) |
| K4 parolayla veya `--require-encrypted` ile düz paket çıkış 3 | geçti | "K4 ..." |
| K5 `--expect-bundle-id` uyuşmazlığı çıkış 3, hedef değişmez; eşleşmede 0 | geçti | "K5 ..." |
| K6 `--dry-run` yalnız isim ve new/conflict basar, yazmaz, yedek oluşturmaz; çakışmada çıkış 4 | geçti | "K6 ..." |
| K7 gerçek import 0700 yedek dizini oluşturur, yolu basar, kimlik dosyaları yedekte, dosyalar grup/diğer okumasız | geçti | "K7 ..." |
| K8 `manifest [--json]` ve `doctor` isim, var/yok, uzunluk basar; değer yok | geçti | "K8 ..." (canary ve token değeri çıktıda yok) |
| K9 canary (düz, base64, hex, base64url) stdout, stderr, günlük, şifreli pakette yok; yanlış parola yolu da | geçti | "K9 ..." (kontrol: düz pakette canary var, "K9b") |
| K10 parola `/dev/fd/3` borusundan; export ve import çalışır, parola çıktıda yok | geçti | "K10 ..." (sh here-doc ile fd 3) |
| K11 `migrate-container.js` yalnız Node yerleşikleri | geçti | "K11 ..." (import belirteçleri taranır) |
| Regresyon: v2 import | geçti | K2 + `migrate-v3.test.js` "K2 v2 import via the CLI" |
| Regresyon: transfer serve/pull, fleet | geçti | `transfer.test.js`, `lantransfer.test.js`, `relaytransfer.test.js`, `fleet*.test.js` |
| Regresyon: migrate push/pull (WebDAV) | geçti | `migrate.test.js`, `relaytransfer.test.js` (davBackend, round-trip) |
| Regresyon: legacy tek satır paket | geçti | `migrate-stream.test.js` "legacy ...", `migrate-v3.test.js` "a legacy one-string bundle ..." |
| Regresyon: meta yalnız `end` doğrulanınca | geçti | `migrate-stream.test.js` "tampered ... installs no metadata", "missing only its end record" |

Komutlar: `node --test test/migrate*.test.js test/transfer.test.js test/fleet*.test.js test/lantransfer.test.js test/relaytransfer.test.js`
=> 137 test, 135 geçti, 0 kaldı, 2 atlandı. `node --test test/migrate-v3-qa.test.js` => K1-K11 geçti (K3-K6 yeniden koşuldu, 5/5).
Tam `npm test` bu işte koşturulmadı (gate geliştirici ve releaser'ın).

## Kalanlar

Başarısız kontrol yok. Gözlemler (hata değil):
- Reddedilen veya `--dry-run` import bile hedef yapılandırma dizininde yönetilen `.gitignore` dosyasını (keyflip'in sürüm-kontrol başlatması) yaratabiliyor. Kullanıcı verisi, kimlik veya kayıt yazılmıyor; testlerin özeti bu dosyayı ve `.update-check.json` damgasını hariç tutar. Beklenen: "hiçbir şey yazmaz" katı okunursa bu dosya da yazılmamalı. Karar sahibi geliştirici/analist; engel sayılmadı.
- scrypt N=2^17 nedeniyle her şifreli çağrı ~1-3 sn sürüyor; qa dosyası bu yüzden yaklaşık 4 dk.

## İnceleme düzeltmeleri

Düzeltme: commit `8719f8d` (Keychain'deki sırların yedeği). Tüm koşular geçici HOME ve bellek içi anahtarlıkla.

| Bulgu | Sonuç | Kanıt |
|---|---|---|
| 1 [büyük] Keychain tipli mağazada `--force` içe aktarma eski hesap ve sağlayıcı sırlarını yedeklemeli | geçti | `test/migrate-v3-review-qa.test.js` "streamed --force import on a keychain-type store ..." (akış içe aktarıcısı uçtan uca: `store/work.cred` eski değer, `store/provider__relay.cred` = eski anahtar, dizin 0700, dosya 0600, yeni değer yazıldı); geliştirici testi `migrate-v3.test.js` "safety copy holds the old Keychain-held secrets ..." |
| 1b Mağaza okunamıyorsa `--force` yazmadan önce durur (NEED_STORE, çıkış 5) | geçti | QA "--force with an unreadable store aborts before any write" (hesap sırrı ve profil değişmedi); `src/cli.js` NEED_STORE -> `migrateFail(..., 5)` kodda doğrulandı; CLI üzerinden çıkış 5 koşulmadı (geçici HOME dosya mağazası kullanır, okunamaz hale getirilemedi) |
| 1c `--force` yoksa okunamayan mağaza engellemez (çakışma zaten reddedilir) | geçti | QA "without --force an unreadable store does not block" |

Gözlem (hata değil): dosya içi çıktı hâlâ "safety copy of the files this import could touch" diyor; artık mağaza sırlarını da içeriyor, metin güncellenebilir.

Kapı yeniden koşuldu (kripto ve düşürme kapatma, regresyon v2 import, transfer, fleet):
- `machine-resources.sh check` => çıkış 0, ardından geçici HOME ile `npm test`: 2270 test, 2265 geçti, 4 atlandı, 1 kaldı.
- Kalan: `test/mcp.test.js` "login/logout/browser tools ..." (oturum zaman aşımı, tam suit yükü altında). Dosya bu dalda değişmedi (main'e göre diff yok); tek başına iki kez koşuldu, 33/33 geçti. Yük kaynaklı kararsızlık, bu işle ilgisiz; ayrıca izlenmeli.
- Regresyon v2 import, transfer, fleet, migrate, kripto/düşürme testleri tam suit içinde geçti.
