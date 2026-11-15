# Geliştirme Listesi ve Yaratıcı Özellik Önerileri (`GELISTIRME_LISTESI.md`)

Bu liste, `docs/RAKIP_ANALIZI.md` sonucunda belirlenen tüm özelliklerin tamamlanma durumunu ve sekizinci turda önerilen **beş yeni yaratıcı özelliği** (en değerli ikisi uygulanmış olarak) içerir.

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
- [x] **Menü Çubuğundan Tek Tıkla Onaylı OAuth Ön-Isıtma (`triggerDaemonJob: refresh`) ve Havuz Ufku (`evaluatePoolHorizonAndQuietHours`):** `HESAPLAR` bölümünden tek tıkla (`Ön-Isıt`) kullanıcı onaylı `refresh` tetikleme ve toplam kalan 5 saatlik kapasiteyi hesaplama.
- [x] **Çentik Dostu Dar Menü Çubuğu Etiketi (`compactMenuBarLabel`):** MacBook ekran çentiği (notch) için menü çubuğu etiketini yalnızca kalan yüzde ve `owner_needed` rozetine (`%58 •2`) daraltma.
- [x] **Durum Panosu Satır Bazlı Sessize Alma (`mutedRowKeys`):** Bilinen ve üzerinde çalışılan bir `bad`/`warn` satırını geçici olarak sessize (`bell.slash.fill`) alarak sorun sayacından ve "Yalnızca Sorunlar" filtresinden düşürme.
- [x] **Failover Maliyet Simülatörü (`estimateFailoverSessionCost`):** Aktif Claude Code oturumlarının ortalama token tüketimine göre yedek zincirde 1 saatlik standart çalışmanın tahmini API maliyetini (`~$2.40/saat`) ve kalan tavanın kaç saat yeteceğini hesaplama.
- [x] **Durum Panosu JSON Şema Doğrulayıcı (`keyflip status-board validate [dosya] [--json]`):** Harici script yazarlarının ürettikleri `status.json` dosyasını şema ve ISO-8601 tarih formatı açısından CLI üzerinden doğrulaması.
- [x] **Hesap Havuzu Dayanıklılık ve SPOF Riski Derecesi (`evaluatePoolResilienceScore` — `0-100` / `A`–`D`):** Hesap yedekliliği, OAuth geçerliliği, kota boşluğu ve failover hazırlığına göre dayanıklılık notu üretme.
- [x] **Durum Panosu Ağırlıklı SLA / Sağlık Yüzdesi (`computeStatusBoardHealth` & `computedHealthPct`):** Tüm bölümlerdeki satırların ağırlıklı sağlık yüzdesini (`%65 sağlıklı`) hesaplayıp gösterme.
- [x] **Olay Zaman Çizelgesi Tür Filtresi (`auditKindFilter` — `Tümü / Geçiş / Failover / Servis`):** `SON OLAYLAR (DENETİM)` bölümündeki kayıtları kategoriye göre filtreleme.
- [x] **Haftalık Sıfırlama Takvimi Özeti (`buildWeeklyResetCalendar`):** Etkin hesapların 7 günlük sıfırlama gün ve saatlerini kronolojik sıralayarak sıradaki sıfırlamayı (`Sıradaki 7g sıfırlama: ...`) gösterme.
- [x] **Durum Panosu Fark Özeti CLI Komutu (`keyflip status-board diff <eski.json> <yeni.json> [--json]`):** İki `status.json` anlık görüntüsü arasındaki kötüleşen (`degraded`), iyileşen (`recovered`) satırları ve `owner_needed` farklarını karşılaştırma (`diffStatusBoards`).
- [x] **Çoklu Sağlayıcı AI Süreklilik ve Çeşitlilik Endeksi (`evaluateMultiProviderContinuity`) & Birleşik Servis Filosu Sağlık Skoru (`evaluateServicesHealthSummary`):** Tüm aktif AI yüzeyleri ve yerel servis filosu için birleşik süreklilik ve sağlık puanları.
- [x] **Kota Darboğaz Penceresi Tahmincisi (`predictDailyBottleneckWindow`):** `events.jsonl` içindeki hesap rotasyonu ve failover olaylarının yoğunlaştığı UTC saat dilimini (`14:00-15:00 UTC`) tespit edip `HESAPLAR` bölümünde gösterme.
- [x] **Durum Panosu Anlık Görüntü Kaydedici (`keyflip status-board snapshot [dosya] [--json]`):** Mevcut `status.json` dosyasını doğrulayıp `<configDir>/status-snapshots/` altına zaman damgalı olarak yedekleme (`snapshotStatusBoard`).
- [x] **Menü Çubuğu Klavye Navigasyon Kısayolları (`⌘1`..`⌘3` Hesap Seçimi):** Kontrol Merkezi açıkken ilk 3 etkin hesaba klavye kısayolu (`requestSwitchAccountBySlot`) ile kullanıcı onaylı geçiş başlatma.
- [x] **Derin Çalışma / Oturum Öncesi Hazırlık Kontrol Listesi (`evaluateWorkSessionReadiness`) & Abonelik Değer / ROI Analizi (`evaluateSubscriptionValueROI`):** 5 maddelik oturum hazırlık kontrolü (`Oturuma Hazır (5/5 kontrol tam)`) ve 7 günlük abonelik kullanımından üretilen eşdeğer API değeri (`~$48 eşdeğer API değeri`).
- [x] **Durum Panosu Snapshot Geçmişi ve Canlı Diff (`keyflip status-board history [--json]` / `listStatusBoardSnapshots`):** `<configDir>/status-snapshots/` altındaki anlık görüntüleri listeleme ve en son snapshot ile canlı `status.json` dosyasını otomatik karşılaştırma.
- [x] **Hesap Rotasyon Soğuma Süresi ve Ping-Pong Koruması Analizi (`evaluateRotationStability`):** Hesaplar arasında `<15 dk` içinde tekrarlayan hızlı geçişleri (`thrashing`) tespit edip menü çubuğunda uyarı gösterme.
- [x] **Menü Çubuğu Hızlı Sorun Kopyalama (`buildIssuesOnlySummary` / `copyIssuesOnlySummary`):** Durum panosunda yalnızca sessize alınmamış `bad`/`warn` satırlarını ve `owner_needed` maddelerini içeren kısa özeti üretip panoya kopyalama.

---

## 2. Listedeki İşler Tamamlandığı İçin Önerilen Beş Yeni Yaratıcı Özellik (En Değerli İkisi Uygulandı)

### ✅ Yeni Öneri 1 (UYGULANDI): Traycer Ajan Filosu Verimlilik ve Takılı Ajan Sağlık Skoru (`evaluateFleetEfficiency`)
- **Değer:** `FİLO (TRAYCER)` bölümünde yalnızca ham sayıları (`3 çalışıyor · 1 boşta · 1 takılı`) göstermek yerine, aktif çalışma oranını (`activeRatioPct`) ve takılı (`stuck`) ajanların oluşturduğu darboğazı `0-100` arasında bir sağlık puanına (`Filo sağlığı: %75 (1 takılı ajan incelenmeli)`) dönüştürerek bölüm başlığında anında görünür kılar.
- **Uygulama:** `src/controlcenter.js` (`evaluateFleetEfficiency`), `src/daemon.js` (`base.fleetEfficiency`), `Models.swift` (`FleetEfficiencySummary`) ve `ControlCenterView.swift` (`fleetAndServerSection`).

### ✅ Yeni Öneri 2 (UYGULANDI): Uzak Sunucu ve Barındırılan Siteler Birleşik SLA Skoru (`evaluateServerSitesHealth`)
- **Değer:** `SUNUCU` bölümünde izlenen web sitelerinin (`sites`) erişilebilirlik durumlarını ve sunucu genel durumunu (`ok` / `warning` / `down`) birleştirerek `0-100` arasında bir **Site SLA Puanı** (`Site SLA: %100 (3/3 site aktif)` veya `Site SLA: %50 (api.example.com sorunlu)`) hesaplar ve bölüm başlığında gösterir.
- **Uygulama:** `src/controlcenter.js` (`evaluateServerSitesHealth`), `src/daemon.js` (`base.serverSitesHealth`), `Models.swift` (`ServerSitesHealthSummary`) ve `ControlCenterView.swift` (`fleetAndServerSection`).

### 📋 Yeni Öneri 3 (Gelecek Adayı): Durum Panosu Otomatik Snapshot Budama (`pruneStatusBoardSnapshots`)
- **Değer:** `<configDir>/status-snapshots/` altında biriken eski anlık görüntüleri yapılandırılabilir bir sınırda (örn. son 20 snapshot) tutarak disk şişmesini önleme (`keyflip status-board prune`).

### 📋 Yeni Öneri 4 (Gelecek Adayı): İkincil AI Araçları Tükenme Riski Uyarıcısı (`evaluateSecondaryQuotasAlert`)
- **Değer:** `DİĞER KOTALAR` altındaki ikincil sağlayıcılardan (Kiro, Antigravity `agy`, API Promosyonları) herhangi biri `%90+` kullanıma ulaştığında veya tükendiğinde üst uyarı listesine (`warnings`) otomatik bildirim ekleme.

### 📋 Yeni Öneri 5 (Gelecek Adayı): Birleşik Kontrol Merkezi Sağlık Özeti CLI Komutu (`keyflip daemon summary`)
- **Değer:** Terminal kullanıcıları için tüm alt sistemlerin (Hesap Havuzu, Failover, Durum Panosu, Servisler, Filo ve Sunucu) sağlık puanlarını 6 satırlık kompakt bir tabloda özetleyen hızlı CLI alt komutu.
