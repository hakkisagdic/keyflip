# keyflip — Hesap Değiştirici

[English](README.md) | **Türkçe**

Birden çok **Anthropic / Claude Code** hesabı arasında tek tıkla (veya tek komutla) geçiş yapın.
Hesaplarınıza bir kez giriş yapın, sonra tekrar tekrar çıkış/giriş yapmadan aralarında dolaşın.

**Çok platformlu:** macOS, Linux ve Windows. Saf Node.js, sıfır çalışma zamanı bağımlılığı.

[![CI](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml/badge.svg)](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/keyflip)](https://www.npmjs.com/package/keyflip)
[![Node.js](https://img.shields.io/node/v/keyflip)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/hakkisagdic/keyflip)](https://github.com/hakkisagdic/keyflip/blob/main/LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://github.com/hakkisagdic/keyflip)
[![GitHub stars](https://img.shields.io/github/stars/hakkisagdic/keyflip)](https://github.com/hakkisagdic/keyflip/stargazers)

> **Platform kapsamı.** Çekirdek — hesap değiştirme, provider'lar, oturumlar,
> failover proxy, skill'ler, MCP — **çapraz-platformdur** (macOS/Linux/Windows,
> üçünde de CI-testli). **Masaüstü-uygulaması** özellikleri (desktop login
> takası, Cowork, oturum birleştirme, gateway) uygulama verisini okur: **macOS
> ve Windows'ta** çalışır (Linux'ta resmi masaüstü uygulaması yok). Uygulamanın
> hesabını otomatik algılamanın artık bir **Windows yolu da var** (DPAPI + AES-GCM,
> `src/wincrypt.js`, fixture-testli; kesin gerçek-kurulum yolları hâlâ cihazda
> doğrulama bekliyor). Bir **tarayıcı** çözüyle (uygulamanın ya da claude.ai'a girişli
> bir tarayıcının) çalışan `keyflip chat` şimdilik **yalnız macOS** — bkz.
> [docs/PORTING.md](docs/PORTING.md).

---

## Neden güvenli

- **OAuth token'larınız işletim sisteminin kimlik deposunda kalır.** macOS'ta bu Keychain'dir; Linux/Windows'ta Claude'un kendi `~/.claude/.credentials.json` dosyasıdır. keyflip token'ları bu yuvalar *arasında* kopyalar — yeni bir düz-metin token dosyası eklemez ve bu depo **hiçbir kimlik bilgisi içermez**.
- Bir geçiş yalnızca iki şeyi değiştirir: canlı kimlik yuvası ve `~/.claude.json` içindeki hesap işaretçisi (`oauthAccount` + `userID`).
- `~/.claude/projects` altındaki oturum geçmişiniz **hesaptan bağımsızdır** — hangi hesap aktifse onun altında görünür.

---

## Passkey'ler ve cihaza bağlı kimlik bilgileri

Claude (web ve masaüstü uygulama) artık **passkey (WebAuthn) ile giriş** sunuyor. keyflip için anlamı:

- **Passkey oturum açma adımını değiştirir, oturumun kendisini değil.** WebAuthn sonrasında istemci yine sıradan oturum kimlik bilgisi alır — keyflip'in kaydedip değiştirdiği şey tam olarak odur. Passkey eklemek mevcut profilleri veya kayıtlı girişleri geçersiz kılmaz.
- **Senkron passkey'ler Apple ID'nizle taşınır.** macOS'ta Safari/Chrome'da oluşturulan passkey'ler iCloud Keychain'de yaşar ve aynı Apple ID ile açık her Mac'te zaten çalışır. keyflip WebAuthn kimlik bilgilerini asla dışa aktarmaz — aktarım gerekmez ve sunulmaz. Touch ID yalnızca yerel kilidi açar: biyometrik veri cihazdan asla çıkmaz ve hiçbir kaydın parçası değildir.
- **Cihaza bağlı passkey'ler ve donanım güvenlik anahtarları taşınamaz.** Bir hesap bunlara bağlıysa yeni bir makineye tek yol orada etkileşimli giriş yapmaktır.
- **Masaüstü uygulama girişleri makineye özel kalır.** Uygulamanın cookie'leri o makinenin Safe Storage anahtarıyla şifrelidir; `keyflip transfer` bu yüzden bunları **bilinçli olarak** paketlemez (her makinede `keyflip add`'i yeniden çalıştırın).

---

## Gereksinimler

- **Node.js ≥ 18** (Claude Code zaten Node gerektirir)
- Kaydetmek istediğiniz hesap(lar)a girişli **Claude** uygulaması / Claude Code
- macOS, Linux veya Windows

---

## Kurulum

**macOS / Linux — tek satır** (npm ve sudo gerekmez; kaynakları indirir, macOS'ta başlatıcı uygulamayı da kurar):

```bash
curl -fsSL https://raw.githubusercontent.com/hakkisagdic/keyflip/main/install.sh | bash
```

**Windows — PowerShell** (Başlat Menüsü / Masaüstü kısayolu da oluşturur):

```powershell
irm https://raw.githubusercontent.com/hakkisagdic/keyflip/main/install.ps1 | iex
```

**npm ile (her işletim sistemi):**

```bash
npm install --global @hakkisagdic/keyflip          # npm registry'den
# veya doğrudan git'ten (registry gerekmez):
npm install --global git+https://github.com/hakkisagdic/keyflip.git
```

**Klondan:**

```bash
git clone https://github.com/hakkisagdic/keyflip.git && cd keyflip && ./install.sh   # Windows'ta: .\install.ps1
```

Kurulum kodu `~/.local/share/keyflip`'e yerleştirir, `keyflip`'i `~/.local/bin`'e bağlar ve `PATH`'e ekler. Kaldırmak için `./uninstall.sh` (veya `npm uninstall -g keyflip`).

---

## İlk kurulum (hesapları bul ve kaydet)

Kolay yol — yönlendirmeli sihirbazı çalıştırın, tüm hesapları sizin için yakalar:

```bash
keyflip setup
```

Önce o an girişli olduğunuz hesabı kaydeder, sonra döngüye girer: bir sonraki
hesaba geçin (Claude Code'da `/logout` sonra `/login`, ya da masaüstü uygulaması) ve
keyflip **yeni girişi otomatik algılayıp kaydeder** — tuşa basmanıza gerek yok.
Bittiğinde `d` yazın. Profiller e-postanızdan otomatik adlandırılır.

Elle yapmayı mı tercih edersiniz? `keyflip add` o an girişli olduğunuz hesabı
kaydeder (tek tek). macOS'ta ilk Keychain okumasında **"Always Allow"** (Her Zaman
İzin Ver) sorusu çıkar — onaylayın.

---

## Günlük kullanım

`keyflip` çalıştırın (veya macOS/Windows'ta **"Keyflip"** başlatıcısını açın) ve numarayla hesap seçin:

```
        Keyflip (keyflip)
  Active: alice@example.com

  → [1] alice@example.com
    [2] bob@example.org

  [number] switch   [a] save current   [d] delete   [t] threads   [r] refresh   [q] quit
```

`[t]` **thread** ekranını açar: aynı görevin, kota ortada tükenince iki hesabın oturumlarına dağılmış
halini tek ad altında gösterir. Her thread'i üyeleriyle listeler — hangi hesabın, transkripti nerede,
ne kadar taze ve onu sürdürecek `cd … && claude --resume …` satırı birebir — ayrıca `[s]` ile *bölünmüş
işi kendisi arar*. Bilerek salt-okunur: transkript gövdesi okumaz, hiçbir şey yazmaz, kota harcamaz;
bir thread'i değiştirmenin tek yolu adını CLI'dan yazmak (`keyflip threads create|add|open …`). Atanmamış
bir üye düzeltme komutuyla birlikte işaretlenir, çünkü keyflip'in sahibini bilemediği bir oturum
*o anki hesapla* devam eder — bir görev tam olarak böyle sessizce bölünür.

Claude / Claude Code açıksa keyflip önce **"Geçiş için Claude kapatılacak — devam edilsin mi?"** diye sorar. **Evet**'te Claude'u kapatır, geçer ve yeniden açar (macOS); **hayır**'da iptal eder, hiçbir şey değişmez.

### CLI

```bash
keyflip                       # etkileşimli menü (↑/↓ + Enter)
keyflip onboard [--manual] [--sso] [--console]   # tam ilk-kurulum: hesap başına giriş, CLI+tarayıcıyı
                              #   hizala, chatleri eşitle, sıradakini sor ("p" = API-key provider; --sso = kurumsal)
keyflip setup                 # hafif: Claude'da giriş yap, keyflip algılayıp yakalar
keyflip login [ad] [--email x] [--sso] [--console]   # resmi tarayıcı akışı, izole + yakala (--sso = kurumsal)
keyflip login <ad> --long-lived   # tek tarayıcı tıkıyla BİR YILLIK CLI token'ı (yalnız çıkarım);
                              #   hesabın normal girişi tamamen ölünce geçişler bunu kullanır
keyflip add [ad] [--app] [--dry-run]   # girişli hesap(lar)ı kaydet — CLI + masaüstü uygulaması (--dry-run = yalnız plan)
keyflip browser [status|logout|sync]   # tarayıcı claude.ai hesabını kontrol/sıfırla/geri yükle (uzantı)
keyflip <ad|numara>           # TÜM yüzeyleri o hesaba geçirir — CLI, masaüstü uygulaması ve
                              # tarayıcının claude.ai oturumu (dolayısıyla Chrome uzantısı); kaydı
                              # olmayan yüzey atlanır ve adıyla söylenir, diğerleri yine geçer
keyflip <ad> --only cli       # ...yalnız bu yüzeyler: cli | app | browser (virgülle)
keyflip <ad> --restart        # ...sormadan Claude'u kapatıp yeniden açar
keyflip <ad> --force          # ...Claude'u kapatmadan takas eder (kendiniz yeniden başlatın)
keyflip <ad> --browser        # ...sekmelerini geri açmayan açık bir tarayıcıyı da kapatıp geçirir
                              # (varsayılanda böyle bir tarayıcı atlanır, habersiz kapatılmaz)
keyflip <ad> --dry-run        # ...önce PLANI göster: neyin üzerine yazılacak, ne engelliyor ve o
                              # hesap gerçekten kimlik doğrulayabiliyor mu — HİÇBİR ŞEYE dokunmaz
keyflip <ad> --no-verify      # ...geçişin sonunda yaptığı geri-okumayı atla (varsayılan olarak çalışır)
keyflip <ad> --rollback-on-fail  # ...geri-okuma geçişin tutmadığını söylerse önceki hesabı geri koyar
                              # (bilerek açılır: kimlik bilgilerini yeniden yazar)
keyflip next                  # sıradaki kayıtlı hesaba dön
keyflip next --strategy best  # ...veya kalan kotaya göre seç (ayrıca: next-available)
keyflip provider catalog      # hazır presetler (Z.AI, Kimi, DeepSeek, MiniMax, OpenRouter, Ollama…)
keyflip provider add <id> --key-file -                    # ...bir preset için yalnızca anahtar gerekir
keyflip provider add <ad> --base-url <url> --key-file -   # ...veya herhangi bir 3. taraf endpoint kaydet
keyflip provider models <id|ad>   # endpoint gerçekte ne sunuyor? (GET /v1/models)
keyflip use <ad>              # Claude Code'u bir provider'a yönlendir (geri: keyflip provider off)
keyflip doctor                # sağlık kontrolü: git-e-sır, orphan oturumlar, versiyonlama, config, giriş, endpointler, masaüstü oturumu, otomatik güncelleme durumu, arka plan servisleri (kurulu mu? tutuluyor mu? her biri en son ne zaman çalıştı?)
                              #   --history ekle: keyflip'in commit ettiği her blob'da hâlâ okunabilir bir sır var mı?
keyflip backup now|list|restore <n>   # keyflip metadata anlık görüntüsü (sırsız)
keyflip usage --history       # hesap-başına kullanım eğilimi + failover olayları
keyflip usage --providers     # bu makinedeki DİĞER AI araçlarında kullanım/limit (Codex/Gemini/Cursor/Copilot/OpenRouter + Claude) — CodexBar tarzı monitör
keyflip api status            # Max/Team planının bağlı Console org'una verdiği aylık Claude API kredisi
                              #   (Admin anahtarı kullanımı okur; gösterilen bakiye bir tahmindir)
keyflip status                # her yüzey hangi hesapta (CLI + masaüstü uygulaması)
keyflip verify [hesap] [--usage] [--live]  # oraya geçmek ŞİMDİ işe yarar mı? saklanan/canlı token
                              # bitişini, uygulama cookie yakalamasını (oturum cookie'si + bitişi),
                              # token önbelleğini ve tarayıcı yakalamasının yaşını okur — sır değeri asla
keyflip refresh [hesap|--all] # saklı OAuth tokenları yeniler; bir Claude çalışırken yenilemeyi REDDEDER
                              # (canlı oturumun altında rotasyon bir yüzeyi logout eder)
keyflip refresh --schedule [--at 04:30] | --unschedule | --schedule-status
keyflip freshness [--json]    # her kayıtlı giriş ne kadar eski: CLI token + claude.ai girişleri (takma ad: age)                              # `refresh --all`'ı her gece zamanlayıcıya koy (launchd/cron) — token
                              # takvimde ölür, geçiş yaptığın günde değil; boş vaktte gözetimsiz koşar
keyflip chains [hesap] [--tighten [--apply]]   # bir giriş NEYDEN OLUŞUR: her yakalama hangi depodan
                              # kopyalandı, her parçayı kim yenileyebilir (araç / geçişte keyflip / yeni
                              # yakalama / sadece insan), ve ne bayat, paylaşılmış ya da herkese okunabilir.
                              # Yalnız stat — sırrı hiç okumaz, Keychain'e hiç dokunmaz
keyflip list [--usage]        # hesaplar; --usage her hesabın 5s/7g kullanımını ekler
keyflip autoswitch            # kullanımı izle; eşikte CLI hesabını otomatik değiştir
keyflip link [ad|--remove]    # bu dizin ağacını `run` için bir hesaba eşle
keyflip shell-init <bash|zsh|fish>   # `cd` ile sabitlenmiş hesabı otomatik etkinleştiren shell hook'u yazdır (eval "$(keyflip shell-init zsh)")
keyflip group [list|tag <hesap> <g…>|untag <hesap> <g>|members <g>]   # hesapları havuzlara etiketle; `next --group <g>` havuz içinde döner
keyflip budget [status|set <hesap> --5h N --7d N|clear <hesap>]   # kullanım-% tavanları + aşım/yaklaşım uyarıları (usage cache okur)
keyflip notify [status|set --webhook URL --events a,b,c|test|off]   # kota/switch/fleet-reply olaylarında bildirim (webhook + macOS banner)
keyflip import-env [<dosya>] [--dry-run] [--env]   # provider endpoint'lerini .env dosyasından / ortamdan içe aktar (anahtarlar asla yazılmaz)
keyflip log [--tail N] [--grep S] [--since ISO]   # eylem/denetim log'unu görüntüle
keyflip run-job "<prompt>" [--group g] [--strategy best]   # ORKESTRATOR: prompt'u en boş hesapta headless çalıştır (izole)
keyflip jobs [list|run|clear] · keyflip fanout "<prompt>" --accounts a,b,c   # iş kuyruğu + aynı prompt'u N hesapta koştur
keyflip cost [status|predict <hesap>|by-project]   # harcama/kullanım, limite-kalan-süre tahmini, repo bazında dağılım
keyflip team <publish|pull|members|add-member|remove-member> --dir <shared> --pool <n> --passphrase-file <f>   # rollü ŞİFRELİ ekip havuzu
keyflip policy <list|allow|deny|remove|default|check> [--cwd D --account A --group G]   # bir dizinin hangi hesabı kullanabileceğini kısıtla
keyflip vault <status|use op|bw|vault|off>   # kimlik bilgilerini 1Password / Bitwarden / HashiCorp Vault'ta sakla
keyflip route <list|set <model> <provider>|clear|arbitrage on|off> · keyflip cache <status|purge>   # model yönlendirme/arbitraj + yanıt cache
keyflip post --to <webhook> [--status]   # durumu/olayları Slack/Discord/genel webhook'a gönder
keyflip swarm <run "<cmd>"|ping <url>|drain --allow-exec|results>   # KENDİ kayıtlı filo makinelerinde komut çalıştır (exec onay-kapılı; argv-array, shell yok)
keyflip config <list|get <k>|set <k> <v>|unset <k>>   # ayarlar için tek doğrulanmış ev (E4)
keyflip ui [--fleet]          # tam ekran TUI: hesaplar · sağlayıcı kullanımı (u) · filo (f) · aranabilir KOMUT PALETİ (p) — hiçbir komutu ezberlemene gerek yok
keyflip codexbar              # yerel kurulu CodexBar kullanım-monitörüne köprü: izlediği sağlayıcıları keyflip'inkiyle hizala (sır okumaz)
keyflip brain "<niyet>"       # OPT-IN: düz dili, tek tek onaylayacağın bir keyflip adım planına çevir (Gemini; SADECE önerir, kendi başına çalıştırmaz)
keyflip surfaces              # bu makinedeki diğer AI araçlarını algıla (Cursor/Gemini/Codex/Copilot/opencode/Aider) — salt-okunur
keyflip license <status|activate <dosya>|deactivate>   # offline plan (Ed25519-imzalı, phone-home yok)
keyflip run <ad> [-- argümanlar]  # PARALEL oturum: o hesap YALNIZCA bu terminalde
keyflip add <ad> --token <dosya|->   # ham kimlik bilgisini headless içe aktar
keyflip mcp [--setup]         # agent'lar için stdio üzerinden MCP sunucusu
keyflip panel [--open]         # yerel web paneli: hesaplar+kotalar, etkinlik takvimi, memory takımyıldızı, oturumlar
keyflip panel --export <f> [--anon]   # paylaşıma-güvenli STATİK snapshot yaz (oturum içeriği yok, sır yok)
keyflip menubar [--install]   # menü-çubuğu/tepsi eklentisi — macOS xbar/SwiftBar, Linux GNOME Argos/KDE kargos: hesap+kota tek bakışta, tıkla-geç
keyflip statusline install    # aktif hesap + kotayı Claude Code promptunda göster
keyflip install-skill         # keyflip skill'ini bu makinedeki her agent'a kur
keyflip export [dosya|-]      # hesapları dosyaya yedekle (SIR İÇERİR)
keyflip import <dosya|->      # yedekten hesapları geri yükle (--force üzerine yazar)
keyflip migrate export <dosya> # hesap + provider + transkript + memory + config (MCP + settings) paketle
                              #   altküme seç: --sessions <id,id> / --search T / --newer-than 7d / --only-sessions
                              #   --agents (memory) ve/veya --agent-config (MCP/ayarlar, redakte) ile diğer AI ajanları
                              #   veya --agent-config-secrets ile GERÇEK anahtarları kendi makinelerin arasında taşı (şifrele!)
keyflip agents                # diğer ajanların memory + config'ini listele (Cursor/Gemini/Codex/Copilot/opencode/Aider; sırlar redakte edilir)
keyflip settings [show|get <k>|set <k> <v>]   # ~/.claude/settings.json'ı gör/düzenle (`migrate` ile diğer makinelere gider)
keyflip migrate import <dosya> # bu paketi bu makineyle BİRLEŞTİR (birleşim; --force üzerine yazar)
                              #   dosya paketleri AKIŞ (stream) hâlinde: önce metadata, sonra 128 KiB'lik
                              #   transkript parçaları; --passphrase-file ile kayıt-başına AES-256-GCM
keyflip migrate push --url <webdav>   # paketi başka makineye WebDAV üzerinden ilet (şifreli; bellekte, >256 MB reddedilir)
keyflip migrate pull --url <webdav>   # diğer makinede çekip BİRLEŞTİR (--force üzerine yazar; bellekte, >256 MB reddedilir)
keyflip transfer serve [--qr] # LAN: tek-kullanımlık kod (+ taranabilir QR) göster + şifreli paketi eşe akıt
keyflip transfer pull --code X # LAN: eşi otomatik bul, çek + BİRLEŞTİR (ya da <host:port> ver)
keyflip transfer serve --receive   # LAN: push edilen paketi ALMAK için BEKLE (ters yön)
keyflip transfer push <host> --code X   # LAN: paketini dinleyen makineye GÖNDER (E2 filtreleriyle)
keyflip transfer serve --relay <dizin|url>   # İNTERNET: aynı kod UX'i, paket senkronlu klasör / WebDAV relay üzerinden gider (LAN değil)
keyflip transfer pull --relay <dizin|url> --code <rendezvous>-<key>   # İNTERNET: relay'den çek + BİRLEŞTİR (tek-atış; alınınca silinir)
keyflip transfer relay [--dir D --host H --port P --auth-user U --auth-pass-file f]   # KENDİ sıfır-bağımlılık relay'ini barındır (sunucu gerekmez)
keyflip fleet init --dir <paylaşılan-klasör>   # FİLO: bu makineyi kontrol düzlemine bağla (şifreli paylaşılan/senkron klasör)
keyflip fleet discover   # bu LAN'daki diğer keyflip makinelerini bul (UDP multicast; paylaşılan klasör gerekmez)
keyflip fleet push [--with-secrets]   # bu makinenin durumunu yayınla (hesaplar+kota+chat durumu) + kuyruğa alınmış komutları uygula
keyflip fleet status | panel   # TÜM makineleri tek ekranda gör — hesaplar, kota, "cevap geldi mi?" (panel = web panosu)
keyflip fleet switch <makine> <hesap>   # UZAK makinenin hesabını değiştir (o makine push edince uygulanır)
keyflip fleet send-account <hesap> --to <makine> [--from <makine>]   # hesabı dağıt (örn. C'nin hesabını B'ye, A'dan)
keyflip fleet collect         # filoda yayınlanmış tüm hesapları bu makineye topla
keyflip fleet keys            # her makinenin imza-anahtarı parmak izini denetle (ok / CHANGED / unpinned)
keyflip fleet trust <makine>  # meşru bir yeniden-anahtarlama SONRASI makinenin imza anahtarını yeniden sabitle (aşağıdaki "Filo — origin authentication")
keyflip consolidate [--dry-run] [--watch] [--no-instances]  # her hesabın + kopyanın sohbet dizinini birleştir; her biri TÜM sohbetleri görsün
                                                 #   --dry-run yalnızca planı gösterir (uygulama açıkken de çalışır)
keyflip remove <ad|numara>    # kayıtlı hesabı sil (onay ister; --force ile atla)
keyflip logout [--browser] [--desktop]   # canlı oturum(lar)dan çık — kayıtlı hesaplar korunur
keyflip history | undo | restore <ref>   # git-versiyonlu config: her değişikliği incele / geri al / geri dön (sırlar asla commit edilmez)
keyflip doctor --history      # bir sır eski bir commit'te hâlâ okunabilir mi? (her blob'u tarar, türü bildirir)
keyflip scrub-history [--apply]  # onları history'den çıkar (önce dry-run; bundle yedeği + git-filter-repo; canlı dosya için --include-tracked)
keyflip secrets list | tolerate <yol> [--kind T] | untolerate <yol>  # hangi bulgular BEKLENEN bir şey (bedava/döndürülmüş/ölü anahtar): alarmı ve rotasyon ısrarını bitirir, temizliği asla
keyflip reset [--soft]        # FABRİKA sıfırlaması: TÜM keyflip verisini SİL (--soft hesapları korur)
keyflip uninstall [--purge]   # keyflip'i bu makineden kaldır (--purge veriyi de siler)
keyflip upgrade               # keyflip'in kendisini güncelle (kurulum yöntemini algılar)
```

### İnternet transferi — relay (sıfır-bilgi)

`transfer serve`/`pull` **internet üzerinden de** çalışır ve aynı tek-kullanımlık-kod UX'ini korur.
Doğrudan bir LAN soketi yerine şifreli paket **senin kontrol ettiğin bir relay** üzerinden gider;
`--relay` değerinden otomatik algılanır: bir **senkronlu klasör** (Dropbox/iCloud/Drive/Nextcloud) veya
bir **WebDAV URL'i**. Relay **sıfır-bilgidir** — yalnızca ciphertext tutar. Tek-kullanımlık kod
`<rendezvous>-<key>` biçimindedir: `rendezvous` yarısı herkese açık, rasgele bir arama tutamacıdır
(relay slot'u); `key` yarısı ise AES parolasıdır ve **relay'e, bir URL'e ya da log'a asla ulaşmaz**.
Paket, alınınca silinir (tek-atış).

Kendi relay'in yok mu? keyflip **senin için barındırabilir** — kendi kendine yeten, sıfır-bağımlılık bir
blob deposu; Docker yok, daemon yok: her iki makinenin de erişebildiği bir sunucuda
`keyflip transfer relay --host 0.0.0.0 --auth-user ben --auth-pass-file pass.txt` çalıştır, sonra her
iki taraftan `--relay http://<o-host>:8788/kf --user ben --pass-file pass.txt` ile ona işaret et. (Auth
olmadan herkese açık bir arayüze bağlanmayı reddeder; istersen `--allow-open` ile geçersiz kılarsın.)

### Filo — makine eklemek (pairing, sessiz güven yok)

Bir makine **ilk görüşte asla güvenilmez**. Klasöre yayınlamak bir eşi yalnızca *görünür* yapar
(`push`'ta `pending`, `fleet keys`'te `unpinned`); anahtarı sabitlenene kadar komutları yok sayılır.
Sabitlemenin iki yolu:

- **`keyflip fleet invite` / `keyflip fleet join <host-id> --code <kod>`** — davet eden, tek
  kullanımlık bir kod üretir (bir kez gösterilir, ~15 dk) ve davet dosyasını **o kodla şifreleyerek**
  yazar; katılan kodu girerek açar, davet edeni sabitler ve kodla şifreli bir join geri yazar; davet
  edenin bir sonraki `fleet push --accept-join <host-id> --code-file <f>`'i katılanı sabitler. İki taraf
  da yalnızca kodla kanıtlanmış anahtarı sabitler — parola tek başına bir makine ekleyemez.
- **`keyflip fleet trust <makine>`** — parmak izlerini elle karşılaştırdıktan sonra (`fleet keys`).

Sonradan **DEĞİŞEN** sabitli anahtar bir çakışmadır (olası anahtar-değiştirme) ve sessizce üzerine
yazılmaz.

### Filo — diğer makineleri bulmak (LAN keşfi)

Rendezvous klasörü her yerde çalışır, ama her makinede bir yol kurulumu ve eşler görünmeden önce bir
senkron turu gerektirir. Tek bir ağda daha hızlı bir yol var: `keyflip fleet discover` bir **UDP
multicast beacon** gönderip dinler ve yanıt veren keyflip makinelerini listeler — henüz paylaşılan
klasör yok, parola yok. Dinlerken **bu makineyi de ilan eder** (varsayılan AÇIK; `keyflip fleet announce
off` ya da `--no-announce` ile kapat). Beacon **yalnız genel kimlik** taşır (makine id'si, görünen ad ve
Ed25519 imza anahtarının kısa SHA-256 parmak izi) — asla parola, özel anahtar ya da komut — bu yüzden
liste yazdırılması güvenlidir. Bulunan bir eş yalnızca *erişilebilir*dir: bir komut hâlâ parola **ve**
sabitli bir anahtar gerektirir (yukarıdaki gibi pair et). Multicast kimseyi bulamazsa `fleet discover`
`tailscale status --json`'a düşer ve çevrimiçi tailnet eşlerini (`[Tailscale]` işaretli) listeler —
aynı genel-kimlik kuralları, hiç aynı LAN'da olmayan makineler için. İki taşıma da kimseyi bulamazsa
bunu söyler ve paylaşılan klasör yedek yol olarak kalır.

### Filo — origin authentication

Filo, makineleri **şifreli paylaşılan bir klasör** üzerinden koordine eder; dolayısıyla parola tek
başına bir komutu *kimin* kuyruğa aldığını kanıtlayamaz. Bu yüzden her makinenin bir **Ed25519 imza
anahtarı** vardır: özel anahtar makineden asla çıkmaz (`0600`, asla paylaşılan klasörde/argv'de değil);
açık anahtar status'te yayınlanır. Kuyruğa alınan her komut **imzalanır** ve alıcısına bağlanır; alıcı
imzası doğrulanmayan, başka bir makineye adreslenmiş ya da anahtarı **değişmiş** bir peer'den gelen
komutu **reddeder** (olası anahtar-değiştirme saldırısı). Bir peer'in anahtarı yalnızca **invite/join
pairing** ile (yukarıda) ya da açık bir `fleet trust` ile sabitlenir — asla ilk görüşte değil — böylece
sızmış bir parola ne komut uydurabilir ne de makine ekleyebilir. Sabitlemeleri `keyflip fleet keys` ile
denetle; bir makine meşru şekilde yeniden anahtarlandığında (temiz kurulum / sıfırlama) yeni anahtarını
`keyflip fleet trust <makine>` ile yeniden sabitle (önce out-of-band doğrulaman için yeni anahtarın
parmak izini yazdırır).

Genel bayraklar: `--json` (makine-okunur stdout — tek JSON nesnesi, `schemaVersion: 1`,
insan metni stderr'e; script/status-line için ideal) ve `--debug` (ayrıntılı log).
`ccs` kısa takma ad olarak çalışır. Günde en fazla bir kez pasif "yeni sürüm var"
bildirimi görünür (asla bir komutu engellemez).

### Güvenilirlik garantileri

- Her değişiklik **süreçler-arası kilit** altında çalışır — iki keyflip çağrısı
  bir geçişi asla iç içe geçiremez.
- Geçiş **işlemseldir**: canlı kimlik yazımı başarısız olursa hesap işaretçisi
  geri alınır; yarım kalmış geçiş durumu asla oluşmaz.
- Kayıtlı blob'lar geri yüklenmeden önce **doğrulanır**; bozuk profiller geri
  yüklenmek yerine temiz bir "yeniden ekle" mesajıyla reddedilir.
- Süresi dolmak üzere olan OAuth token'ları geçişte **otomatik yenilenir**
  (kimliğe canlı bir Claude oturumu sahipse atlanır; hatalar yüksek sesle uyarır).
- Kilitli macOS Keychain **"keychain kilitli"** olarak okunur ("kimlik yok" değil),
  5 sn zaman aşımıyla; profil deposu dosyalara düşerek çalışmaya devam eder.

### 3. taraf endpoint'ler — provider'lar (`provider`, `use`)

Hesaplar Anthropic **aboneliklerin** (OAuth). **Provider'lar** ise Claude Code'u
*farklı bir API endpoint'ine* yönlendirir — relay, kurumsal gateway, AWS Bedrock,
OpenRouter, Anthropic-uyumlu her şey — `~/.claude/settings.json`'daki `env`
bloğunu yamalar; Claude Code bunu **anında yeniden yükler, yeniden başlatma
gerekmez.**

```bash
keyflip provider catalog        # 19 preset: Z.AI/GLM, Zhipu, Kimi, DeepSeek, MiniMax, Qwen, Ark,
                                # OpenRouter, OpenAI, Gemini, xAI, Mistral, Groq, Together,
                                # Fireworks, Anthropic ve yerel Ollama / LM Studio / llama.cpp
keyflip provider add zai --key-file -          # bir preset yalnızca anahtar ister (URL katalogdan gelir)
keyflip provider add benim-gw --from deepseek --key-file -   # preseti kendi adınla kaydet
keyflip provider add openrouter --base-url https://openrouter.ai/api/v1 --key-file -   # herhangi bir endpoint
keyflip use zai                 # Claude Code'u ona yönlendir
keyflip provider off            # aboneliğine geri dön (OAuth)
keyflip provider list           # kayıtlı / aktif olan
keyflip provider models zai     # endpoint gerçekte ne sunuyor? (GET /v1/models)
keyflip speedtest openrouter    # endpoint'leri ölç, en hızlısını kullan
keyflip test openrouter         # tek gerçek istek: auth çalışıyor mu?
keyflip doctor                  # sağlık kontrolü: git-e-sır + orphan + versiyonlama + config + giriş + endpointler + masaüstü oturumu + otomatik güncelleme durumu + her arka plan servisi (kurulu / tutuluyor / son çıktı)
```

- Her preset, **Anthropic API** mi konuştuğunu (Claude Code doğrudan
  yönlendirilebilir) yoksa **OpenAI chat API**'si mi (Anthropic-uyumlu bir
  gateway/shim gerekir ya da yalnızca router/maliyet için uygundur) kaydeder —
  ikinci durumda `provider use` sessizce CLI'ı bozmak yerine uyarır. Model adları
  değişir; `provider models <id>` canlı listeyi sorar, `--model default=…` ezer.
- Terminalde çıplak `keyflip provider add` kategori gruplu, numaralı bir seçici açar.
- **API anahtarı sırdır** → OS kimlik deposunda saklanır, asla metadata dosyasında
  veya komut satırında değil (stdin/dosyadan okunur).
- Geçiş yalnızca keyflip'in yönettiği anahtarlara dokunur; kendi `settings.json`'un
  (hooks, plugins, model override'ları) korunur; `provider off` tam olarak
  enjekte edileni geri alır.
- `keyflip gateway use <provider>` aynısını Claude **masaüstü uygulaması** için
  yapar (uygulamayı yeniden başlat).

### Aylık API kredisi (`api`)

7 Ekim 2026'dan beri bir Claude **Max** veya **Team** aboneliği her ay bir
**Claude Platform (Console) API kredisi** de taşıyor: Max 5x $100, Max 20x $200,
Team koltuk başına ($500'de tavanlı). claude.ai hesabı tam **bir Console
organization**'a bağlanır (claude.ai → Ayarlar → Faturalama → API credits →
*Link organization*); kredi her faturalama döngüsünde yenilenir, devredemez ve ön
ödemeden önce harcanır.

`keyflip api` bu krediyi kaydettiğin her hesap için izler:

```bash
keyflip api add hakkisagdic --plan max20x --cycle-day 8 --admin-key-file -   # Admin anahtarı stdin'den
keyflip api orgs hakkisagdic      # o admin anahtarının gördüğü org'lar (bağlı olanı seç)
keyflip api status                # org başına: grant, bu döngüde harcanan, kalan
keyflip api status --json --offline
keyflip api set hakkisagdic --balance 137.42   # manuel mod: Console'un gösterdiğini işle
keyflip api remove hakkisagdic
```

- **Admin API anahtarı bir sırdır** (`sk-ant-admin01-…`, Console → Ayarlar → API
  Keys) → OS kimlik deposunda saklanır (`keyflip:admin-key` / `api:<hesap>`),
  asla metadata dosyasına yazılmaz, asla komut satırına konmaz. Tam tek bir
  sunucuya gider: `api.anthropic.com`.
- Console gerçek kalan bakiyeyi gösterir ama **onu okuyan bir API yok** — bu
  yüzden `status` Admin **maliyet raporunu** okuyup grant'tan düşer: *gösterilen
  sayı bir tahmindir* (grant − harcama) ve her yerde öyle söylenir. Plan
  grant'ları bilinir (`--plan`); bir **Team** org'una grant'ı bir kez söylenir
  (`--grant`).
- **Individual (bireysel) org'ların Admin API'si hiç yok** ("The Admin API is
  unavailable for individual accounts" — admin-keys sayfası orada 404 verir), bu
  yüzden o hesaplar **manuel modda** çalışır: `api add`'i `--admin-key-file`
  olmadan ver, sonra Console'daki Credits bakiyesini okuyup
  `api set <hesap> --balance <usd>` ile işle. Her okuma `api-accounts.json`'da
  bir girdidir (bir sayı ve bir zaman damgası — asla sır değil, 200'de sınırlı);
  `status` son bakiyeyi, önceki okumadan bu yana değişimi ve sıfırlama gününü
  ağa çıkmadan basar. Hesabı sonra yeniden eklemek (ör. anahtar eklemek)
  okumaları korur.
- `--cycle-day` kredinin her ay indiği gün (varsayılan `1`); hesabın abonelik
  yenileme gününe kur, döngü penceresi hep doğru olsun.

### Geçmiş konuşmaları bul & devam ettir (`sessions`, `resume`)

Claude Code transcript'lerin (`~/.claude/projects`) hesaptan bağımsız — keyflip
hepsini tek yerden tarar ve herhangi birini **kendi dizininde** devam ettirir.

```bash
keyflip sessions --search "oauth"     # tüm Claude Code konuşmalarını ara
keyflip sessions --here               # yalnız bu dizinde başlayan oturumlar
keyflip resume 3                       # listedeki 3. öğenin devam komutunu yazdır
keyflip resume <id> --run             # `claude --resume <id>`'yi kendi dizininde başlat
keyflip sessions rebind <eski> <yeni> # klasörünü yeniden adlandırdıktan sonra projenin chat geçmişini yeniden bağla
keyflip sessions assign <id> <hesap>  # bir oturumu başka bir hesap altında sürdür (resume --run) — profil değiştirmeden
keyflip sessions attribute           # ATANMAMIŞ her oturumun hesabını keyflip'in kendi geçiş zaman çizelgesinden tahmin et (kuru çalıştırma; yazmak için --apply)
keyflip threads                       # AYNI görevin oturumlarına tek ad — HESAPLAR ARASI (işaretçi, kopya değil)
keyflip threads suggest               # ZATEN 2+ hesaba bölünmüş işi bul — id tahmin etmeden
keyflip threads create <slug> --title "…"   # sonra: keyflip threads add <slug> <oturum-id|--chat uuid> [--account <ad>]
keyflip threads show <slug> [--timeline] [--md]  # thread'i tek kronolojik görünüm olarak (--md = yalnız belge)
keyflip threads open <slug> [--run]   # işin son durduğu yerde, ona sahip hesabın kimliğiyle devam ettir
keyflip threads where <id> | remove <slug> <id> | drop <slug> -y   # bul / ayır / adı UNUT (transkriptlere dokunmaz)
keyflip threads mirror <slug> | unmirror <slug>   # opsiyonel: birleşik sohbet metnini thread-mirror/'a yaz (`config set threads.mirror true` ister)
keyflip send <id> "<mesaj>" [--as <hesap>] [--fork]   # bir oturuma mesaj enjekte et (headless yönlendir/sürdür; ör. başka makineden)
keyflip sessions archive <id|--older-than 30d>   # eski transkriptleri keyflip'e taşı (gzip'li); unarchive geri yükler
keyflip sessions distill <id>   # bir sohbeti kalıcı hatıraya damıt (damıtma modelini `keyflip llm` seçer); `keyflip memory` ile gözat
keyflip sessions compact <id> [--apply]   # transkripti küçült: hacimli tool çıktısını ele, sohbeti koru (varsayılan dry-run)
keyflip sessions scrub <id> [--apply] [--categories …] [--llm-url URL]   # PII redakte et (e-posta/telefon/TCKN/kart/IBAN/IP/sırlar + özel + opsiyonel yerel LLM) — varsayılan dry-run, --apply'da yedekler
keyflip sessions delete <id> [--hard]   # bir sohbeti sil — varsayılan önce arşivler (geri alınabilir); --hard kalıcı siler
keyflip sessions edit <id> <delete-message|redact-message|truncate-after> <n> [--apply]   # cerrahi JSONL düzenleme (yedekler; dosyayı geçerli tutar)
keyflip sessions export <id> [--format md|html|json]   # bir sohbeti temiz, paylaşılabilir belgeye çıkar (offline inceleme / arşiv)
keyflip foreign <oturum-dosyası> [--format md|html|json]   # BAŞKA bir ajanın oturumunu (mesaj-olayı JSONL — Claude Code/opencode/Gemini/Qoder CLI — / Cursor SQLite / genel JSON / Copilot YAML / Aider MD) aynı görünüme normalize et
keyflip handoff [--to claude|cursor|kiro|opencode|windsurf|generic] [--out CONTINUE.md]   # YENİ bir yapay zeka aracının bu projeyi .keyflip/ üzerinden (bağlam, görevler, kararlar, kurallar, son checkpoint) her şeyi yeniden okumadan sürdürmesi için bir DEVAM-İSTEMİ üretir
keyflip dream [--older-than 30d] [--archive] [--apply]   # "dreaming": eski sohbetleri tek geçişte damıt (+ arşivle); varsayılan dry-run
keyflip recall "<sorgu>" [--answer]   # TÜM sohbetlerinde arama (BM25; --semantic=embeddings; --answer = damıtma modelinin atıflı sentezi)
keyflip dream schedule [--at 03:00] | unschedule | status   # dream'i her gece gözetimsiz koştur (launchd/cron)
keyflip llm [status|set --provider claude|ollama|openai [--model M] [--base-url U] [--key-env AD]|test [--timeout ms]|off]   # bu görevleri hangi model koşar — ve kimin kotasını yakar
keyflip cowork --search "sınav"       # masaüstü Cowork oturumları (tüm hesaplar)
keyflip chat                          # claude.ai Chat listesi (deneysel) — `--as <hesap>` başka hesabı okur
keyflip chat get <kısa-id|başlık>     # bir bulut sohbetini oku (listelemedeki kısa id yeterli)
keyflip chat search "<sözcükler>"     # başlığa göre bulut sohbeti ara
```

**Hesaplar arası ne taşınabilir:** Claude Code oturumları ve **Cowork**
oturumları yerelde hesap-başına saklanır — keyflip ikisini de okur ve geçişte
birleştirir; her hesap hepsini görür. **claude.ai Chat** ise bulutta, hesap-başına
sunucu tarafında; `keyflip chat` bunu bir **claude.ai oturum çerezi**yle okur.
**Deneyseldir** (belgesiz API) ve çerez-bağımlıdır:

**Birleştirme hem temel uygulamayı hem de keyflip kopyalarını kapsar.** Claude
Desktop Recents/Cowork işaretçilerini hesap-başına `<accountUuid>/<orgUuid>/`
klasörlerine yazar; her `keyflip instance` kopyası bunların kendi kopyasını
`~/.keyflip-instances/<araç>/<slug>/User Data/` altında taşır. `consolidate` bütün
bu depoları hesap klasörleriyle birlikte birleştirir; bir kopyada açılan sohbet
temel uygulamada ve diğer tüm kopyalarda görünür. İki hesap farklı transcript'ler
için aynı `local_*.json` adını meşru olarak kullanabilir: keyflip birini sessizce
düşürmek yerine `local_<cliSessionId>.json` adına geri düşer ve `deleted_<id>`
mezar taşı yine kazanır. `instance.pid`'i canlı bir kopya atlanır (dizini uygulama
sahiplenir ve çıkışta yeniden yazar) ve sonuçta adıyla bildirilir; `--no-instances`
yalnızca temel uygulamayla sınırlar. Birleştirme yalnızca dosya ekler ve önce her
depoyu yedekler.

**Kiro ve ChatGPT için birleştirme gerekmez.** Kiro sohbet durumunu tek IDE profilinde,
hesaba göre değil çalışma alanına göre saklar (`User/workspaceStorage/<hash>/state.vscdb`
ve `User/globalStorage/kiro.kiroagent/artifacts/sess_*`); hesap değişince yalnızca kimlik
bilgisi değişir, yerel geçmiş yerinde kalır. ChatGPT sohbetleri hesap başına sunucuda tutar
(claude.ai Chat gibi) ve yerel veri kökü (`~/Library/Application Support/Codex`) ortaktır —
birleştirilecek hesap-başına sohbet dizini yoktur. keyflip ChatGPT'nin *girişini* yönetir
(`keyflip chatgpt`), sohbet geçmişini değil.

- Oturum çerezi otomatik bulunur ve her listeleme nereden okunduğunu yazar: uygulamanın
  kendi çerezi, yoksa claude.ai'a girişli bir tarayıcı (güncel masaüstü sürümleri
  `sessionKey`'i bellekte tutar; diskteki çerez kavanozu genelde *kullanılabilir olmaz*),
  o da yoksa hesabın kayıtlı anlık kopyası.
- `--as <hesap>`, *başka* bir kayıtlı hesabın sohbetlerini, onun **kayıtlı tarayıcı
  oturumundan** (`~/.config/keyflip/browser-sessions/<ad>__<tarayici>.sql`, sonra
  `app/<ad>.cookies`) hiçbir şeyi değiştirmeden okur — yani o hesabın bulut geçmişini
  buradan arayabilir ve okuyabilirsin. Kayıtlı oturum yoksa, o hesapla bir tarayıcıda
  claude.ai'a giriş yap ve bir kez `keyflip browser capture <hesap>` çalıştır
  (`browser sync` tersini yapar — kayıtlı oturumu tarayıcıya geri yazar). Her keyflip
  geçişi ayrıca bırakılan hesabın girişini *ve çerezini* tazeler.
- Bir Chromium **profili** tam olarak tek bir claude.ai hesabı tutar; iki hesabın aynı anda
  canlı olması için iki profil gerekir. keyflip her profili görür (`Default` `chrome` olarak
  kalır; diğerleri `chrome-<ProfilDizini>` olarak görünür, örn. `chrome-Profile-2`), her birini
  kendi kimliği altında kaydedip geri yükler ve geçiş tarayıcıyı hepsi için bir kez kapatıp
  açar. `keyflip browser status --browser chrome` tüm profilleri kapsar; tek profile inmek
  için tam kimliği ver.
- **403, Cloudflare doğrulamasının bayatladığı** demektir — çıkış yapıldığı değil.
  `keyflip chat --flush` uygulamayı bir kez kapatıp açar ve tekrar dener.
- Arama yalnızca sohbet **başlıklarında** yapılır; mesaj içerikleri yerel kayıtlarında —
  tam metin için `keyflip recall "<sorgu>"`.
- Çerezler makine-bağımlıdır (tarayıcının kendi safeStorage anahtarı): bir anlık kopya
  yalnızca yakalandığı makine ve tarayıcıda çözülür. Taşınabilir kimlik bilgileri için
  `keyflip transfer`.

(Uygulama tercihleri, `design/`, worktree'ler global/boş — orada taşınacak hesap-bazlı veri yok.)

### Kiro — CLI ve IDE girişleri ayrıdır (`kiro`, macOS)

Kiro, keyflip'in yönettiği ilk Claude-dışı yüzey. **Birbiriyle bağlantısız iki
giriş** tutar: CLI'ın token'ı + cihaz kaydı macOS Anahtar Zinciri'nde
(`kirocli:odic:*`), IDE'nin ise `~/.aws/sso/cache/kiro-auth-token.json` dosyası ve
yanındaki `<clientIdHash>.json` kaydı. keyflip her yüzeyi ayrı yakalar; böylece
kayıtlı hesap "ekranda hangi token varsa o" değil, gerçek bir kimlik bilgisi
çiftidir:

```bash
keyflip kiro status          # canlı CLI e-postası/son geçerlilik + IDE süresi/hash'i ve kayıtlı hesaplar
keyflip kiro capture [ad]    # iki yüzeyi de kaydet (--cli-only / --ide-only ile daralt)
keyflip kiro switch <ad|n> [--dry-run] [--force] [--no-verify]
keyflip kiro usage [ad]      # IDE'nin kendi q-client.log'undan son kota bloğu
keyflip kiro list            # kayıtlı hesaplar ve her yüzeyin son geçerliliği
keyflip kiro import <slug>   # eski keyflip:surface:kiro:<slug>:* kaydını taşı
keyflip kiro remove <ad> --force
```

Kayıtlar `~/.config/keyflip/surfaces/kiro/<hesap>/` altında (0600, zaten
git-ignored `surfaces/` içinde) durur; `meta.json` sır içermez. CLI değeri asla
argv'den geçmez: keyflip `surfaces/kiro/.bin/` altında küçük bir yardımcı derler,
değeri stdin'den verir ve `SecItemUpdate` kullanır; böylece `kiro-cli` kendi
öğesini ve ACL'ini korur. Geçiş iki yüzeyi de bayt bayt geri okur; `whoami`
pozitif bir uyuşmazlık bildirirse yazım geri alınır. Önce Kiro'yu kapat —
çalışan `Kiro`/`kiro_cli_desktop` oturumu tutar ve çıkışta yeniden yazabilir; bu
yüzden komut `--force` olmadan reddeder.

İki yüzey tek bir yenileme zincirini paylaşabilir: IDE'deki bir yenileme CLI
token'ını, CLI'daki bir yenileme IDE token'ını geçersiz kılabilir. keyflip her
yüzeyin kendi baytlarını saklar; ama yüzey başına tamamen bağımsız zincir için her
yüzeye bir tarayıcı girişi gerekir (#33). Süresi geçmiş kayıt `EXPIRED` görünür;
ona geçiş taze bir giriş ister.

### ChatGPT + Codex — tek ortak giriş (`chatgpt`, tüm platformlar)

ChatGPT.app ve Codex CLI **aynı dosyayla** kimlik doğrular:
`~/.codex/auth.json` (veya `$CODEX_HOME/auth.json`, kip 0600). Dosya OAuth
token'larını — API-key girişinden sonra `OPENAI_API_KEY`'i de — tutar. Hesap
e-postası, plan ve hesap kimliği id_token'dan okunur. Uygulamanın diskteki
çerezleri burada **kimlik bilgisi değildir**: yalnızca Cloudflare/analytics
kayıtları içerir.

```bash
keyflip chatgpt status          # canlı e-posta/plan/son geçerlilik + kayıtlı hesaplar; asla token değeri
keyflip chatgpt capture [ad]    # canlı girişi kaydet (e-postasından otomatik adlandırır)
keyflip chatgpt switch <ad|n|e-posta> [--dry-run] [--force] [--no-verify]
keyflip chatgpt refresh [--force]   # şimdi döndür; --force 24s eşiğini yok sayar
keyflip chatgpt list            # kayıtlı hesaplar ve token son geçerlilikleri
keyflip chatgpt backups         # geçmiş geçiş/yenilemelerden auth.json kopyaları
keyflip chatgpt backups restore <n|dosya> [--dry-run] [--force]
keyflip chatgpt remove <ad> --force
```

`codex`, `chatgpt` için takma addır. Kayıtlar
`~/.config/keyflip/surfaces/codex/<slug>/` altında: 0600 kipinde `auth.json` ve
sır içermeyen `meta.json` (e-posta, plan, hesap kimliği, son geçerlilik — asla
token). Geçiş canlı dosyayı yedekler, giden girişi en-iyi-çabayla yakalar, saklı
baytları yazar ve geri okur (ham içerik + e-posta kimliği). ChatGPT/Codex
çalışırken `--force` olmadan reddeder; çünkü uygulama token'ları önbelleğe alır ve
çıkışta dosyayı yeniden yazar.

**Kötü bir geçiş geri alınabilir.** Her geçiş ve token yenilemesi canlı `auth.json`
dosyasını `~/.config/keyflip/backups/` altına kopyalar (en yeni 10 tanesi saklanır).
`keyflip chatgpt backups` bunları hesap e-postası/plan/son geçerlilikle listeler —
asla token — ve `backups restore <n|dosya>` birini geri yazar; önce mevcut canlı
girişi yedeklediği için geri yükleme de geri alınabilir. ChatGPT/Codex çalışırken
`--force` olmadan reddeder ve dosyayı geri okuyup doğrular.

**Yenileme yalnızca canlı dosyada ve soy-güvenlidir.** Erişim token'ları yaklaşık
on gün yaşar (beş güne indiği görüldü). Arka plan yenileme daemon'ı (`keyflip
refresh --daemon-start`) beş dakikada bir kontrol eder ve son geçerliliğe 24 saat
kala **canlı** dosyayı döndürür — ChatGPT/Codex çalışırken asla. Az önce
harcanan refresh token'ını aynen tutan kayıtlı bir kopya varsa o da güncellenir;
böylece ona geri dönüş ölü bir token'ı tekrar oynatmaz. Uyuyan kayıtlar kendi
başlarına yenilenmez: hesap başına tek soy, birbiriyle yarışan iki refresh token
yok. Bu özellikten önce zaten bayatlamış bir kayıt yine taze giriş ister (eski
refresh token'ı uygulama tarafından harcanmıştır); başarısız yenileme dosyayı olduğu
gibi bırakır ve sağlayıcı hatasını bildirir; `refresh` ayrıca neden ertelediğini
yazar (vadesi gelmedi / çalışıyor / refresh token yok). Gece `refresh --schedule`
işi Claude OAuth token'larını kapsar; bu giriş için tek seferlik komut
`keyflip chatgpt refresh`'tir.

### Aynı anda birden çok hesap — izole uygulama kopyaları (`instance`, macOS)

> **Yalnızca macOS.** Bu komutlar bir macOS `.app` paketini `~/Library/Application Support`
> altına kopyalar, `open` ile başlatır ve AppleScript ile sürer — bunların hiçbiri Linux/Windows'ta
> yoktur. Oralarda komut *"`<Araç>.app` /Applications/… konumunda bulunamadı"* diyerek erken durur.
> Bunun yerine `keyflip switch` kullanın: kimlik bilgisi geçişi her platformda çalışır, uygulama
> kopyaları ise yalnızca macOS'tadır.

Masaüstü uygulamalarının çerezleri ~30 günde düşer. `keyflip instance` her hesap için
uygulamanın APFS copy-on-write kopyasını (`cp -cR`, neredeyse sıfır disk) ve ayrı bir
`--user-data-dir` oluşturur; oturumlar birbirine karışmaz ve yeniden giriş istemez.

```bash
keyflip instance list                     # tüm araçlar (ya da: list claude)
keyflip instance create <araç> <hesap>    # ör. create claude yahoo@gmail.com
keyflip instance launch <araç> <hesap>    # önce aynı aracın diğer örneklerini kapatır (deep-link tuzağı)
keyflip instance focus <araç> <hesap>
keyflip instance kill <araç> <hesap>
keyflip instance harden [araç] [hesap]    # uygulamanın sunduğu güncelleme anahtarını uygular (varsayılan: hepsi)
keyflip instance enable-all <araç>        # kayıtlı tüm hesaplar için örnek oluşturur
keyflip instance help                     # desteklenen araçlar adaptörlerden okunur
```

**Desteklenen araçlar:** `claude`, `kiro`, `chatgpt` (kurulu uygulamalara karşı doğrulandı —
Claude.app, Kiro.app, ChatGPT.app) ve `cursor` (standart yol; doğrulama makinesinde kurulu değil).
Dördü de Electron olduğu için `--user-data-dir` gerçek çerez/oturum izolasyonu verir. Yeni araç =
`src/instances.js` içindeki `TOOL_ADAPTERS`'a tek kayıt; CLI yönlendirmesi, MCP uçları, PID takibi ve
launch/focus/kill mantığı otomatik çalışır.

**Konum:** `~/.keyflip-instances/<araç>/<hesap>/` — `<Araç>.app` kopyası,
`User Data/`, `Config/` (adaptör config env tanımlıyorsa uygulamaya geçirilir; Claude:
`CLAUDE_CONFIG_DIR`), `profile.json`, `instance.pid`.

Kısa yol bilinçli: Kiro kendi user-data dizininde bir Unix soketi açar ve macOS bu yolları 103
karakterle sınırlar; eski `~/Library/Application Support/keyflip-instances` konumu her Kiro
kopyasını `listen EINVAL` ile düşürüyordu. Mevcut örnekler ilk kullanımda otomatik taşınır.

Otomatik güncelleme: uygulama kendi anahtarını sunuyorsa `create` onu kapatır — Claude kopyasının
`User Data/config.json` dosyasına `disableAutoUpdates: true` yazar; ChatGPT'nin Sparkle
`Info.plist` feed'i boşaltılır (en-iyi-çaba). Plist imza kapsamında olduğu için anahtar yazıldıktan
sonra kopya ad-hoc yeniden imzalanır (Apple'ın iç yardımcılarına dokunulmaz); imzalama başarısız
olursa özgün plist geri konur ki kopya açılmaya devam etsin. Kiro/Cursor böyle bir anahtar sunmaz. Eski
`keyflip instance harden [araç] [hesap]` mevcut kopyalara anahtarı yeniden uygular (hedefsiz
çağrı tümüne; çalışan kopyayı önce kapatın — `config.json` uygulamanın elindedir ve üzerine yazar). `keyflip doctor` **canlı** durumu okur: kapatılabilir olduğu hâlde hâlâ açık bir
kopya uyarıdır, anahtarı olmayan araç ise olduğu gibi — `uncontrollable` — raporlanır. Eski
`keyflip claude-profiles` komutları uyumluluk sarmalayıcısıyla çalışmaya devam eder.

**Hangi girişler gerçekten izole:** bir kopya uygulamanın *profilini* (çerezler,
önbellekler, pencere durumu) izole eder; aracın sahip olduğu her kimlik bilgisini değil.
Tamamen kopya-izole tek araç Claude'dur: CLI yapılandırması (`CLAUDE_CONFIG_DIR`) ve
masaüstü kullanıcı verisi kopyanın içinde yaşar. ChatGPT/Kiro girişi global bir depoda
tutar (`~/.codex/auth.json`, Anahtar Zinciri ve `~/.aws/sso/cache`); her kopya bu depoyu
paylaşır — farklı hesap için kopya kullanmak yine önce `keyflip chatgpt switch` /
`keyflip kiro switch` ister. Antigravity (Anahtar Zinciri `gemini/antigravity`) ve Qoder
(`~/.qoder/.auth/user`) için instance adaptörü yoktur ve girişleri globaldir; kopyalamak
onları ayırmaz. Cursor tanımlı ama doğrulama makinesinde denenmedi.

**Sorun giderme:**

- *"No instance found for claude/work"* — önce oluşturun; slug hesap adıdır, yani `yahoo@gmail.com` ile
  `yahoo` ayrı slug'lardır. `keyflip instance list` tam `araç/slug` çiftlerini yazar.
- *"`<Araç>.app` /Applications/… konumunda bulunamadı"* — keyflip uygulamayı indirmez, kopyalar.
  Temel uygulamayı kurun ya da kurulu bir aracı seçin.
- *Kopya açılışta oturumsuz görünüyor* — `create` uygulamayı kopyalar, girişi değil. Hesabın kayıtlı
  uygulama oturumunu **o kopyaya** geri yükleyin: `keyflip switch <hesap> --instance claude/<slug>`
  (`keyflip <hesap> --instance …` kısayolu da geçerli). Düz `keyflip switch` yalnızca temel uygulamaya dokunur.
- *`harden` çalışan kopyayı reddediyor* — önce kapatın (`keyflip instance kill claude/<slug>`). Çalışan
  uygulama `config.json`'ı belleğinde tutar ve çıkışta üzerine yazar; altına yazmak sessizce geri alınırdı.
- *Bir örneği başlatmak diğerlerini kapatıyor* — bilinçli: iki canlı kopya, macOS'un `claude://`
  bağlantılarını yanlış olana yönlendirmesine yol açar.
- *`du` kopya başına yüzlerce MB gösteriyor* — APFS'te beklenen: dokunulmamış bloklar fiziksel olarak
  paylaşılır. Gerçek maliyeti öncesi/sonrası `df` ile ölçün.
- *`harden` `Info.plist`'i düzenledikten sonra kopya açılmıyor* — güncel keyflip plist'i yamaladıktan
  hemen sonra dış paketi ad-hoc yeniden imzalar; imzalama başarısız olursa özgün plist'i geri koyar, yani
  bu artık olmamalı. Eski sürümle oluşturulmuş bir kopya takıldıysa kapatıp
  `keyflip instance harden <araç>/<slug>` komutunu yeniden koşun; son çare kopyayı yeniden oluşturun.
  Onarım için `codesign --deep` **kullanmayın**: derin imzalama Apple'ın iç yardımcılarını yeniden yazar;
  otomatik yol bilinçli olarak onlara dokunmaz.

### Görevleri hangi model koşar (`llm`)

`dream`, `sessions distill` ve `recall --answer` ev işidir — aboneliğin parasını yemesi gereken iş
değil. Yine de varsayılan olarak `claude -p`'yi çağırırlar, yani **aktif hesabın** kotasını harcarlar;
kurulu bir `dream schedule` bunu her gece 03:00'te gözetimsiz tekrarlar. `keyflip llm` bu tercihi
açık ve geri alınabilir hale getirir:

```bash
keyflip llm                                   # görevleri kim koşuyor, maliyeti ne
keyflip llm set --provider ollama --model qwen2.5:7b-instruct   # yerel, ücretsiz, makineden çıkmaz
keyflip llm set --provider openai --base-url https://own-gateway/v1 --key-env GW_KEY --model NAME
keyflip llm test                              # toplu işten önce endpoint'in cevap verdiğini kanıtla
keyflip llm off                               # varsayılana dön (`claude -p`)
```

- Sağlayıcılar: `claude` (Claude Code CLI, aktif hesabın kotası), `ollama` (yerel, varsayılan
  `http://127.0.0.1:11434/v1`), `openai` (OpenAI-uyumlu herhangi bir endpoint — API anahtarı olan bir gateway).
- **Endpoint anahtarı saklanmaz.** `--key-env` bir ortam değişkeninin *adını* alır; value'su çağrı
  anında shell'den okunur. Durum dizini bir git reposu olduğu için saklanan anahtar sızdırılmış
  anahtardır; `--key-env`'e anahtar biçiminde bir değer verilirse komut reddeder.
- Her görev, bir şey harcamadan **önce** `distills via <sağlayıcı> <model> — <maliyet>` yazdırır;
  yazılan hatıralar hangi modelden üretildiğini kaydeder. `dream schedule` kurulum anındaki sağlayıcıyı
  fişe yazar ve `keyflip doctor` bu fiş saparsa — ya da gecelik iş hâlâ aboneliği yakıyorsa — uyarır.
- Paylaşılan duruma dokunmadan tek seferlik yönlendirme: `KEYFLIP_LLM_PROVIDER=ollama keyflip dream --apply`
  (ayrıca `KEYFLIP_LLM_MODEL`, `KEYFLIP_LLM_BASE_URL`, `KEYFLIP_LLM_KEY_ENV`) — cron girdisinin kullandığı yol.
- Önce `ollama pull <model>` (ya da `--model`'i sahip olduğun bir modele çevir); `keyflip llm test`
  endpoint'in cevap verdiğini kanıtlar. Soğuk bir yerel model ağırlıkları yüklerken dakika harcar, bu
  yüzden self-test 3 dakika bekler — `keyflip llm test --timeout 300000` ile uzat ya da daha küçük model seç.

### Hiçbir şey kendi kendine ölmesin (`refresh --schedule`)

Bir Anthropic OAuth token'ı yaklaşık altı gün yaşar ve **takvimde** ölür — geçiş yaptığın günde değil.
Bir geçişin "başarılı" görünüp sonra giriş ekranı açmasının nedeni bu boşluk: saklı token haftalar önce
sessizce ölmüştür, `keyflip refresh` ise yalnızca kimlik bilgisi boştayken çalışır. O yüzden onarım
hatırlanacak değil, zamanlanacak bir şey:

```bash
keyflip refresh --schedule                      # launchd (macOS) / crontab (Linux), varsayılan 04:30
keyflip refresh --schedule --at 05:15
keyflip refresh --schedule-status               # ne koşar, ne zaman, çıktısı nereye yazar
keyflip refresh --unschedule
```

- `keyflip refresh --all`'ı koşar: her kayıtlı hesabın token'ı hiçbir şey onu kullanmırken yenilenir.
  **Model çağırmaz, kota harcamaz** — gözetimsiz `dream`'den farkı bu; bu yüzden kendi launchd
  etiketi, kendi crontab işareti ve kendi makbuzu var. İki iş birbirinin üstüne yazmaz, ve 04:30
  bilinçli olarak dream'in 03:00'ı değil.
- **Canlı bir Claude oturumu varsa koşu hiçbir şeyi değiştirmez.** Bir oturum hâlâ tutarken refresh
  token'ını döndürmek o yüzeyi logout eder; iş bunu reddedip bir sonraki boş geceden sessizce bekler.
  `--json` tarafında bu red bir paragraf değil `{refused, changed:false}` alanıdır — exit 0 bir no-op'u
  yenileme sanmanın tam yoludur.
- Çıktısı `~/Library/Logs/refresh-keyflip.log` dosyasına gider ve plist `AbandonProcessGroup` taşır:
  iş koştuktan sonra okunabilir, kopuk çocuk süreçler iş bitiminde öldürülmez. launchd'in `PATH`'i
  `/usr/bin:/bin:/usr/sbin:/sbin` olduğu için zamanlayıcı mutlak bir çalıştırıcı + betik yolu yazar —
  fnm ile kurulmuş bir `keyflip` yoksa başka türlü hiç bulunamaz.
- `keyflip doctor`'da **token renewal** satırı var: hesaplar yenilenmeyen tokenlar tutarken uyarır,
  bir şey zamanlanınca yeşile döner. MCP tarafında: `keyflip_refresh_schedule` (`action=status|install|
  remove`, `confirm` ister). Zamanlanmış bir yenilemenin *kurtaramayacağı* kısımlar için `keyflip
  chains`'e bak — masaüstü uygulamasının session cookie'si insan ister, hiçbir zamanlayıcı bunu değiştirmez.
- **Diğer araçların kendi saatleri var.** ChatGPT/Codex erişim token'ı (~10 gün) ayrıca kurulan
  yenileme daemon'ıyla (`keyflip refresh --daemon-start`, 5 dakikada bir) son geçerliliğe 24 saat
  kala döndürülür — ChatGPT/Codex çalışırken asla. `keyflip chatgpt refresh` bunu elle bir kez yapar;
  yukarıdaki gece zamanlayıcısı yalnızca Claude OAuth içindir.
- **Döndürülecek bir şey kalmadan süresi dolmuşsa bu sessiz bir sürpriz değil, doctor hatası.**
  Token'ı dolmuş ve döndürecek refresh token'ı kalmamış (ya da apikey modunda) bir ChatGPT/Codex
  yakalaması geçiş anında çalışmaz; `keyflip doctor`'ın **chatgpt/codex captures** satırı slug'ları,
  geçerlilik bitişlerini ve tek çareyi söyler — bir kez giriş yap, sonra `keyflip chatgpt capture
  <slug>`. Daemon da bu ölü kümeyi (tick başına değil, küme başına bir kez) log'lar.

### Arkada gerçekten çalışan bir şey var mı? (`keyflip doctor`)

Zamanlanmış bir iş bir sözdür ve sözler çürür: launchd bir gün tuttuğu plist'i ertesi gün tutmayabilir
(çıkış yapmış olman, dizini taşımış olman, dosyayı elle düzenlemiş olman), 04:30'da uykudaki bir
dizüstü gecelik işi hiç çalıştırmaz, ve bütün belirti haftalar sonra gelir — bayat bir arama cevabı ya
da ölmüş bir token. Bu yüzden `doctor`, kurabildiği her arka plan işini sayar — `dream`, `refresh`,
süre-dolumu `daemon`'ı ve sohbet indeksi — ve her birine üç ayrı soru sorar:

```bash
keyflip doctor                    # → "2 of 4 scheduled — dream: off · refresh: nightly at 04:30 · spoke 9 h ago …"
keyflip doctor --json | jq '.checks[] | select(.name=="background services") | .services'
```

- **Kurulu** (keyflip'in yazdığı dosya yerinde), **tutulan** (launchd/cron gerçekten sahibi) ve
  **konuşmuş** (log'u en son ne zaman değişmiş) üç ayrı bilgidir; işin çalıştığını gösteren son
  ikisidir. `kurulu + NOT LOADED` bir uyarıdır ve tamir komutuyla birlikte gelir.
- Sessizlik, işin **kurulurken** söz verdiği arılığa göre yargılanır: 30 dakikada bir denen bir indeks
  bir gün boyunca hiçbir şey yazmadıysa bozulmuştur; on dakika önce kurulmuş olan ise henüz sırası
  gelmemiştir. `KeepAlive` daemon'ının arılığı yoktur, sessizliği suç sayılmaz.
- Bir günden eski sohbet indeksi ve onu tazeleyen bir iş yoksa bu ayrı bir uyarıdır — o indeks
  dünkü sohbetler hakkında cevap verir.
- Her işin kendi görüntüsü de duruyor: `keyflip conv index --schedule-status`,
  `keyflip refresh --schedule-status`, `keyflip dream status`, `keyflip refresh --daemon-status`.
  MCP tarafında `keyflip_doctor` tüm envanteri yapısal `services` satırları olarak döndürür.

### Her giriş ne kadar eski? (`keyflip freshness`)

Bir girişin öbür yarısı yenilenemez: masaüstü uygulamasının ve tarayıcının tuttuğu claude.ai
`sessionKey`'i **bir insanın giriş yaptığı andan itibaren sabit 28 gün** yaşar, claude.ai daha eskisini
"Sign in again" ile daha erken de reddedebilir. Bunun bir refresh çağrısı yoktur. keyflip'in
yapabileceği, onu ölçmek ve canını yakmadan önce uyarmaktır:

```bash
keyflip freshness            # hesap başına: cli token, uygulama girişi, her tarayıcı girişi — yaş + kalan gün
keyflip freshness --json     # aynısı, makine okunur (takma ad: keyflip age)
```

- Yaşlar cookie veritabanının oluşturma/bitiş **zaman damgalarından** okunur (veritabanının özel bir
  kopyasından); hiçbir cookie değeri okunmaz ya da yazdırılmaz.
- Uygulama geri yüklenen bir girişe "Sign in again" ile cevap verince (Claude'un `main.log`'unda
  `session_stale_relogin`), keyflip bunu geçişin hemen ardından ve gecelik `refresh` koşusunda fark eder,
  o girişin kaç günlük olduğunu durum dizininde `freshness/` altına yazar ve bundan sonra şimdiye kadar
  reddedilmiş en genç yaşta uyarır. Eşik sabit kodlanmaz, kendi makinenden öğrenilir.
- Aynı ölçüm `keyflip doctor`'da bir satır (**claude.ai sign-in age**) ve geçiş planında bir uyarı
  olarak da görünür: geçtiğin hesabın kayıtlı uygulama girişi eskiyorsa plan bunu söyler.
- Çözüm hep aynıdır ve yalnızca bir insan yapabilir: Claude'da o hesapla bir kez giriş yap, sonra
  `keyflip add <hesap> --app`.

### Bir sır geçmişte hâlâ okunabilir mi? (`doctor --history`, `scrub-history`)

keyflip kendi durum dizinini git'le versiyonlar; böylece her değişiklik incelenebilir ve geri
alınabilir — ama bir zamanlar bir ignore kuralından sızmış her sır da aynı şekilde saklanır. Bugün
**takip edilen** dosyalara bakmak yetmez: `git rm --cached` dosyayı gelecekteki commit'lerden durdurur,
zaten kaydetmiş olan commit ise eski blob'u eksiksiz çözmeye devam eder. Transkript aynalamasına
geçmeden önce temizliğinin kanıtlanması gereken işte bu rezidüeldir; çünkü insanlar API anahtarlarını
sohbetlere yapıştırır.

```bash
keyflip doctor --history          # commit edilmiş her blob'u tara; İÇERİĞİ değil, TÜRÜNÜ bildir
keyflip scrub-history             # plan: hangi yol, hangi tür, kaç commit onu tutuyor
keyflip scrub-history --apply     # bundle yedeği → git-filter-repo → kanıt olarak yeniden tarama
keyflip memory audit [--apply]    # aynı tarama keyflip'in hatıralarında (keepsake)
```

- **Rapor, sırrın kopyası olmaz.** Bulgular yol + sır *türü* (`anthropic-api-key`, `jwt`,
  `private-key-block`…) + blob id + boyut + onu kaç commit'in tuttuğunu taşır; terminal, log dosyası ve
  çıktıyı okuyan agent temiz kalır.
- **Gizli bir dizinin altındaki yakalama, byte'ları hiçbir bilinen biçime uymasa bile sırdır** —
  tarayıcının tanımadığı bir format yine bir kimlik dosyasıdır.
- **Bugün hâlâ takip edilen bir yolun history'si, `--include-tracked` verilmeden temizlenmez**: canlı
  dosyanın history'sini silmek, working tree'den de silmek demektir. Yalnızca genel long-hex biçimine
  uyan eşleşme `[weak match]` olarak işaretlenir — 64 hex karakterlik bir `userID` bir tanımlayıcıdır,
  bir dosyayı yok etme gerekçesi değil.
- `--apply`, `git-filter-repo` kurulu **değlse reddeder** (elle yazılan kısmi bir rewrite repoyu
  bozabilir); önce güncel history'nin `git bundle` yedeğini yazar ve o bundle doğrulanmazsa devam
  etmez; sonra yeniden tarar ve history'nin kanıtlanmış biçimde temiz olup olmadığını söyler.
- Senin yerlerine yapamayacağı iki şey: bundle, sen taşıp silene kadar sırları içerir ve **kimlikler
  döndürülmelidir** — çıkarılmış ama hâlâ geçerli bir sır, düzelmiş sır değildir.
- `memory audit --apply` sırları yerinde karalar ve her orijinali `<key>.md.pre-scrub` olarak
  yanına koyar (0600; `pre-scrub` gizli uzantı setine kayıtlıdır, yani o kopya asla versiyonlanmaz ve
  yedeklenmez). Karaelenmiş bir hatıra, `scrub-history` çalışana kadar git history'sinde okunur kalır.
- MCP tarafında: salt-okunur `keyflip_history_audit` + `keyflip_memory_audit`, `confirm` isteyen
  `keyflip_history_scrub` + `keyflip_memory_redact`.

#### "Onu zaten biliyorum" — tolerans politikası (`secrets`)

Her bulgu bir sorun değildir. Bedava bir Google AI anahtarı, oturumu haftalar önce düşmüş bir JWT, bir
atılabilir hesabın kaydı — hepsi gerçekten sırdır, hiçbiri alarmı hak etmez. Kullanıcının karara bağladığı
bir şeyin her taramada yeniden ✗ olarak basılması tam da gürültüdür; gürültü, gerçekten sorun olan bulgunun
gözden kaçmasının sebebidir. `keyflip secrets`, "beklenen bu" kararını her taramada vermek yerine bir kez
bir dosyaya yazmanın yoludur.

```bash
keyflip secrets list                 # her bulgu + her kural, ve her kuralın neyi susturduğu
keyflip secrets list --alarms        # yalnızca hâlâ alarm olanlar
keyflip secrets tolerate "surfaces/codex/x/auth.json" --kind jwt --note "oturum düştü"
keyflip secrets tolerate --kind google-api-key   # her nerede çıkarsa çıkmasın sorun olmayan bir tür
keyflip secrets untolerate <yol>     # alarm geri gelir
```

- **Tolerans ALARMI bitirir, temizliği asla.** Toleranslı yol `scrub-history` planında kalır ve history'den
  yine silinir; duran şey ✗ ile rotasyon tavsiyesidir. "Bu sır geçmişte kalsın" anlamına bir seçenek
  bilinçli olarak yok — o bir politika değil, config dosyası olan bir sızıntı.
- **Bir kural yol ve tür söyler, değer asla** — değere göre eşleşmek sırrın parmak izini git'le versiyonlanan
  durum reposuna koymak olurdu. `--note` metni saklanmadan önce redakte edilir; `secrets-policy.json`
  kendisi gizli bir yol **değildir**, yani `keyflip backup` ile taşınır ve `keyflip undo` ile geri alınabilir.
- **Bilinçli olarak reddedilenler:** bilinmeyen bir `--kind` (hiçbir şeyi susturmaz, kalan alarm hata gibi
  görünür) ve türü olmayan çıplak `*` — o politika değil, tarayıcının kapatılması. `*` dizin sınırını aşmaz
  ve `*`/sonunda `/` olan bir kural **etki alanıyla** birlikte basılır, çünkü o yol altındaki YENİ her şeyi
  de kapsar.
- **Kapalı tarafa düşer (fail closed).** Bozuk/okunamaz politika hiçbir kuralı uygulamaz, bunu söyler ve her
  bulgu alarm olarak kalır; hatalı kurallar düşürülür ama sayılır.
- **Hatıralar (keepsake) asla susturulmaz.** `memory audit` politikasızdır: damıtılmış bir "anahtarım
  sk-ant-…" metni keyflip'in *senin hakkında* yazdığı bir satırdır, senin saklamayı seçtiğin bir dosya değil.
- `doctor --history` bulguları değil **alarm sayısı**nı başlığa koyar ve politikanın susturduklarını soluk bir
  satırla bildirir — temiz başlık her zaman açıklanabilir. MCP: `keyflip_secrets_policy` (salt-okunur) ve
  `keyflip_secrets_tolerate` (`action=tolerate|untolerate`, `confirm` ister).

### Bir giriş gerçekte neyden oluşur? (`chains`)

Bir hesap asla tek dosya değildir. Canlı bir kimlik bilgisi **artı keyflip'in ondan çıkardığı her
kopya**: OAuth profili, masaüstü uygulamasının token önbelleği *ve* oturum cookie'si, bir tarayıcı
cookie yakalaması, bir sağlayıcı API anahtarı, `surfaces/` altında üçüncü taraf bir kayıt. Bu kopyalar
bir grafik oluşturur ve geçişin çalışıp çalışmayacağını o grafiğin üç özelliği belirler — hiçbir önceki
komut bunları göremezdi, çünkü her biri tek dosyaya bakıyor, doğrunun olduğu yer ise dosyalar arası
ilişki:

- **Yenilenme.** Uygulamanın `oauth:tokenCache` değeri *türetilmiştir*: uygulama onu, `sessionKey`
  cookie'si ile `/authorize` çağırıp yeniden basar. Yani zincirin gerçek kökü cookie'dir ve onu
  insan dışında hiç kimse yenileyemez. Bir token blob'u kusursuz görünürken hesabın kendisi ölmüş
  olabilir — "geçtim, uygulama sadece giriş ekranını gösterdi" tam olarak budur.
- **Bayatlık.** Bir yakalama, hareket etmeye devam eden bir deponun kopyasıdır. Kaynağın mtime'ı
  yakalamadan yeni ise, o yakalamayı geri yüklemek geçmişi geri yükler.
- **Paylaşım.** Tek bir tarayıcı profili, ya da tek bir uygulama cookie kavanozu, **bir tek** hesabın
  oturumunu tutar. Aynı depodan çıkarılmış her yakalama diğerleriyle yarışır: Chrome'a bir hesapla
  giriş yapmak, o hesabın diğerlerinden aldığı yakalamaları sessizce geçersiz kılar.

```bash
keyflip chains                 # tüm harita, artı tüm bulgular
keyflip chains is              # tek hesap: ne tutuyor, kimi yeniler, nerede sonlanıyor
keyflip chains --tighten       # durum reposunda herkese okunabilir ne var (dry run)
keyflip chains --tighten --apply   # o dosyaları 600 yap, sonra kanıt için yeniden tara
```

- **Sırrı hiç okumaz.** Harita yalnız yol ve `stat()` sonuçlarından kurulur — boyut, mtime, mode.
  Ayrıca `security … -w` çalıştırmaz, çünkü bir Keychain kaydının var olduğunu kanıtlamanın tek yolu
  sırrı yazdırmaktır; o konumlar `exists: null` (probed değil) olarak raporlanır. Ve git'le
  versiyonlanan durum reposuna **hiçbir şey yazmaz**, dolayısıyla sır değerinin parmak izini
  history'ye bırakamaz.
- **Şikâyet değil, bulgu.** Her risk kendi çözümünü söyler (`re-capture it while that account is
  logged in`, `keyflip add <ad>`, `keyflip chains --tighten`) ve `high` olanlar önce sıralanır.
  `doctor` satırını yalnız keyflip'in kendi bırakmış olduğu, sahibinden başkasına okunabilir bir sır
  kızartabilir — dört hesabın tek Chrome profilini paylaşması yapısal gerçektir, üzerine kalıcı bir ✗
  koymak ✗'yi görmezden gelmeyi öğretir.
- **`--tighten` bilinçli olarak sınırlıdır**: yalnız durum reposunun içindeki, yalnız gizli yol
  kümesindeki dosyalar. Chrome'un kendi cookie DB'sinin 644 olması normaldir (macOS onu dosya
  sisteminin üstünde korur), o yüzden ona da dokunulmaz, uyarı da edilmez.
- CLI'ın `--json` çıktısı ve MCP sonuçları yalnız repoya ya da `~`'e göreli yollar taşır
  (`publicNode`/`publicRisk` mutlak olanları düşürür); yani haritayı bir agent kaydına yapıştırmak
  dosya sistemini ona haritalamaz.
- MCP tarafında: salt-okunur `keyflip_chains` (+ opsiyonel `account`), `confirm` isteyen
  `keyflip_chains_tighten`. `keyflip doctor` her teşhiste bu haritayı çalıştıran **credential chains**
  satırını kazandı.

### Hesaplar arası tek görev (`threads`)

Kota görevin ortasında tükenir, hesap değiştirirsin, ve aynı iş bir anda üç nesneye bölünür: gmail
altında bir Claude Code oturumu, yahoo altında bir tane daha, ve kimsenin işaret edemediği bir
claude.ai sohbeti. `keyflip threads` o işe **tek bir ad** verir. Bir thread bir *işaretçi dosyasıdır*,
`~/.config/keyflip/threads/<slug>.json`; oturum id'lerini ve chat uuid'lerini, hangisinin hangi hesaba
aidiyetle birlikte listeler — kap değildir. Yani hesap değiştirmek işi bölmeyi bırakır, `keyflip
chat`'in parça parça erişimi de adlandırılmış tek bir göreve dönüşür.

```bash
keyflip threads suggest                    # ZATEN 2+ hesaba bölünmüş iş, proje klasörü başına
keyflip threads create dugum-acmak --title "Düğüm açmak" --session 1a2b3c4d
keyflip threads add dugum-acmak 9f8e7d6c --account yahoo   # kısa önek yeterli — tam id yazılır
keyflip threads add dugum-acmak 3b0c…e1a4 --chat            # bir claude.ai sohbeti de üyedir
keyflip threads show dugum-acmak --timeline               # tek kronolojik sohbet, kaynağıyla birlikte
keyflip threads open dugum-acmak            # işin son durduğu yer, ona sahip hesabın kimliğiyle
keyflip threads where 1a2b3c4d              # bu oturumu hangi thread'ler içeriyor
keyflip threads drop dugum-acmak -y    # yalnız ADI unutur; her transkript ve her atama yerinde kalır
```

- **İşaretçi, asla kopya.** Transkript Claude'un yazdığı yerde kalır. Hiçbir şey çoğalmaz; bir
  thread'i silmek, bozmak ya da taşımak bir mesajı değil yalnız bir adı kaybedebilir. `keyflip threads
  show --md` hiçbir şey yazmadan birleşik belgeyi basar.
- **Menüdeki `[t]` aynı deposunu salt-okunur hali.** Hesap değiştiricinin bir thread ekranı var: her
  thread, üyeleri, her üyenin hangi hesaba ait olduğu, transkriptinin nerede olduğu, ne kadar taze
  olduğu ve onu sürdüren `cd … && claude --resume …` satırının birebir hali — artı *bulabildiği*
  bölünmüş işler için `[s]`. Asla bir transkript gövdesi okumaz, asla yazmaz, asla kota harcamaz;
  ad koymak ve adı silmek CLI'da kalır, çünkü bir thread hesap geçişinin sessizce bölebildiği tek şey.
- **Bölünmeyi sen sayıp dökmeni beklemeden bulur.** `suggest` son oturumları proje klasörü başına
  toplar ve **iki veya daha fazla adlandırılmış hesabın** çalıştığı klasörleri — bir thread'in zaten
  kapsadıklarını düşürerek — raporlar; yani işlerini adlandırdıkça liste küçülür. Bir hesap artı
  atanmamış oturumlar *raporlanmaz*: o bir hesap geçişi değil, sahibinin atamadığı bir oturumdur
  (`keyflip sessions assign <id> <hesap>` ile ata).
- **`sessions attribute` her oturumu elle atamak zorunda bırakmak yerine hesabı tahmin eder.** Geçiş
  zaman çizelgesini keyflip'in kendi eylem günlüğünden yeniden kurar (yalnız hesap adları + zaman
  damgaları — hiçbir transkript okumaz) ve atanmamış her oturum için çalışılmış hesabı önerir: oturumun
  tüm aralığı tek bir hesabın penceresine sığıyorsa `high`, bir geçişi kesiyorsa `low` ve **işaretli**.
  `--apply` olmadan hiçbir şey yazılmaz; yazılan bir tahmin tahmin olarak saklanır — `sessions assign`
  ile onaylayana kadar thread ekranı onu `yahoo (inferred)` diye gösterir.
- **Birleştirme, nerede eksik kaldığını söyler.** Her tur üyesini ve hesabını taşır
  (`↪ yahoo'dan · oturum 9f8e7d6c`); tarihsiz turlar kararların arasına sıkıştırılmak yerine başta bir
  grup olarak kalır; bir bulut sohbeti offline tur katkısı yapamaz ve okuyacak `keyflip chat get …`
  komutuyla `unavailable` altında listelenir; `threads.mergeMaxMiB` (varsayılan 8 — buradaki
  transkriptler 24 MB'a kadar çıkıyor) tarafından kesilen bir üye sessizce kısa sayılmaz, kesilmiş
  diye sayılır.
- **Diskte sohbet metni görmek opsiyoneldir ve çift kapılıdır.** `threads mirror`,
  `~/.config/keyflip/thread-mirror/<slug>.md` dosyasını yalnız `keyflip config set threads.mirror true`
  **ve** çağrı izin verirlerse yazar; o dizin kayıtlı bir sır dizinidir (0600, asla versiyonlanmaz,
  yedeklenmez, senkronlanmaz, `migrate` dışlanır), ve durum reposunda bir git remote varsa ayna yine de
  reddeder. Bir işaretçi dosyasına transkript düzyesi de kopyalanmaz — bir oturumun ilk istemi
  yapıştırılmış bir API anahtarının bulunduğu yerdir.
- **Adlar dosya adıdır, o yüzden normalize edilir.** `düğüm` → `dugum`, `../secrets/x` `threads/`
  dışına çıkamaz, ve belirsiz önek tahmin edilmez, reddedilir. Bozuk ya da elle düzenlenmiş bir
  thread'i `list` raporlar ve yazmayı engeller; `keyflip doctor`ın okunamaz dosyalar, hesabı
  çözümlenemeyen üyeler ve açık ayna için bir **threads** satırı var.
- MCP tarafında: salt-okunur `keyflip_threads` (liste / `slug` / `timeline` / `suggest` / tersten `id`)
  artı `confirm` isteyen `keyflip_thread_create|add|remove|drop|mirror`. MCP sonuçları **ve** tüm `--json`
  çıktıları yolları durum reposuna ya da `~/.claude/projects`'e göreli döndürür — asla kullanıcının ev
  yoluyla değil, çünkü bu çıktı bir agent kaydına yapıştırılmak içindir. Bir devam komutunun `cwd`'si
  mutlak kalır (çalıştırmak onu ister, bir çalışma dizini sır değildir) ve insan çıktısı, açılabilsin diye
  gerçek yolları korur.

### Her aracın sohbetleri, aranabilir hâlde (`conv`)

Claude Code `~/.claude/projects`'e, Codex `~/.codex/sessions`'a (bazen zstd sıkıştırılmış), Kiro hem
`~/.kiro/sessions/cli`'ye hem IDE deposuna, Cursor üç ayrı depoya yazar (editörün `state.vscdb`'si,
`cursor-agent` CLI'ının içerik-adresli `~/.cursor/chats`'i ve `agent-transcripts` aynası);
opencode/Qoder/Gemini/Copilot/Aider'in ise kendine göre. `keyflip conv` hepsini **tek kanonik biçimde**
okur — id, uygulama, yüzey, başlık, çalışma dizini, zaman damgaları, `{role, text, ts, tools}`
mesajları — ve araçların kendi gürültüsünü ayıklar:
`<system-reminder>`, `<task-notification>`, `<command-name>` tesisatı, ortam bağlamları ve
`<pasted_content>` sarmalayıcıları (bazı araçların bozuk kapanış etiketleri dahil) indekse ya da
dışa aktarıma asla ulaşmaz. Kaynaklar salt-okunur; keyflip hiçbir aracın deposuna yazmaz.

```bash
keyflip conv list --app claude,codex --since 7d   # gez: id öneki, uygulama, yaş, mesaj sayısı, başlık
keyflip conv list --account yahoo                 # yalnızca o hesabın çalıştığı sohbetler
keyflip conv index                                # bir kez çözümle, parçaları keyflip tutsun (artımlı)
keyflip conv index --embed                        # + yerel embedding (varsayılan Ollama nomic-embed-text)
keyflip conv index --schedule --interval 30        # kendini güncel tut (macOS'ta launchd, Linux'ta cron)
keyflip conv search "database migration"          # şimdi BM25; vektörler varsa hibrit
keyflip conv search "database migration" --account gmail   # …ve yalnızca o hesabın sohbetleri
keyflip conv context "database migration"         # yapıştırmaya hazır RAG bloğu, kaynak atıflı
keyflip conv show a7dc93d0                        # tek sohbeti oku, gürültüsüz
keyflip conv export --all --obsidian --out ~/Documents/Vault
keyflip conv transfer a7dc93d0 --to codex         # başka bir yapay zekâ aracına devir paketi
```

- **Cursor: veritabanı dosyası başına değil, composer başına bir sohbet.** Tek bir `state.vscdb`
  makinedeki bütün sohbetleri tutar; bu yüzden editör deposu sohbet sohbet okunur — sohbet listesi yeni
  sürümlerde `composerHeaders` tablosundan, eski sürümlerde `composerData:` KV satırlarından, her balon
  kendi `bubbleId:` kaydından gelir. `fullConversationHeadersOnly` Cursor'un gerçekten çizdiği şey kabul
  edilir: `isRenderable:false` işaretli bir balon transkriptte yoktur, listelenmiş ama metni gitmiş bir
  balon ise **sayılır**, uydurulmaz. Araç kartları ve düşünme adımları araç olarak korunur (yeni
  sürümlerde `toolFormerData`, eskilerde `capabilities`) ve yükü kaybolmuş bir araç kartı yine de bir
  turu adlandırır — tahmin edilmez, etiketlenir. `cursor-agent` CLI'ının kendi deposu vardır
  (`~/.cursor/chats`, içerik-adresli blob'lar artı bir meta kaydı) ve her oturumu
  `agent-transcripts/*.jsonl` aynasına da yazar; ayna oturum id'sinden tanınır ve zengin kopyadan bir
  kez indekslenir. Bu okuyucuların yazıldığı makinede Cursor kurulu değil, yani testler sözleşmeyi
  dağıtılan uygulamanın kendi biçiminden kurulmuş fikstürlerle sabitler — yakalanmış canlı bir depoyla
  değil.
- **Okunamayan bir depo asla boş bir depo gibi görünmez.** `conv index` okuyamadığı her depoyu (çok
  büyük, okunamaz, kayıp) **gerekçeli bir atlanmış kaynak** olarak adlandırır; sohbet üretmiş ama `-wal`
  yan dosyası yeniden oynatılamamış bir depoyu ise **uyarı** olarak — ikisi birden asla değil, sessizlik
  de asla.
- **Bir parça, bir soru ve aldığı cevaptır.** Turlar asla ortadan kesilmez: bir kullanıcı mesajı ve
  asistanın bir sonraki soruya kadar söyledikleri, sabit 1.400 karakterlik pencere yerine tek parçada
  kalır; böylece bulunan cevap onu doğuran soruyu da taşır. Canlı 1864 sohbetlik indekste bu, sahipsiz
  `Assistant: …` parçalarını ortadan kaldırdı — önce 122.611 parçanın 15.392'si (%12,6), sonra 117.033
  parçanın 15'i. Bütün tutulamayacak kadar uzun bir tur, örtüşmeyle bölünür ve her parça sorusunun kısa
  bir kopyasını taşır; yani uzun bir cevabın ortası da "ne sorulmuştu" ile bulunur.
- **Aynı paragraf bir kez gösterilir.** Dallanmış (fork) ve devam ettirilmiş oturumlar önceki turları
  birebir tekrarlar. `conv search` tek kopyayı tutar, diğer sohbetleri `alsoIn` içinde adlandırır ve
  katlanan kopyaları `collapsed` diye sayar — aynı cevaba birkaç sonuç yuvası harcamaz.
- **Sıralamayı nasıl yaptığını dürüstçe söyleyen arama.** Leksiksel taraf BM25: hafif bir stemmer ve
  gerçek belge frekansları. `--embed` varsayılan olarak yerel bir Ollama ile vektör hesaplar (ya da
  `KEYFLIP_EMBED_URL`; uzak uç noktaya giden metin önce sır-ayıklamadan geçer). Hibrit iki listeyi
  reciprocal rank fusion ile kaynaştırır; leksiksel liste ağır basar, yani sadece vektörden gelen
  bir eşleşme BM25 sonucunu sayfadan düşüremez — vektör yoksa sonuç `lexical` etiketiyle ve notla döner,
  asla sessizce "hibrit" olmaz. İlk sorguda `search` indeksi bir kez kurar; ilk arama da çalışır.
- **Hangi hesap bu sohbetle çalıştı — ve keyflip bunu nereden biliyor.** Her sohbet satırı bir `account`
  taşır; iki kaynak, kesin sırayla: **SİZİN SÖZÜNÜZ** (`keyflip sessions assign <oturum> <hesap>`) her
  zaman keyflip'in tahminine öncelik alır. Tahmin, keyflip'in kendi geçiş zaman çizelgesinden gelir —
  Claude Code için `active -> <profil>`, diğer yüzeyler için `kiro -> <slug>` ve `codex -> <slug>` —
  ve sohbetin yaşam aralığı, vaktin çoğunu elinde tutan hesabın penceresine yerleştirilir. Her yüzey
  **kendi** çizelgesini okur; yani bir Kiro geçişi asla bir Claude oturumunu yeniden etiketleyemez.
  Etiket daima cevapla birlikte taşınır: `accountSource` `stated` ya da `inferred`dir, `accountConfidence`
  `high` (görünür yaşamın tamamı tek pencerede), `medium` (başlangıcı kayıtlı tarihten önce) ya da `low`
  (bir geçişin ortasına denk düşer); gerekçesini `keyflip conv show <id>` yazar. Kayıtlı hiçbir geçişten
  eski sohbete **hesap verilmez**, tahmin de verilmez; keyflip'in hesabını yönetmediği araçlar (Qoder,
  Gemini) de hesap almaz; sildiğiniz hesap asla adlandırılmaz. `conv list`te tahmin edilen adın sonunda
  `*` vardır ve açıklama satırı bunu söyler.
- **İndeks kendini güncel tutar.** `keyflip conv index --schedule [--interval N]` indeksi bir zamanlayıcıya
  koyar (macOS'ta launchd ajanı, Linux'ta crontab satırı) böylece `conv search` az önce yaptığınız sohbeti
  bulur, bayat olanı değil — **gece saatinde değil, aralıkla** çalışır, çünkü günlük indeks bir gün geride
  kalırdı. Geçiş kademeli: değişmeyen bir transcript tek `stat()` demektir, yalnızca yeni ya da değişen
  parçalar gömülür, dolayısıyla bir tur saniyeler sürer. **Yerel** embedding modelini çalıştırır — bulut
  modeli yok, kota yok. Durumu `--schedule-status` gösterir, `--unschedule` kaldırır; terminali açık
  tutmayı severseniz ön planlı karşılığı `--watch`.
- **`conv context` RAG giriş noktasıdır.** Karakter bütçeli (varsayılan 12.000) taşınabilir tek blok
  döndürür: kararlı başlıklar, kaynak id'leri, çalışma dizinleri ve tarihler; `--expand N` komşu
  parçaları da çeker ki bir karar ikiye bölünmesin. Hiçbir şey yüklenmez; erişim diskte çalışır.
- **Dışa aktarım varsayılan olarak sır ayıklar.** MD / kendi kendine yeten HTML / kanonik JSON, ve
  YAML başlıklı, etiketli, indeks notlu Obsidian notları. Kimlik-bilgisi biçimli satırlar maske edilir;
  `--no-redact` ile birebir kalır. Dosyalar `0600`'dır ve `export`, `--force` olmadan üzerine yazmayı
  reddeder.
- **Obsidian aktarımı sahiplik izler, kör senkron değildir.** Notlar
  `<vault>/keyflip/Conversations/`'a, içerik özetlerinin gizli manifestosuyla yazılır. keyflip'in
  yazdığı not yerinde güncellenir; sizin düzenlediğiniz not üzerine yazılmaz, **çakışma kopyası**
  (`<ad> (conflict <zaman damgası>).md`) bırakılır; başlığı değişen not, hâlâ keyflip'in yazdığıyla
  bayt-bayt aynıysa kaldırılır. Vault'unuz asla yeniden düzenlenmez.
- **Devir, neyin var olduğunu dürüstçe anlatır.** `keyflip conv transfer <id> --to claude|codex|kiro|cursor|opencode|windsurf|gemini|copilot|aider|generic`
  0600 bir paket yazar — `conversation.json` (kayıpsız), `CONTINUE.md` (hedefe göre ayarlanmış devam
  istemi) ve gerçeği söyleyen bir README: **hiçbir hedef aracın belgelenmiş bir içe aktarımı yok**;
  paket eklenip/yapıştırılacak bağlamdır ve hedef aracın kendi deposunda hiçbir şey değişmez.
- **İndeks, sıra-komşusu bir artefakt gibi muamele görür.** `~/.config/keyflip/conv-index` içinde
  yaşar (kayıtlı sır dizini: asla versiyonlanmaz, yedeklenmez, `migrate` dışlanır), `0600`, mtime+boyut+
  özete göre artımlıdır: değişmemiş bir konuşma manifest satırından, yeniden ayrıştırılmadan kullanılır;
  uzayan bir sohbet yalnızca yeni kuyruğunu yeniden embed eder. Bir token yan dosyası (`tokens/`, yine
  0600, parçalardan türetilir) metni yeniden tokenize etmeden BM25'i hızlı tutar. Sayılar diskten ileri gidemez — parça
  dosyası kaybolan satır yeniden parçalanır, parçası olmayan kaynak asla "embed edildi" sayılmaz ve
  yarım parça dosyası vektörü yazılmadan önce diskle uzlaştırılır. Her satır kendi parça dosyasının
  parmak izini de tutar: dosya başka bir konuşma tarafından ezilmişse diskte karşılığı olmayan bir
  sayıyla yeniden kullanılmaz, kaynak konuşmadan yeniden parçalanır; aynı id'yi isteyen iki transcript
  birbirinden ayrılır ve raporlanır (`id çakışması ayrı tutuldu`). Silmek gerçektir: tam yeniden kurulum
  gitmiş sohbetleri düşürür; filtreli kurulum (`--app`, `--limit-sources`) geri kalanına dokunmaz.
- MCP tarafında: salt-okunur `keyflip_conv_list`, `_show`, `_search`, `_context`, `_status` (indeksi
  asla kendileri kurmaz — o iş `keyflip_conv_index`'in, `keyflip_conv_export` gibi `confirm` ister).
  Kesitler ve bağlam blokları bir agent kaydına ulaşmadan önce sır-maskelenir, indeks yolu durum
  dizinine göreli raporlanır, asla ev yolu olarak değil.

## Bağlam Katmanı — taşınabilir proje hafızası (`.keyflip/`)

Yapay zeka araçları değişir; proje hafızanız değişmemeli. Bağlam Katmanı, projenizin dizininde
araçtan bağımsız küçük bir **`.keyflip/`** klasörü tutar; bu klasör depo ile birlikte araçlar,
hesaplar ve makineler arasında taşınır. **Sır'lar asla içine girmez** — her metin alanı, yazılmadan
veya paketlenmeden önce keyflip'in gizli-bilgi tarayıcısından geçirilir ve yalnızca ortam değişkeni
**adları** taşınır, değerleri asla. Dosyalar `0600` izinleriyle yazılır.

### Proje bağlamı (`keyflip context`)

- `project.json` — kimlik, ad, açıklama, teknoloji yığını, depolar, aktif görev, son sağlayıcı
- `context.md` — bir sonraki YZ oturumu için serbest biçimli proje özeti
- `decisions.json` — mimari/ürün kararları (gerekçe, alternatifler ve açık "YAPMA" notlarıyla)
- `tasks.json` — durum, ilgili dosyalar, tamamlanan/kalan adımlar, kabul kriterleri ve bilinen sorunlarla görevler

```bash
keyflip context init                              # .keyflip/ oluştur
keyflip context status                            # kısa özet
keyflip context decision add "Postgres kullan" --rationale "ACID + ekip aşinalığı" --do-not "Üretimde SQLite"
keyflip context task add "Ödeme webhook'unu bağla"
keyflip context task set <id> in_progress         # todo | in_progress | blocked | done
keyflip context show --json                       # sır'lardan arındırılmış tam bağlam paketi
```

MCP: `keyflip_context_read` (salt-okunur), ayrıca `keyflip_context_task_set` ve `keyflip_context_decision_add` (değiştirici — `confirm: true` gerektirir).

### Yapay zeka kural dosyalarını birleştir (`keyflip rules`)

Her yapay zeka aracı yönergelerini farklı bir dosyada ister — `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*`,
`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`. `keyflip rules` mevcut dosyaları okur, hepsini
tek bir ortak modele **normalleştirir** (her bölüm coding / architecture / security / workflow / general
olarak sınıflandırılır, kaynağı korunur) ve bu modeli herhangi bir aracın beklediği dosya olarak
**yeniden üretir**.

```bash
keyflip rules show                     # kural dosyalarını algıla + normalleştirilmiş modeli önizle
keyflip rules import                   # modeli .keyflip/rules.json içine önbelleğe al
keyflip rules emit --to claude         # tüm araçların kurallarından üretilen CLAUDE.md içeriğini yazdır
keyflip rules emit --to cursor --write # projeye .cursorrules dosyasını yaz
```

Hedefler: `claude` (CLAUDE.md), `cursor` (.cursorrules), `agents` (AGENTS.md), `gemini` (GEMINI.md), `generic` (RULES.md). İçe/dışa aktarılan her satır gizli-bilgi tarayıcısından geçer; bir kural dosyasına yanlışlıkla yapıştırılan bir anahtar, paylaşılan modele veya üretilen dosyaya girmeden önce **maskelenir**. MCP: `keyflip_rules_show` (salt-okunur), `keyflip_rules_emit` (içeriği döndürür; dosyayı yalnızca `confirm=true` ile yazar).

### Kontrol Noktaları (Checkpoints) — git'e bağlı oturum anlık görüntüleri

Bir projeyi oturum sınırında yakalayın; böylece siz (ya da sıradaki ajan) tam kaldığınız yerden devam
edebilirsiniz. Bir kontrol noktası; git dalını, kısa commit'i ve değişmiş (commit edilmemiş) dosyaları,
ayrıca okunabilir bir özeti, isteğe bağlı bir görev anlık görüntüsünü ve aktif sağlayıcıyı kaydeder —
`parent` ile bir geçmişe zincirlenir ve `.keyflip/checkpoints/` altında saklanır, depo ile birlikte taşınır.

```bash
keyflip checkpoint create --summary "auth yeniden düzenlemesi bitti; testler yeşil"
keyflip checkpoint list             # en yeniden eskiye
keyflip checkpoint latest           # en son kontrol noktası
keyflip checkpoint show <id>        # bir kontrol noktasının tüm ayrıntıları
```

- **Sır güvenli:** her metin alanı (özet, sağlayıcı, git yolları ve görev anlık görüntüsündeki her değer) yazılmadan veya hash'lenmeden önce taranır ve maskelenir — API anahtarları ve token'lar bir kontrol noktasına asla girmez.
- **Salt-okunur:** `checkpoint show` ve MCP `keyflip_checkpoint_*` araçları bir kontrol noktasını yalnızca *okur*. keyflip sizin yerinize git çalıştırmaz veya çalışma ağacınızı değiştirmez.
- **İçerik hash'i:** her kontrol noktası, makineler arası çakışma tespiti için bir `contentHash` (kanonik gövdesinin sha256'sı) taşır.

MCP: `keyflip_checkpoint_list`, `keyflip_checkpoint_latest` (salt-okunur), `keyflip_checkpoint_create` (değiştirici — onay gerektirir).

### Devir (Handoff) — sıradaki araç için bir devam-istemi

Bir proje yapay zeka aracı değiştirdiğinde (Kiro → Cursor → Claude Code → opencode → Windsurf),
`keyflip handoff --to <araç>` taşınabilir `.keyflip/` hafızasını tek bir markdown isteme dönüştürür:
projenin hangi araçlar arasında dolaştığı, okunacak dosyalar, aktif görev (biten / kalan / bilinen
sorunlar), yeni aracın açıklama yapmadan DEĞİŞTİRMEMESİ gereken kararlar ve araca uygun bir kapanış
talimatı. Sır-güvenlidir — her alan yeniden taranır, yalnızca ortam değişkeni **adları** taşınır. Salt-okunur MCP aracı `keyflip_handoff` olarak da mevcuttur.

### Bağlam eşitleme gizlilik modları

Bağlam Katmanı bir proje için paylaşılabilir bir `.keyflip/` paketi oluşturabilir. Bir gizlilik **modu**
neyin makineden çıkabileceğini belirler ve **her metin alanı paketlenmeden önce — her modda — gizli-tarama'dan
geçirilir** (derinlemesine savunma): bir jeton veya anahtar asla paylaşılan bağlama giremez.

| Mod | Ne gönderilir |
| --- | --- |
| `local` | Hiçbir şey — makineden asla çıkmaz (varsayılan). |
| `git` | Depoda düz metin (`.keyflip/` depoyla taşınır). |
| `encrypted` | Bulut/WebDAV için parola ile mühürlü (AES-256-GCM). |
| `company` | Ham konuşmalar + kaynak parçacıkları çıkarılır; yalnızca onaylı sağlayıcılar paylaşılır. |

```bash
keyflip context sync status                              # geçerli mod + politika + kontrol noktası
keyflip context sync mode company                        # gizlilik modunu değiştir
keyflip context sync export --passphrase-file pass.txt   # eşitleme yükünü üret (stdout)
keyflip context sync check --against incoming.json       # deneme: ne gönderilir, temizlenen sırlar, çakışmalar
```

Ortam değişkeni **değerleri asla taşınmaz** — yalnızca değişken adı ve bir açıklama gider. Çakışma tespiti bir içerik özetini üst kontrol noktasıyla karşılaştırır: iki makine aynı tabanı düzenlediyse `check` bir çakışma bildirir ve `use-new` / `use-old` / `merge` / `two-branches` seçeneklerini sunar. Ajanlar modu `keyflip_ctxsync_status` ile okur ve (onay ile) `keyflip_ctxsync_mode` ile değiştirir.

### Skill kur — elindeki her agent'a

Tek skill, makinede skill okuyan her araç:

```bash
keyflip skill agents                  # 72 hedef dizin; ● = o araç burada
keyflip skill add anthropics/skills   # GitHub / ./dizin / file.tgz'den her agent'a kur
keyflip skill add ./benim-skill --agents claude,cursor   # …ya da yalnız adını verdiğin agent'lara
keyflip skill sync                    # kaynak değiştiyse yeniden uygula; senin düzenlediğin kopyaya dokunmaz
keyflip skill list | keyflip skill remove <ad>   # yalnız keyflip'in kurduklarına dokunur
keyflip install-skill                 # paketli keyflip skill'i → Claude + tespit edilen diğer agent'lar
```

Tespit, aracın kendi ev dizinine bakar (`~/.cursor`, `~/.kiro`, …): keyflip kurulu olmayan bir araç için dizin uydurmaz; paylaşılan bir dizin (`~/.agents/skills` Codex, Warp, Goose, Zed ve daha fazlasına hizmet eder) bir kez yazılır. Yazmadan önce skill'in metni taranır — **sır taşıyan bir skill kabul edilmez, reddedilir (redakte edilmez)**. `~/.config/keyflip/installed-skills.json` manifesti hedef başına SHA-256 tutar: `sync` el değmemiş kopyayı senin düzenlediğinden ayırır (seninki asla üzerine yazılmaz), `remove` ise kendi yazmadığını silmez. `--link` kopyalamak yerine symlink kurar; `--dry-run` planı yazdırır, hiçbir şey yazmaz.

### Failover proxy

```bash
keyflip proxy start --wire            # yerel failover proxy başlat + Claude'u ona bağla
keyflip proxy status | keyflip proxy stats
keyflip proxy stop                    # durdur (ve bağlantıyı kaldır)
```

**Proxy komutla başlatılır** (asla her zaman-açık daemon değil): çalışırken her
API isteğini aktif hesaba yönlendirir ve istemciye bir bayt gitmeden önce
`429`/`5xx` olursa **sıradaki sağlıklı hesaba geçip yeniden dener** — kota-eşikli
`autoswitch`'in veremeyeceği istek-seviyesi failover. Yalnız `127.0.0.1` dinler.

Failover bilinçli çalışır, ilk hatada körlemesine atlamaz:

- **`Retry-After` uygulanır.** Üst servis beklenebilir bir süre verdiyse ve bu süre
  `proxy.maxWaitSeconds` (varsayılan 10 sn) içindeyse keyflip bekler ve **aynı**
  hesabı bir kez daha dener — başka hesabın kotasını harcamaktan ucuzdur. Daha uzun
  bir bekleme verilmişse hemen failover yapılır ve hesap en az o süre park edilir.
- **Faturalama 429'u hız limiti değildir.** Yanıt gövdesi kredi/faturalama/
  kuruluş-devredışı diyorsa hata sana döner (başka hesabın kotasıyla maskelenmez);
  gerçek hız-limitli 429'lar failover olur.
- **Türe göre cooldown.** 429, 401/403, 529 veya 5xx alan hesap `breakers.json`
  içinde türe özel TTL ile park edilir (`keyflip config`:
  `proxy.cooldownQuotaSeconds`, `…ThrottledSeconds`, `…OverloadedSeconds`,
  `…AuthSeconds`, `…ServerSeconds`; `0` o türü kapatır). Park edilen hesap
  atlanır; hepsi parktaysa en erken açılacak olan bekleme bilgisiyle kullanılır.
- **Belirlenimci sıra.** Önce `proxy.priority` (virgüllü hesap adları), sonra
  aktif hesap, sonra en-az-kullanılan (LRU).
- **Hata ayıklama başlıkları** her yanıtta: `x-keyflip-account`,
  `x-keyflip-attempts`, `x-keyflip-failover`, `x-keyflip-error-class`,
  `x-keyflip-cooldown`, `x-keyflip-model`, `x-keyflip-route`
  (`proxy.debugHeaders=false` kapatır).

#### Bildirimsel yönlendirme (`proxy-routes.json`)

Yukarıdakilerin hepsi varsayılandır. **İstek bazında** karar vermek için
`~/.config/keyflip/proxy-routes.json` oluştur (`keyflip proxy routes init` geçerli
bir başlangıç dosyası yazar). Çalışan proxy dosyayı **bir sonraki istekte**
yeniden okur — yeniden başlatma yok:

```json
{
  "fallback": "retry",
  "sticky": { "enabled": true, "ttlSeconds": 1800 },
  "modelChain": ["claude-sonnet-4-5", "claude-haiku-4-5"],
  "rules": [
    { "name": "opus-is", "when": { "model": "*opus*" }, "use": { "account": "is" } },
    { "when": { "tokensGt": 120000 }, "use": { "model": "claude-sonnet-4-5" } }
  ],
  "transforms": {
    "setHeaders": { "x-team": "pay" },
    "removeHeaders": ["x-internal"],
    "bodyModel": null,
    "maxTokens": 8192
  }
}
```

- **rules** — ilk eşleşen kazanır. `when`: `model`, `path`, `header`
  (ad → glob), `tokensGt` (bağımlılıksız tahmin, ~karakter/4 — "yalnız çok büyük
  istekler" demek için), `account`, `user`; glob `*` ve `?` kullanır. `use` bir
  `account` ve/veya `model` seçer. Kural yalnız **o an kullanılabilir** bir hesabı
  adlandırabilir: cooldown veya açık breaker her zaman kazanır ve gerekçe bunu
  sessizce görmezden gelmek yerine söyler.
- **sticky** — bir sohbet (`metadata.user_id`, ya da `x-keyflip-session` başlığıyla
  isteğe bağlı) bir hesapta başarılı olursa TTL boyunca orada kalır (süreç içi,
  1000 sohbetle sınırlı).
- **fallback** — `off` (ilk yanıtı olduğu gibi döndür, yeniden deneme yok),
  `retry` (yukarıdaki failover; varsayılan) veya `model-chain` (429/529/5xx'te
  başka hesabın kotasını harcamadan önce **aynı hesapta** sıradaki modele düş —
  model sorunu hesap arızası değildir, breaker açılmaz).
- **transforms** — istek başlığı ekle/kaldır, gövde modelini değiştir,
  `max_tokens` tavanı koy (yalnız düşürülür). Gövde yalnız JSON ise yeniden
  yazılır; başka bir şey olduğu gibi iletilir.
- **custom router** — `CUSTOM_ROUTER_PATH=/yol/router.js` (veya dosyada
  `customRouter`) stdin'den `{model,path,user,tokens,accounts}` JSON'u alır ve
  `{"account":"…","model":"…","reason":"…"}` döndürür; 1,5 sn zaman aşımı, 64 KB
  sınır, herhangi bir hata kuralara geri düşer. Salt-okunur araçlar bu kancayı
  **çalıştırmaz**.

Geçersiz bir dosya proxy'yi asla bozmaz: yok sayılır ve `keyflip proxy routes` +
`keyflip proxy status` her sorunu adıyla gösterir.

```bash
keyflip proxy routes                  # dosya, hataları, geçerli politika
keyflip proxy routes init [--force]   # geçerli bir şablondan başla (üzerine yazmaz)
keyflip proxy explain --model claude-opus-4 --tokens 200000   # bu istek nereye gider, neden?
keyflip cooldown                      # rota sırası + her hesabın breaker/cooldown durumu (kalan sn)
keyflip cooldown clear <hesap>|--all
```

### Kullanıma göre otomatik geçiş (`autoswitch`)

`keyflip autoswitch --threshold 90 --interval 60 --strategy next-available`
aktif hesabı izler ve 5s/7g kullanımı eşiği aşınca **CLI kimliğini otomatik
olarak** seçilen hesaba takas eder — hiçbir şeyi kapatmadan (Claude Code yeni
hesabı bir sonraki isteğinde alır). Başlangıçta bir kez onay ister (`-y` ile
scriptlenebilir) ve masaüstü uygulamasına asla dokunmaz. `keyflip link <ad>`
ile dizinleri hesaplara sabitleyin: adsız `keyflip run`, en yakın bağlı üst
dizini kullanır.

**Gözetimsiz çalıştır** — bir terminal açık tutman gerekmesin (ve sen Claude'da
çalışırken rotasyon gerçekten olsun): `keyflip autoswitch install` bir arka plan
servisi kaydeder (macOS'ta launchd `StartInterval`, Linux'ta cron `*/N`) ve
aralıkla tek bir `keyflip autoswitch --once` kontrolü çalıştırır. `keyflip
autoswitch status` aktif mi gösterir; `keyflip autoswitch uninstall` durdurur.
Varsayılanlar (threshold/strategy/group/interval), flag verilmezse `keyflip
config`'ten gelir. MCP: `keyflip_autoswitch_service` (`action=status|install|remove`).

### Agent'lar için: MCP sunucusu ve skill

Agent'lar CLI'ı tahmin etmek zorunda kalmasın — keyflip **MCP** konuşur:

```bash
claude mcp add keyflip -- keyflip mcp     # veya: keyflip mcp --setup
```

**Tüm CLI yüzeyi 160+ MCP aracı olarak sunulur** — agent hiçbir şeyi kabuğa
dökmeden yapabilir: hesaplar (`keyflip_status/list/switch/next/add/account_remove`), provider'lar
(`keyflip_providers`, `keyflip_provider_use/add/remove`, `keyflip_test_provider`, `keyflip_speedtest`),
**filo** kontrol düzlemi (`keyflip_fleet_status/push/switch/send_account/collect/keys/trust`;
`push` bu makinenin durumunu yayınlar ve gelen kutusunu işler — sırlar ve kuyruktaki
switch/save komutlarının uygulanması ayrı izin bayraklarıdır),
oturumlar (`keyflip_sessions`, `keyflip_resume_command`, archive/distill/compact), **hesaplar arası tek
görev** (`keyflip_threads` salt-okunurdur: liste / `slug` / `timeline` / `suggest` / tersten `id` arama;
`keyflip_thread_create|add|remove|drop|mirror` yazar ve `confirm` ister), **geçiş ön kontrolü**
(`keyflip_switch_plan` + `keyflip_verify` salt-okunurdur: bir şey hareket etmeden önce tam yazılacaklar,
engeller, kota durumu ve geri alma kapsamı), **görev maliyeti** (`keyflip_llm` — `dream`/`distill`/
`recall` hangi modelin koşacağı ve kimin kotasını yaktığı; `keyflip_recall` `answer: true` atıflı sentez
verir), **geçmiş hijyeni** (`keyflip_history_audit` + `keyflip_memory_audit` salt-okunurdur: commit
edilmiş her blob ve hatıralar taranır; `keyflip_history_scrub` + `keyflip_memory_redact` yazar ve
`confirm` ister; `keyflip_secrets_policy` okur, `keyflip_secrets_tolerate` ise değersiz
"bu bulgu beklenen bir şey" politikasını yazar — alarmı susturur, yolu temizlikten muaf tutmaz),
**kimlik bilgisi zincirleri** (`keyflip_chains` salt-okunurdur: her yakalamanın
hangi depodan kopyalandığı, her parçayı kimin yenileyebileceği, neyin bayat/paylaşılmış/herkese
okunabilir olduğu — yol ve stat, asla değer; `keyflip_chains_tighten` chmod eder ve `confirm` ister),
migrate + LAN
(`keyflip_migrate_*`, `keyflip_transfer_pull`), WebDAV sync (`keyflip_sync_test/push/pull`),
`keyflip://` linkleri (`keyflip_share/share_apply`), masaüstü gateway (`keyflip_gateway_*`), MCP-sunucu
kaydı (`keyflip_mcpreg_*`), dizin pin'leri (`keyflip_link/links`), izole uygulama örnekleri
(`keyflip_instances`, `keyflip_instance_*`), ortak ChatGPT/Codex girişi
(`keyflip_chatgpt`, `_chatgpt_capture`, `_chatgpt_switch`, `_chatgpt_refresh`, salt-okunur `_chatgpt_backups`, onay-gerektiren `_chatgpt_restore`), tanılama
(`keyflip_doctor`, `keyflip_usage_history`), yedekler, skill'ler (`keyflip_skills` ve `keyflip_skill_agents` salt-okunur;
`keyflip_skill_add`, `keyflip_skill_sync` ve `keyflip_skill_remove` tespit edilen her agent'a, ya da yalnız verdiğin `agents`'a yazar)
ve failover proxy. Her aracın düzgün JSON Şeması ve
salt-okunur/yıkıcı anotasyonu var; **değiştiren araçlar `confirm: true` ister**
ve açıklamaları agent'a önce kullanıcıya sormasını söyler. Sırlar MCP üzerinden
asla alınmaz — ör. provider anahtarı ekleme CLI'daki `--key-file`'a bırakılır.

Agent'a tüm bunları ne zaman ve nasıl kullanacağını öğreten paketli bir
**agent skill'i** de var (rate-limit playbook'u, durum kodları, paralel
oturumlar). `keyflip install-skill` onu Claude'un skill dizinine kendi
yedek + sürüklenme kontrolüyle kurar ve aynı skill'i tespit edilen diğer
agent'lara (Cursor, Kiro, Codex, Qoder, …) dağıtır; `keyflip skill agents`
hedefleri listeler.

```bash
keyflip panel [--open]         # yerel web paneli: hesaplar+kotalar, etkinlik takvimi, memory takımyıldızı, oturumlar
keyflip panel --export <f> [--anon]   # paylaşıma-güvenli STATİK snapshot yaz (oturum içeriği yok, sır yok)
keyflip menubar [--install]   # menü-çubuğu/tepsi eklentisi — macOS xbar/SwiftBar, Linux GNOME Argos/KDE kargos: hesap+kota tek bakışta, tıkla-geç
keyflip statusline install    # aktif hesap + kotayı Claude Code promptunda göster
keyflip install-skill         # paketli skill → ~/.claude/skills/keyflip + diğer tespit edilen agent'lar
```

### Paralel oturumlar (`run`)

`keyflip run <ad>` Claude Code'u o hesapla **yalnızca geçerli terminalde**
başlatır — diğer tüm terminaller, masaüstü uygulaması ve VS Code mevcut
hesabında kalır; iki hesap yan yana çalışabilir. `~/.claude`
özelleştirmeleriniz (settings, keybindings, CLAUDE.md, skills, commands,
agents) symlink'lerle sizinle gelir (`--no-share` = çıplak profil); konuşma
geçmişi hesap-başına kalır (`--share-history` ile paylaşılabilir). `--`
sonrası her şey `claude`'a iletilir (ör. `keyflip run is -- --resume`).
Oturum token'ı yenilerse keyflip çıkışta profile geri kaydeder.

> ⚠️ **Önce onay ister** (`-y` ile atlanır): paralel oturumdaki bir token
> yenilemesi o hesabın refresh token'ını döndürür ve *aynı hesabın diğer canlı
> kopyalarını* düşürebilir.

### Headless içe aktarma (`add --token`)

`keyflip add <ad> --token <dosya|->`, ham bir kimlik JSON blob'unu
(`{"claudeAiOauth":{...}}`) giriş akışı olmadan hesap olarak kaydeder — CI
veya makine hazırlama için. Blob **dosyadan veya stdin'den okunur, asla
argv'den değil**. TTY'de onay ister; pipe'lı/scriptli kullanım `--force`
geçmelidir ve mevcut bir hesabın üzerine yazmak her zaman `--force` ister.

### VS Code

VS Code Claude Code eklentisi CLI'ın kimlik deposunu paylaşır; yani her
keyflip geçişi ona da uygulanır (almak için pencereyi yenileyin).
[`vscode-keyflip/`](vscode-keyflip/) içindeki ince eklenti status bar'a hesap
göstergesi, QuickPick hesap değiştirici (5s/7g kota ile), tek tıkla **Open
Dashboard** (`keyflip panel`) ve durum görünümü ekler — yerel kurulum için
[README](vscode-keyflip/README.md) ([TR](vscode-keyflip/README.tr.md)).

### Geçişten sonra tüm oturumlarınızı görmek (macOS)

Claude **masaüstü uygulaması** "Recents" listesini hesap-başına bir dizinde tutar:
`~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/` —
bu yüzden her hesap varsayılan olarak yalnızca kendi altında açtığınız Code
oturumlarını gösterir.

keyflip her geçişte (uygulama kapalıyken) bu dizini **birleştirir** — diğer
hesapların oturum işaretçilerini aktif olana kopyalar; böylece Recents hepsini
gösterir. Aynı geçiş **Cowork** oturum işaretçilerini de kapsar ve temel
uygulamayı her **instance kopyasıyla** birleştirir (`User Data/claude-code-sessions`
ve `local-agent-mode-sessions`); bir kopyada açılan sohbet her yerde görünür.
Farklı hesapların aynı adlı dosyaları `local_<cliSessionId>.json` adına geri
düşülerek ayrı tutulur; çalışan bir kopya atlanır (kapatıp yeniden koşun) ve
`--no-instances` birleştirmeyi temel uygulamayla sınırlar. Önce her depoyu yedekler
ve yalnızca dosya *ekler* (asla silmez).

> `~/.claude/projects` transcript'leriniz zaten hesaptan bağımsızdır; bu sadece
> uygulamanın listesinin onları göstermesini sağlar. **Bulut "Chat" sohbetlerine
> (claude.ai) dokunulmaz** — onlar sunucuda hesap-başına yaşar ve yerel olarak
> birleştirilemez.

### Masaüstü uygulamasının girişini de değiştirmek (macOS, deneysel)

Claude **masaüstü uygulamasının** CLI'dan ayrı kendi girişi vardır. *Gerçek*
oturumu, `Cookies` veritabanındaki claude.ai çerezidir (`config.json`'daki
`oauth:tokenCache` blob'ları uygulamanın açılışta o çerezden yeniden türettiği
bir önbellektir). keyflip bu yüzden **ikisini de** yakalar ve takas eder —
her hesabın masaüstü girişi bir kez yakalandıktan sonra `keyflip <ad>` hem
CLI'ı hem masaüstü uygulamasını aynı hesaba çevirir.

Masaüstü girişi CLI'dan **bağımsızdır** — aynı anda farklı hesaplarda bile
olabilirler. `keyflip add` **o an girişli ne varsa** yakalar: CLI girişi
ve/veya masaüstününki (otomatik algılanır). Hesap başına: giriş yapın
(uygulama ve/veya CLI), `keyflip add` çalıştırın, bitti. `keyflip list` her
hesapta nelerin yakalandığını gösterir (`[cli ✓|— | app ✓|—]`); uygulamanın
hesabı otomatik tanınamazsa adını siz verin (`keyflip add <ad> --app`).

Sonrasında `keyflip <ad>` (uygulama kapatılıp yeniden açılarak) CLI kimliğini
**ve** masaüstü girişini (token + oturum çerezi) takas eder — elle yeniden
giriş yok. `config.json` ve çerez veritabanı önce yedeklenir
(`~/.config/keyflip/backups/`).

Kayıtlı *yakalama* ile *canlı giriş* aynı şey değildir; farkı şöyle ortaya çıkar:
claude.ai o oturumu yakalamadan sonra döndürmüş ya da iptal etmişse uygulama açılışta
çerezi siler ve **giriş ekranıyla** açılır — token önbelleği sağlam ve çözülebilir
olduğu hâlde. Bunu hiçbir otomatik yol çözemez (çerezi yalnızca bir giriş üretir),
bu yüzden keyflip sağlıklı görünmek yerine durumu söyler: `keyflip list` yakalama
`app ✓` dururken uygulamayı `(signed out on disk…)` diye işaretler, `keyflip doctor`
**desktop app session** kontrolünü çalıştırır (çerez varsa son kullanma tarihini de
gösterir) ve Claude'u yeniden açan bir geçişten sonra birkaç saniye bekleyip uygulama
girişsiz açıldıysa uyarır. Her üç durumunda da çözüm aynı: uygulamada bir kez giriş
yapın, sonra `keyflip add <ad>` çalıştırın — CLI, tarayıcı oturumu ve diğer tüm
yakalamalar seçtiğiniz hesapta kalmaya devam eder.

Suçu kolayca yanlış yere atan bir özel neden: uygulama **kendini güncelledi**. Squirrel/ShipIt
paketi değiştirip uygulamayı yeniden başlatır ve o yeniden başlatmada Chromium `claude.ai`
oturum çerezini henüz diske yazmamış olabilir — böylece canlı kavanoz girişsiz görünürken kayıtlı
yakalaman kusursuzdur ve keyflip tarafında hiçbir değişiklik olmadan *sanki* girişler çalışmaz hâle
gelmiş gibi görünür. `keyflip doctor` kurulu paketin tarihini okur ve "uygulama GÜNCELLENDİ
<tarih> (vX)…" der, bozuk bir yakalama ima etmek yerine. `keyflip add --dry-run` ise bir yakalamanın
*ne* kaydedeceğini ve uygulamanın kavanozunda şu an kullanılabilir bir oturum olup olmadığını hiçbir
şey yazmadan gösterir.

> Deneysel: uygulama kapalıyken `config.json` girişini yeniden yazar. Kayıtlı
> token tamamen süresi dolmuşsa uygulama yeniden giriş isteyebilir; o hesabı
> yeniden `add` edin. Bir şey ters görünürse yedeği geri yükleyin.

> Geçiş Claude kapalıyken yapılmalıdır; yoksa Claude çıkarken değişikliğin
> üzerine yazabilir.
> - **Etkileşimli** (menü veya terminalde `keyflip <ad>`): Claude açıksa
>   **kapatılmadan önce sorulur** — *hayır* derseniz iptal edilir.
> - `--restart`: sormadan kapatıp yeniden açar (macOS).
> - `--force`: kapatmadan geçer — sonrasında Claude'u kendiniz yeniden başlatın. **Masaüstü uygulaması** başka bir hesapta çalışıyorsa paylaşılan girişi geri yazıp geçişi bozabilir; `--force` bunu tespit edince uyarır ve `--restart` önerir.
> - `--dry-run`: planı yazdırır (hangi yüzeylerin üzerine yazılacak, ne engelliyor, o hesap hâlâ kimlik doğrulayabiliyor mu) ve hiçbir şeyi değiştirmez — Claude açıkken bile güvenlidir.
> - Her geçiş ardından **kendini geri okur**: yeni hesaba taşınan yüzeyleri yeniden kontrol eder (token son kullanma tarihi, uygulamanın oturum çerezi, diskteki CLI kimliği) ve temiz çıkan çıkış koduna güvenmek yerine `usable now` / `usable, decaying` / `NOT usable` der. `--no-verify` bunu atlar; `--rollback-on-fail` ayrıca geri-okuma geçişin tutmadığını söylerse önceki hesabı geri koyar — bilerek açılır, çünkü geri alma kimlik bilgilerini yeniden yazar ve `keyflip undo` çare değildir (yalnız keyflip'in metadata deposunu geri alır).
> - Etkileşimsiz (pipe/CI) ve Claude açıkken bayraksız: uygulamanızı beklenmedik
>   şekilde kapatmak yerine reddeder.

---

## Alternatifler & keyflip nasıl kıyaslanıyor

Claude araç ekosistemi kalabalık, ama çoğu araç bu işlerden **birini** yapıyor;
keyflip hepsini tek bir CLI+MCP aracında birleştiriyor — **GUI yok, her-zaman-açık
daemon yok** — ve **masaüstü uygulamasının** girişini de takas eden nadir araç.

| Proje | Yıldız | Tür | Ne yapar |
|---|---|---|---|
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 112k | Rust/Tauri GUI | 7 AI CLI için provider+MCP+skill yöneticisi (GUI) |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 35k | TS router | İstekleri farklı model/provider'a yönlendirir |
| [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) | 12k | Barındırılan relay | Kendi kendine barındırılan çok-hesap relay + pano |
| [realiti4/claude-swap](https://github.com/realiti4/claude-swap) | 712 | Python CLI | Claude Code **hesap** değiştirme (ilk ilhamımız) |
| [jolehuit/clother](https://github.com/jolehuit/clother) | 371 | Go CLI | Çoklu provider değiştirme |
| [guyskk/claude-code-config-switcher](https://github.com/guyskk/claude-code-config-switcher) | 83 | Go CLI | Provider değiştirme (Kimi/GLM/MiniMax…) |
| [Danielmelody/ccconfig](https://github.com/Danielmelody/ccconfig) | 62 | JS CLI | Hızlı provider değiştirme |
| [yaakua/cc-copilot](https://github.com/yaakua/cc-copilot.com) | 56 | TS GUI | Masaüstü GUI: proje+provider+oturum |

**keyflip'in nişi:** OAuth **hesap** değiştirme **+** 3. taraf **provider**
yönlendirme **+** **failover proxy** **+** **masaüstü uygulaması** login takası
**+** oturum/Cowork/Chat tarama **+** tam **MCP** yüzeyi + agent skill — tek,
bağımlılıksız araç, provenance'lı token'sız yayın. Yepyeni (henüz kullanıcı yok);
yukarıdaki devlerin çok daha fazla kitlesi var ve keyflip'in masaüstü-kripto
özellikleri macOS-öncelikli (yukarıdaki *Platform kapsamı*'na bakın).

---

## Nasıl çalışır

| Parça | macOS | Linux / Windows |
|------|-------|-----------------|
| Canlı giriş token'ı | Keychain kaydı `Claude Code-credentials` | `~/.claude/.credentials.json` |
| Kayıtlı profil token'ları | Keychain kayıtları `keyflip:<ad>` | `~/.config/keyflip/creds/<ad>.cred` (0600) |
| Hesap kimliği | `~/.claude.json` içinde `oauthAccount` + `userID` | aynı |
| Profil metadata'sı (sır içermez) | `~/.config/keyflip/<ad>.json` (0600) | aynı |

Arka uç otomatik algılanır: bir kimlik **dosyası** zaten varsa o kullanılır
(her OS); yoksa macOS Keychain kullanır. Geçiş, kayıtlı token'ı canlı yuvaya
kopyalar **ve** `~/.claude.json`'daki iki alanı günceller. *Ayrılırken*
keyflip önce mevcut hesabın (muhtemelen yenilenmiş) token'ını yeniden kaydeder
— hiç kaydetmediğiniz girişli bir hesabı bile otomatik kaydeder, token'ı kaybolmaz.

### Güvenlik notları

- **Yapılandırma bütünlüğü:** `~/.claude.json` yazımları atomiktir ve dosya
  modunu korur; dosya var ama geçerli JSON değilse keyflip ayarlarınızı ezme
  riskine girmek yerine dokunmayı reddeder.
- **macOS Keychain:** token'lar `security -i`'ye **stdin** üzerinden (hex
  kodlu) verilerek yazılır; sır asla süreç tablosunda görünmez;
  `/usr/bin/security` mutlak yolla çağrılır. (Yalnızca stdin satır bütçesine
  sığmayan bloblar argv yazımına düşer.)
- **Dışa aktarmalar:** `keyflip export` dosyaları giriş sırları içerir —
  `0600` ile ve yüksek sesli uyarıyla yazılırlar; taşıma için `-` ile stdout'a
  verip şifreleyin (ör. gpg), içe aktardıktan sonra silin.
- Geçişi Claude kapalıyken yapın. macOS uygulaması/`--restart` sizin yerinize
  kapatıp açar; diğerlerinde Claude çalışıyorsa keyflip uyarır ve geçişten
  sonra yeniden başlatmanızı ister.

---

## Test ve CI — "tüm sürümler" nasıl kapsanıyor

Her işletim sistemine sahip olmanız gerekmez. İki katman:

1. **Hermetik birim testleri** (`node --test`, `test/` içinde). Kimlik deposu ve
   `~/.claude.json` bir bağlam nesnesinin arkasına soyutlanmıştır; testler
   bellek-içi depo ve geçici ev dizini enjekte eder. Mantık OS/sürümden
   bağımsızdır, dolayısıyla bu testler her yerde aynı şekilde çalışır.

   ```bash
   npm test
   ```

2. **GitHub Actions matrisi** (`.github/workflows/ci.yml`) test setini
   **`ubuntu-latest` + `macos-latest` + `windows-latest`** üzerinde
   **Node 18 / 20 / 22** ile çalıştırır — her push'ta gerçek farklı OS ve
   sürümler, ücretsiz. Ayrıca özel bir macOS işi, tek kullanımlık bir keychain'e
   karşı gerçek `security` yolunu uçtan uca test eder.

---

## Sorun giderme

- **Kurumsal proxy / TLS araya girme:** token yenileme ve kullanım denetimleri
  Anthropic'e Node'un paketli CA'larıyla HTTPS üzerinden gider. MITM proxy
  arkasında Node'a CA paketinizi gösterin:
  `export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`.
- **`list --usage` içinde `[throttled]`:** kullanım *endpoint'i* o token'ı
  kısıtladı — hesabın rate-limitli olduğu anlamına **gelmez**. Sonra tekrar deneyin.
- **`[expired]`:** kayıtlı token artık doğrulanamıyor — o hesaba bir kez giriş
  yapıp `keyflip add` çalıştırın.
- **"keychain kilitli":** login keychain'in kilidini açın; keyflip'in kendi
  profil deposu otomatik olarak dosyalara düşer, çalışmaya devam edersiniz.

---

## Sıfırlama & kaldırma

```bash
keyflip reset                # FABRİKA sıfırlaması — TÜM keyflip verisini SİL (hesaplar,
                             #   provider'lar, yedekler, geçmiş); keyflip kurulu kalır.
                             #   Canlı Claude oturumuna dokunulmaz; ~/.claude/projects korunur.
keyflip reset --soft         # hesapları koru; yalnız runtime durumunu temizle (geçmiş, breaker,
                             #   proxy durumu, cache, log) + Claude Code aboneliğe geri döner
keyflip reset --logout       # (fabrika ya da --soft) her canlı yüzeyi KAPAT + ÇIKIŞ:
                             #   CLI (çalışan Claude Code'ları kapatır), tarayıcı (kapatır +
                             #   claude.ai/uzantı temizlenir), masaüstü (kapatır, kapalı kalır) — tam sıfır
keyflip reset --logout --no-desktop   # ...ama masaüstü uygulamasını girişli bırak
                             #   (ör. şu an onu kullanıyorsan)

keyflip uninstall            # keyflip'i bu makineden kaldır, kayıtlı veriyi tut
keyflip uninstall --purge    # ...ve kayıtlı veriyi + Keychain öğelerini de sil
```

`uninstall`, keyflip'in nasıl kurulduğunu (`install.sh` düzeni ya da npm global)
otomatik algılar ve doğru şeyleri kaldırır; canlı Claude oturumuna asla dokunmaz
(çıkış da yapmak istiyorsan önce `keyflip reset --logout` çalıştır) ve bir kaynak
kopyasını (checkout) silmez. Kabuk betiği de hâlâ çalışır:

```bash
./uninstall.sh               # macOS/Linux: CLI + uygulamayı kaldır, kayıtlı profilleri tut
./uninstall.sh --purge       # kayıtlı profilleri de sil
npm uninstall -g keyflip     # npm ile kurulduysa (her OS)
```

---

## Yayınlama (geliştiriciler için)

Sürümler npm'e **Trusted Publishing (OIDC)** ile yayınlanır — repoda `NPM_TOKEN`
secret'ı **yoktur** (GitHub Actions, npm'e kısa ömürlü bir token'la kimliğini
kanıtlar; provenance otomatik eklenir). Klasik automation token'ları npm
tarafından tam da bu yüzden güvenlik riski sayılıp önerilmez.

Tek seferlik kurulum (bir paketin trusted publisher'ı ancak paket var olduktan
sonra ayarlanabilir):

1. **İlk yayını elle** kendi makinenden yap — bu, repoda saklanan bir token
   değil, senin etkileşimli `npm login` oturumunu kullanır:
   ```bash
   npm login
   npm publish --access public        # @hakkisagdic/keyflip oluşturur
   ```
2. **npmjs.com** → paket → **Settings → Trusted Publisher → GitHub Actions**:
   kullanıcı `hakkisagdic`, repo `keyflip`, workflow `publish.yml`. Kaydet.
3. Bundan sonrası tamamen otomatik ve token'sız: `package.json`'daki `version`'ı
   yükselt, sonra
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   `release.yml` etiketi doğrular, test eder ve bir GitHub Release oluşturur; o
   Release'i yayınlamak `publish.yml`'i tetikler ve paket OIDC üzerinden npm'e gider.

---

## Web Sitesi

`/website` dizini, Astro ile oluşturulmuş projenin pazarlama ve dokümantasyon sitesini içerir. Kendi `package.json` dosyasına sahip bağımsız bir alt projedir. Geliştirme ve dağıtım talimatları için [`website/README.md`](website/README.md) dosyasına bakınız.

---

## Lisans

[MIT](LICENSE)

---

*Anthropic ile bağlantılı değildir. "Claude" ve "Claude Code", Anthropic'in ticari markalarıdır.*
