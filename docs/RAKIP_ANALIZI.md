# keyflip — Rakip Analizi (Dünya + Türkiye)

> **Tarih:** 13 Kasım 2026  
> **Kapsam:** `keyflip` ürününün kesiştiği 4 ana dikeydeki (Çoklu AI Ajan Hesap/Oturum Yöneticileri, AI Gateway & Failover Proxy, Ajan Konuşma Hafızası/Arama, Geliştirici Sır & Kimlik Kasası) en güçlü **8 rakibin** (Dünya + Türkiye) özellik matrisi, fiyat/paket yapısı, kullanıcı övgüleri ve şikâyetleri.  
> **İlke:** Tüm veriler doğrulanmış açık kaynaklardan ve resmi fiyatlandırma sayfalarından derlenmiştir; kamuya açık olarak doğrulanamayan kalemler açıkça ***(doğrulanmadı)*** olarak işaretlenmiştir.

---

## 1. İncelenen Rakipler (Özet Profil)

| # | Rakip | Bölge / Kategori | Temel Konumlandırma | Kaynak |
|---|---|---|---|---|
| 1 | **Portkey AI** (`portkey.ai`) | Küresel (ABD/Hindistan — Mayıs 2026'da Palo Alto Networks tarafından satın alındı) | Kurumsal AI Gateway, koşullu yönlendirme, semantik önbellek (semantic cache), 50+ guardrail ve OpenTelemetry gözlemlenebilirliği | [portkey.ai](https://portkey.ai), [portkey.ai/pricing](https://portkey.ai/pricing) |
| 2 | **LiteLLM** (`litellm.ai`) | Küresel (ABD — BerriAI) | Açık çekirdekli (MIT + Enterprise) kendi sunucunda barındırılan (self-hosted) LLM Proxy, sanal anahtarlar (Virtual Keys), model bazlı bütçeler ve kurumsal RBAC/SSO | [litellm.ai](https://www.litellm.ai), [docs.litellm.ai](https://docs.litellm.ai) |
| 3 | **OpenRouter** (`openrouter.ai`) | Küresel (ABD — Ağustos 2026'da Stripe satın alma anlaşması) | Bulut tabanlı birleşik LLM API toplayıcısı, BYOK (Kendi Anahtarını Getir) yönlendirme, otomatik sağlayıcı/model failover | [openrouter.ai/pricing](https://openrouter.ai/pricing), [openrouter.ai/docs](https://openrouter.ai/docs) |
| 4 | **Helicone** (`helicone.ai`) | Küresel (ABD — Mart 2026'da Mintlify bünyesine katıldı) | Açık kaynaklı (Apache 2.0) LLM gözlemlenebilirlik (observability), maliyet ilişkilendirme, önbellek ve oturum analitiği | [helicone.ai](https://www.helicone.ai), [helicone.ai/pricing](https://www.helicone.ai/pricing) |
| 5 | **CodexBar** (`steipete/CodexBar`) | Küresel (Açık Kaynak) | macOS menü çubuğu ve CLI üzerinden Claude Code, Codex, Cursor, Gemini 5 saatlik / 7 günlük kota ve sıfırlanma süresi takipçisi | [github.com/steipete/CodexBar](https://github.com/steipete/CodexBar) |
| 6 | **CC Switch & Claude Squad** (`ccswitch.io` / `smtg-ai/claude-squad`) | Küresel (Masaüstü & TUI) | Claude Code, Codex ve OpenCode için çoklu hesap kartı değiştirici (`ccswitch.io`) ve `tmux` + `git worktree` tabanlı paralel ajan çoklayıcı (`claude-squad`) | [ccswitch.io](https://ccswitch.io), [github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) |
| 7 | **SpecStory & Entire CLI** (`specstory.com` / `entire.com`) | Küresel (ABD) | 12+ kodlama ajanının oturum geçmişini yerel olarak yakalayan, semantik arayan, Git commit'leriyle ilişkilendiren (`entire why`/`blame`) ve ajanlar arası devir yapan araçlar | [specstory.com](https://specstory.com), [entire.com](https://entire.com) |
| 8 | **Wiro AI** (`wiro.ai`) & **Infisical** (`infisical.com`) | **Türkiye** (Wiro AI — TRAI üyesi) & Küresel (Infisical) | **Wiro AI:** Türkiye çıkışlı birleşik AI model API gateway (`llm.wiro.ai/v1`), Türkçe LLM'ler, ön ödemeli kredi ve MCP desteği. **Infisical:** Geliştirici CLI sır/anahtar enjeksiyonu (`infisical run`), sızıntı tarama ve Agent Vault | [wiro.ai](https://wiro.ai), [infisical.com/pricing](https://infisical.com/pricing) |

---

## 2. Özellik Matrisi (Özellik × Rakip × keyflip)

> **Gösterim:** **Var** = Tam destekleniyor | **Kısmi** = Temel altyapı var ancak rakip derinliğinde değil | **Yok** = Henüz mevcut değil

| Özellik / Yetenek | Portkey | LiteLLM | OpenRouter | Helicone | CodexBar | CC Switch / Squad | SpecStory / Entire | Wiro AI (TR) / Infisical | **keyflip (Biz)** |
|---|---|---|---|---|---|---|---|---|---|
| **16+ Yerel AI Kodlama Ajanı Hesap Geçişi** (Claude, Cursor, Codex, Windsurf, Kiro, Gemini, Droid, Amp, Kilocode vb.) | Yok | Yok | Yok | Yok | Kısmi (yalnız okuma) | Kısmi (3–4 ajan) | Yok | Yok | **Var** (`src/surface.js`, `src/clisurfaces.js`) |
| **Tarayıcı + Masaüstü + CLI Atomik Senkron Geçiş** (Chrome/Arc/Brave/Edge + Windows DPAPI + macOS Keychain) | Yok | Yok | Yok | Yok | Yok | Yok | Yok | Yok | **Var** (`src/browserswitch.js`, `src/wincrypt.js`) |
| **Canlı 5s / 7g Kota & Sıfırlanma Takibi + Statusline** | Yok | Yok | Kısmi (kredi) | Yok | **Var** | Kısmi | Yok | Yok | **Var** (`src/usage.js`, `src/codexbar.js`, `src/menubar.js`) |
| **Tur Sınırında (Turn-Boundary) Önbellek Dostu Otomatik Hesap Değişimi** | Yok | Yok | Yok | Yok | Yok | Kısmi (orta turda keser, önbelleği bozar) | Yok | Yok | **Kısmi** (`src/switchplan.js` var; aktif prompt-cache sıcaklığını koruyan dinamik pencere hesabı eksik) |
| **Yerel Failover Proxy (429/401/5xx Hesap & Sağlayıcı Rotasyonu)** | **Var** | **Var** | **Var** | **Var** | Yok | Kısmi | Yok | **Var** (Wiro) | **Var** (`src/proxy.js`, `src/breaker.js`) |
| **Çoklu Protokol Ağ Geçidi (`/v1/messages` ↔ `/v1/chat/completions` ↔ `/v1/responses`)** | **Var** | **Var** | **Var** | **Var** | Yok | Yok | Yok | **Var** (Wiro) | **Kısmi** (`src/proxy.js` Anthropic odaklı; OpenAI `/v1/chat/completions` ve `/v1/responses` normalizasyonu kısmi) |
| **Sanal Anahtarlar (Virtual Keys `vk_...`) + Anahtar/Model Bazlı USD/TL Bütçe & RPM/TPM Limiti** | **Var** | **Var** | **Var** | **Var** | Yok | Yok | Yok | **Var** (Infisical/Wiro) | **Yok** (`src/budget.js` yalnız hesap bazlı 5s/7g % kota tavanı tutar; sanal anahtar, USD/TL harcama tavanı, RPM/TPM ve geçici bütçe artışı yok) |
| **Semantik Yanıt Önbelleği (Semantic Cache) + Maliyet Tasarruf Raporu** | **Var** | **Var** | Yok | **Var** | Yok | Yok | Yok | Yok | **Kısmi** (`src/router.js` tam SHA-256 eşleşmeli önbellek tutar; benzerlik tabanlı yerel önbellek ve kazanılan $ tasarruf sayacı yok) |
| **Proxy Üzerinde Gerçek Zamanlı Giden (Outbound) PII & Sır Maskeleme Guardrail'i** | **Var** | **Var** | Kısmi (Armor) | Kısmi | Yok | Yok | Kısmi (SpecStory yerel kayıt) | **Var** (Infisical Agent Vault) | **Kısmi** (`src/pii.js` ve `src/leakscan.js` dosya/konuşma tarar; `src/proxy.js` canlı HTTP gövdesinde giden sır/PII engelleme veya maskeleme yapmaz) |
| **Bileşik Yönlendirme Skoru (Fiyat + Gecikme TTFT + 429 Oranı + Kota Sağlığı)** | **Var** | **Var** | **Var** | Kısmi | Yok | Yok | Yok | Yok | **Kısmi** (`src/router.js` yalnız en ucuz statik fiyata veya sabitlemeye bakar; canlı gecikme/429 ağırlıklı bileşik skor yok) |
| **Ajan Konuşma İndeksi (BM25 + Yerel Vektör Semantik Arama)** | Yok | Yok | Yok | Kısmi (log arama) | Yok | Yok | **Var** | Yok | **Var** (`src/convindex.js`, `src/embed.js`) |
| **Git Commit ↔ Ajan Konuşması İlişkilendirme (`why` / `blame`) ve Prompt Kalite/Verimlilik Skoru** | Yok | Yok | Yok | Yok | Yok | Yok | **Var** (`entire why`, SpecStory Spec Score) | Yok | **Yok** (konuşmalar `cwd` ile eşleşir ancak commit SHA / dosya satırı izleme ve oturum verimlilik skoru yok) |
| **Harici Sır Kasası (1Password / Bitwarden) + Süreç Enjeksiyonu + Sızıntı Tarama** | Yok | Kısmi | Yok | Yok | Yok | Yok | Yok | **Var** (Infisical) | **Var** (`src/vault.js`, `src/leakscan.js`, `src/secretpolicy.js`) |
| **Çevrimdışı İmzalı Lisans (`keyflip license`) + Deneme (Trial) + Ek Süre (Grace Period) + Koltuk (Seat) & Kullanım Ölçümü** | Kısmi (bulut) | **Var** (`LITELLM_LICENSE`) | Yok (kredi) | Kısmi (bulut) | Yok | Yok | Kısmi (bulut) | Kısmi | **Kısmi** (`src/license.js` Ed25519 doğrulama var; ancak **deneme lisansı, grace period/süre dolum uyarısı, seat/cihaz alanı, kullanım/fatura defteri ve Web Panel lisans ekranı** eksik) |
| **Türkiye Yerel Ödeme (iyzico / PayTR, TL + Taksit, e-Fatura Uyumlu Fatura Kaydı)** | Yok | Yok | Yok | Yok | Yok | Yok | Yok | **Var** (Wiro) | **Kısmi** (`issuer/adapters/iyzico.js` ve `paytr.js` webhook doğrulayıcıları var; ancak TL/USD paket tanımları, fatura/kullanım muhasebe kaydı ve CLI/Panel satın alma akışı eksik) |

---

## 3. Rakiplerin Fiyatları, Paketleri, Övgüleri ve Şikâyetleri

### 3.1. Portkey AI (`portkey.ai` / Prisma AIRS AI Gateway)
- **Fiyat ve Paketler:**
  - **Open Source (Self-Hosted):** $0 (MIT lisansı; temel gateway, yönlendirme, basit yerel pano).
  - **Developer (Bulut Ücretsiz):** $0/ay — ayda 10.000 kaydedilmiş istek/log, temel gözlemlenebilirlik.
  - **Production / Pro:** **$49/ay** başlangıç + kullanım aşımı (~100.000 ek log başına ~$9); semantik önbellek, sanal anahtarlar, uzatılmış veri saklama.
  - **Enterprise:** Özel fiyatlandırma *(tam liste fiyatı kamuya açık değil — doğrulanmadı)*; SSO, RBAC, sıkı bütçe engelleme, SOC 2 / HIPAA, VPC kurulumu.
- **En Çok Övülenler:**
  - Sadece 2–3 satırlık `baseURL` ve başlık değişikliğiyle entegre olması.
  - Semantik önbellek (semantic caching) sayesinde tekrarlayan CI/CD ve RAG sorgularında doğrudan fatura düşüşü sağlaması.
  - 40+ sağlayıcı ve 1.600+ modeli tek OpenAI uyumlu şemada toplaması ve MCP araç çağrılarını izlemesi.
- **En Çok Şikâyet Edilenler:**
  - Yüksek trafik ve büyük iz (trace) hacimlerinde web panosunun yavaşlaması.
  - Çoklu ajan testlerinde ücretsiz 10.000 log limitinin birkaç saat içinde tükenmesi.
  - Kendi sunucunda (self-hosted) veya kapalı ağda çalışırken model fiyat tablolarının manuel güncellenmesi zorunluluğu.
  - Mayıs 2026'daki Palo Alto Networks satın alması sonrası bağımsız geliştiricilerin "kurumsal karmaşıklık" endişesi.
- **Kaynaklar:** [portkey.ai/pricing](https://portkey.ai/pricing), [G2 Portkey Reviews](https://www.g2.com/products/portkey/reviews), [Gartner Peer Insights](https://www.gartner.com/reviews/market/ai-gateways)

### 3.2. LiteLLM (`litellm.ai` — BerriAI)
- **Fiyat ve Paketler:**
  - **Open Source (MIT):** $0 — sınırsız trafik, temel sanal anahtarlar (`/key/generate`), model yönlendirme, temel bütçe limitleri (PostgreSQL + Redis gerektirir).
  - **Enterprise:** Özel yıllık lisans (`LITELLM_LICENSE` ortam değişkeni ile açılır; AWS/Azure Marketplace veya doğrudan satış — *kamuya açık sabit aylık liste fiyatı doğrulanmadı*). Anahtar başına model bütçeleri, geçici bütçe artışları, e-posta bütçe uyarıları, SSO/SCIM, `team_admin` RBAC, denetim kayıtları (audit logs).
- **En Çok Övülenler:**
  - Token başına komisyon (%0 markup) almaması ve 140+ sağlayıcıyı desteklemesi.
  - Sanal anahtar (`Virtual Keys`) ve takım bütçesi kavramını açık kaynak ekosisteminde standartlaştırması.
- **En Çok Şikâyet Edilenler:**
  - **Tedarik Zinciri ve Güvenlik Vakaları (2026):** Mart 2026 (`v1.82.7`/`v1.82.8`) ve Ekim 2026 (`v1.107.0`) PyPI/Docker paket sızıntıları ile `CVE-2026-35029` / `CVE-2026-59823` yetkisiz yapılandırma ve RCE açıkları nedeniyle tüm API anahtarlarını tek bir Python sunucusunda toplamanın yarattığı güvenlik endişesi.
  - **Altyapı Yükü:** Basit bir anahtar/bütçe takibi için dahi harici PostgreSQL ve Redis kümesi kurma ve bakım zorunluluğu.
  - **"SSO Vergisi":** Temel takım yetkilendirme (RBAC) ve denetim kayıtlarının yalnızca kurumsal sözleşmeyle açılması.
- **Kaynaklar:** [litellm.ai](https://www.litellm.ai), [docs.litellm.ai/docs/proxy/enterprise](https://docs.litellm.ai/docs/proxy/enterprise), [Check Point Research LiteLLM Advisory](https://research.checkpoint.com)

### 3.3. OpenRouter (`openrouter.ai`)
- **Fiyat ve Paketler:**
  - **Free Tier:** $0 — 25+ ücretsiz model, 50 istek/gün ve 20 istek/dk sınırı (en az $10 kredi yüklenmiş hesaplarda ücretsiz modeller için 1.000 istek/gün).
  - **Standard (Kullandıkça Öde):** Kredi yüklemesinde **%5.5 platform komisyonu** (min. $0.80 kart komisyonu); sağlayıcı liste fiyatından %0 token farkı.
  - **BYOK (Kendi Anahtarını Getir):** Temmuz/Ağustos 2026 politikasıyla ayda **$25.000 liste fiyatı karşılığı BYOK kullanımı ücretsiz**; aşan kısım üzerinden **%5 komisyon** OpenRouter kredisinden düşülür.
  - **Business Plan:** Kredi yüklemesinde **%8 komisyon**; AB/ABD bölge içi (in-region) veri yönlendirme ve kurumsal yönetişim.
  - **Enterprise:** Özel sözleşme, faturalı ödeme, SAML SSO, SLA.
- **En Çok Övülenler:**
  - Ekim 2026'da devreye alınan bileşik yönlendirici: sadece en ucuz fiyata değil, **etkin fiyat + throughput + TTFT gecikmesi + 429 sıklığı + araç çağırma (tool-call) başarısına** göre otomatik sağlayıcı seçimi.
  - Anında model değiştirme ve tek API ile 600+ modele erişim.
- **En Çok Şikâyet Edilenler:**
  - **Kontrolsüz Ajan Döngülerinde Bakiye Erimesi:** Sonsuz döngüye giren kodlama ajanlarının veya sızan anahtarların otomatik bakiye yükleme (auto-top-up) ile yüzlerce doları dakikalar içinde tüketmesi ve katı iade politikası.
  - **Sessiz Ücretli Fallback:** Ücretsiz veya ucuz model 429 verdiğinde yedek (fallback) olarak pahalı bir modele geçip krediyi beklenmedik şekilde bitirmesi.
  - **BYOK Şeffaflık Eksikliği:** Hangi çağrının kullanıcının kendi anahtarından (BYOK), hangisinin OpenRouter bakiyesinden geçtiğinin geçmiş panosunda zor ayırt edilmesi ve ~25–40 ms ek bulut proxy gecikmesi.
- **Kaynaklar:** [openrouter.ai/pricing](https://openrouter.ai/pricing), [openrouter.ai/docs/use-cases/byok](https://openrouter.ai/docs/use-cases/byok), [Trustpilot OpenRouter Reviews](https://www.trustpilot.com/review/openrouter.ai)

### 3.4. Helicone (`helicone.ai`)
- **Fiyat ve Paketler:**
  - **Hobby (Ücretsiz):** $0/ay — 10.000 istek/ay, 1 GB depolama, 1 ay saklama, 1 koltuk.
  - **Pro:** **$79/ay** (+ kullanım aşımı) — sınırsız koltuk, özel uyarılar, zamanlanmış raporlar, gelişmiş log sorgulama.
  - **Team:** **$799/ay** (+ kullanım aşımı) — 5 organizasyon, SOC 2 & HIPAA uyumluluğu, özel Slack desteği.
  - **Enterprise:** Özel fiyatlandırma — SAML SSO, yerinde (on-prem) kurulum, kurumsal SLA.
- **En Çok Övülenler:**
  - Tek satırlık başlık (`Helicone-Auth`) veya `baseURL` ile tüm istek/yanıt, TTFT ve maliyet metriklerini yakalaması.
  - Çok adımlı ajan oturumlarını (`Session`) ve kullanıcı bazlı maliyetleri net görselleştirmesi.
- **En Çok Şikâyet Edilenler:**
  - Pro ($79/ay) ile Team ($799/ay) arasında 10 katlık keskin fiyat uçurumu.
  - Bulut proxy üzerinden geçişin gizlilik/veri yerleşimi hassasiyeti olan ekiplerde ek onay gerektirmesi.
- **Kaynaklar:** [helicone.ai/pricing](https://www.helicone.ai/pricing), [G2 Helicone Reviews](https://www.g2.com/products/helicone/reviews)

### 3.5. CodexBar (`steipete/CodexBar`)
- **Fiyat ve Paketler:**
  - **Açık Kaynak (MIT):** $0 — tamamen ücretsiz (ticari paket veya ücretli sürüm yok).
- **En Çok Övülenler:**
  - Tarayıcı panosunu açmadan macOS menü çubuğunda ve Claude Code durum çubuğunda (`statusline`) 5 saatlik ve haftalık kota yüzdesini ve sıfırlanma sayacını göstermesi.
  - Şifre saklamadan yerel OAuth/Keychain oturumlarını okuması.
- **En Çok Şikâyet Edilenler:**
  - **Yalnız İzleme Yapması (Pasif Araç):** Kota dolduğunda hesabı kendisi değiştiremez, proxy failover yapamaz, oturum devri yapamaz.
  - **macOS Bağımlılığı:** Yerel arayüzün yalnız macOS 14+ üzerinde çalışması (Windows desteği olmaması).
  - 30 günlük token hesaplamasının bazen Claude Code `/status` çıktısıyla sapma göstermesi.
- **Kaynaklar:** [github.com/steipete/CodexBar](https://github.com/steipete/CodexBar), [CodexBar Issues](https://github.com/steipete/CodexBar/issues)

### 3.6. CC Switch (`ccswitch.io`) & Claude Squad (`smtg-ai/claude-squad`)
- **Fiyat ve Paketler:**
  - **Claude Squad:** $0 (AGPL/MIT açık kaynak TUI).
  - **CC Switch (`ccswitch.io`):** Ücretsiz/açık masaüstü ve CLI sürümleri mevcut *(kurumsal/ücretli katman fiyatı kamuya açık olarak doğrulanmadı)*.
- **En Çok Övülenler:**
  - `CC Switch`: İş ve kişisel Claude/Codex abonelikleri arasında tek tıkla geçiş ve paralel terminal pencerelerini farklı hesaplara bağlama.
  - `Claude Squad`: `git worktree` ve `tmux` ile birden fazla kodlama ajanını çakışmadan paralel çalıştırma ve TUI içinden diff inceleme.
- **En Çok Şikâyet Edilenler:**
  - **Prompt Cache Yıkımı (Maliyet Patlaması):** Otomatik hesap değiştiricilerin (%95 kotada) konuşmanın tam ortasında (mid-turn) hesap değiştirmesi yüzünden Anthropic prompt önbelleğinin (cache) sıfırlanması ve yeni hesapta tüm bağlamın baştan tam fiyattan yazılması.
  - **Bağlam ve Hafıza Kopukluğu (`CLAUDE_CONFIG_DIR`):** Hesapları ayrı klasörlere izole ettiklerinde B hesabının A hesabının yaptığı konuşmayı, MCP ayarlarını ve `CLAUDE.md` hafızasını görememesi.
  - `Claude Squad`'ın Windows'ta yerel çalışmayıp WSL/`tmux` gerektirmesi ve kendi başına hesap rotasyonu yapamaması.
- **Kaynaklar:** [ccswitch.io](https://ccswitch.io), [github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)

### 3.7. SpecStory (`specstory.com`) & Entire CLI (`entire.com`)
- **Fiyat ve Paketler:**
  - **SpecStory:** IDE eklentileri ve CLI **Ücretsiz** (Apache 2.0); **SpecStory Cloud** Freemium + ücretli **Pro** plan (çapraz ajan analitiği, Spec Score, token maliyet defteri — *Pro planın sabit aylık USD fiyatı giriş yapılmadan kamuya açık sayfada doğrulanmadı*).
  - **Entire (`entire.com`):** **Entire CLI** Ücretsiz (MIT); Bulut inceleme ajanları için ön ödemeli kredi sistemi ($100 ücretsiz deneme kredisi, min. $10 yükleme).
- **En Çok Övülenler:**
  - 12+ farklı terminal ve IDE ajanının konuşmalarını otomatik olarak yerel Markdown/checkpoint olarak saklayıp sırları maskelemesi.
  - `entire why` / `entire blame` ile bir kod satırının veya commit'in hangi ajan konuşmasından ve hangi prompt'tan çıktığını anında bulması.
  - `Spec Score` ile başlangıç prompt kalitesini ve token verimliliğini ölçmesi.
- **En Çok Şikâyet Edilenler:**
  - Yalnızca konuşma geçmişine odaklanmaları; kota takibi, hesap geçişi, yerel failover proxy veya anahtar kasası özelliklerinin hiç bulunmaması.
  - Bulut senkronizasyonu açıldığında şirket içi kod/konuşma parçalarının üçüncü parti buluta çıkması endişesi.
- **Kaynaklar:** [specstory.com](https://specstory.com), [entire.com](https://entire.com)

### 3.8. Wiro AI (`wiro.ai` — Türkiye) & Infisical (`infisical.com`)
- **Fiyat ve Paketler:**
  - **Wiro AI (Türkiye):** Kurulum veya sabit abonelik ücreti yok; **Ön Ödemeli Kredi / Kullandıkça Öde (Pay-per-use)**. Yalnız başarılı çağrılar ücretlendirilir (LLM'lerde token başına `cpt`, görsel/video modellerde saniye `cps` veya piksel `cp-pixel` bazlı). Eşzamanlı çalışma (concurrency) limiti hesaptaki kredi bakiyesine göre artar.
  - **Infisical:** Self-Hosted Core **$0** (MIT); Cloud Free **$0** (5 kimliğe kadar); **Pro $20/kimlik/ay** (yıllıkta; aylıkta $23); **Advanced $40/kimlik/ay** (yıllıkta; aylıkta $46 — otomatik rotasyon ve dinamik sırlar); **Enterprise** Özel fiyat.
- **En Çok Övülenler:**
  - **Wiro AI:** Türkiye'deki geliştiriciler için tek API (`llm.wiro.ai/v1`) ve MCP desteğiyle 1.000+ modele erişim, Türkçe ince ayarlı modeller (WiroAI Turkish LLM 8B/9B) ve yerel ekosistem uyumu.
  - **Infisical:** `infisical run` ile `.env` dosyalarını diske yazmadan süreç içine enjekte etmesi ve **Agent Vault** ile AI ajanlarının ham API anahtarını görmeden çağrı yapmasını sağlaması.
- **En Çok Şikâyet Edilenler:**
  - **Wiro AI:** Tamamen bulut API çağrısı üzerine kurulu olması; geliştiricinin kendi Claude Pro/Max veya Cursor/Codex masaüstü/CLI aboneliklerini yerel olarak yönetmemesi.
  - **Infisical:** **Makine Kimliği (Machine Identity) Maliyeti:** Her CI/CD işçisi veya ajan kimliğinin insan kullanıcı gibi koltuk başına ($20–$40/ay) ücretlendirilmesi nedeniyle çoklu ajan kullanan ekiplerde faturanın hızla şişmesi.
- **Kaynaklar:** [wiro.ai](https://wiro.ai), [infisical.com/pricing](https://infisical.com/pricing), [G2 Infisical Reviews](https://www.g2.com/products/infisical/reviews)

---

## 4. Stratejik Sentez: `keyflip` Neden Kazanır ve Hangi Boşlukları Kapatmalı?

1. **Rakiplerin Hiçbiri "Tam Yığın Yerel Ajan Kontrol Düzlemi" Değil:**
   - `CodexBar` ve `CC Switch` yalnız kota/hesap bakar ama proxy, sanal anahtar, bütçe, konuşma arama ve sır kasası yoktur.
   - `LiteLLM` ve `Portkey` güçlü proxy/bütçe sunar ama PostgreSQL/Redis veya bulut aboneliği ister; geliştiricinin yerel Claude Code / Cursor / Codex / Gemini OAuth aboneliklerini döndüremez ve konuşma hafızasını indekslemez.
   - `SpecStory` ve `Entire` konuşma geçmişini ve commit bağlantısını çözer ama kota, proxy, maliyet tavanı ve anahtar güvenliği sunmaz.
2. **Rakiplerden Alınacak Kritik İşlevler (`docs/GELISTIRME_LISTESI.md` Girdileri):**
   - **Merkezi Ticari Kilit (`keyflip license`):** Deneme (Trial) üretimi, süre dolumu öncesi uyarı / ek süre (Grace Period), koltuk/cihaz sayısı (`seats`), yerel kullanım & fatura defteri (`billing/receipts`) ve Web Panel (`src/panel.js`) üzerinde canlı lisans & paket yükseltme deneyimi.
   - **LiteLLM / Portkey'den:** Yerel Proxy için **Sanal Anahtarlar (`Virtual Keys`)**, anahtar/model bazlı **USD & TL harcama bütçeleri**, RPM/TPM hız sınırları ve **geçici bütçe artışı (temporary budget boost)**.
   - **Portkey / Infisical Agent Vault'tan:** Proxy üzerinden geçen canlı isteklerde **gerçek zamanlı giden (outbound) PII ve API anahtarı sızıntısı engelleme / maskeleme guardrail'i**.
   - **Portkey / Helicone'dan:** Yanıt önbelleğinde **token/maliyet tasarruf sayacı (Saved USD/TL & Tokens)** ve önbellek ısısını koruyan **tur sınırı (turn-boundary) + cache-warm hesap rotasyonu**.
   - **OpenRouter'dan:** Yalnız statik fiyata değil, **etkin fiyat + son gecikme (latency) + 429 hata oranı + kota sağlığına** dayalı **bileşik yönlendirme skoru (composite routing)**.
   - **Entire CLI / SpecStory'den:** **Git Commit ↔ Ajan Konuşması İlişkilendirme (`keyflip conv why <commit|file>`)** ve konuşma başına **Prompt Verimlilik / Önbellek Skoru (`Efficiency Score`)**.
