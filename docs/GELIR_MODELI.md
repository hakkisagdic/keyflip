# Keyflip Kontrol Merkezi — Gelir Modeli ve Ürünleştirme Notu

Bu belge, `keyflip` menü çubuğu uygulamasının (`apps/menubar`) ve birleşik arka plan servisinin (`com.keyflip.daemon`) **keyflip'in ücretli katmanının (Pro / Team) yüzü** olarak nasıl konumlandığını, ücretsiz CLI ile ücretli Kontrol Merkezi arasındaki sınırı ve dağıtım/lisanslama mimarisini tanımlar.

---

## 1. Ürün Konumlandırması: Neden Menü Çubuğu Ücretli Katmanın Yüzüdür?

Komut satırı aracı (`keyflip`), teknik kullanıcıların tekil hesap geçişi ve oturum kurtarma ihtiyacını çözer; bu katman açık kaynak (MIT) kalarak doğal büyüme hunisini (funnel) oluşturur. Ancak yoğun yapay zekâ destekli geliştirme yapan bireyler ve ekipler için asıl maliyet **"oturumun yarıda kesilmesi ve hangi aracın kotasının ne zaman dolacağının bilinmemesi"** sorunudur.

**Keyflip Kontrol Merkezi** bu sorunu üç temel sütunla çözer ve ücretli katmanın somut, her an görünür değerini oluşturur:

1. **Sıfır Kesintili Otomatik Süreklilik (Daemon + Otomatik Yedek Zincir)**:
   - Arka planda çalışan tek denetimli servis (`com.keyflip.daemon`), OAuth tokenlarını süresi dolmadan yeniler (`6cbc3ea`), 5 saatlik / 7 günlük kullanımı izler ve eşik (`%95`) aşıldığında diğer uygun hesaba geçer.
   - Tüm abonelik hesapları dolduğunda, bütçe tavanı (`capUsd`) korumalı **Keysmith API yedek zincirini (`39a01b7`)** otomatik devreye alır; ilk uygun hesap sıfırlandığında (`recoverAt`) otomatik olarak aboneliğe geri döner.
2. **Tek Bakışta Çoklu Araç Kota Görünürlüğü**:
   - Geliştirici yalnızca Claude kullanmaz; aynı anda **Kiro kredisi**, **GitHub Copilot**, **Antigravity (`agy`)**, **EVREN** ve **Claude aylık API promosyon kredilerini (`apicredits`)** tüketir.
   - Menü çubuğu uygulaması, eklenti tabanlı kota okuyucularıyla (`~/.config/keyflip/quotas/<id>.json` ve yerel anlık görüntüler) tüm araçların kalan kotalarını tek pencerede toplar. Okunamayan veriyi asla uydurmaz; açıkça `"okunamadı"` olarak işaretler.
3. **Denetimli Yerel Servis ve Filo Kontrolü**:
   - Keysmith Gateway, yerel yönlendirici (router), `polyctl` admin-tick, gece yedekleri ve embedding koruyucu servislerinin sağlık durumunu, son başarılı çalışmasını ve son hatasını gösterir.
   - Kullanıcı onayı (`confirm: true`) ve denetim günlüğü (`keyflip.log` + `events.jsonl`) güvencesiyle servisleri tek tıkla yeniden başlatma olanağı sunar.

---

## 2. Katman Matrisi (Free vs. Pro vs. Team)

| Özellik Kümesi | **Free (Açık Çekirdek CLI)** | **Pro (Kontrol Merkezi)** | **Team / Enterprise** |
|---|---|---|---|
| **Hedef Kullanıcı** | Tekil geliştirici, manuel kullanım | Yoğun AI kullanan profesyonel geliştirici | Çoklu ajan / çoklu geliştirici ekipleri |
| **Fiyat (Gösterge)** | **$0** (MIT, npm / Homebrew) | **~$9–12 / ay** (veya yıllık indirimli) | **~$8–10 / koltuk / ay** |
| **Claude Hesap Değiştirme** | Elle (`keyflip <hesap>`, `keyflip next`) | Otomatik eşik geçişi + Menü çubuğundan onaylı geçiş | Ekip havuzu (RBAC) + merkezi politika |
| **Token Yenileme & Daemon** | Tek seferlik CLI komutları | `com.keyflip.daemon` ile kesintisiz arka plan yenileme | Çoklu makine filo senkronizasyonu |
| **Yedek Zincir (API Failover)** | Manuel durum görüntüleme | Otomatik devreye girme/çıkma + harcama tavanı kontrolü | Kurumsal paylaşımlı bütçe ve maliyet muhasebesi |
| **Çoklu Araç Kotaları** | Yalnızca Claude CLI kullanımı | Kiro, Copilot, `agy`, EVREN, API promosyonları (`apicredits`) | Özel kurumsal kota eklentileri |
| **macOS Menü Çubuğu (`apps/menubar`)** | Salt-okunur temel durum (veya xbar çıktısı) | Tam yerel SwiftUI Kontrol Merkezi + bildirimler | Filo (`fleet`) ve sunucu (`server`) izleme |

---

## 3. Gizlilik ve Çevrimdışı Lisans Mimarisi (`src/license.js`)

Keyflip'in temel marka sözü **"yerel-öncelikli, sıfır telemetri, sır sızdırmama"** ilkesidir. Ücretli katman bu ilkeyi bozmadan çalışır:

1. **Çevrimdışı Ed25519 Lisans Doğrulaması (No Phone-Home)**:
   - Müşteri ödeme yaptığında (`issuer/` servisi üzerinden Lemon Squeezy, Stripe, iyzico veya PayTR webhook'u ile), `{ tier, email, expiry, issued }` yükü Ed25519 özel anahtarıyla imzalanır.
   - İmzalı lisans jetonu `~/.config/keyflip/license.json` (`0600`) dosyasına kaydedilir (`keyflip license activate <dosya>`).
   - Hem `keyflip daemon` hem de `KeyflipControlCenter.app` (daemon soketi üzerinden), `src/license.js` içindeki gömülü Ed25519 açık anahtarıyla lisansı **tamamen çevrimdışı** doğrular; hiçbir lisans sunucusuna ağ isteği atılmaz.
2. **Sıfır Sır (Zero-Secret) Sınırı**:
   - Menü çubuğu uygulaması (`apps/menubar`) hiçbir zaman macOS Keychain'e, OAuth `accessToken`/`refreshToken` değerlerine, `sessionKey` çerezlerine veya yönetici API anahtarlarına (`sk-ant-admin...`) erişmez.
   - Uygulama yalnızca `~/.config/keyflip/daemon.sock` (`0600`) üzerinden `redactSecrets()` süzgecinden geçmiş JSON özetini okur.
3. **Yumuşak Geçiş (Soft Degradation)**:
   - Lisans süresi dolduğunda veya lisans bulunmadığında daemon ve menü çubuğu uygulaması **asla çökmez** ve kullanıcının mevcut oturumunu bozmaz.
   - CLI üzerinden manuel hesap geçişi çalışmaya devam eder; menü çubuğundaki Pro otomasyon özellikleri (otomatik failover, çoklu araç kota eklentileri) nazik bir `"Pro plan ile etkinleştirin"` bilgisi gösterir.

---

## 4. Paketleme, İmzalanma ve Dağıtım Hattı

`apps/menubar` ve `Makefile`, yerel geliştirmeden Apple onaylı (Notarized) üretime doğrudan geçebilecek şekilde yapılandırılmıştır:

1. **Yerel Geliştirme (İmzasız Derleme)**:
   - `make menubar` komutu SwiftUI paketini derler ve `apps/menubar/build/KeyflipControlCenter.app` paketini oluşturur.
   - `make menubar-test` komutu model, kota eşiği ve soket istemcisi birim testlerini koşturur.
2. **Üretim İmzası ve Apple Notarization**:
   - `make menubar-sign DEVELOPER_ID="Developer ID Application: ..."` komutu `apps/menubar/Entitlements.plist` ve Hardened Runtime (`--options runtime`) ile `.app` paketini imzalar.
   - `make menubar-notarize NOTARY_PROFILE="..."` komutu paketi `xcrun notarytool` ile Apple'a gönderir ve onay biletini (`xcrun stapler staple`) pakete zımbalar.
3. **Kullanıcıya Teslimat**:
   - **CLI + Daemon**: `npm install -g keyflip` veya `brew install keyflip`
   - **Menü Çubuğu Uygulaması**: `brew install --cask keyflip-control-center` veya web sitesinden doğrudan imzalı `.dmg` / `.zip` indirmesi.
