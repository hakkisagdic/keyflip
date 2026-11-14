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
| **Çoklu Sağlayıcı Süreklilik Endeksi (`multiProviderContinuity`)** | ❌ | ❌ | ✅ (Çoklu model sağlık skoru) | ❌ | ✅ (`evaluateMultiProviderContinuity`: Claude + Failover + ikincil araçlar) |
| **Oturum Öncesi Hazırlık Kontrol Listesi (`sessionReadiness`)** | ❌ | ❌ | ❌ | ✅ (Sistem hazırlık kontrolleri) | ✅ (`evaluateWorkSessionReadiness`: 5 maddelik pre-flight kontrolü) |
| **Abonelik Değer / Eşdeğer API ROI Analizi (`subscriptionRoi`)** | ✅ (Maliyet/değer tahmini) | ❌ | ✅ (Tasarruf analizi) | ❌ | ✅ (`evaluateSubscriptionValueROI`: `~$49 eşdeğer API değeri`) |
| **Kota Darboğaz Saat Penceresi Tahmincisi (`bottleneckWindow`)** | ❌ | ❌ | ✅ (Trafik zirve saatleri) | ❌ | ✅ (`predictDailyBottleneckWindow`: `14:00-15:00 UTC` darboğaz analizi) |
| **Gözetimli Tekil Daemon (`launchd` + Unix Soket)** | ❌ | ❌ | ✅ (HTTP proxy) | ❌ | ✅ (`com.keyflip.daemon`, `0600` soket, sıfır sır sızıntısı) |
| **Genel Durum Panosu (`status.json` Şeması, Doğrulayıcı, Diff & Snapshot)** | ❌ | ❌ | ❌ | ⚠️ (Özel script eklentileri) | ✅ (`status.json`, `owner_needed` rozeti, `validate`, `diff` ve `snapshot` CLI) |
| **Durum Panosu Canlı Arama, Sabitleme (Pin) & Satır Sessize Alma** | ❌ | ❌ | ✅ (Tablo arama/mute) | ✅ (Anlık arama) | ✅ (`searchQuery`, `pinnedSectionIds`, `mutedRowKeys` ve `% sağlıklı` SLA) |
| **Kota Tüketim Hızı, Haftalık Verimlilik & Sıfırlama Takvimi** | ✅ (5s pencere ETA) | ❌ | ❌ | ❌ | ✅ (`computeQuotaForecast`, `weeklyEfficiency` + `buildWeeklyResetCalendar`) |
| **OAuth Ön-Isıtma Hazırlık Kontrolü & Tek Tıkla Tetikleme** | ❌ | ❌ | ❌ | ❌ | ✅ (`evaluatePoolReadiness` + menü çubuğundan onaylı `Ön-Isıt` düğmesi) |
| **Sorun Odaklı Filtreleme (`bad`/`warn`) ve Markdown Rapor** | ❌ | ❌ | ✅ (Dashboard filtreleri) | ✅ | ✅ ("Yalnızca Sorunlar" filtresi + `⌘⇧C` ile Markdown kopyalama) |
| **Servis Filosu Sağlık Skoru, Kıvılcım Grafiği & Denetim Filtresi** | ❌ | ⚠️ (Oturum geçmişi) | ✅ (İstek logları) | ❌ | ✅ (`servicesHealth`, `sparkline` `█/▁` + `auditKindFilter` sekmeleri) |
| **Toplantı / Odak Modu & Çentik Dostu Dar Menü Çubuğu** | ✅ (Kompakt ikon) | ❌ | ❌ | ✅ (Odak modu) | ✅ (`desktop.snoozeUntil` Odak Modu + `compactMenuBarLabel` dar etiket) |
| **Çoklu Makine Durum Panosu Birleştirici** | ❌ | ❌ | ✅ (Merkezi telemetri) | ❌ | ✅ (`menubar.extraStatusFiles` ile `[<host>]` etiketli birleştirme) |
| **Anonimleştirilmiş Tanılama Paketi (`diagnosticBundle`)** | ❌ | ❌ | ✅ (Sanitized debug export) | ❌ | ✅ (`buildDiagnosticBundle` ile e-posta/ev dizini/sır maskeli çıktı) |

---

## 2. Rakiplerin Güçlü Yönleri ve Bizdeki Karşılıkları

### A. ClaudeBar / macOS Kota ve Abonelik ROI Widget'ları
- **Rakipte ne var?** 5 saatlik pencere tükenme tahmini, 7 günlük sıfırlama günü/saati takvimi, abonelikten elde edilen eşdeğer API değeri (ROI) ve MacBook çentikli ekranlarda yer kaplamayan dar (kompakt) menü çubuğu etiketi.
- **Bizim avantajımız ve yanıtımız:** `computeQuotaForecast`, `buildWeeklyResetCalendar` ve `evaluateSubscriptionValueROI` ile 5 saatlik tükenme tahmini, 7 günlük sıfırlama takvimi ve haftalık eşdeğer API değeri (`Haftalık ort. %82 kullanım (~$49 eşdeğer API değeri)`) sunuluyor.

### B. LiteLLM / Portkey / Datadog Tarzı Gözlemlenebilirlik ve API Yönlendiricileri
- **Rakipte ne var?** Bütçe aşımı hız uyarıları, oturum maliyet simülasyonu, çoklu sağlayıcı süreklilik skoru, gün içi trafik/kota darboğaz saat penceresi analizi, zaman damgalı durum anlık görüntüsü (snapshot) alma ve diff karşılaştırma.
- **Bizim avantajımız ve yanıtımız:**
  - `predictDailyBottleneckWindow` ile `events.jsonl` içindeki geçmiş rotasyon/failover olaylarından günün en yoğun kota darboğaz penceresi (`Darboğaz penceresi: 14:00-15:00 UTC`) otomatik tespit ediliyor.
  - `keyflip status-board snapshot` ve `keyflip status-board diff` ile durum panosunun zaman damgalı anlık görüntüsü kaydedilip önceki görüntülerle karşılaştırılabiliyor.

### C. Raycast / Sistem Kontrol Merkezleri
- **Rakipte ne var?** Klavye kısayolları ile hızlı profil/hesap seçimi (`⌘1`–`⌘3`) ve derin çalışma öncesi sistem hazırlık kontrolü ("Pre-flight Readiness Check").
- **Bizim avantajımız ve yanıtımız:** `evaluateWorkSessionReadiness` ile derin kodlama oturumu öncesi 5 kritik kontrol (5s kota boşluğu, OAuth süresi, yedek hesap/failover hazırlığı, servis sağlığı, durum panosu sağlığı) tek satırda (`Oturuma Hazır (5/5 kontrol tam)`) özetleniyor ve `⌘1`–`⌘3` klavye kısayollarıyla ilk 3 etkin hesaba onaylı geçiş başlatılabiliyor.
