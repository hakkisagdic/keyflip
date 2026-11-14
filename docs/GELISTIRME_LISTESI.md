# Geliştirme Listesi ve Yaratıcı Özellik Önerileri (`GELISTIRME_LISTESI.md`)

Bu liste, `docs/RAKIP_ANALIZI.md` sonucunda belirlenen özellikleri ve Kontrol Merkezi'nin değerini artırmak üzere önerilen **beş yaratıcı özelliği** içerir. En yüksek değerli ilk iki özellik bu turda uygulanmış ve test edilmiştir.

---

## 1. Tamamlanan Temel İşler (Faz 1–4)

- [x] **Faz 1 — Birleşik Gözetimli Daemon (`keyflip daemon`):** 4 eski `launchd` işini tek `KeepAlive` süreçte birleştirme, `0600` Unix soketi, `redactSecrets()` koruması ve `ROLLBACK.md` yedeklemesi.
- [x] **Faz 2 — Yerel macOS Menü Çubuğu Uygulaması (`apps/menubar`):** SwiftUI `MenuBarExtra(.window)` ile 7 bölümlü Kontrol Merkezi, her eylemde kullanıcı onayı (`confirm: true`) ve denetim günlüğü (`AUDIT`).
- [x] **Faz 3 — Gelir Modeli ve Ürünleşme Taslağı (`docs/GELIR_MODELI.md`):** Bireysel Pro ve Takım paketleri, Lemon Squeezy / Paddle karşılaştırması.
- [x] **Faz 4 — Genel Durum Panosu (`status.json`):** `menubar.statusFile` ayarı (varsayılan `~/.polyctl/admin/status.json`), dosya yokken gizlenme, menü çubuğunda `owner_needed` rozeti (`•<sayı>`), açılır/kapanır bölümler, `bad`/`warn` üstte sıralama ve `>20 dk` `"veri eski"` uyarısı (`docs/STATUS-BOARD.md`).

---

## 2. Beş Yaratıcı Özellik Önerisi (En Değerli İkisi Uygulandı)

### ✅ Öneri 1 (UYGULANDI): Akıllı Kota Tüketim Hızı (Burn-Rate) & "Sıfırlanmadan Kullan" (Use-It-Or-Lose-It) Hesap Önerisi
- **Değer:** Yalnızca mevcut yüzdeyi göstermek yerine, 5 saatlik pencerenin kalan süresine göre tüketim hızını (`burnRateRatio`) ve kotanın kaç dakika sonra dolacağını (`minutesUntilExhaustion`) hesaplar. Ayrıca sıfırlanmasına ≤90 dakika kalmış ve ≥%30 boş kapasitesi olan hesabı öne çıkararak boşa gidecek abonelik kapasitesini değerlendirir.
- **Uygulama:** `src/controlcenter.js` (`computeQuotaForecast`), `src/daemon.js` (`base.quotaForecast`), `Models.swift` (`QuotaForecastSummary`) ve `ControlCenterView.swift` (`Önerilen: <hesap>` bandı + `~X dk sonra dolabilir` uyarısı).

### ✅ Öneri 2 (UYGULANDI): Durum Panosu "Yalnızca Sorunlar (`bad`/`warn`)" Hızlı Filtresi & Tek Tıkla Gizlilik Korumalı Markdown Özeti Kopyalama
- **Değer:** Durum Panosu (`status.json`) içinde çok sayıda proje/servis satırı biriktiğinde tek tıkla yalnızca `bad` ve `warn` durumundaki satırları süzer. Üst çubuktaki kopyalama düğmesi (`doc.on.doc`) ile hiçbir token/çerez içermeyen Markdown durum özetini panoya (`NSPasteboard`) kopyalar.
- **Uygulama:** `src/controlcenter.js` (`buildControlCenterMarkdown`), `Models.swift` (`filteredSections(onlyIssues:)`, `buildMarkdownSummary(isStale:)`), `ControlCenterViewModel.swift` (`copySummaryToPasteboard()`) ve `ControlCenterView.swift`.

### 📋 Öneri 3 (Planlandı): Menü Çubuğu Denetim Zaman Çizelgesi (`events.jsonl` Mini Audit Timeline)
- **Değer:** Son gerçekleşen otomatik hesap geçişlerini (`autoswitch`), failover devreye giriş/çıkışlarını ve servis yeniden başlatmalarını menü çubuğu içinde daraltılabilir bir "Son Olaylar" kutusunda zaman damgası ve nedeni ile gösterme.

### 📋 Öneri 4 (Planlandı): Toplantı / Odak Modu ("Sessiz Saatler" — Masaüstü Yeniden Başlatma Erteleme)
- **Değer:** Kullanıcı aktif toplantıdayken veya ekran paylaşırken Claude Desktop'ın arka planda yeniden başlatılmasını 30 / 60 / 120 dakika boyunca tek tıkla erteleyen (`desktop.snoozeUntil`) anahtar.

### 📋 Öneri 5 (Planlandı): Çoklu Makine Durum Panosu Birleştirici (Multi-Host `status.json` Aggregator)
- **Değer:** Birden fazla geliştirme makinesinden veya uzak sunucudan gelen `status.<makine>.json` dosyalarını tek bir Durum Panosu altında makine etiketleriyle birleştirerek gösterme.
