# TEST: keyflip kiro apikey (20261117-keyflip-kiro-apikey)

Mod: function. Gerçek anahtar kullanılmadı; değerler çalıştırma başına rastgele, Keychain öğeleri rastgele adlı ve test sonunda silindi (sonrası `dump-keychain` kontrolü: kalıntı yok). Dal yerelde çalıştırıldı (canlı URL kanıt sayılmadı).
Eklenen test: `test/kiroapikey-cli.test.js` (gerçek CLI + gerçek login Keychain, stub kiro-cli). Geliştiricinin `test/kiroapikey.test.js` testleri de çalıştırıldı.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 add --keychain-service, list, meta 0600 değersiz | geçti | kiroapikey-cli.test.js (0600, grep, list uzunluk); kiroapikey.test.js K1 |
| K2 olmayan servis hata, meta yok | geçti | CLI testi (çıkış kodu != 0, a9.json yok) |
| K3 kiro-api-hold: reddedilir, öğe değişmez | geçti | CLI testi (gerçek hold öğesi durdu) + unit K3 |
| K4 --key-file - stdin, değer argv/çıktı/meta/logda yok | geçti | CLI testi (stdin ile keyflip öğesi oluştu); unit K4 argv günlüğü |
| K5 stub ile PASS, ortamda yalnız KIRO_API_KEY | geçti | CLI testi (env adları: AWS_PROFILE/KIRO_OTHER yok); unit K5 |
| K6 rejected/plan not eligible/timeout/key missing, JSON | geçti | CLI testi `--json` dört kategori; unit K6 |
| K7 remove yalnız referans; --delete-item yalnız keyflip öğesi | geçti | CLI testi (yabancı öğe remove ve --delete-item sonrası duruyor; keyflip öğesi siliniyor) + unit K7 |
| K8 sızıntı: yakalanan stdout/stderr/dosyalarda değer yok | geçti | CLI testi (tüm çıktılar + config dizini grep; stub değeri yankılasa da çıktıda yok); unit K8 |
| K9 npm test + lint, kiro.test.js değişmedi | geçti | `npm test`: 2241 test, 2237 geçti, 0 kaldı, 4 atlandı; eslint 0 hata (yalnız mevcut uyarılar); git diff kiro.test.js boş |
| Regresyon: kiro capture/switch/list/status/usage/import/remove | geçti | test/kiro.test.js tamamı yeşil |
| Regresyon: KeychainStore okuma/yazma, redact | geçti | tam paket yeşil |

Not: CLI testi ilk çalışmada kfkc yardımcısını derlediği için ~30 sn sürer.

## Kalanlar
Yok.
