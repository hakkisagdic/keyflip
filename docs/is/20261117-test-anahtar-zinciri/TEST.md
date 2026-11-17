# TEST: 20261117-test-anahtar-zinciri (dal is/20261117-test-anahtar-zinciri, mod function) - yeniden kontrol 1

Karar: GEÇTİ (K5 hariç, o yalnız sahip tarafından elle denenir). Düzeltme e334e66 sonrası tam `npm test` 2267 test / 2263 geçti / 0 kaldı / 4 atlandı; `final-no-real-spawns` yeşil; koşu penceresinde securityd istem satırı 0.

Koşu penceresi: 2026-11-17 05:08:14 - 05:15:36 (+03), makine yuvası alındıktan sonra tek koşu (`heavy_slot.sh`, yuva bırakıldı).

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 guard, mutlak yol dahil, açık keychain'siz security reddi + final-no-real-spawns kırmızı | geçti | `test/tester-keychain-chain.test.js` "K1: ..." yeşil; tam koşuda `final-no-real-spawns` yeşil |
| K2 tam npm test, pencerede securityd "displaying keychain prompt" = 0 | geçti | `/usr/bin/log show --predicate 'process == "securityd" AND eventMessage CONTAINS "displaying keychain prompt"'` 05:08:14-05:15:40 penceresinde 0 satır; aynı sorgu önceki koşu penceresi 04:16-04:25'te 1 satır verdi (sorgunun çalıştığı kanıtı, 02:20-02:35 penceresinde 8) |
| K3 atılgan keychain ile add --key-file -, list, test, remove; list-keychains ve varsayılan keychain aynı; login öge sayısı aynı | geçti | `test/kiroapikey-cli.test.js` tam koşuda yeşil; `security list-keychains` öncesi/sonrası aynı (diff), `dump-keychain` genp sayısı 206 = 206 (değer okunmadı) |
| K4 sabit yol helper yeniden derleme | geçti | `test/tester-keychain-chain.test.js` "K4: ..." yeşil |
| K5 gerçek makinede ikinci okumada parola istemi yok | yürütülmedi | Yalnız sahip elle dener. Not: koşu sırasında istem yok, atılgan keychain'de yabancı öge uzunluk okuması artık yapılmıyor (`test/kiroapikey.test.js` "K2b") |
| K6 yabancı öge: istemden önce uyarı; `--no-length` ile istem ve length yok | geçti | `test/kiroapikey-cli.test.js` ve `test/kiroapikey.test.js` yeşil |
| K7 temizlik betiği yalnız a1,a2,a9,h | geçti | `test/tester-keychain-chain.test.js` "K7" ve "K7 run" yeşil |
| K8 depoda e-posta, özel yol, sır yok | geçti | Dal farkındaki eklenen satırlarda e-posta, kullanıcı adı, `.polyctl`, anahtar deseni taraması boş (yalnız `/Users/someone/...` yer tutucusu) |
| Ek: KEYFLIP_KEYCHAIN_FILE yalnız guard aktifken veya temp altındaysa geçerli | geçti | `test/tester-keychain-chain.test.js` "review: ..." artık yeşil; `test/exec.test.js` yeni testleri yeşil; kod: `src/exec.js` `confinedFile`, `src/kiroapikey.js` `keychainFile` (`active() || isTempKeychainFile`) |
| Ek: helper put/get/del argv ve loga değer yazmaz; çağrı noktaları | geçti | önceki turdaki tarama değişmedi (put stdin, get yalnız süreç içinde + registerSecret); "no test file runs the real security tool without creating its own throwaway keychain" tam koşuda yeşil |
| Regresyon: Claude profil deposu, kiro swap, kiro apikey, keychain.real, uninstall, cli flags, switch dry run, mcp, migrate-v3 dalı | geçti | Tam `npm test` 0 kalan; `keychain.real` opt-in olduğu için atlandı (kasıtlı) |

## Kalanlar

Yok (K5 yalnız sahibin elle denemesi için kalır).

Eklenen testler: `test/tester-keychain-chain.test.js` (5 test, hepsi yeşil). Ekran görüntüsü gerekmedi (arayüz yok).
