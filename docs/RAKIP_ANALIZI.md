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
| **Gözetimli Tekil Daemon (`launchd` + Unix Soket)** | ❌ | ❌ | ✅ (HTTP proxy) | ❌ | ✅ (`com.keyflip.daemon`, `0600` soket, sıfır sır sızıntısı) |
| **Genel Durum Panosu (`status.json` Şeması & CLI Doğrulayıcı)** | ❌ | ❌ | ❌ | ⚠️ (Özel script eklentileri) | ✅ (`status.json`, `owner_needed` rozeti, `keyflip status-board validate`) |
| **Durum Panosu Canlı Arama, Sabitleme (Pin) & Satır Sessize Alma** | ❌ | ❌ | ✅ (Tablo arama/mute) | ✅ (Anlık arama) | ✅ (`searchQuery`, `pinnedSectionIds`, `mutedRowKeys` ve `% sağlıklı` SLA) |
| **Kota Tüketim Hızı (Burn-Rate) & Haftalık Verimlilik** | ✅ (5s pencere ETA) | ❌ | ❌ | ❌ | ✅ (`computeQuotaForecast`, `weeklyEfficiency` + "use-it-or-lose-it" önerisi) |
| **OAuth Ön-Isıtma Hazırlık Kontrolü & Tek Tıkla Tetikleme** | ❌ | ❌ | ❌ | ❌ | ✅ (`evaluatePoolReadiness` + menü çubuğundan onaylı `Ön-Isıt` düğmesi) |
| **Sorun Odaklı Filtreleme (`bad`/`warn`) ve Markdown Rapor** | ❌ | ❌ | ✅ (Dashboard filtreleri) | ✅ | ✅ ("Yalnızca Sorunlar" filtresi + `⌘⇧C` ile Markdown kopyalama) |
| **Servis Sağlık Kıvılcım Grafiği (`sparkline`) & Denetim Zaman Çizelgesi** | ❌ | ⚠️ (Oturum geçmişi) | ✅ (İstek logları) | ❌ | ✅ (`sparkline` `█/▁` + `collectAuditTimeline` `SON OLAYLAR` bölümü) |
| **Toplantı / Odak Modu & Çentik Dostu Dar Menü Çubuğu** | ✅ (Kompakt ikon) | ❌ | ❌ | ✅ (Odak modu) | ✅ (`desktop.snoozeUntil` Odak Modu + `compactMenuBarLabel` dar etiket) |
| **Çoklu Makine Durum Panosu Birleştirici** | ❌ | ❌ | ✅ (Merkezi telemetri) | ❌ | ✅ (`menubar.extraStatusFiles` ile `[<host>]` etiketli birleştirme) |
| **Anonimleştirilmiş Tanılama Paketi (`diagnosticBundle`)** | ❌ | ❌ | ✅ (Sanitized debug export) | ❌ | ✅ (`buildDiagnosticBundle` ile e-posta/ev dizini/sır maskeli çıktı) |

---

## 2. Rakiplerin Güçlü Yönleri ve Bizdeki Karşılıkları

### A. ClaudeBar / macOS Kota Widget'ları
- **Rakipte ne var?** 5 saatlik pencere tükenme tahmini ve MacBook çentikli ekranlarda yer kaplamayan dar (kompakt) menü çubuğu etiketi.
- **Bizim avantajımız ve yanıtımız:** `computeQuotaForecast` ile tüketim hızı, tükenme tahmini, haftalık verimlilik (`weeklyEfficiency`) ve "use-it-or-lose-it" önerisi sunulurken; `MenuBarGlanceLabel` içine eklenen **Çentik Dostu Dar Menü Çubuğu Modu (`compactMenuBarLabel`)** ile yalnızca kalan yüzde ve `owner_needed` rozeti (`%58 •2`) gösterilebiliyor.

### B. LiteLLM / Portkey / Datadog Tarzı Gözlemlenebilirlik ve API Yönlendiricileri
- **Rakipte ne var?** Bütçe aşımı hız uyarıları, oturum maliyet simülasyonu, bilinen uyarıları sessize alma (alert muting), SLA sağlık yüzdesi ve yedeklilik/SPOF skoru.
- **Bizim avantajımız ve yanıtımız:**
  - `evaluateFailoverSpendHealth` ve `estimateFailoverSessionCost` ile hem aktif harcama hızı hem de standart bir Claude Code seansının saatlik tahmini maliyeti (`~$2.40/saat`) ve kalan tavanın kaç saat yeteceği gösteriliyor.
  - `evaluatePoolResilienceScore` ile hesap havuzunun yedekliliği, OAuth sağlığı ve failover hazırlığı `0-100` (`A`–`D`) puanıyla derecelendiriliyor.
  - Durum Panosu'nda bilinen uyarı satırları `bell.slash.fill` (`mutedRowKeys`) ile sessize alınabiliyor, ağırlıklı SLA sağlık yüzdesi (`%65 sağlıklı`) gösteriliyor ve `keyflip status-board validate` ile harici `status.json` üreticileri şemalarını doğrulayabiliyor.

### C. Raycast / Sistem Kontrol Merkezleri
- **Rakipte ne var?** Odak/toplantı sırasında otomatik uygulama yeniden başlatmalarını geçici olarak dondurma ("Do Not Disturb / Snooze") ve arka plan görevlerini onaylı olarak elle tetikleme.
- **Bizim avantajımız ve yanıtımız:** `desktop.snoozeUntil` Odak Modu ve `HESAPLAR` bölümündeki onaylı **`Ön-Isıt` (`triggerDaemonJob: refresh`)** düğmesiyle tam kontrol sağlandı.
