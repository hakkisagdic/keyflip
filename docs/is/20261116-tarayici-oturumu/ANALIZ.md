# 20261116-tarayici-oturumu: Tarayıcı oturumu sessizce değişmesin, doğru hesabı izlesin

## Bugün ne var
- `src/cli.js` `cmdBrowser` (~14780): `status|logout|capture|sync`. `sync` -> `browserSync()` (~14643): tarayıcıyı sorusuz kapatır, cookie yazar, yeniden açar, sonra "synced" yazar. Aynısı `src/mcp.js` `keyflip_browser_sync` (~5623): `confirm` var ama açıklama tarayıcının yeniden başlayacağını söylemiyor; kapatma mantığı kopya.
- `status` yalnız `claude auth status` (CLI) hesabını "olması gereken" sayar; masaüstü uygulamasının hesabını (`appauth.detectAppAccount`) hiç göstermez. Öneri: yalnız `logout`.
- `capture <ad>` zaten var (`browserCapture`, ~14773) ama ad zorunlu, `--account` yok. Sağlam: başka hesabın oturumunu reddeder.
- `sync` kaydı yoksa "yet" diye tek cümle basar; iki adımı söylemez.
- `keyflip list` "web" sütunu (~17390) canlı tarayıcı org'una bakar, KAYITLI oturuma değil. Bu yüzden capture sonrası kalıcı `web ✓` görünmez.
- `src/browserswitch.js` `align()` (hesap geçişi bacağı) tarayıcıyı yalnız sekmeleri geri getirecekse kapatır; bu kural `browserSync`te yok.
- Testler: `test/browser.test.js`, `test/browserswitch.test.js`, `test/app-preserve.test.js` (capture).

## Ne değişecek
1. Yeni saf modül `src/browserplan.js` (+ `test/browserplan.test.js`): hedef hesabı çözer, plan üretir, doğrulama sonucunu sınıflar. CLI ve MCP aynı modülü kullanır; `mcp.js`teki kopya silinir.
2. `sync` önce tek satır plan basar: hangi tarayıcı, "açık sekmeleri tarayıcı kendisi geri getirir" (yalnız `restoresTabs` doğruysa; değilse "sekmeler kaybolabilir" uyarısı), hangi hesap. `--yes`/`-y` yoksa: TTY'de e/h sorusu, TTY değilse planı basıp çıkış kodu 1. MCP: `confirm` zorunlu, açıklamaya "tarayıcıyı yeniden başlatır" eklenir; `confirm` yoksa plan döner, kapatma yapılmaz.
3. `status`: CLI ve masaüstü farklı hesaptaysa ikisini de açıkça yazar. `--for cli|desktop|<hesap>` hedefi seçer (status, sync, MCP `for`).
4. `capture [ad] [--account X]`: ad verilmezse hedef hesap. `list` "web" artık kayıtlı oturum varlığına bakar (canlı olması ayrı işaret).
5. `sync` için kayıtlı oturum yoksa: "X için kayıtlı tarayıcı oturumu yok" + 2 adım (tarayıcıda claude.ai'a X ile giriş yap; `keyflip browser capture --account X`). Başka hesabın oturumunu asla geri yüklemez.
6. Sync sonrası doğrulama: tarayıcı açıldıktan sonra cookie yeniden okunur (kısa bekleme); sessionKey var ve org hedefle aynı mı. Eklentinin kendi giriş durumu okunamaz: çıktı bunu dürüstçe söyler ("tarayıcı oturumu X; eklenti paneline bak, giriş ekranındaysa claude.ai'ı bir kez yenile"). Doğrulanamazsa "başarılı" yazılmaz, çıkış kodu 0 ama uyarı satırı + JSON `verified:false`.
7. Hiçbir çıktı cookie/token/değer basmaz; yalnız tarayıcı adı, hesap adı, org'un ilk 8 hanesi.

## Kabul kontrolleri
- K1: Given Chrome açık, when `keyflip browser sync <hesap>` (TTY'siz, `--yes`siz), then plan satırı (tarayıcı, sekme notu, hesap) basılır, çıkış kodu != 0, Chrome süreci aynı PID ile açık kalır (`pgrep -x "Google Chrome"` önce/sonra aynı).
- K2: Given aynı komut `--yes` ile ve kayıtlı oturum var, when çalışır, then plan satırı ÖNCE basılır, sonra tarayıcı yeniden açılır, doğrulama satırı çıkar.
- K3: Given MCP `keyflip_browser_sync` `confirm` olmadan, when çağrılır, then hata/plan döner ve tarayıcıya dokunulmaz; tool açıklaması "restart" sözcüğünü içerir (`tools/list`).
- K4: Given CLI hesap A, masaüstü hesap B, when `keyflip browser status`, then iki hesap da adıyla görünür ve "farklı" uyarısı çıkar; `--for desktop` hedefi B yapar, `--for cli` A (JSON `target`).
- K5: Given B'nin kayıtlı tarayıcı oturumu yok, when `keyflip browser sync --for B --yes`, then hiçbir şey geri yüklenmez, "kayıtlı oturum yok" ve 2 adım yazılır, çıkış kodu != 0.
- K6: Given tarayıcı B ile giriş yapmış, when `keyflip browser capture --account B`, then "saved" yazılır ve `keyflip list` B satırında `web ✓` görünür; tarayıcı A ile girişliyse B için reddedilir.
- K7: Given sync sonrası cookie yok/yanlış org (fixture), when doğrulama, then çıktı "doğrulanamadı/uyuşmuyor" der, başarı satırı yok.
- K8: Given herhangi bir komut çıktısı ve JSON, when `sessionKey=` veya fixture cookie değeri aranır, then bulunmaz (test grep).
- K9: Given `npm test` ve `npm run lint`, then yeşil; testler yalnız fixture kullanır, gerçek profil okunmaz.

## Riskler
- Erişim/oturum: cookie yazma/okuma. Mevcut güvenlik kuralları korunur; yanlış hesabın oturumu başka ada kaydedilmez (mevcut `other-account` koruması aynen).
- Regresyon (adlandırılmış): `keyflip <hesap>` geçişinin tarayıcı bacağı (`align`) ve `browser logout`/`capture` davranışı değişmemeli (`browserswitch.test.js`, `app-preserve.test.js` yeşil kalır). `onboard/login` içindeki `saveBrowserSession` çağrıları aynı.
- Genel repo: kamuya açık; testlerde gerçek e-posta/yol yok, yer tutucu kullanılır.
- Betik/otomasyon `browser sync`i `--yes`siz çağırıyorsa artık kırılır: bilinçli (CHANGELOG "değişiklik" notu; autoswitch/`align` yolu etkilenmez).
- Kurulum bu checkout'a bağlı: iniş sonrası kurulu komutla `keyflip browser status` ve `--yes`siz `sync` denenir (hiçbir şey yeniden başlamamalı).

## Kararlar
- Varsayılan hedef: CLI ve masaüstü aynıysa o hesap. Farklıysa status varsayılanı `cli` (eklentinin native-messaging ana bilgisayarı Claude Code'a bağlı) ve ikisini de gösterir; ama `sync` iki yüzey farklıyken `--for` olmadan tahmin yürütmez: planı basıp `--for cli|desktop` ister (çıkış != 0). Gerekçe: bu olayda yanlış tahmin tam bu hataydı.
- `--yes` ve mevcut `-y`/`--force` aynı onay sayılır; TTY'de soru sorulur.
- Doğrulama eklenti durumunu okumaz (güvenilir yolu yok); yalnız tarayıcı cookie'sini doğrular ve sınırı açıkça söyler.
- `align()` kuralları (sekme geri gelmiyorsa kapatma) `browser sync`e de uygulanır: sekme geri gelmiyorsa ek uyarı, yine `--yes` gerekir.
- `list` "web": kayıtlı oturum = ✓; yalnız canlıysa mevcut gösterim korunur.
- Kapsam dışı: `review/control-center` ve `fix/ci-and-deps` dallarına dokunulmaz; Chrome eklentisinin kendi girişini otomatikleştirme yok.

## Sahibe sorular
Yok. (Karar gerektiren her şey geri alınabilir ve yukarıda yazıldı.)

## Boyut
M. Mevcut alanda tek özellik: yeni küçük modül + CLI/MCP bağlantısı + testler, tahmini 350-500 satır, yeni ekran yok. `touches.access` true (oturum/cookie): gözden geçiren gerekir, S olamaz; L değil.
