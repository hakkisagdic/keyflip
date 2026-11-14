# Rakip Analizi — Keyflip & Kontrol Merkezi (`RAKIP_ANALIZI.md`)

Bu analiz, AI kodlama abonelikleri (Claude Code, Claude Desktop, Cursor, Codex, Antigravity, Kiro) ve yerel API/servis yönetimi alanındaki mevcut araçları **Keyflip Kontrol Merkezi** ile karşılaştırır.

---

## 1. Rakip Kategorileri ve Karşılaştırma Matrisi

| Özellik | ClaudeBar / Usage Widgets | CCManager / Oturum Araçları | LiteLLM / OpenRouter / Portkey | Raycast AI / Sistem Bar Araçları | **Keyflip Kontrol Merkezi** |
|---|---|---|---|---|---|
| **Çoklu Claude Hesabı Rotasyonu (CLI + Desktop)** | ❌ (Tek hesap) | ⚠️ (Yalnızca CLI profili) | ❌ (Yalnızca API key) | ❌ | ✅ (`keyflip switch` + Desktop çerez/OAuth senkronu) |
| **Abonelikten Ücretli API'ye Otomatik Failover** | ❌ | ❌ | ⚠️ (Yalnızca API-arası) | ❌ | ✅ (`keyflip failover` + Keysmith harcama tavanı) |
| **Failover Saatlik Harcama Hızı Kesen (Spend Breaker)** | ❌ | ❌ | ✅ (Bütçe hız uyarıları) | ❌ | ✅ (`evaluateFailoverSpendHealth` ile `$/saat` ve tavan ETA uyarısı) |
| **Gözetimli Tekil Daemon (`launchd` + Unix Soket)** | ❌ | ❌ | ✅ (HTTP proxy) | ❌ | ✅ (`com.keyflip.daemon`, `0600` soket, sıfır sır sızıntısı) |
| **Genel Durum Panosu (`status.json` Şeması)** | ❌ | ❌ | ❌ | ⚠️ (Özel script eklentileri) | ✅ (Yapılandırılabilir `status.json`, `owner_needed` rozeti, >20dk eski veri uyarısı) |
| **Durum Panosu Canlı Arama & Bölüm Sabitleme (Pin)** | ❌ | ❌ | ✅ (Tablo arama/pin) | ✅ (Anlık arama) | ✅ (`searchQuery` canlı filtre + `pinnedSectionIds` sabitleme) |
| **Kota Tüketim Hızı (Burn-Rate) & Tükenme Tahmini** | ✅ (5s pencere ETA) | ❌ | ❌ | ❌ | ✅ (`computeQuotaForecast` + "use-it-or-lose-it" önerisi) |
| **Hesap Havuzu OAuth Ön-Isıtma Hazırlık Kontrolü** | ❌ | ❌ | ❌ | ❌ | ✅ (`evaluatePoolReadiness` ile rotasyona hazır hesap ve token süresi izleme) |
| **Sorun Odaklı Filtreleme (`bad`/`warn`) ve Markdown Rapor** | ❌ | ❌ | ✅ (Dashboard filtreleri) | ✅ | ✅ ("Yalnızca Sorunlar" filtresi + `⌘⇧C` ile Markdown kopyalama) |
| **Olay Zaman Çizelgesi (Audit Timeline UI)** | ❌ | ⚠️ (Oturum geçmişi) | ✅ (İstek logları) | ❌ | ✅ (`collectAuditTimeline` + açılır/kapanır `SON OLAYLAR` bölümü) |
| **Toplantı / Odak Modu (Masaüstü Restart Erteleme)** | ❌ | ❌ | ❌ | ✅ (Odak modu) | ✅ (`desktop.snoozeUntil` + üst çubukta onaylı 60 dk Odak Modu düğmesi) |
| **Çoklu Makine Durum Panosu Birleştirici** | ❌ | ❌ | ✅ (Merkezi telemetri) | ❌ | ✅ (`menubar.extraStatusFiles` ile `[<host>]` etiketli birleştirme) |
| **Kronik Sorun Süreklilik Yaşlandırması (`sinceAge`) & Geçiş Uyarısı** | ❌ | ❌ | ✅ (Incident duration & alerting) | ❌ | ✅ (`sinceAge` yaşlandırması + `newlyDegradedRows` kritik geçiş tespiti) |

---

## 2. Rakiplerin Güçlü Yönleri ve Bizdeki Karşılıkları

### A. ClaudeBar / macOS Kota Widget'ları
- **Rakipte ne var?** 5 saatlik pencerenin yüzde kaçının geçtiğini kullanım yüzdesiyle kıyaslayarak *"Bu hızla gidersen sıfırlanmadan 40 dk önce kotan bitecek"* uyarısı verir.
- **Bizim avantajımız ve yanıtımız:** Rakipler yalnızca tek hesabı izlerken Keyflip birden fazla hesabı yönetir. `computeQuotaForecast` ile hem tüketim hızı (`burnRateRatio`) ve tükenme tahmini (`minutesUntilExhaustion`) eklendi hem de rakiplerde olmayan **"sıfırlanmasına az kalmış boş kapasiteli hesabı önerme" (use-it-or-lose-it)** algoritması ve **`evaluatePoolReadiness` (havuz hazırlık kontrolü)** devreye alındı.

### B. LiteLLM / Portkey / API Yönlendiricileri ve Olay İzleme Panelleri
- **Rakipte ne var?** Bütçe aşımı hız uyarıları (spend velocity), çok sayıda servis ve kota satırı arasında canlı metin araması, kritik bölümleri en üste sabitleme (pinning), bir sorunun ne kadar süredir devam ettiğini (incident duration) gösterme ve yeni oluşan `bad` durumlarında uyarı üretme.
- **Bizim avantajımız ve yanıtımız:**
  - `evaluateFailoverSpendHealth` ile failover devredeyken `$/saat` harcama hızı ve tavana kalan dakika hesaplanıyor.
  - Durum Panosu (`status.json`) içine **Canlı Arama (`searchQuery`)**, **Bölüm Sabitleme (`pinnedSectionIds`)**, **Yalnızca Sorunlar (`bad`/`warn`)** hızlı filtresi, **`sinceAge` süreklilik yaşlandırması**, **`newlyDegradedRows` kritik geçiş tespiti**, **Çoklu Makine (`menubar.extraStatusFiles`) birleştirici**, **`SON OLAYLAR (DENETİM)` zaman çizelgesi** ve hiçbir OAuth/API sırrı içermeyen **Tek Tıkla (`⌘⇧C`) Markdown Özeti Kopyalama** eklendi.

### C. Raycast / Sistem Kontrol Merkezleri
- **Rakipte ne var?** Odak/toplantı sırasında otomatik uygulama yeniden başlatmalarını geçici olarak dondurma ("Do Not Disturb / Snooze") ve klavye odaklı hızlı filtreleme.
- **Bizim avantajımız ve yanıtımız:** `desktop.snoozeUntil` yapılandırması ve menü çubuğu üst bandındaki **Odak Modu (`moon.fill`)** düğmesiyle 60 dakikalık onaylı masaüstü yeniden başlatma ertelemesi ve durum panosu canlı arama çubuğu devreye alındı.
