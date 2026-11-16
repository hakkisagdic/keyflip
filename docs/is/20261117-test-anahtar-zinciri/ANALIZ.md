# 20261117-test-anahtar-zinciri: Test kosusu Keychain parolasi istemesin, gercek kullanim da rahatsiz etmesin

## Bugün ne var
- `test/kiroapikey-cli.test.js` gercek CLI'yi calistirir; CLI `src/kiroapikey.js` `addByValue` ile `keyflip:kiro-apikey:<ad>` ogesini `security -i` (mutlak yol `/usr/bin/security`) uzerinden GERCEK login Keychain'e yazar, uzunlugunu `itemLength` ile `kfkc` yardimcisiyla okur. Yardimci her sandbox config dizininde (`surfaces/kiro/.bin/kfkc`) yeniden derlenir: imzasiz yeni ikili, ogenin erisim listesinde yok, macOS parola sorar (28 olay / 3 saat).
- `src/spawnguard.js` yalniz `exec.run` icinden gecen osascript/open/say/terminal-notifier, `claude auth` ve webhook'u reddeder. `security` icin yalniz `test/run.js` PATH golgesi var; mutlak yol golgeyi ve kalkani asar. Testlerin kendi `execFileSync(SEC, ...)` cagrilari kalkana hic girmez.
- Cagri noktalari (security): `src/stores/keychain.js` (`keychainPath` kapisi var), `src/kiro.js:208` (`keychainRead`, kirocli:odic:*), `src/kiroapikey.js` (`itemExists`, `readValue`, `addByValue` -> KeychainStore), `src/login.js:50,81`, `src/antigravity.js` (3 yer), `src/appauth.js:147`, `src/chat.js:23`, `src/browser.js:206`, `src/refresh.js:273,350`. Yardimci `kfkc`: `src/kiro.js` (`ensureHelper`, `writeKeychain`), `src/kiroapikey.js` (`itemLength`).
- Gercek Keychain'e ulasan testler (okuma sirasiyla dogrulanacak): `kiroapikey-cli.test.js` (dogrudan SEC + CLI; su an opt-in), `refresh.test.js`/`login`/`cli`/`mcp`/`uninstall` testleri gercek `claude`/security yoluna girebilir (onceki is: claude auth zaten kalkanda). `keychain.real.test.js` atilgan keychain kullanir ama opt-in; `create-keychain` arama listesine eklenebilir, bu dogrulanmali.
- Zaten var: yardimci kaynagi degismedikçe ve ikili duruyorsa yeniden derlenmez (`ensureHelper`), ama yol config dizinine bagli; ikili ad-hoc imzali, kimligi derleme ciktisina bagli.

## Ne değişecek
1. `spawnguard.js`: `security` (ad VE mutlak yol) ve `kfkc` icin yeni sinif. Aktifken, acik bir keychain dosyasi (gecici dizin altinda) adlanmadiysa find/add/delete/-i ve yardimci derleme/calistirma reddedilir, sayilir, `KEYFLIP_SPAWN_LOG`'a `keychain ...` satiri yazilir. `final-no-real-spawns.js` bu satirda basarisiz olur. Testlerin dogrudan cagrilari icin `test/guard-source.test.js`: test dizininde `/usr/bin/security` kullanan her dosya acik keychain yolu gecmiyorsa kirmizi.
2. Atilgan keychain: test sandbox'ta `create-keychain` (rastgele parola, `-d` ile liste degistirilmez; once/sonra liste sayisi karsilastirilir) dosyasi; CLI'ye belgeli `KEYFLIP_KEYCHAIN_FILE` (yalniz guard aktifken veya acikca) ile `KeychainStore.keychainPath`, `itemExists`/`readValue` ve yardimciya `KFKC_KEYCHAIN` (SecKeychainOpen + kSecMatchSearchList / kSecUseKeychain). Yardimci dosyayi liste disinda adresleyemezse uctan uca testte yardimci sahtelenir ve sonuc raporunda acikca yazilir.
3. Urun: yardimciya `put`/`get`/`del` kipleri; `keyflip:` ogeleri `security -i` yerine yardimciyla olusturulur/okunur/silinir (olusturan yardimci olur, onay istemez). Yardimci tek sabit yolda, kaynak degisince derlenir, sabit tanimlayici ile imzalanir. Yabanci oge (`--keychain-service`): komut, sistem istemini TETIKLEMEDEN once ciktida duyurur; `--no-length` ile uzunluk denetimi atlanir.
4. Temizlik betigi (tek seferlik, test degil): yalniz `keyflip:kiro-apikey:a1,a2,a9,h` adlariyla `find` ve sonra `delete`; deger okunmaz, liste dokulmez; `kiro-api:*`, `kiro-api-hold:*` dokunulmaz.

## Kabul kontrolleri
- K1: Given `npm test`, when guard aktifken bir test `/usr/bin/security`'yi acik keychain'siz cagirir (mutlak yol dahil), then cagri reddedilir ve `final-no-real-spawns` kirmizi olur. Gozlem: gecici test + `npm test` ciktisi.
- K2: Given tam `npm test`, when biter, then `log show --predicate 'process == "securityd"' --start <baslangic> --end <bitis>` icinde "displaying keychain prompt" satiri yoktur, ekranda diyalog cikmaz.
- K3: Given atilgan keychain dosyasi, when uctan uca test `add --key-file -`, `list`, `test`, `remove` calistirir, then hepsi gecer ve `security list-keychains` oge sayisi testten once/sonra ayni, varsayilan keychain degismemis.
- K4: Given helper sabit yolda, when ayni kaynakla iki kez `add` calisir, then ikili yeniden derlenmez (mtime/sha ayni); kaynak degisirse bir kez derlenir.
- K5: Given gercek makine, when `echo anahtar | keyflip kiro apikey add x --key-file -` sonra `list` ve `test x` kosulur, then ikinci ve sonraki okumalarda parola istemi yoktur (yalniz sahip elle dener; analist/gelistirici KOSMAZ).
- K6: Given `add y --keychain-service <yabanci>`, when kosulur, then cikti istemden ONCE "macOS one kez ... izin isteyecek" der; `--no-length` ile hic istem tetiklenmez ve `length` gosterilmez.
- K7: Given temizlik betigi, when calisir, then yalniz a1,a2,a9,h adlari aranir/silinir; `kiro-api:*` ve `kiro-api-hold:*` ogeleri sorgulanmaz bile (betik kaynagi okunarak dogrulanir).
- K8: Given depo, when `grep` edilir, then e-posta, ozel yol, sir yoktur (kamuya acik depo).

## Riskler
- Erisim/sir: yardimci artik anahtar degerini `get` ile stdout'a verebilir; yalniz CLI'nin kendi sureci okur, `registerSecret` ile redakte edilir, ciktiya yazilmaz.
- Veri kaybi: mevcut `security` ile yazilmis `keyflip:kiro-apikey:*` ogeleri yardimciyla ilk okumada bir kez sorabilir; gecis: sessiz yeniden yazim yok, `add` yeniden calistirilinca yardimci olusturur. Sahibin gercek `kiro-api:*` ogelerine dokunulmaz.
- Duzenlenemeyen dogrulama: sabit tanimlayici/ACL davranisi ve K5 diyalogsuz dogrulanamaz; sahibin tek elle denemesi gerekir.
- Gerileme: Claude profil deposu (`KeychainStore`), `kiro swap` (`writeKeychain`/`keychainRead`), `kiro apikey` add/list/remove/test, `test/kiroapikey-cli` ve `keychain.real` testleri.
- Paralel isler: `migrate-v3` dalina ve yonetici'nin `kiroapikey-cli.test.js` satirina dokunulmaz; main'de birlesme sürüyor, dal ondan sonra rebase.

## Kararlar
- Anahtar degeri hala kendi dosyalarimizda saklanmaz; yardimciyla Keychain'e yazilir.
- Opt-in `KEYFLIP_E2E_REAL_KEYCHAIN` kalir, kapida hic set edilmez; atilgan keychain testi varsayilan kosuya girer.
- Aramalistesine ekleme, varsayilan keychain degisikligi, login keychain kilit islemleri YOK.
- Eski testin kalintilari tam adla aranir; rastgele `kf-test-*` adlari kayitli degilse aranmaz.

## Sahibe sorular
- Yok. (Varsayilan: sahip yalniz K5'i bir kez elle dener; geri alinabilir.)

## Boyut
M, riskli (erisim + gizli veri; migrasyon yok): ~450-600 satir, tek gelistirici dilimi; kalkan genislemesi, helper kipleri, test yeniden yazimi. Gozden gecirici ve yedek gerekir. Tam suit kosusu icin once makine yuvasi (`heavy_slot.sh acquire`), yoksa hedefli testler ve tam kosu borclu.
