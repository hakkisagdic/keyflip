# Geliştirme Listesi ve Yaratıcı Özellik Önerileri (`GELISTIRME_LISTESI.md`)

Bu liste, `docs/RAKIP_ANALIZI.md` sonucunda belirlenen tüm özelliklerin tamamlanma durumunu ve ikinci turda önerilen **beş yeni yaratıcı özelliği** (en değerli ikisi uygulanmış olarak) içerir.

---

## 1. Tamamlanan Temel ve Rakip Analizi İşleri

- [x] **Faz 1 — Birleşik Gözetimli Daemon (`keyflip daemon`):** 4 eski `launchd` işini tek `KeepAlive` süreçte birleştirme, `0600` Unix soketi, `redactSecrets()` koruması ve `ROLLBACK.md` yedeklemesi.
- [x] **Faz 2 — Yerel macOS Menü Çubuğu Uygulaması (`apps/menubar`):** SwiftUI `MenuBarExtra(.window)` ile Kontrol Merkezi, her eylemde kullanıcı onayı (`confirm: true`) ve denetim günlüğü (`AUDIT`).
- [x] **Faz 3 — Gelir Modeli ve Ürünleşme Taslağı (`docs/GELIR_MODELI.md`):** Bireysel Pro ve Takım paketleri, Lemon Squeezy / Paddle karşılaştırması.
- [x] **Faz 4 — Genel Durum Panosu (`status.json`):** `menubar.statusFile` ayarı (varsayılan `~/.polyctl/admin/status.json`), dosya yokken gizlenme, menü çubuğunda `owner_needed` rozeti (`•<sayı>`), açılır/kapanır bölümler, `bad`/`warn` üstte sıralama ve `>20 dk` `"veri eski"` uyarısı (`docs/STATUS-BOARD.md`).
- [x] **Akıllı Kota Tüketim Hızı (Burn-Rate) & "Sıfırlanmadan Kullan" (`computeQuotaForecast`):** 5 saatlik pencerenin kalan süresine göre tükenme tahmini (`~X dk sonra dolabilir`) ve sıfırlanmasına ≤90 dakika kalmış, ≥%30 boş kapasiteli hesabı önerme.
- [x] **Durum Panosu "Yalnızca Sorunlar (`bad`/`warn`)" Hızlı Filtresi & Tek Tıkla Markdown Özeti Kopyalama:** Sorunlu satırları tek tıkla süzme ve sıfır-sır garantili Markdown raporunu panoya kopyalama.
- [x] **Menü Çubuğu Denetim Zaman Çizelgesi (`collectAuditTimeline` / `SON OLAYLAR`):** `events.jsonl` içindeki son hesap geçişlerini, failover hareketlerini ve servis yeniden başlatmalarını menü çubuğu içinde açılır/kapanır zaman çizelgesinde gösterme.
- [x] **Toplantı / Odak Modu (`desktop.snoozeUntil` — Masaüstü Yeniden Başlatma Erteleme):** Üst çubuktaki ay (`moon.fill`) düğmesi ile otomatik Claude Desktop yeniden başlatmalarını 60 dakika boyunca onaylı olarak erteleme.
- [x] **Çoklu Makine Durum Panosu Birleştirici (`menubar.extraStatusFiles`):** Birden fazla `status.json` dosyasını `[<host>]` etiketiyle tek Durum Panosu altında birleştirme.

---

## 2. Listedeki İşler Tamamlandığı İçin Önerilen Beş Yeni Yaratıcı Özellik (En Değerli İkisi Uygulandı)

### ✅ Yeni Öneri 1 (UYGULANDI): Durum Panosu Satır Süreklilik Yaşlandırması (`sinceAge` / "Ne Kadar Süredir Bozuk?")
- **Değer:** `status.json` içindeki `bad` veya `warn` satırlarında `since` ISO zaman damgası bulunduğunda, satırın ne kadar süredir o durumda olduğunu (`"45 dk"`, `"2s 15dk"`, `"3 gün"`) otomatik hesaplar ve `45 dk · 17:45` biçiminde gösterir. Böylece anlık dalgalanma ile kronik kesintiler ilk bakışta ayırt edilir.
- **Uygulama:** `src/controlcenter.js` (`formatSinceAge`, `sortStatusBoardRows`), `Models.swift` (`StatusBoardRow.formattedSinceDuration(now:)`) ve `ControlCenterView.swift`.

### ✅ Yeni Öneri 2 (UYGULANDI): Durum Panosu Toplu Daralt/Genişlet & `⌘⇧C` Hızlı Raporlama Kısayolları
- **Değer:** Durum panosunda çok sayıda bölüm açıkken tek tıkla tüm bölümleri daraltıp genişletme (`Daralt` / `Genişlet`) ve menü çubuğu penceresi açıkken `⌘⇧C` klavye kısayolu ile gizlilik korumalı Markdown durum özetini anında panoya kopyalama.
- **Uygulama:** `ControlCenterView.swift` (`allCollapsed` toplu kontrolü ve `.keyboardShortcut("c", modifiers: [.command, .shift])`).

### 📋 Yeni Öneri 3 (Gelecek Adayı): Harcama Anomalisi ve Saatlik Failover Hız Kesen (Hourly Spend Breaker)
- **Değer:** Yedek zincir (API failover) devredeyken aylık/toplam tavana ek olarak son 15 dakikadaki harcama hızı olağandışı yükselirse kullanıcıya anlık bildirim gönderme.

### 📋 Yeni Öneri 4 (Gelecek Adayı): Otomatik OAuth Yenileme Ön-Kontrol Isıtıcısı (Pre-Warm Check Before Peak Hours)
- **Değer:** Kullanıcının yoğun çalışma saatleri başlamadan hemen önce tüm kayıtlı profillerin OAuth ve yüzey çerezlerini kontrol edip süresi dolmak üzere olanları sessizce yenileme.

### 📋 Yeni Öneri 5 (Gelecek Adayı): Durum Panosu Webhook / Yerel Bildirim Tetikleyicisi (`bad` Geçişlerinde Anlık Uyarı)
- **Değer:** `status.json` içinde bir satır `ok` durumundan `bad` durumuna ilk kez geçtiğinde macOS yerel bildirimi (`notify.desktop`) gönderme.
