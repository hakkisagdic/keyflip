# Geliştirme Listesi ve Yaratıcı Özellik Önerileri (`GELISTIRME_LISTESI.md`)

Bu liste, `docs/RAKIP_ANALIZI.md` sonucunda belirlenen tüm özelliklerin tamamlanma durumunu ve dördüncü turda önerilen **beş yeni yaratıcı özelliği** (en değerli ikisi uygulanmış olarak) içerir.

---

## 1. Tamamlanan Temel ve Rakip Analizi İşleri

- [x] **Faz 1 — Birleşik Gözetimli Daemon (`keyflip daemon`):** 4 eski `launchd` işini tek `KeepAlive` süreçte birleştirme, `0600` Unix soketi, `redactSecrets()` koruması ve `ROLLBACK.md` yedeklemesi.
- [x] **Faz 2 — Yerel macOS Menü Çubuğu Uygulaması (`apps/menubar`):** SwiftUI `MenuBarExtra(.window)` ile Kontrol Merkezi, her eylemde kullanıcı onayı (`confirm: true`) ve denetim günlüğü (`AUDIT`).
- [x] **Faz 3 — Gelir Modeli ve Ürünleşme Taslağı (`docs/GELIR_MODELI.md`):** Bireysel Pro ve Takım paketleri, Lemon Squeezy / Paddle karşılaştırması.
- [x] **Faz 4 — Genel Durum Panosu (`status.json`):** `menubar.statusFile` ayarı (varsayılan `~/.polyctl/admin/status.json`), dosya yokken gizlenme, menü çubuğunda `owner_needed` rozeti (`•<sayı>`), açılır/kapanır bölümler, `bad`/`warn` üstte sıralama ve `>20 dk` `"veri eski"` uyarısı (`docs/STATUS-BOARD.md`).
- [x] **Akıllı Kota Tüketim Hızı (Burn-Rate) & "Sıfırlanmadan Kullan" (`computeQuotaForecast`):** 5 saatlik pencerenin kalan süresine göre tükenme tahmini (`~X dk sonra dolabilir`) ve sıfırlanmasına ≤90 dakika kalmış, ≥%30 boş kapasiteli hesabı önerme.
- [x] **Durum Panosu "Yalnızca Sorunlar (`bad`/`warn`)" Hızlı Filtresi & Tek Tıkla Markdown Özeti Kopyalama (`⌘⇧C`):** Sorunlu satırları tek tıkla süzme ve sıfır-sır garantili Markdown raporunu panoya kopyalama.
- [x] **Menü Çubuğu Denetim Zaman Çizelgesi (`collectAuditTimeline` / `SON OLAYLAR`):** `events.jsonl` içindeki son hesap geçişlerini, failover hareketlerini ve servis yeniden başlatmalarını menü çubuğu içinde açılır/kapanır zaman çizelgesinde gösterme.
- [x] **Toplantı / Odak Modu (`desktop.snoozeUntil` — Masaüstü Yeniden Başlatma Erteleme):** Üst çubuktaki ay (`moon.fill`) düğmesi ile otomatik Claude Desktop yeniden başlatmalarını 60 dakika boyunca onaylı olarak erteleme.
- [x] **Çoklu Makine Durum Panosu Birleştirici (`menubar.extraStatusFiles`):** Birden fazla `status.json` dosyasını `[<host>]` etiketiyle tek Durum Panosu altında birleştirme.
- [x] **Durum Panosu Satır Süreklilik Yaşlandırması (`sinceAge`) & Toplu Daralt/Genişlet:** `since` zaman damgasından otomatik `"45 dk"`, `"2 saat"` hesaplama ve tüm bölümleri tek tıkla daraltıp genişletme.
- [x] **Failover Harcama Hızı ve Tavan Sağlığı (`evaluateFailoverSpendHealth`):** Yedek zincir devredeyken `$/saat` harcama hızını (`burnUsdPerHour`) ve tavana kalan dakikayı (`estimatedMinutesToCap`) hesaplayıp uyarı gösterme.
- [x] **Hesap Havuzu OAuth Hazırlık ve Ön-Isıtma Özeti (`evaluatePoolReadiness`):** Etkin hesapların kaçının geçerli OAuth belirtecine ve boş kapasiteye sahip olduğunu (`readyForRotation`) ve süresi yakında dolacak hesapları (`needsPreWarm`) raporlama.
- [x] **Durum Panosu Kritik Geçiş Tespiti (`detectStatusBoardTransitions` / `newlyDegradedRows`):** Yeni `bad` durumuna geçen satırları ve artan `owner_needed` maddelerini anında tespit edip üst çubukta uyarı gösterme.
- [x] **Durum Panosu Canlı Arama (`searchQuery`) & Bölüm Sabitleme (`pinnedSectionIds`):** Durum panosu satırlarını anlık arama ile filtreleme ve sabitlenen bölümleri en üstte tutma.
- [x] **Hesap Başına Haftalık Kota Verimlilik Sınıflandırması (`weeklyEfficiency`):** 7 günlük pencere kullanımını `optimal`, `balanced`, `underutilized`, `saturated` olarak sınıflandırma.
- [x] **Servis Sağlık Kıvılcım Grafiği (`sparkline` — `█/▁`):** İzlenen servislerin son log satırlarındaki başarı/hata durumunu tek bakışlık Unicode kıvılcım dizisiyle (`████▁█`) gösterme.
- [x] **Anonimleştirilmiş Tanılama Paketi (`buildDiagnosticBundle`):** E-posta adreslerini, ev dizini yollarını ve tüm OAuth/API sırlarını maskeleyerek (`keyflip.diagnostic.v1`) dışa aktarma.

---

## 2. Listedeki İşler Tamamlandığı İçin Önerilen Beş Yeni Yaratıcı Özellik (En Değerli İkisi Uygulandı)

### ✅ Yeni Öneri 1 (UYGULANDI): Menü Çubuğundan Tek Tıkla Onaylı OAuth Ön-Isıtma (`triggerDaemonJob: refresh` / `Ön-Isıt`) ve Havuz Ufku (`evaluatePoolHorizonAndQuietHours`)
- **Değer:** Kullanıcı yoğun bir çalışma veya toplantı seansına girmeden hemen önce `HESAPLAR` bölümündeki **`Ön-Isıt`** düğmesine tıklayarak (onay penceresi ve denetim günlüğü kaydıyla) daemon üzerindeki `refresh` görevini anında tetikleyebilir; ayrıca tüm etkin hesapların birleşik kalan 5 saatlik kapasitesi (`poolHorizon`) hesaplanır.
- **Uygulama:** `src/controlcenter.js` (`evaluatePoolHorizonAndQuietHours`), `Models.swift` (`PoolHorizonSummary`, `PendingConfirmationAction.triggerDaemonJob`), `ControlCenterViewModel.swift` (`requestTriggerDaemonJob`) ve `ControlCenterView.swift`.

### ✅ Yeni Öneri 2 (UYGULANDI): Çentik Dostu Dar Menü Çubuğu Etiketi (`compactMenuBarLabel`)
- **Değer:** 14"/16" MacBook Pro ekran çentiği (notch) nedeniyle menü çubuğunda dar alanı olan kullanıcılar, Tercihler altındaki *"Dar menü çubuğu etiketi (yalnızca % + rozet)"* seçeneğiyle tam hesap adı yerine yalnızca kalan yüzdeyi, failover kısaltmasını ve `owner_needed` rozetini (`%58 •2`) görüntüleyebilir.
- **Uygulama:** `KeyflipControlCenterApp.swift` (`MenuBarGlanceLabel.compactMode`), `ControlCenterViewModel.swift` (`compactMenuBarLabel`) ve `ControlCenterView.swift`.

### 📋 Yeni Öneri 3 (Gelecek Adayı): Durum Panosu Satır Bazlı Sessize Alma (`mutedRowKeys`)
- **Değer:** Bilinen ve üzerinde çalışılan bir `bad`/`warn` satırını geçici olarak sessize alarak üst çubuktaki uyarı sayısını kirletmesini önleme.

### 📋 Yeni Öneri 4 (Gelecek Adayı): Failover Maliyet Simülatörü (`estimateFailoverSessionCost`)
- **Değer:** Aktif Claude Code oturumlarının ortalama token tüketimine göre yedek zincirde 1 saat kalınması halinde oluşacak tahmini API maliyetini önceden gösterme.

### 📋 Yeni Öneri 5 (Gelecek Adayı): Durum Panosu JSON Şema Doğrulayıcı (`keyflip status-board validate <dosya>`)
- **Değer:** Harici script yazarlarının ürettikleri `status.json` dosyasını menü çubuğuna bağlamadan önce şema ve ISO tarih formatı açısından CLI üzerinden doğrulaması.
