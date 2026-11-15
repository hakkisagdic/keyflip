# Rakip Analizi — Keyflip & Kontrol Merkezi (`RAKIP_ANALIZI.md`)

Bu analiz, AI kodlama abonelikleri (Claude Code, Claude Desktop, Cursor, Codex, Antigravity, Kiro) ve yerel API/servis yönetimi alanındaki mevcut araçları **Keyflip Kontrol Merkezi** ile karşılaştırır.

---

## 1. Rakip Kategorileri ve Karşılaştırma Matrisi

| Özellik | ClaudeBar / Usage Widgets | CCManager / Oturum Araçları | LiteLLM / OpenRouter / Portkey | Raycast AI / Sistem Bar Araçları | **Keyflip Kontrol Merkezi** |
|---|---|---|---|---|---|
| **Çoklu Claude Hesabı Rotasyonu (CLI + Desktop)** | ❌ (Tek hesap) | ⚠️ (Yalnızca CLI profili) | ❌ (Yalnızca API key) | ❌ | ✅ (`keyflip switch` + Desktop çerez/OAuth senkronu + `⌘1`–`⌘3` kısayolları) |
| **Abonelikten Ücretli API'ye Otomatik Failover** | ❌ | ❌ | ⚠️ (Yalnızca API-arası) | ❌ | ✅ (`keyflip failover` + Keysmith harcama tavanı) |
| **Failover Saatlik Harcama Hızı Kesen & Maliyet Simülatörü** | ❌ | ❌ | ✅ (Bütçe hız uyarıları) | ❌ | ✅ (`evaluateFailoverSpendHealth` + `estimateFailoverSessionCost`) |
| **Havuz Dayanıklılık & SPOF Puanı (`0-100` / `A`–`D`)** | ❌ | ❌ | ✅ (Yedeklilik sağlığı) | ❌ | ✅ (`evaluatePoolResilienceScore` ile SPOF ve yedeklilik derecesi) |
| **Hesap Rotasyon Kararlılığı & Ping-Pong Koruması (`rotationStability`)** | ❌ | ❌ | ✅ (Flapping / thrashing tespiti) | ❌ | ✅ (`evaluateRotationStability`: `<15 dk` hızlı geçiş ve ping-pong uyarısı) |
| **Çoklu Sağlayıcı Süreklilik Endeksi (`multiProviderContinuity`)** | ❌ | ❌ | ✅ (Çoklu model sağlık skoru) | ❌ | ✅ (`evaluateMultiProviderContinuity`: Claude + Failover + ikincil araçlar) |
| **Oturum Öncesi Hazırlık Kontrol Listesi (`sessionReadiness`)** | ❌ | ❌ | ❌ | ✅ (Sistem hazırlık kontrolleri) | ✅ (`evaluateWorkSessionReadiness`: 5 maddelik pre-flight kontrolü) |
| **Abonelik Değer / Eşdeğer API ROI Analizi (`subscriptionRoi`)** | ✅ (Maliyet/değer tahmini) | ❌ | ✅ (Tasarruf analizi) | ❌ | ✅ (`evaluateSubscriptionValueROI`: `~$48 eşdeğer API değeri`) |
| **Kota Darboğaz Saat Penceresi Tahmincisi (`bottleneckWindow`)** | ❌ | ❌ | ✅ (Trafik zirve saatleri) | ❌ | ✅ (`predictDailyBottleneckWindow`: `14:00-15:00 UTC` darboğaz analizi) |
| **Filo Ajan Verimliliği (`fleetEfficiency`) & Sunucu Site SLA Skoru (`serverSitesHealth`)** | ❌ | ❌ | ✅ (Uptime / SLA skoru) | ❌ | ✅ (`evaluateFleetEfficiency` + `evaluateServerSitesHealth`) |
| **Gözetimli Tekil Daemon (`launchd` + Unix Soket)** | ❌ | ❌ | ✅ (HTTP proxy) | ❌ | ✅ (`com.keyflip.daemon`, `0600` soket, sıfır sır sızıntısı) |
| **Genel Durum Panosu (`status.json` Şeması, Validate, Diff, Snapshot & History)** | ❌ | ❌ | ❌ | ⚠️ (Özel script eklentileri) | ✅ (`status.json`, `owner_needed` rozeti, `validate`, `diff`, `snapshot`, `history`) |
| **Durum Panosu Canlı Arama, Sabitleme (Pin) & Satır Sessize Alma** | ❌ | ❌ | ✅ (Tablo arama/mute) | ✅ (Anlık arama) | ✅ (`searchQuery`, `pinnedSectionIds`, `mutedRowKeys` ve `% sağlıklı` SLA) |
| **Kota Tüketim Hızı, Haftalık Verimlilik & Sıfırlama Takvimi** | ✅ (5s pencere ETA) | ❌ | ❌ | ❌ | ✅ (`computeQuotaForecast`, `weeklyEfficiency` + `buildWeeklyResetCalendar`) |
| **OAuth Ön-Isıtma Hazırlık Kontrolü & Tek Tıkla Tetikleme** | ❌ | ❌ | ❌ | ❌ | ✅ (`evaluatePoolReadiness` + menü çubuğundan onaylı `Ön-Isıt` düğmesi) |
| **Sorun Odaklı Filtreleme (`bad`/`warn`), Markdown Rapor & Açık Sorun Özeti** | ❌ | ❌ | ✅ (Dashboard filtreleri) | ✅ | ✅ ("Yalnızca Sorunlar" filtresi + `⌘⇧C` tam rapor + `copyIssuesOnlySummary`) |
| **Servis Filosu Sağlık Skoru, Kıvılcım Grafiği & Denetim Filtresi** | ❌ | ⚠️ (Oturum geçmişi) | ✅ (İstek logları) | ❌ | ✅ (`servicesHealth`, `sparkline` `█/▁` + `auditKindFilter` sekmeleri) |
| **Toplantı / Odak Modu & Çentik Dostu Dar Menü Çubuğu** | ✅ (Kompakt ikon) | ❌ | ❌ | ✅ (Odak modu) | ✅ (`desktop.snoozeUntil` Odak Modu + `compactMenuBarLabel` dar etiket) |
| **Çoklu Makine Durum Panosu Birleştirici** | ❌ | ❌ | ✅ (Merkezi telemetri) | ❌ | ✅ (`menubar.extraStatusFiles` ile `[<host>]` etiketli birleştirme) |
| **Anonimleştirilmiş Tanılama Paketi (`diagnosticBundle`)** | ❌ | ❌ | ✅ (Sanitized debug export) | ❌ | ✅ (`buildDiagnosticBundle` ile e-posta/ev dizini/sır maskeli çıktı) |

---

## 2. Rakiplerin Güçlü Yönleri ve Bizdeki Karşılıkları

### A. ClaudeBar / macOS Kota ve Abonelik ROI Widget'ları
- **Rakipte ne var?** 5 saatlik pencere tükenme tahmini, 7 günlük sıfırlama günü/saati takvimi, abonelikten elde edilen eşdeğer API değeri (ROI) ve MacBook çentikli ekranlarda yer kaplamayan dar (kompakt) menü çubuğu etiketi.
- **Bizim avantajımız ve yanıtımız:** `computeQuotaForecast`, `buildWeeklyResetCalendar` ve `evaluateSubscriptionValueROI` ile 5 saatlik tükenme tahmini, 7 günlük sıfırlama takvimi ve haftalık eşdeğer API değeri (`Haftalık verim: %80 (~$48 eşdeğer API değeri)`) sunuluyor.

### B. LiteLLM / Portkey / Datadog Tarzı Gözlemlenebilirlik ve API Yönlendiricileri
- **Rakipte ne var?** Bütçe aşımı hız uyarıları, hızlı rota salınımı ("route flapping / thrashing") tespiti, ajan filosu ve sunucu SLA puanları, zaman damgalı durum anlık görüntüsü (snapshot) geçmişi ve diff karşılaştırma.
- **Bizim avantajımız ve yanıtımız:**
  - `evaluateRotationStability` ile hesaplar arasında `<15 dk` içinde gerçekleşen hızlı "ping-pong" geçişler tespit edilerek eşik ince ayarı öneriliyor.
  - `evaluateFleetEfficiency` ve `evaluateServerSitesHealth` ile hem Traycer ajan filosunun aktif/takılı sağlık puanı hem de izlenen web sitelerinin SLA yüzdesi başlıkta gösteriliyor.
  - `keyflip status-board history` ile kaydedilen tüm anlık görüntüler listelenip en son snapshot ile canlı `status.json` arasındaki fark (`latest vs live`) otomatik özetleniyor.

### C. Raycast / Sistem Kontrol Merkezleri
- **Rakipte ne var?** Klavye kısayolları ile hızlı profil/hesap seçimi (`⌘1`–`⌘3`), derin çalışma öncesi sistem hazırlık kontrolü ("Pre-flight Readiness Check") ve yalnızca açık sorunları panoya kopyalama.
- **Bizim avantajımız ve yanıtımız:** `evaluateWorkSessionReadiness`, `⌘1`–`⌘3` klavye kısayolları ve `buildIssuesOnlySummary` / `copyIssuesOnlySummary` ile tam kontrol sağlandı.
