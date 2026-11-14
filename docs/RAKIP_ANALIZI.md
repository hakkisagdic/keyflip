# Rakip Analizi — Keyflip & Kontrol Merkezi (`RAKIP_ANALIZI.md`)

Bu analiz, AI kodlama abonelikleri (Claude Code, Claude Desktop, Cursor, Codex, Antigravity, Kiro) ve yerel API/servis yönetimi alanındaki mevcut araçları **Keyflip Kontrol Merkezi** ile karşılaştırır.

---

## 1. Rakip Kategorileri ve Karşılaştırma Matrisi

| Özellik | ClaudeBar / Usage Widgets | CCManager / Oturum Araçları | LiteLLM / OpenRouter / Portkey | Raycast AI / Sistem Bar Araçları | **Keyflip Kontrol Merkezi** |
|---|---|---|---|---|---|
| **Çoklu Claude Hesabı Rotasyonu (CLI + Desktop)** | ❌ (Tek hesap) | ⚠️ (Yalnızca CLI profili) | ❌ (Yalnızca API key) | ❌ | ✅ (`keyflip switch` + Desktop çerez/OAuth senkronu) |
| **Abonelikten Ücretli API'ye Otomatik Failover** | ❌ | ❌ | ⚠️ (Yalnızca API-arası) | ❌ | ✅ (`keyflip failover` + Keysmith harcama tavanı) |
| **Failover Saatlik Harcama Hızı Kesen & Maliyet Simülatörü** | ❌ | ❌ | ✅ (Bütçe hız uyarıları) | ❌ | ✅ (`evaluateFailoverSpendHealth` + `estimateFailoverSessionCost`) |
| **Havuz Dayanıklılık & SPOF Puanı (`0-100` / `A`–`D`)** | ❌ | ❌ | ✅ (Yedeklilik sağlığı) | ❌ | ✅ (`evaluatePoolResilienceScore` ile SPOF ve yedeklilik derecesi) |
| **Çoklu Sağlayıcı Süreklilik Endeksi (`multiProviderContinuity`)** | ❌ | ❌ | ✅ (Çoklu model sağlık skoru) | ❌ | ✅ (`evaluateMultiProviderContinuity`: Claude + Failover + ikincil araçlar) |
| **Gözetimli Tekil Daemon (`launchd` + Unix Soket)** | ❌ | ❌ | ✅ (HTTP proxy) | ❌ | ✅ (`com.keyflip.daemon`, `0600` soket, sıfır sır sızıntısı) |
| **Genel Durum Panosu (`status.json` Şeması, Doğrulayıcı & Diff)** | ❌ | ❌ | ❌ | ⚠️ (Özel script eklentileri) | ✅ (`status.json`, `owner_needed` rozeti, `validate` ve `diff` CLI) |
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

### A. ClaudeBar / macOS Kota Widget'ları
- **Rakipte ne var?** 5 saatlik pencere tükenme tahmini, 7 günlük sıfırlama günü/saati takvimi ve MacBook çentikli ekranlarda yer kaplamayan dar (kompakt) menü çubuğu etiketi.
- **Bizim avantajımız ve yanıtımız:** `computeQuotaForecast` ve `buildWeeklyResetCalendar` ile hem 5 saatlik tükenme tahmini hem de tüm hesapların kronolojik 7 günlük sıfırlama takvimi (`Sıradaki 7g sıfırlama: ...`) sunulurken; `MenuBarGlanceLabel` içine eklenen **Çentik Dostu Dar Menü Çubuğu Modu (`compactMenuBarLabel`)** ile yalnızca kalan yüzde ve `owner_needed` rozeti (`%58 •2`) gösterilebiliyor.

### B. LiteLLM / Portkey / Datadog Tarzı Gözlemlenebilirlik ve API Yönlendiricileri
- **Rakipte ne var?** Bütçe aşımı hız uyarıları, oturum maliyet simülasyonu, çoklu sağlayıcı süreklilik skoru, servis filosu sağlık skoru, bilinen uyarıları sessize alma (alert muting), denetim olayı kategori filtreleme ve iki durum görüntüsü arasındaki farkları (`diff`) karşılaştırma.
- **Bizim avantajımız ve yanıtımız:**
  - `evaluateMultiProviderContinuity` ile Claude abonelikleri, Keysmith Failover ve ikincil AI araçları (Antigravity, Kiro, Copilot, EVREN, API promosyonları) genelinde birleşik **Süreklilik Endeksi (`%85 · 3 aktif yüzey`)** hesaplanıyor.
  - `evaluateServicesHealthSummary` ile izlenen arka plan servislerinin toplu sağlık yüzdesi (`1/1 servis sağlıklı (%100)`) ve hatalı servis etiketleri başlıkta özetleniyor.
  - `SON OLAYLAR (DENETİM)` bölümü `Tümü / Geçiş / Failover / Servis` (`auditKindFilter`) sekmeleriyle filtrelenebiliyor ve `keyflip status-board diff <eski.json> <yeni.json>` ile iki durum panosu arasındaki geçişler CLI'dan karşılaştırılabiliyor.

### C. Raycast / Sistem Kontrol Merkezleri
- **Rakipte ne var?** Odak/toplantı sırasında otomatik uygulama yeniden başlatmalarını geçici olarak dondurma ("Do Not Disturb / Snooze") ve arka plan görevlerini onaylı olarak elle tetikleme.
- **Bizim avantajımız ve yanıtımız:** `desktop.snoozeUntil` Odak Modu ve `HESAPLAR` bölümündeki onaylı **`Ön-Isıt` (`triggerDaemonJob: refresh`)** düğmesiyle tam kontrol sağlandı.
