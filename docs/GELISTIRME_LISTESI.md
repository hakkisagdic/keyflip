# Geliştirme Listesi ve Yaratıcı Özellik Önerileri (`GELISTIRME_LISTESI.md`)

Bu liste, `docs/RAKIP_ANALIZI.md` sonucunda belirlenen tüm özelliklerin tamamlanma durumunu ve üçüncü turda önerilen **beş yeni yaratıcı özelliği** (en değerli ikisi uygulanmış olarak) içerir.

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

---

## 2. Listedeki İşler Tamamlandığı İçin Önerilen Beş Yeni Yaratıcı Özellik (En Değerli İkisi Uygulandı)

### ✅ Yeni Öneri 1 (UYGULANDI): Durum Panosu Canlı Arama ve Metin Süzgeci (`searchQuery`)
- **Değer:** Çoklu sunucu/makine (`extraStatusFiles`) ve çoklu proje içeren `status.json` panolarında onlarca satır ve `owner_needed` maddesi arasında aranan servisi, projeyi veya hata mesajını anında bulmak için Durum Panosu üstüne canlı arama çubuğu eklendi. Bölüm başlığı, satır etiketi (`label`), değeri (`value`), detayı (`detail`) ve `owner_needed` proje/metin alanlarını büyük-küçük harf duyarsız olarak anında süzer.
- **Uygulama:** `Models.swift` (`filteredSections(onlyIssues:searchQuery:)`, `filteredOwnerNeeded(searchQuery:)`, `StatusBoardRow.matchesSearch`), `ControlCenterViewModel.swift` (`statusBoardSearchQuery`) ve `ControlCenterView.swift`.

### ✅ Yeni Öneri 2 (UYGULANDI): Kritik Durum Panosu Bölümlerini En Üste Sabitleme (`pinnedSectionIds` / Pin to Top)
- **Değer:** Kullanıcı `status.json` içindeki en kritik bölümleri (ör. `quotas` veya `prod-services`) tek tıkla (`pin.fill`) sabitleyebilir; sabitlenen bölümler JSON dosyasındaki sıradan bağımsız olarak her zaman Durum Panosunun en üstünde yer alır ve tercih `UserDefaults` üzerinde kalıcı olarak saklanır.
- **Uygulama:** `Models.swift` (`orderedSections(pinnedIds:onlyIssues:searchQuery:)`), `ControlCenterViewModel.swift` (`pinnedSectionIds`, `togglePinSection`) ve `ControlCenterView.swift`.

### 📋 Yeni Öneri 3 (Gelecek Adayı): Hesap Başına Haftalık Kota Verimlilik Skoru (Weekly Quota Efficiency Score)
- **Değer:** Her Claude hesabının 7 günlük pencere sıfırlanmadan önce ne kadar verimli kullanıldığını (%90+ kullanım = yüksek verim, <%30 kullanım ile sıfırlanma = atıl kapasite) puanlayarak abonelik optimizasyonu önerme.

### 📋 Yeni Öneri 4 (Gelecek Adayı): Servis Sağlık Geçmişi Mini-Kıvılcım Grafiği (24s Uptime Sparkline)
- **Değer:** `collectServicesStatus` tarafından izlenen 5 ana servisin son 24 saatlik çalışma/hata durumunu tek satırlık Unicode bloklarıyla (`▁▂█▁`) görselleştirme.

### 📋 Yeni Öneri 5 (Gelecek Adayı): Tek Tıkla Anonimleştirilmiş Tanılama Paketi (`keyflip doctor --bundle`)
- **Değer:** Hata bildirimi veya destek için tüm sırları ve kişisel yolları maskeleyerek (`redactSecrets`) son daemon durumunu, yapılandırmayı ve denetim zaman çizelgesini tek bir `.tar.gz` veya JSON paketinde dışa aktarma.
