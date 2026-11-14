# Rakip Analizi — Keyflip & Kontrol Merkezi (`RAKIP_ANALIZI.md`)

Bu analiz, AI kodlama abonelikleri (Claude Code, Claude Desktop, Cursor, Codex, Antigravity, Kiro) ve yerel API/servis yönetimi alanındaki mevcut araçları **Keyflip Kontrol Merkezi** ile karşılaştırır.

---

## 1. Rakip Kategorileri ve Karşılaştırma Matrisi

| Özellik | ClaudeBar / Usage Widgets | CCManager / Oturum Araçları | LiteLLM / OpenRouter / Portkey | Raycast AI / Sistem Bar Araçları | **Keyflip Kontrol Merkezi** |
|---|---|---|---|---|---|
| **Çoklu Claude Hesabı Rotasyonu (CLI + Desktop)** | ❌ (Tek hesap) | ⚠️ (Yalnızca CLI profili) | ❌ (Yalnızca API key) | ❌ | ✅ (`keyflip switch` + Desktop çerez/OAuth senkronu) |
| **Abonelikten Ücretli API'ye Otomatik Failover** | ❌ | ❌ | ⚠️ (Yalnızca API-arası) | ❌ | ✅ (`keyflip failover` + Keysmith harcama tavanı) |
| **Gözetimli Tekil Daemon (`launchd` + Unix Soket)** | ❌ | ❌ | ✅ (HTTP proxy) | ❌ | ✅ (`com.keyflip.daemon`, `0600` soket, sıfır sır sızıntısı) |
| **Genel Durum Panosu (`status.json` Şeması)** | ❌ | ❌ | ❌ | ⚠️ (Özel script eklentileri) | ✅ (Yapılandırılabilir `status.json`, `owner_needed` rozeti, >20dk eski veri uyarısı) |
| **Kota Tüketim Hızı (Burn-Rate) & Tükenme Tahmini** | ✅ (5s pencere ETA) | ❌ | ❌ | ❌ | ✅ (`computeQuotaForecast` + "use-it-or-lose-it" önerisi) |
| **Sorun Odaklı Filtreleme (`bad`/`warn`) ve Markdown Rapor** | ❌ | ❌ | ✅ (Dashboard filtreleri) | ✅ | ✅ ("Yalnızca Sorunlar" filtresi + `⌘⇧C` ile Markdown kopyalama) |
| **Olay Zaman Çizelgesi (Audit Timeline UI)** | ❌ | ⚠️ (Oturum geçmişi) | ✅ (İstek logları) | ❌ | ✅ (`collectAuditTimeline` + açılır/kapanır `SON OLAYLAR` bölümü) |
| **Toplantı / Odak Modu (Masaüstü Restart Erteleme)** | ❌ | ❌ | ❌ | ✅ (Odak modu) | ✅ (`desktop.snoozeUntil` + üst çubukta onaylı 60 dk Odak Modu düğmesi) |
| **Çoklu Makine Durum Panosu Birleştirici** | ❌ | ❌ | ✅ (Merkezi telemetri) | ❌ | ✅ (`menubar.extraStatusFiles` ile `[<host>]` etiketli birleştirme) |
| **Kronik Sorun Süreklilik Yaşlandırması (`sinceAge`)** | ❌ | ❌ | ✅ (Incident duration) | ❌ | ✅ (`since` zaman damgasından otomatik `"45 dk"`, `"2 saat"` hesaplama) |

---

## 2. Rakiplerin Güçlü Yönleri ve Bizdeki Karşılıkları

### A. ClaudeBar / macOS Kota Widget'ları
- **Rakipte ne var?** 5 saatlik pencerenin yüzde kaçının geçtiğini kullanım yüzdesiyle kıyaslayarak *"Bu hızla gidersen sıfırlanmadan 40 dk önce kotan bitecek"* uyarısı verir.
- **Bizim avantajımız ve yanıtımız:** Rakipler yalnızca tek hesabı izlerken Keyflip birden fazla hesabı yönetir. `computeQuotaForecast` ile hem tüketim hızı (`burnRateRatio`) ve tükenme tahmini (`minutesUntilExhaustion`) eklendi hem de rakiplerde olmayan **"sıfırlanmasına az kalmış boş kapasiteli hesabı önerme" (use-it-or-lose-it)** algoritması devreye alındı.

### B. LiteLLM / Portkey / API Yönlendiricileri ve Olay İzleme Panelleri
- **Rakipte ne var?** Çok sayıda servis ve kota satırı arasında yalnızca hatalı/uyarı veren (`bad`/`warn`) bileşenleri filtreleme, bir sorunun ne kadar süredir devam ettiğini (incident duration) gösterme ve denetim olaylarını zaman çizelgesinde listeleme.
- **Bizim avantajımız ve yanıtımız:** Durum Panosu (`status.json`) içine **Yalnızca Sorunlar (`bad`/`warn`)** hızlı filtresi, **`sinceAge` süreklilik yaşlandırması**, **Çoklu Makine (`menubar.extraStatusFiles`) birleştirici**, **`SON OLAYLAR (DENETİM)` zaman çizelgesi** ve hiçbir OAuth/API sırrı içermeyen **Tek Tıkla (`⌘⇧C`) Markdown Özeti Kopyalama** eklendi.

### C. Raycast / Sistem Kontrol Merkezleri
- **Rakipte ne var?** Odak/toplantı sırasında otomatik uygulama yeniden başlatmalarını geçici olarak dondurma ("Do Not Disturb / Snooze").
- **Bizim avantajımız ve yanıtımız:** `desktop.snoozeUntil` yapılandırması ve menü çubuğu üst bandındaki **Odak Modu (`moon.fill`)** düğmesiyle 60 dakikalık onaylı masaüstü yeniden başlatma ertelemesi devreye alındı.
