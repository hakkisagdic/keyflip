# Keyflip & Kontrol Merkezi — Uçtan Uca Doğrulama Raporu (`DOGRULAMA.md`)

Bu belge, `feat/control-center` dalındaki tüm alt sistemlerin izole test ortamında (`KEYFLIP_CONFIG_DIR`) ve yerel macOS derlemesinde (`apps/menubar/build/KeyflipControlCenter.app`) uçtan uca çalıştırılarak doğrulanması sonucunda hazırlanmıştır.

> **Güvenlik ve Canlı Ortam Notu:** Yönetici kararı uyarınca `feat/control-center` dalı `main`'e birleştirilmemiş ve canlı makineye (`~/Library/LaunchAgents`) daemon kurulmamıştır. Tüm soket, zamanlayıcı ve `launchd` testleri hermetik geçici dizinlerde (`mkdtemp`) çalıştırılmıştır.

---

## Özellik Başına Doğrulama Tablosu

| # | Özellik / Alt Sistem | Durum | Açıklama ve Kanıt |
|---|---|---|---|
| 1 | **Yapılandırma Şeması (`src/config.js`)** | **çalışıyor** | `menubar.statusFile` (varsayılan `~/.polyctl/admin/status.json`), `autoswitch.threshold` ve `daemon.*` anahtarları tip/sınır doğrulamasından geçiyor; `0600` izinle atomik kaydediliyor (`test/config.test.js`: 21/21 geçti). |
| 2 | **Birleşik Gözetimli Daemon (`src/daemon.js`)** | **çalışıyor** | Tek-uçuş (non-overlapping) zamanlayıcı, `Retry-After` sessiz pencere koruması (`.usage-throttle.json`), `0600` izinli Unix soket (`daemon.sock`), HTTP/1.1 + NDJSON protokolü ve `redactSecrets` sızıntı engeli doğrulandı (`test/daemon.test.js`: 5/5 geçti). |
| 3 | **Uzun Dizin Yollarında macOS `sun_path` Sınırı** | **çalışıyor** | *(Önceki turda bozuktu: >104 bayt soket yolunda `EINVAL` veriyordu — düzeltildi)* `socketPath()` >96 bayt yollarda `/tmp/kf-d-<sha256>.sock` yoluna düşüyor. |
| 4 | **Genel Durum Panosu (`status.json` / `collectStatusBoard`)** | **çalışıyor** | `menubar.statusFile` ayarından okunuyor; dosya yoksa `null` dönerek bölümü tamamen gizliyor; `bad` → `warn` → `ok` → `unknown` sıralaması yapıyor; `>20 dk` veride `stale: true` (`"veri eski"`) üretiyor (`test/controlcenter.test.js` ve `ModelsTests.swift`). |
| 5 | **Menü Çubuğu `owner_needed` Rozeti (`MenuBarGlanceLabel`)** | **çalışıyor** | `status.json` içindeki `owner_needed` dizisinin uzunluğu `>0` olduğunda menü çubuğu etiketinde `•<sayı>` rozeti ve üst çubukta `BEKLEYEN: <sayı>` uyarısı gösteriliyor. |
| 6 | **Durum Panosu Dosya İzleme Tepki Süresi (`ControlCenterViewModel`)** | **çalışıyor** *(bozuk: yalnızca 15 sn'lik daemon döngüsünde yenileniyordu → düzeltildi)* | `status.json` atomik olarak güncellendiğinde veya silindiğinde 15 saniye beklememesi için 3 saniyelik hafif `mtime`/varlık izleyicisi (`checkStatusFileIfChanged`) eklendi. |
| 7 | **Sunucu Durumu Varsayılanlarında Gömülü Alan Adları (`collectServerStatus`)** | **çalışıyor** *(bozuk: ürün kodunda kişisel alan adları ve `Alastyr` sabiti gömülüydü → düzeltildi)* | "Ürün koduna yöneticiye özel yol ya da ad gömme" kuralı gereğince sabit kişisel domain listesi kaldırıldı; sunucu adı ve siteler yalnızca snapshot JSON dosyasından okunuyor. |
| 8 | **Diğer Kotalar (`collectOtherQuotas`)** | **çalışıyor** | Kiro, Copilot, Antigravity (`agy`), EVREN ve API Promosyonları (`apicredits`) kaynaklarını okuyor; erişilemeyen kaynaklarda asla sayı uydurmayıp `"okunamadı"` döndürüyor. |
| 9 | **Servis Yönetimi ve Beyaz Liste (`restartManagedService`)** | **çalışıyor** | Yalnızca `ALLOWED_RESTART_SERVICES` beyaz listesindeki servisleri ve `confirm: true` onayını kabul ediyor; her işlemi `keyflip.log` (`AUDIT`) ve `events.jsonl` içine kaydediyor. |
| 10 | **Akıllı Kota Tüketim Hızı (Burn-Rate) & Hesap Önerisi (`computeQuotaForecast`)** | **çalışıyor** | 5 saatlik penceredeki tüketim hızını (`burnRateRatio`), sıfırlanmadan önce tükenme süresini (`minutesUntilExhaustion`) ve sıfırlanmasına az kalmış boş kapasiteli ("use-it-or-lose-it") önerilen hesabı hesaplıyor. |
| 11 | **Durum Panosu "Yalnızca Sorunlar" Filtresi & Markdown Özeti Kopyalama** | **çalışıyor** | `filteredSections(onlyIssues: true)` ile yalnızca `bad`/`warn` satırları filtreliyor; `copySummaryToPasteboard()` ile gizlilik korumalı Markdown raporunu panoya kopyalıyor. |
| 12 | **SwiftUI Menü Çubuğu Uygulaması Derleme ve Test (`apps/menubar`)** | **çalışıyor** | `make menubar` (`apps/menubar/build/KeyflipControlCenter.app`) ve `make menubar-test` sıfır hata ile derlendi ve geçti. |
| 13 | **Tam Regresyon Paketi (`npm test`)** | **çalışıyor** | 2188 test çalıştırıldı, **0 başarısız** (`pass 2186`, `fail 0`, `skipped 2`). |
