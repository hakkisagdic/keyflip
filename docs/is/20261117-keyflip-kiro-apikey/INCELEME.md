# İNCELEME: 20261117-keyflip-kiro-apikey

**Karar: GEÇER (ship).** Engel ya da büyük bulgu yok; aşağıdaki küçük bulgular test edenin doğrulamasıyla sonradan kapatılabilir.

Okunanlar: `src/kiroapikey.js`, `src/cli.js` (cmdKiroApikey + yönlendirme), `src/mcp.js` (4 araç), `src/stores/keychain.js` (kullanılan yollar), `src/redact.js`, `test/kiroapikey.test.js`, `test/kiroapikey-cli.test.js`, README/README.tr/CHANGELOG, ANALIZ.md, TEST.md. PLAN.md klasörde yok; plan ANALIZ.md'nin "Ne değişecek" bölümünde.
İnceleyen doğruladı: `node --test test/kiroapikey.test.js test/kiro.test.js` 23/23 geçti; `test/kiro.test.js` dalda değişmemiş; yeni dosyalarda eslint hatası yok (yalnız uyarı). Tam `npm test` ve gerçek Keychain'e yazan CLI testi inceleyen tarafından çalıştırılmadı (TEST.md'deki kanıta dayanıldı). Gerçek Keychain'deki ayrılmış öğe adı `kiro-api-hold:` önekine uyuyor; koruma gerçek öğeyi kapsıyor.

## Mercekler
1. Veri güvenliği: göç yok; yeni meta dizini `kiro-apikey/` hesap başına 0600, atomik yazım, değer yok. Silme yalnız `owned:true` + `keyflip:kiro-apikey:` önek + sabit hesap `kiro-apikey` üçlüsüyle; yabancı öğe silinemiyor. Üzerine yazma varsayılanı aşağıda (küçük).
2. Erişim: yerel tek kullanıcılı CLI; hesap adı `[A-Za-z0-9._-]{1,64}` ile sınırlı, yol kaçışı yok. MCP ekle/kaldır `confirm` istiyor; ekle aracının hedef servis adı sınırsız (küçük).
3. Para ve kişisel veri: para yok. Değer argv'ye girmiyor (`security -i` stdin, hex), meta/çıktı/hata metinleri `redact`ten geçiyor, çocuğa yalnız `KIRO_API_KEY` gidiyor, `AWS_*`/diğer `KIRO_*` siliniyor. Diff'te e-posta, kişisel yol ya da anahtar yok.
4. Dürüstlük: K1–K9 için birim + uçtan uca testler gerçekten iddia ediyor (0600, grep, ortam adları, kategori JSON, yabancı öğenin kalması). TEST.md'deki "Kalanlar: yok" iddiası kodla tutarlı.
5. Sırlar: kodda, testte, commit'te sır yok; test değerleri çalıştırma başına rastgele.

## Bulgular

| Önem | Dosya:satır | Sorun | Düzeltme |
|---|---|---|---|
| küçük | src/kiroapikey.js:120-131 | `add <hesap> --key-file -` aynı hesapta keyflip'e ait öğe varsa `-U` ile eski anahtarın üzerine sessizce yazar; tek kopya keyflip'teyse eski anahtar geri gelmez. `addByService` de var olan bir `owned:true` referansın üzerine yazıp keyflip öğesini sahipsiz bırakır. | Meta zaten varsa `--force` olmadan reddet ("account exists; use --force to replace"); `--force` ile değiştirirken eski `owned` öğe başka servise işaret ediliyorsa onu da sil ya da kullanıcıya söyle. |
| küçük | src/mcp.js:647-665 | `keyflip_kiro_apikey_add` herhangi bir Keychain servis adını kabul ediyor; `confirm=true`'yu kendisi koyan yönlendirilmiş bir ajan `Claude Code-credentials` ya da `keyflip:surface:*` gibi başka bir sırrı referans yapıp `test` ile Kiro uç noktasına `KIRO_API_KEY` olarak gönderebilir. | `addByService` içinde bilinen keyflip/Claude servislerini (`Claude Code-credentials`, `keyflip:` önekli ama `keyflip:kiro-apikey:` olmayanlar, `kirocli:`) reddet; MCP açıklamasına "yalnız Kiro API anahtarı öğeleri" yaz. |
| küçük | src/mcp.js:628-643 | `keyflip_kiro_apikey_test` kredi harcıyor ama `readOnlyHint:true` ve onay istemiyor; `timeoutSeconds` üst sınırı yok ve `spawnSync` MCP sunucusunu süre boyunca kilitliyor. | `readOnlyHint:false` yap ve `confirm` iste; `timeoutSeconds`'ı 1–120 aralığına sıkıştır (CLI `--timeout` için de negatif/sıfır değerleri reddet). |
| küçük | src/stores/keychain.js:95 (kiroapikey.js:176-178 üzerinden) | `_delete` yalnız zaman aşımında hata fırlatıyor; erişim reddi gibi bir hatada `removeKey` yine `itemDeleted:true` ve "and its Keychain item" der, öğe Keychain'de kalır. | `removeKey` içinde silmeden sonra `itemExists(service)` ile doğrula; hâlâ varsa `itemDeleted:false` dön ve hata yaz (paylaşılan `_delete` koşulunu değiştirmek ayrı iş). |
| küçük | test/kiroapikey-cli.test.js:87,158 | Uçtan uca test gerçek login Keychain'de sabit `a2` hesabını kullanıyor: sahibin gerçek `keyflip:kiro-apikey:a2` öğesi varsa test onun üzerine yazar ve `finally` içinde siler. Test `npm test` ile her darwin çalıştırmasında koşuyor. | Hesap adını rastgele yap (`rnd('kft')`); `finally` silmesini `-a kiro-apikey` ile daralt; testi `KEYFLIP_REAL_KEYCHAIN=1` gibi açık bir bayrağa bağla. |
| küçük | src/kiroapikey.js:74,94,136,141 | Yeni dosyada 4 eslint uyarısı (kullanılmayan `e`, gereksiz atama). | `catch {}` biçimine geç; `let files = []` yerine `let files;`. |
