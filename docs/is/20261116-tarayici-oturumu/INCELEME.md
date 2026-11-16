# İNCELEME: 20261116-tarayici-oturumu

**Karar: GEÇMEZ (ship=false).** 1 engel, 1 büyük, 6 küçük bulgu var. Plan önce, `--yes` kapısı, MCP `confirm`, kayıtsız hesapta iki adım ve çıktıda değer olmaması doğru kurulmuş. Ama masaüstü hesabı gerçek makinede hiç tanınmıyor: K4 ve "tahmin yürütmez" kuralı yalnız fixture'da çalışıyor.

Okunan: `src/browserplan.js`, `src/cli.js` (cmdBrowser, cmdList, usage/failover biçim değişiklikleri), `src/mcp.js` (keyflip_browser_sync), `test/browserplan.test.js`, `test/browsersync-cli.test.js`, `test/mcp.test.js`, `CHANGELOG.md`, `docs/USE-CASES.md`, ANALIZ.md, TEST.md. `test/browserplan.test.js` yeniden koşuldu: 7/7 geçti.

## Mercekler
1. **Veri güvenliği:** Migrasyon yok. Cookie DB'ye yazma eskisi gibi yalnız tarayıcı kapandıktan sonra yapılıyor (`did-not-quit` koruması duruyor). Kayıt anahtarı hesap adı, başka hesabın kaydı yüklenmiyor (K5b).
2. **Erişim:** Hedef hesap seçimi bu işin özü. Masaüstü yüzeyi gerçek veride çözülmüyor (engel). Konumsal hesap adında yazım hatası olursa sessizce CLI hesabına düşülüyor (büyük).
3. **Para / kişisel veri:** Para yok. Çıktıda e-posta ve org'un ilk 8 hanesi var, cookie değeri yok. Yerel CLI için kabul edilebilir.
4. **Dürüstlük:** TEST.md K6'yı doğru biçimde "kısmen" olarak işaretlemiş. K4/K4b "geçti" diyor, ama fixture gerçek Desktop dizin yapısıyla uyuşmuyor, kanıt gerçeği göstermiyor (engel). K6 test adı söylediğinden azını sınıyor.
5. **Sırlar:** Kodda, testte ya da commit'te sır yok. Fixture değerleri sahte.

## Bulgular

| Önem | Dosya:satır | Sorun | Düzeltme |
|---|---|---|---|
| engel | `src/cli.js:14850`, `src/mcp.js:5658`, `test/browsersync-cli.test.js:53` | `desktopName`, `appauth.detectAppAccount().account` değerinin keyflip profil adı olduğunu varsayıyor. Oysa bu alan Desktop'ın `claude-code-sessions/<hesap-UUID>` klasör adı. Gerçek makinede klasör adları UUID; profil adları `work`/`gmail` gibi. Sonuç: `desktopName` hep `null`. `browser status` masaüstünü "(unsaved)"/e-posta olarak gösterir, `differ` hiç true olmaz, `--for desktop` "which account?" ile düşer, `sync` iki yüzey farklıyken tahmin yürütmeden CLI hesabına geçer. Bu, işin önlemek istediği hatanın ta kendisi. Test fixture'ı klasörü profil adıyla (`.../claude-code-sessions/beta/<org>`) kurduğu için K4/K4b yalancı yeşil veriyor. | Profili org üzerinden eşle: `det.org` varsa `profiles.list()` içinde `oauthAccount.organizationUuid === det.org` olan profili al (`cmdList` ~17385'teki desen). Ortak bir yardımcıya taşı ve CLI ile MCP aynı yardımcıyı kullansın. `det.reason` boş değilse (yedek okuma) sonucu "tahmini" diye işaretle. Fixture'da klasör adını UUID yap (örn. `cccccccc-…`). K4/K4b bu haliyle yeniden yeşil olmalı. |
| büyük | `src/cli.js:14868` | `sync <ad>` içindeki ad bir profile çözülmezse (yazım hatası, silinmiş hesap) `name:null` gidiyor ve `resolveTarget` varsayılan hedefe, yani CLI hesabına düşüyor. `--yes` ile tarayıcı istenmeyen hesaba kapatılıp açılıyor. `capture` (15004) ve MCP (`no such saved account`) bu durumu reddediyor, `sync` reddetmiyor. | Konumsal argüman verildiyse ve `core.resolveProfile` null dönüyorsa `fail("no such saved account: '<ad>' (see: keyflip list)")` ver, çıkış != 0. Bunu `--yes` ile çalıştıran bir black-box test ekle; cookie DB değişmemeli. |
| küçük | `src/cli.js:14849`, `src/mcp.js:5657` | `detectAppAccount` token önbelleğini çözmek için Keychain'e gidiyor. Artık her `browser status`/`capture`/`sync` çağrısında ve MCP'nin salt plan çağrısında çalışıyor. `desktopTugRisk` yorumu bu yüzden bilinçli olarak `detectActiveOrg` kullanıyor. Keychain izni yoksa kullanıcı plan için bile istem görür. | Yüzey tespitinde önce `appauth.detectActiveOrg(ctx)` (Keychain'siz) ile org→profil eşlemesi yap. Çözümü yalnız gerçekten gerektiğinde (`--for desktop`/sync onaylıyken) dene. |
| küçük | `src/cli.js:15093` | Doğrulama başarısız olsa bile "✅ <tarayıcı>: claude.ai session restored for X." satırı yeşil onayla basılıyor, uyarı ondan sonra geliyor. K7 "başarı demez" diyor; ✅ işareti başarı gibi okunur. | Doğrulanmamış tarayıcıda nötr işaret kullan (`·` "cookies written") ya da ✅'yi doğrulama `ok` olduktan sonra bas. |
| küçük | `src/browserplan.js:54-55` | Profilde `organizationUuid` yoksa (`wantOrg` null) yalnız `sessionKey` varlığı `ok` sayılıyor ve `verified:true` dönüyor. Hesap aslında doğrulanmamış oluyor. | `wantOrg` yoksa `{ state: 'unverifiable-account' }` dön (ok değil) ve çıktıda bunu söyle. |
| küçük | `src/cli.js:15003` | `capture` ad verilmeden çalışınca iki yüzey farklıysa (`ambiguous`) sessizce CLI hesabını seçiyor. `--account` değeri eksikse (`--account` son argümansa) yine varsayılana düşüyor. Org koruması yanlış kaydı çoğu durumda engelliyor, ama org okunamazsa engellemiyor. | `surfaces.target.ambiguous` ise `sync`'teki gibi `--account`/`--for` iste. `--account` değersizse `fail` ver. |
| küçük | `src/cli.js:14919` | Uyumsuzlukta "Fix:" satırı, hedef `--for desktop` olsa bile CLI hesabına (`activeLabel`) giriş yapmayı söylüyor. | Satırda `shown(surfaces.target.name)` kullan. |
| küçük | `test/browsersync-cli.test.js:215` | Test adı "unreadable/other-account" diyor ama yalnız okunamayan oturumu sınıyor. `other-account` reddi CLI uçtan uca sınanmıyor (TEST.md bunu dürüstçe "kısmen" yazmış). | Test adını "unreadable" yap ya da `browserCapture`'a `readClaudeCookies` fixture'ı (başka org) verip `other-account` reddini sınayan birim test ekle. |

## Düzeltme sonrası tester'ın bakacakları
- Gerçek makinede, Desktop ve CLI farklı hesaptayken: `keyflip browser status` iki hesabı adıyla gösteriyor ve DIFFERENT uyarısını veriyor mu? `keyflip browser sync` (`--for`suz) çıkış != 0 veriyor mu? Tarayıcıya dokunulmamalı.
- `keyflip browser sync olmayanhesap --yes` reddediliyor mu, tarayıcı PID'i aynı kalıyor mu?
