# 20261117-keyflip-kiro-apikey: Kiro API anahtarı için `keyflip kiro apikey` grubu

## Bugün ne var
- `src/kiro.js` yalnız CLI/IDE girişlerini (Keychain `kirocli:odic:*`, IDE token dosyası) yakalar/değiştirir. API anahtarı kavramı yok.
- Kiro API anahtarı, başsız `kiro-cli`nin `KIRO_API_KEY` ortam değişkenidir; Anthropic uyumlu uç nokta değil, bu yüzden `provider add` ile kaydedilmez.
- `src/cli.js` `cmdKiro` (~15222): `status|list|capture|switch|usage|import|remove`. Yardım satırı ~394, MCP tanımları `src/mcp.js`.
- Seam: `src/exec.js` `run()` (spawnSync, `env`, `timeoutMs`), kiro.js içinde `d.run || defaultRun` (~138); kiro-cli yolu `kiroCliCandidates` (`KEYFLIP_KIRO_CLI` ile ezilir).
- `src/stores/keychain.js`: okuma `-w` (değeri döndürür, `registerSecret` ile kaydeder), yazma `security -i` stdin (argv'de değer yok). `src/redact.js`: `registerSecret`, `redact`.
- kiro.js içindeki Swift/C yardımcısı `kfkc stat <svc>` bayt uzunluğu + sha256 öneki basar, değeri basmaz; `kfkc set` stdin'den yazar.
- Testler: `test/kiro.test.js` sahte runner kullanır; gerçek Keychain'e dokunmaz.

## Ne değişecek
1. Yeni modül `src/kiroapikey.js` (+ `test/kiroapikey.test.js`); `cmdKiro` yalnız `apikey` alt grubunu ona yönlendirir. Mevcut capture/switch koduna dokunulmaz.
2. Meta: yapılandırma dizininde hesap başına dosya (0600, atomicWrite): `{account, service, owned, addedAt}`. Değer asla yazılmaz.
3. `apikey add <hesap> --keychain-service <ad>`: yalnız ad kaydedilir; varlık `security find-generic-password -s AD` (`-w`/`-g` YOK) ile, uzunluk `kfkc stat` ile ölçülür. `kiro-api-hold:` ile başlayan ad reddedilir (dokunulmaz kuralı). Öğe yoksa kayıt yapılmaz, hata.
4. `apikey add <hesap> --key-file -`: değer stdin'den okunur, `registerSecret`, keyflip'e ait öğeye (`keyflip:kiro-apikey:<hesap>`) `KeychainStore`/kfkc ile stdin üzerinden yazılır; argv'de asla. `owned:true`.
5. `apikey list`: hesap, servis adı, var evet/hayır, uzunluk. `apikey remove <hesap>`: yalnız referans; `--delete-item` yalnız `owned:true` ve `keyflip:` önekli öğeyi siler, yabancıyı asla.
6. `apikey test <hesap>`: değer süreç içinde execFile ile okunur (shell yok), çocuğa yalnız `KIRO_API_KEY` olarak verilir; ortamdan diğer `KIRO_*`/`AWS_*` değişkenleri temizlenir; `kiro-cli chat --no-interactive --trust-tools= "Reply with OK"`, zaman sınırı (varsayılan 60 sn). Çıktı: PASS/FAIL + kategori (key missing, rejected, plan not eligible, timeout) + CLI kredi satırı varsa. Tüm çıktı/hata `redact`ten geçer.
7. `--json` bayrağı diğer kiro alt komutları gibi. CLI yardımı, MCP (`keyflip_kiro_apikey_list/test`; add/remove için `confirm`), README bölümü (yer tutucularla), CHANGELOG satırı.

## Kabul kontrolleri
- K1: Given rastgele adlı geçici Keychain öğesi, when `keyflip kiro apikey add a1 --keychain-service <ad>`, then "added", sonra `list` hesap/ad/present yes/uzunluk gösterir; meta dosyası 0600 ve değeri içermez (`ls -l`, `cat`).
- K2: Given olmayan servis adı, when `add`, then hata ve meta dosyası oluşmaz.
- K3: Given `kiro-api-hold:` önekli ad, when `add/test/remove --delete-item`, then reddedilir; öğe değişmez.
- K4: Given `printf '%s' DEGER | keyflip kiro apikey add a2 --key-file -`, when çalışır, then keyflip'e ait öğe oluşur, `ps`/argv'de değer yok, çıktı/meta/log değeri içermez (grep boş).
- K5: Given stub kiro-cli (KIRO_API_KEY'i yankılamadan doğrular), when `apikey test a1`, then PASS; stub ortamında `AWS_*`/diğer `KIRO_*` yok.
- K6: Given stub ret/plan-uygun-değil/zaman-aşımı simülasyonları, when `test`, then sırasıyla FAIL rejected / plan not eligible / timeout; yokluk için FAIL key missing; `--json` aynı kategoriyi verir.
- K7: Given `remove a1` (yabancı öğe) ve `remove a2 --delete-item` (keyflip öğesi), then a1 öğesi durur, a2 öğesi silinir; yabancıya `--delete-item` "refused" der.
- K8: Given tüm testin yakaladığı stdout/stderr ve config dizini dosyaları, when geçici değer aranır, then hiçbir yerde yok.
- K9: Given `npm test` ve lint, then yeşil; mevcut `test/kiro.test.js` değişmeden geçer.

## Riskler
- Gizli değer sızıntısı (çıktı, hata metni, meta, argv, log): tüm yollar `redact`; K8 testi bekçi. Erişim/gizli veri olduğu için `touches.access`.
- Yabancı Keychain öğesini silmek: `owned` bayrağı + `keyflip:` ön ek çift kontrol; K7.
- `-w`/`-g` ile yanlışlıkla değer basmak: yalnız `test` içinde süreç içi okuma; başka yerde yasak.
- Gerçek Keychain testleri CI'da çalışmaz: rastgele servis adı, try/finally ile silme; darwin dışında atla.
- Regresyon: mevcut `keyflip kiro capture/switch/list/status/usage` (test/kiro.test.js) değişmemeli.
- Genel depo: kodda, testte, dokümanda e-posta, yol, anahtar yok.

## Kararlar
- Uzunluk `kfkc stat` ile (değer yazdırmadan); yardımcı yoksa/derlenemezse uzunluk "bilinmiyor", varlık yine raporlanır.
- Meta hesap başına ayrı dosya, kiro capture dizininden ayrı bir alt yolda (mevcut hesap yapısına karışmaz).
- Ortam temizliği: `KIRO_*`, `AWS_*` silinir, PATH/HOME korunur, yalnız `KIRO_API_KEY` eklenir.
- Hesap adı doğrulama: `[A-Za-z0-9._-]{1,64}`; kiro capture hesaplarından bağımsız ad alanı.
- Gerçek anahtar hiçbir testte/kayıtta yok; yönetici servis adını sonradan komutla verir.

## Sahibe sorular
- Yok (tüm kararlar geri alınabilir; gerçek servis adını sahip kurulumdan sonra kendisi verir).

## Boyut
M: mevcut alanda tek özellik, yeni modül + test + yardım/README/CHANGELOG, tahmini ~500 satır. Risk: gizli değer ve erişim (`touches.access`), bu yüzden S değil; inceleme gerekir. Göç yok, para yok, kişisel veri yok.
