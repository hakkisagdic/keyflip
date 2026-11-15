# Geliştirme Listesi ve Yaratıcı Özellik Önerileri (`GELISTIRME_LISTESI.md`)

Bu liste, `docs/RAKIP_ANALIZI.md` sonucunda belirlenen tüm özelliklerin tamamlanma durumunu ve on birinci turda önerilen **beş yeni yaratıcı özelliği** (en değerli ikisi uygulanmış olarak) içerir.

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
- [x] **Derin Çalışma / Oturum Öncesi Hazırlık Kontrol Listesi (`evaluateWorkSessionReadiness`) & Abonelik Değer / ROI Analizi (`evaluateSubscriptionValueROI`):** 5 maddelik oturum hazırlık kontrolü ve 7 günlük abonelik kullanımından üretilen eşdeğer API değeri.
- [x] **Durum Panosu Snapshot Geçmişi ve Canlı Diff (`keyflip status-board history [--json]` / `listStatusBoardSnapshots`):** `<configDir>/status-snapshots/` altındaki anlık görüntüleri listeleme ve en son snapshot ile canlı `status.json` dosyasını otomatik karşılaştırma.
- [x] **Hesap Rotasyon Soğuma Süresi ve Ping-Pong Koruması Analizi (`evaluateRotationStability`):** Hesaplar arasında `<15 dk` içinde tekrarlayan hızlı geçişleri (`thrashing`) tespit edip menü çubuğunda uyarı gösterme.
- [x] **Menü Çubuğu Hızlı Sorun Kopyalama (`buildIssuesOnlySummary` / `copyIssuesOnlySummary`):** Durum panosunda yalnızca sessize alınmamış `bad`/`warn` satırlarını ve `owner_needed` maddelerini içeren kısa özeti üretip panoya kopyalama.
- [x] **Traycer Ajan Filosu Verimlilik Skoru (`evaluateFleetEfficiency`) & Uzak Sunucu Site SLA Skoru (`evaluateServerSitesHealth`):** Filo aktif/takılı ajan sağlık puanı (`Filo sağlığı: %75`) ve izlenen web siteleri SLA puanı (`Site SLA: %50`).
- [x] **Durum Panosu Otomatik Snapshot Budama (`pruneStatusBoardSnapshots` / `keyflip status-board prune [--keep N]`):** `<configDir>/status-snapshots/` altında biriken eski anlık görüntüleri yapılandırılabilir sınırda tutarak disk şişmesini önleme.
- [x] **İkincil AI Araçları Tükenme Riski Uyarıcısı (`evaluateSecondaryQuotasAlert`):** `DİĞER KOTALAR` altındaki ikincil sağlayıcılardan herhangi biri `%85+` kullanıma ulaştığında veya tükendiğinde yapılandırılmış uyarı üretme.
- [x] **Birleşik Kontrol Merkezi 6 Sütunlu CLI Sağlık Özeti (`keyflip daemon summary` / `formatDaemonCompactSummary`):** Terminal kullanıcıları için 6 ana sütunun (Hesap Havuzu, Yedek Zincir, Durum Panosu, Servis Filosu, Traycer Filo, Uzak Sunucu) durumunu tek tabloda özetleme.
- [x] **Birleşik Otonom Operasyonel Sağlık Notu (`evaluateAutonomousOpsPosture`) & Sahiplik Bekleyen İş Önceliklendirici (`prioritizeOwnerNeededQueue`):** 5 boyutlu `A`–`D` (`%0–100`) Otonom Sağlık Notu ve `owner_needed` aciliyet (`ACİL`) sıralaması.
- [x] **OAuth Yenileme Başarı Oranı ve Güvenilirlik Analizcisi (`evaluateOAuthRefreshReliability`):** Etkin hesapların son OAuth yenileme sonuçlarını (`lastResult`, `remainingMs`) analiz ederek kimlik doğrulama güvenilirlik yüzdesini hesaplama.
- [x] **Gün İçi Dinamik Eşik Önericisi (`recommendAdaptiveAutoswitchThreshold`):** Darboğaz saat penceresine (`bottleneckWindow`) ve aktif tüketim hızına (`burnRateRatio`) göre optimal `autoswitch.threshold` değerini (`%85` vs `%95`) önerme.
- [x] **Durum Panosu Bölüm Bazlı Sağlık Özeti (`summarizeSectionHealthBreakdown`):** Her durum panosu bölümünün (`sections`) kendi ağırlıklı sağlık yüzdesini ve en eski sorun yaşını (`oldestIssueMinutes`) hesaplama.

- [x] **Otomatik Sorun Giderme ve Müdahale Eylem Planı (`buildRemediationPlaybook`):** Açık sorunlar için en kritik 1–3 müdahale adımını ve CLI komutunu oluşturup `HESAPLAR` bölümünde gösterme.
- [x] **Hesap Havuzu 7 Günlük Yük Dengesi ve Adillik Endeksi (`evaluatePoolLoadBalance`):** Etkin abonelikler arasındaki 7 günlük kota kullanım farkını (`spreadPct`) analiz ederek atıl kalan hesaba geçiş önerme.
- [x] **Durum Panosu Kronolojik Yaşlanan Sorunlar Listesi (`listAgingStatusBoardIssues`):** Tüm bölümlerdeki `bad` ve `warn` satırlarını `since` zaman damgasına göre en eskiden en yeniye sıralayarak `>=120 dk` kronik sorunları öne çıkarma.
- [x] **Yedek Zincir (Failover) Otomatik Kurtarma Zamanlayıcı Özeti (`evaluateFailoverRecoveryCountdown`):** Failover devredeyken `recoverAt` zamanına veya en erken 5 saatlik hesap sıfırlanmasına kalan dakikayı (`Havuz dönüşüne ~35 dk kaldı`) hesaplama.
- [x] **Günlük Denetim Olayları Yoğunluk Özeti (`summarizeDailyAuditActivity`):** Son 24 saat içindeki toplam hesap geçişi, failover tetiklemesi ve servis yeniden başlatma sayılarını tek satırlık aktivite özetinde toplama.

---

## 2. Listedeki İşler Tamamlandığı İçin Önerilen Beş Yeni Yaratıcı Özellik (En Değerli İkisi Uygulandı)

### ✅ Yeni Öneri 1 (UYGULANDI): Daemon İş Zamanlayıcı Gecikme ve Tutarlılık Analizcisi (`evaluateDaemonSchedulerHealth`)
- **Değer:** `com.keyflip.daemon` içindeki periyodik işlerin (`autoswitch`, `refresh`, `surface-refresh`, `conv-index`) son çalışma zamanlarını, sürelerini (`lastDurationMs`) ve hata durumlarını (`lastResult`) denetleyerek geciken (`overdueJobs`), yavaşlayan (`slowJobs`) veya hata veren (`failingJobs`) işleri anında `SERVİSLER` bölümünde (`Zamanlayıcı sağlıklı (4/4 iş zamanında)`) raporlar.
- **Uygulama:** `src/controlcenter.js` (`evaluateDaemonSchedulerHealth`), `src/daemon.js` (`base.schedulerHealth`), `Models.swift` (`DaemonSchedulerHealthSummary`) ve `ControlCenterView.swift`.

### ✅ Yeni Öneri 2 (UYGULANDI): Haftalık Abonelik İsraf Önleme / "Sıfırlanmadan Tüket" Hesaplayıcısı (`evaluateWeeklyUnclaimedQuota`)
- **Değer:** 7 günlük kota penceresinin sıfırlanmasına `<=48 saat` kalmış olmasına rağmen hâlâ `%35+` boş haftalık kapasitesi bulunan etkin Claude aboneliklerini tespit eder (`Haftalık sıfırlanmadan kullan: yahoo (%70 boş, ~16 saat kaldı)`), eşdeğer dolar değerini (`estimatedUnclaimedUsd`) hesaplar ve sıfırlanma öncesi bu kapasitenin yanmasını önler.
- **Uygulama:** `src/controlcenter.js` (`evaluateWeeklyUnclaimedQuota`), `src/daemon.js` (`base.weeklyUnclaimedQuota`), `Models.swift` (`WeeklyUnclaimedQuotaSummary`, `WeeklyUnclaimedCandidateItem`) ve `ControlCenterView.swift`.

### 📋 Yeni Öneri 3 (Gelecek Adayı): Durum Panosu Sahiplik Bekleyen İşleri Proje Bazlı Gruplama (`groupOwnerNeededByProject`)
- **Değer:** `owner_needed` maddelerini `project` adına göre gruplayarak hangi projede kaç adet acil veya normal sahiplik kararı biriktiğini özetleme.

### 📋 Yeni Öneri 4 (Gelecek Adayı): Uzak Sunucu Kaynak Baskısı (CPU/RAM/Disk) Analizcisi (`evaluateServerResourcePressure`)
- **Değer:** `server-status.json` içindeki `load`, `memory` ve `disk` metriklerini sayısal olarak ayrıştırarak disk doluluğu veya bellek baskısı kritik eşiğe ulaşmadan önce erken uyarı üretme.

### 📋 Yeni Öneri 5 (Gelecek Adayı): Masaüstü Otomatik Yeniden Başlatma Hazırlık ve Güvenlik Kontrolü (`evaluateDesktopRestartSafety`)
- **Değer:** Bekleyen bir Claude Desktop yeniden başlatma isteğinin Odak/Toplantı ertelemesi (`desktop.snoozeUntil`) nedeniyle mi yoksa aktif oturum nedeniyle mi beklediğini ve kalan erteleme süresini dakika cinsinden raporlama.
