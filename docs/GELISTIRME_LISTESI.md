# keyflip — Geliştirme Listesi (Önceliklendirilmiş Yol Haritası)

> **Tarih:** 13 Kasım 2026  
> **Kaynak:** [`docs/RAKIP_ANALIZI.md`](./RAKIP_ANALIZI.md) özellik matrisindeki tüm **"Yok"** ve **"Kısmi"** satırları ile [`docs/GELIR_MODELI.md`](./GELIR_MODELI.md) ticari gereksinimleri.  
> **Öncelik Formülü:** $\text{Öncelik Skoru} = \frac{\text{Gelir Etkisi (1–10)} \times \text{Kullanıcı Değeri (1–10)}}{\text{Efor (1–5)}}$  
> - **P0:** Ürünün satılabilir, tahsilat yapabilir ve ödeyen müşteriye anında değer/ROI kanıtlayabilir olması için şart olan kalemler.  
> - **P1:** Bireysel `Pro` kullanıcısını `Team` paketine yükselten ve rakiplerin (Portkey, LiteLLM, OpenRouter) en güçlü ticari farklarını kapatan kalemler.  
> - **P2:** Çoklu protokol kapsamını, Git commit izlenebilirliğini (`Entire` / `SpecStory` farkı) ve görsel kalite kapısını tamamlayan kalemler.

---

## Özet Öncelik Tablosu

| Kod | İş Kalemi | Matris Karşılığı | Gelir | Değer | Efor | Skor | Öncelik | Durum |
|---|---|---|---|---|---|---|---|---|
| **P0-1** | `keyflip license` Tam Yaşam Döngüsü: 14 Günlük Deneme (`trial`), Ek Süre (`graceDays`), Koltuk (`seats`), Yerel Kullanım/ROI Defteri ve Web Panel Lisans Kartı | Çevrimdışı İmzalı Lisans + Deneme + Grace Period + Kullanım Ölçümü (Kısmi) | 10 | 10 | 2 | **50.0** | **P0** | [x] Tamamlandı |
| **P0-2** | `issuer/` iyzico + MoR Fatura Defteri (`invoices.jsonl`), TL/USD Paket Katalogu (`plans`) ve Sipariş/Vergi Mutabakatı | Türkiye Yerel Ödeme iyzico/PayTR + Fatura Kaydı (Kısmi) | 10 | 9 | 2 | **45.0** | **P0** | [x] Tamamlandı |
| **P0-3** | Sanal Anahtarlar (`Virtual Keys` — `vk_...`), Anahtar/Model Bazlı USD/TL Harcama Bütçesi, RPM/TPM Limiti ve Geçici Bütçe Artışı (`tempBoost`) | Sanal Anahtarlar + USD/TL Bütçe & RPM/TPM Limiti (Yok) | 9 | 10 | 2 | **45.0** | **P0** | [x] Tamamlandı |
| **P1-1** | Proxy Üzerinde Gerçek Zamanlı Giden (Outbound) PII & Sır Maskeleme / Engelleme Guardrail'i (`src/proxy.js` + `src/policy.js`) | Canlı Proxy Outbound PII & Sır Guardrail (Kısmi) | 9 | 9 | 2 | **40.5** | **P1** | [ ] Bekliyor |
| **P1-2** | Normalize/Semantik Yanıt Önbelleği + Kazanılan USD/TL & Token Tasarruf Sayacı (`src/router.js`) | Semantik Yanıt Önbelleği + Maliyet Tasarruf Raporu (Kısmi) | 8 | 9 | 2 | **36.0** | **P1** | [ ] Bekliyor |
| **P1-3** | Bileşik Yönlendirme Skoru (Fiyat + Gecikme TTFT + 429 Oranı + Kota) ve Tur Sınırında (Turn-Boundary) Prompt-Cache Dostu Otomatik Hesap Değişimi | Bileşik Yönlendirme Skoru (Kısmi) + Turn-Boundary Cache-Warm Geçiş (Kısmi) | 8 | 9 | 2 | **36.0** | **P1** | [ ] Bekliyor |
| **P2-1** | Çoklu Protokol Proxy Ağ Geçidi (`/v1/chat/completions` & `/v1/responses` ↔ `/v1/messages` Normalizasyonu) | Çoklu Protokol Ağ Geçidi (Kısmi) | 7 | 8 | 3 | **18.7** | **P2** | [ ] Bekliyor |
| **P2-2** | Git Commit ↔ Ajan Konuşması İlişkilendirme (`keyflip conv why <commit\|file>`) ve Oturum Verimlilik / Prompt Kalite Skoru (`Efficiency Score`) | Git Commit ↔ Konuşma İlişkilendirme & Prompt Skoru (Yok) | 7 | 8 | 3 | **18.7** | **P2** | [ ] Bekliyor |
| **P2-3** | Web Panel (`keyflip ui`) ve Ödeme/Lisans Arayüzü `ui-quality` Kalite Kapısı (Mobil/Laptop/Masaüstü Taşma & Görsel Doğrulama) | Arayüz Kalite Kapısı (Kısmi) | 8 | 8 | 2 | **32.0** | **P2** | [ ] Bekliyor |

---

## Detaylı İş Kalemleri, Kabul Ölçütleri ve Bağımlılıklar

### [x] P0-1 — `keyflip license` Tam Yaşam Döngüsü: Deneme (`trial`), Ek Süre (`graceDays`), Koltuk (`seats`), Yerel Kullanım/ROI Defteri ve Web Panel Lisans Görünümü
- **Matris Karşılığı:** *Çevrimdışı İmzalı Lisans (`keyflip license`) + Deneme (Trial) + Ek Süre (Grace Period) + Koltuk (Seat) & Kullanım Ölçümü (Kısmi → Var)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** Yok (`src/license.js`, `src/cli.js`, `src/panel.js`, `src/mcp.js`)
- **Kabul Ölçütü:**
  1. `src/license.js` imzalı yükü (`canonicalPayload`) geriye dönük uyumlu biçimde isteğe bağlı `seats` (tamsayı, varsayılan 1) ve `trial` (boolean) alanlarını desteklemeli; eski 4 alanlı (`email`, `expiry`, `issued`, `tier`) jetonlar %100 geçerli kalmalı.
  2. Süresi dolmak üzere olan (`expiringSoon`: bitişe $\le 7$ gün) ve süresi yeni dolmuş ancak ek süre (`graceDays`, varsayılan 7 gün) içinde olan lisanslar `status(ctx)` içinde `inGrace: true`, `daysRemaining` ve `expiringSoon: true` olarak raporlanmalı; `tier(ctx)` ek süre (`inGrace`) boyunca kesintisiz çalışmaya devam edip kullanıcıyı uyarmalı.
  3. `keyflip license trial [--email <e>]` komutu ve MCP aracı (`keyflip_license_trial`), makinede daha önce deneme başlatılmamışsa 14 günlük yerel deneme kaydı (`trial-state.json` / `license.json`) oluşturup `pro` özelliklerini 14 gün boyunca açmalı; ikinci kez çalıştırıldığında suistimali önlemek için reddetmeli.
  4. Yerel kullanım ve ROI defteri (`recordUsage(ctx, delta)` / `usageSummary(ctx)`): yapılan proxy isteklerini, önbellekten kazanılan USD/TL tutarını (`savedUsd`), önlenen 429 kesintisini (`failoversSaved`) ve engellenen sızıntıları (`leaksBlocked`) `<configDir>/usage-ledger.json` dosyasında tutmalı; `keyflip license status`, `keyflip license usage`, MCP `keyflip_license_status` ve `src/panel.js` Web Panel'inde göstermeli.
  5. Birim testleri (`test/license.test.js`, `test/panel.test.js`) yeşil olmalı.

---

### [x] P0-2 — `issuer/` iyzico + MoR Fatura Defteri (`invoices.jsonl`), TL/USD Paket Katalogu (`plans`) ve Sipariş/Vergi Mutabakatı
- **Matris Karşılığı:** *Türkiye Yerel Ödeme (iyzico / PayTR, TL + Taksit, e-Fatura Uyumlu Fatura Kaydı) (Kısmi → Var)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** P0-1 (`issuer/config.js`, `issuer/store.js`, `issuer/server.js`, `issuer/admin.js`, `issuer/adapters/iyzico.js`)
- **Kabul Ölçütü:**
  1. `issuer/config.js` ve `issuer/issuer.config.json` içinde TL (`TRY`) ve USD fiyatlı resmi paket tanımları (`pro` aylık/yıllık, `team` aylık/yıllık, koltuk sayısı `seats`, para birimi `currency`, tutar `amount`) desteklenmeli.
  2. `issuer/store.js` içinde her başarılı satın alma (`purchase`) ve iade (`refund`) işleminde `<stateDir>/invoices.jsonl` dosyasına fatura/muhasebe kaydı (`invoiceId`, `orderId`, `provider`, `email`, `tier`, `seats`, `months`, `amount`, `currency`, `taxMode`: `TR` için `domestic-vat-20pct`, yurt dışı için `export-exempt-0pct`, `issuedAt`, `status`) eklenmeli ve `listInvoices()` / `revenueSummary()` ile sorgulanabilmeli.
  3. `issuer/adapters/iyzico.js` hem doğrudan API hem HPP bildirimlerinden `paidPrice` / `price`, `currency` (`TRY`/`USD`), `basketId` ve koltuk (`seats`) bilgilerini çıkarabilmeli.
  4. `issuer/server.js` ve `issuer/admin.js` üzerinde fatura listesi ve gelir özeti (`TRY` ve `USD` ayrı toplamlarla) görüntülenebilmeli; tüm `issuer/*.test.js` testleri yeşil olmalı.

---

### [x] P0-3 — Sanal Anahtarlar (`Virtual Keys` — `vk_...`), Anahtar/Model Bazlı USD/TL Bütçesi, RPM/TPM Limiti ve Geçici Bütçe Artışı (`tempBoost`)
- **Matris Karşılığı:** *Sanal Anahtarlar (Virtual Keys `vk_...`) + Anahtar/Model Bazlı USD/TL Bütçe & RPM/TPM Limiti (Yok → Var)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** P0-1 (`src/budget.js`, `src/proxy.js`, `src/cli.js`, `src/mcp.js`)
- **Kabul Ölçütü:**
  1. `src/budget.js` içinde harici veritabanı (PostgreSQL/Redis) gerektirmeden yerel `<configDir>/virtual-keys.json` (`0600`) üzerinde çalışan **Sanal Anahtar (`vk_<random>`)** yönetimi (`createVirtualKey`, `listVirtualKeys`, `revokeVirtualKey`, `checkVirtualKey`, `recordVirtualKeySpend`, `boostVirtualKeyBudget`) bulunmalı.
  2. Her sanal anahtar için: isim (`label`), izin verilen modeller (`allowedModels` veya `*`), aylık/toplam USD bütçe tavanı (`maxBudgetUsd`), model bazlı alt bütçe (`modelBudgets`), dakikadaki istek sınırı (`rpmLimit`) ve süreli **geçici bütçe artışı (`tempBoostUsd`, `boostExpiresAt`)** tanımlanabilmeli.
  3. `src/proxy.js` gelen istekte `x-keyflip-virtual-key` veya `Authorization: Bearer vk_...` başlığı gördüğünde anahtarı doğrulamalı; bütçe veya RPM aşılmışsa ya da model izinsizse çağrıyı sağlayıcıya göndermeden `429`/`403` JSON hatasıyla durdurmalı ve gerçek sağlayıcı kimlik bilgisini arkada enjekte etmeli (ajan ham API anahtarını hiç görmez).
  4. CLI (`keyflip budget vkey <create|list|revoke|boost>`) ve MCP (`keyflip_budget_vkey_*`) araçları eklenmeli ve testleri (`test/budget.test.js`, `test/proxy.test.js`) yeşil olmalı.

---

### [ ] P1-1 — Proxy Üzerinde Gerçek Zamanlı Giden (Outbound) PII & Sır Maskeleme / Engelleme Guardrail'i
- **Matris Karşılığı:** *Proxy Üzerinde Gerçek Zamanlı Giden (Outbound) PII & Sır Maskeleme Guardrail'i (Kısmi → Var)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** P0-3 (`src/proxy.js`, `src/policy.js`, `src/pii.js`, `src/secretscan.js`)
- **Kabul Ölçütü:**
  1. `src/policy.js` ve `src/proxy.js` içinde giden (outbound) istek gövdelerini inceleyen `guardrail` modu (`off` | `redact` | `block`) desteklenmeli.
  2. `redact` modunda: istek içindeki API anahtarları (`sk-ant-...`, `sk-proj-...`, `AKIA...`, GitHub/Slack token'ları) ve PII verileri (e-posta, telefon, T.C. Kimlik No / kredi kartı kalıpları) sağlayıcıya çıkmadan önce `[REDACTED_SECRET]` / `[REDACTED_PII]` ile maskelenmeli ve yerel ROI defterinde `leaksBlocked` sayacı artırılmalı.
  3. `block` modunda: giden istekte ham sır tespit edildiğinde istek `400/422` (`GUARDRAIL_BLOCKED`) ile reddedilmeli.
  4. Birim testleri yeşil olmalı.

---

### [ ] P1-2 — Normalize/Semantik Yanıt Önbelleği + Kazanılan USD/TL & Token Tasarruf Sayacı (`src/router.js`)
- **Matris Karşılığı:** *Semantik Yanıt Önbelleği (Semantic Cache) + Maliyet Tasarruf Raporu (Kısmi → Var)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** P0-1 (`src/router.js`, `src/cost.js`, `src/cli.js`, `src/mcp.js`)
- **Kabul Ölçütü:**
  1. `src/router.js` önbelleği yalnız birebir ham metin eşleşmesini değil, normalize edilmiş (boşluk/büyük-küçük harf/noktalama arındırılmış kanonik imza + n-gram/token Jaccard benzerliği $\ge 0.88$ eşiğiyle) **Semantik/Yakın Eşleşme (`cacheLookupSimilar`)** aramasını desteklemeli.
  2. Her önbellek isabetinde (`cache hit`), modelin `src/cost.js` fiyat tablosuna göre kaç token ve kaç USD tasarruf edildiği hesaplanarak hem `<configDir>/cache/stats.json` hem de `license.recordUsage(ctx, { savedUsd, cacheHits })` defterine kaydedilmeli.
  3. `keyflip cache stats` komutu ve `keyflip_cache_stats` MCP aracı toplam isabet (`hits`), ıskalama (`misses`), isabet oranı (`hitRatePct`), kurtarılan token ve kazanılan USD/TL miktarını döndürmeli.

---

### [ ] P1-3 — Bileşik Yönlendirme Skoru (Fiyat + Gecikme TTFT + 429 Oranı + Kota Sağlığı) ve Tur Sınırında (Turn-Boundary) Prompt-Cache Dostu Otomatik Hesap Değişimi
- **Matris Karşılığı:** *Bileşik Yönlendirme Skoru (Kısmi → Var)* ve *Tur Sınırında (Turn-Boundary) Önbellek Dostu Otomatik Hesap Değişimi (Kısmi → Var)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** P1-2 (`src/router.js`, `src/switchplan.js`)
- **Kabul Ölçütü:**
  1. `src/router.js` içinde sağlayıcı seçimi (`route(ctx, model, opts)`), sağlayıcıların son gecikme süresi (`latencyMs`), 429/5xx hata oranı (`errorRate`) ve etkin token fiyatını birleştiren **Bileşik Yönlendirme Skoru (`compositeScore`)** hesaplamalı ve en yüksek sağlıklı skora sahip sağlayıcıyı seçmeli.
  2. `src/switchplan.js` içinde aktif konuşmanın Anthropic 5 dakikalık prompt önbelleği sıcaklığını (`cacheWarmUntilMs` / son mesaj yaşı $< 300\text{ sn}$) dikkate alan `isCacheWarm(session)` kontrolü bulunmalı; kota %98 gibi kritik acil eşiğe gelmedikçe sıcak prompt önbelleğini kırmamak için geçişi tur sonuna / önbellek soğuma anına planlamalı (`deferForWarmCache: true`).
  3. Birim testleri (`test/router.test.js`, `test/switchplan.test.js`) yeşil olmalı.

---

### [ ] P2-1 — Çoklu Protokol Proxy Ağ Geçidi (`/v1/chat/completions` & `/v1/responses` ↔ `/v1/messages` Normalizasyonu)
- **Matris Karşılığı:** *Çoklu Protokol Ağ Geçidi (`/v1/messages` ↔ `/v1/chat/completions` ↔ `/v1/responses`) (Kısmi → Var)*
- **Tahmini Efor:** 3 birim (Orta-Yüksek)
- **Bağımlılık:** P0-3 (`src/proxy.js`)
- **Kabul Ölçütü:**
  1. `src/proxy.js` üzerinde OpenAI `/v1/chat/completions` ve `/v1/responses` formatında gelen istekleri Anthropic `/v1/messages` formatına (ve yanıtını tekrar istemcinin beklediği OpenAI Chat / Responses JSON şemasına) çeviren protokol adaptörü (`translateOpenAIToAnthropic` / `translateAnthropicToOpenAI`) bulunmalı.
  2. Böylece yalnızca OpenAI veya UHP `/v1/responses` konuşabilen araçlar da yerel `keyflip` proxy'si üzerinden Claude hesap havuzunu ve failover yeteneğini kullanabilmeli.
  3. Birim testleri (`test/proxy.test.js`) yeşil olmalı.

---

### [ ] P2-2 — Git Commit ↔ Ajan Konuşması İlişkilendirme (`keyflip conv why <commit|file>`) ve Oturum Verimlilik Skoru (`Efficiency Score`)
- **Matris Karşılığı:** *Git Commit ↔ Ajan Konuşması İlişkilendirme (`why` / `blame`) ve Prompt Kalite/Verimlilik Skoru (Yok → Var)*
- **Tahmini Efor:** 3 birim (Orta-Yüksek)
- **Bağımlılık:** Yok (`src/conversations.js`, `src/convindex.js`, `src/cli.js`, `src/mcp.js`)
- **Kabul Ölçütü:**
  1. `src/conversations.js` / `src/convindex.js` içinde bir Git commit SHA'sını veya dosya yolunu (`keyflip conv why <commit|file>`) o sırada aynı çalışma dizininde (`cwd`) aktif olan ve ilgili dosya/commit zaman penceresiyle kesişen ajan konuşmasıyla eşleştiren `explainCommitOrFile(ctx, target)` işlevi bulunmalı.
  2. Her konuşma için açılış prompt netliği, önbellek okuma oranı (`cacheReadRatio`) ve tur başına çıktı verimliliğini 0–100 arasında puanlayan **Oturum Verimlilik Skoru (`scoreConversation`)** hesaplanmalı.
  3. CLI (`keyflip conv why <hedef>`, `keyflip conv score <id>`) ve MCP (`keyflip_conv_why`) araçları eklenmeli ve testleri (`test/convindex.test.js`) yeşil olmalı.

---

### [ ] P2-3 — Web Panel (`keyflip ui`) ve Lisans Arayüzü `ui-quality` Kalite Kapısı Doğrulaması
- **Matris Karşılığı:** *Arayüz Kalite Kapısı (`ui-quality/SKILL.md`)*
- **Tahmini Efor:** 2 birim (Orta)
- **Bağımlılık:** P0-1, P0-3 (`src/panel.js`, `DESIGN.md`)
- **Kabul Ölçütü:**
  1. `DESIGN.md` yön ve tasarım jetonları (tokens) tanımlanmalı; `src/panel.js` arayüzünde genel AI SaaS klişeleri (gradient metin, mor-mavi neon parlamalar, gereksiz rozet kalabalığı, ünlem işaretleri) bulunmamalı; tablo sayı sütunlarında `font-variant-numeric: tabular-nums` kullanılmalı.
  2. Masaüstü (1440 px), dizüstü (1000 px) ve mobil (390 px) görünümlerde yatay taşma (`scrollWidth > innerWidth`) ve öğe çakışması olmamalı; tarayıcı ekran görüntüsüyle doğrulanmalı.
