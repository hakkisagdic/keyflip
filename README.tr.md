# keyflip — Hesap Değiştirici

[English](README.md) | **Türkçe**

Birden çok **Anthropic / Claude Code** hesabı arasında tek tıkla (veya tek komutla) geçiş yapın.
Hesaplarınıza bir kez giriş yapın, sonra tekrar tekrar çıkış/giriş yapmadan aralarında dolaşın.

**Çok platformlu:** macOS, Linux ve Windows. Saf Node.js, sıfır çalışma zamanı bağımlılığı.

[![CI](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml/badge.svg)](https://github.com/hakkisagdic/keyflip/actions/workflows/ci.yml)

> **Platform kapsamı.** Çekirdek — hesap değiştirme, provider'lar, oturumlar,
> failover proxy, skill'ler, MCP — **çapraz-platformdur** (macOS/Linux/Windows,
> üçünde de CI-testli). **Masaüstü-uygulaması** özellikleri (desktop login
> takası, Cowork, oturum birleştirme, gateway) uygulama verisini okur: **macOS
> ve Windows'ta** çalışır (Linux'ta resmi masaüstü uygulaması yok). Uygulamanın
> hesabını otomatik algılamanın artık bir **Windows yolu da var** (DPAPI + AES-GCM,
> `src/wincrypt.js`, fixture-testli; kesin gerçek-kurulum yolları hâlâ cihazda
> doğrulama bekliyor). Uygulamanın **tarayıcı** çerezlerini çözen `keyflip chat`
> şimdilik **yalnız macOS** — bkz. [docs/PORTING.md](docs/PORTING.md).

---

## Neden güvenli

- **OAuth token'larınız işletim sisteminin kimlik deposunda kalır.** macOS'ta bu Keychain'dir; Linux/Windows'ta Claude'un kendi `~/.claude/.credentials.json` dosyasıdır. keyflip token'ları bu yuvalar *arasında* kopyalar — yeni bir düz-metin token dosyası eklemez ve bu depo **hiçbir kimlik bilgisi içermez**.
- Bir geçiş yalnızca iki şeyi değiştirir: canlı kimlik yuvası ve `~/.claude.json` içindeki hesap işaretçisi (`oauthAccount` + `userID`).
- `~/.claude/projects` altındaki oturum geçmişiniz **hesaptan bağımsızdır** — hangi hesap aktifse onun altında görünür.

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

  [number] switch   [a] save current   [d] delete   [r] refresh   [q] quit
```

Claude / Claude Code açıksa keyflip önce **"Geçiş için Claude kapatılacak — devam edilsin mi?"** diye sorar. **Evet**'te Claude'u kapatır, geçer ve yeniden açar (macOS); **hayır**'da iptal eder, hiçbir şey değişmez.

### CLI

```bash
keyflip                       # etkileşimli menü (↑/↓ + Enter)
keyflip onboard [--manual] [--sso] [--console]   # tam ilk-kurulum: hesap başına giriş, CLI+tarayıcıyı
                              #   hizala, chatleri eşitle, sıradakini sor ("p" = API-key provider; --sso = kurumsal)
keyflip setup                 # hafif: Claude'da giriş yap, keyflip algılayıp yakalar
keyflip login [ad] [--email x] [--sso] [--console]   # resmi tarayıcı akışı, izole + yakala (--sso = kurumsal)
keyflip add [ad] [--app]      # girişli hesap(lar)ı kaydet — CLI + masaüstü uygulaması
keyflip browser [status|logout|sync]   # tarayıcı claude.ai hesabını kontrol/sıfırla/geri yükle (uzantı)
keyflip <ad|numara>           # o hesaba geç (Claude'u kapatmadan önce sorar)
keyflip <ad> --restart        # ...sormadan Claude'u kapatıp yeniden açar
keyflip <ad> --force          # ...Claude'u kapatmadan takas eder (kendiniz yeniden başlatın)
keyflip <ad> --browser        # ...tarayıcıyı + Chrome uzantısını da bu hesaba hizalar
keyflip next                  # sıradaki kayıtlı hesaba dön
keyflip next --strategy best  # ...veya kalan kotaya göre seç (ayrıca: next-available)
keyflip provider add <ad> --base-url <url> --key-file -   # 3. taraf endpoint kaydet
keyflip use <ad>              # Claude Code'u bir provider'a yönlendir (geri: keyflip provider off)
keyflip doctor                # sağlık kontrolü: git-e-sır, orphan oturumlar, versiyonlama, config, giriş, endpointler
keyflip backup now|list|restore <n>   # keyflip metadata anlık görüntüsü (sırsız)
keyflip usage --history       # hesap-başına kullanım eğilimi + failover olayları
keyflip status                # her yüzey hangi hesapta (CLI + masaüstü uygulaması)
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
keyflip ui [--fleet]          # tam ekran TUI panosu (hesaplar, kullanım, filo)
keyflip surfaces              # bu makinedeki diğer AI araçlarını algıla (Cursor/Gemini/Codex/Copilot/opencode/Aider) — salt-okunur
keyflip license <status|activate <dosya>|deactivate>   # offline plan (Ed25519-imzalı, phone-home yok)
keyflip run <ad> [-- argümanlar]  # PARALEL oturum: o hesap YALNIZCA bu terminalde
keyflip add <ad> --token <dosya|->   # ham kimlik bilgisini headless içe aktar
keyflip mcp [--setup]         # agent'lar için stdio üzerinden MCP sunucusu
keyflip panel [--open]         # yerel web paneli: hesaplar+kotalar, etkinlik takvimi, memory takımyıldızı, oturumlar
keyflip panel --export <f> [--anon]   # paylaşıma-güvenli STATİK snapshot yaz (oturum içeriği yok, sır yok)
keyflip menubar [--install]   # menü-çubuğu/tepsi eklentisi — macOS xbar/SwiftBar, Linux GNOME Argos/KDE kargos: hesap+kota tek bakışta, tıkla-geç
keyflip statusline install    # aktif hesap + kotayı Claude Code promptunda göster
keyflip install-skill         # agent'lara keyflip'i öğreten Claude Code skill'ini kur
keyflip export [dosya|-]      # hesapları dosyaya yedekle (SIR İÇERİR)
keyflip import <dosya|->      # yedekten hesapları geri yükle (--force üzerine yazar)
keyflip migrate export <dosya> # hesap + provider + transkript + memory + config (MCP + settings) paketle
                              #   altküme seç: --sessions <id,id> / --search T / --newer-than 7d / --only-sessions
                              #   --agents (memory) ve/veya --agent-config (MCP/ayarlar, redakte) ile diğer AI ajanları
                              #   veya --agent-config-secrets ile GERÇEK anahtarları kendi makinelerin arasında taşı (şifrele!)
keyflip agents                # diğer ajanların memory + config'ini listele (Cursor/Gemini/Codex/Copilot/opencode/Aider; sırlar redakte edilir)
keyflip settings [show|get <k>|set <k> <v>]   # ~/.claude/settings.json'ı gör/düzenle (`migrate` ile diğer makinelere gider)
keyflip migrate import <dosya> # bu paketi bu makineyle BİRLEŞTİR (birleşim; --force üzerine yazar)
keyflip migrate push --url <webdav>   # paketi başka makineye WebDAV üzerinden ilet (şifreli)
keyflip migrate pull --url <webdav>   # diğer makinede çekip BİRLEŞTİR (--force üzerine yazar)
keyflip transfer serve [--qr] # LAN: tek-kullanımlık kod (+ taranabilir QR) göster + şifreli paketi eşe akıt
keyflip transfer pull --code X # LAN: eşi otomatik bul, çek + BİRLEŞTİR (ya da <host:port> ver)
keyflip transfer serve --receive   # LAN: push edilen paketi ALMAK için BEKLE (ters yön)
keyflip transfer push <host> --code X   # LAN: paketini dinleyen makineye GÖNDER (E2 filtreleriyle)
keyflip transfer serve --relay <dizin|url>   # İNTERNET: aynı kod UX'i, paket senkronlu klasör / WebDAV relay üzerinden gider (LAN değil)
keyflip transfer pull --relay <dizin|url> --code <rendezvous>-<key>   # İNTERNET: relay'den çek + BİRLEŞTİR (tek-atış; alınınca silinir)
keyflip transfer relay [--dir D --host H --port P --auth-user U --auth-pass-file f]   # KENDİ sıfır-bağımlılık relay'ini barındır (sunucu gerekmez)
keyflip fleet init --dir <paylaşılan-klasör>   # FİLO: bu makineyi kontrol düzlemine bağla (şifreli paylaşılan/senkron klasör)
keyflip fleet push [--with-secrets]   # bu makinenin durumunu yayınla (hesaplar+kota+chat durumu) + kuyruğa alınmış komutları uygula
keyflip fleet status | panel   # TÜM makineleri tek ekranda gör — hesaplar, kota, "cevap geldi mi?" (panel = web panosu)
keyflip fleet switch <makine> <hesap>   # UZAK makinenin hesabını değiştir (o makine push edince uygulanır)
keyflip fleet send-account <hesap> --to <makine> [--from <makine>]   # hesabı dağıt (örn. C'nin hesabını B'ye, A'dan)
keyflip fleet collect         # filoda yayınlanmış tüm hesapları bu makineye topla
keyflip fleet keys            # her makinenin imza-anahtarı parmak izini denetle (ok / CHANGED / unpinned)
keyflip fleet trust <makine>  # meşru bir yeniden-anahtarlama SONRASI makinenin imza anahtarını yeniden sabitle (aşağıdaki "Filo — origin authentication")
keyflip consolidate [--watch] # her hesabın sohbet dizinini eşitle; her biri TÜM sohbetleri görsün
keyflip remove <ad|numara>    # kayıtlı hesabı sil (onay ister; --force ile atla)
keyflip logout [--browser] [--desktop]   # canlı oturum(lar)dan çık — kayıtlı hesaplar korunur
keyflip history | undo | restore <ref>   # git-versiyonlu config: her değişikliği incele / geri al / geri dön (sırlar asla commit edilmez)
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

### Filo — origin authentication

Filo, makineleri **şifreli paylaşılan bir klasör** üzerinden koordine eder; dolayısıyla parola tek
başına bir komutu *kimin* kuyruğa aldığını kanıtlayamaz. Bu yüzden her makinenin bir **Ed25519 imza
anahtarı** vardır: özel anahtar makineden asla çıkmaz (`0600`, asla paylaşılan klasörde/argv'de değil);
açık anahtar status'te yayınlanır. Kuyruğa alınan her komut **imzalanır** ve alıcısına bağlanır; alıcı
her peer'in açık anahtarını **ilk görüşte sabitler (TOFU)** ve sonra imzası doğrulanmayan, başka bir
makineye adreslenmiş ya da anahtarı **değişmiş** bir peer'den gelen komutu **reddeder** (olası
anahtar-değiştirme saldırısı). Böylece parola sızsa bile bir sahteci bir makineye komut veremez.
Sabitlemeleri `keyflip fleet keys` ile denetle; bir makine meşru şekilde yeniden anahtarlandığında
(temiz kurulum / sıfırlama) yeni anahtarını `keyflip fleet trust <makine>` ile yeniden sabitle
(önce out-of-band doğrulaman için yeni anahtarın parmak izini yazdırır).

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
keyflip provider add openrouter --base-url https://openrouter.ai/api/v1 --key-file -   # anahtar stdin'den
keyflip use openrouter          # Claude Code'u ona yönlendir
keyflip provider off            # aboneliğine geri dön (OAuth)
keyflip speedtest openrouter    # endpoint'leri ölç, en hızlısını kullan
keyflip test openrouter         # tek gerçek istek: auth çalışıyor mu?
keyflip doctor                  # sağlık kontrolü: git-e-sır + orphan + versiyonlama + config + giriş + endpointler
```

- **API anahtarı sırdır** → OS kimlik deposunda saklanır, asla metadata dosyasında
  veya komut satırında değil (stdin/dosyadan okunur).
- Geçiş yalnızca keyflip'in yönettiği anahtarlara dokunur; kendi `settings.json`'un
  (hooks, plugins, model override'ları) korunur; `provider off` tam olarak
  enjekte edileni geri alır.
- `keyflip gateway use <provider>` aynısını Claude **masaüstü uygulaması** için
  yapar (uygulamayı yeniden başlat).

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
keyflip send <id> "<mesaj>" [--as <hesap>] [--fork]   # bir oturuma mesaj enjekte et (headless yönlendir/sürdür; ör. başka makineden)
keyflip sessions archive <id|--older-than 30d>   # eski transkriptleri keyflip'e taşı (gzip'li); unarchive geri yükler
keyflip sessions distill <id>   # bir sohbeti kalıcı hatıraya damıt (`claude -p` ile); `keyflip memory` ile gözat
keyflip sessions compact <id> [--apply]   # transkripti küçült: hacimli tool çıktısını ele, sohbeti koru (varsayılan dry-run)
keyflip sessions export <id> [--format md|html|json]   # bir sohbeti temiz, paylaşılabilir belgeye çıkar (offline inceleme / arşiv)
keyflip foreign <oturum-dosyası> [--format md|html|json]   # BAŞKA bir ajanın oturumunu (JSONL / Cursor SQLite / opencode+genel JSON / Copilot YAML / Aider MD) aynı görünüme normalize et
keyflip handoff [--to claude|cursor|kiro|opencode|windsurf|generic] [--out CONTINUE.md]   # YENİ bir yapay zeka aracının bu projeyi .keyflip/ üzerinden (bağlam, görevler, kararlar, kurallar, son checkpoint) her şeyi yeniden okumadan sürdürmesi için bir DEVAM-İSTEMİ üretir
keyflip dream [--older-than 30d] [--archive] [--apply]   # "dreaming": eski sohbetleri tek geçişte damıt (+ arşivle); varsayılan dry-run
keyflip recall "<sorgu>" [--answer]   # TÜM sohbetlerinde arama (BM25; --semantic=embeddings; --answer = `claude -p` ile atıflı sentez)
keyflip dream schedule [--at 03:00] | unschedule | status   # dream'i her gece gözetimsiz koştur (launchd/cron)
keyflip cowork --search "sınav"       # masaüstü Cowork oturumları (tüm hesaplar)
keyflip chat                          # aktif hesabın claude.ai Chat'i (deneysel)
keyflip chat get <id>                 # bir bulut konuşmasını oku
```

**Hesaplar arası ne taşınabilir:** Claude Code oturumları ve **Cowork**
oturumları yerelde hesap-başına saklanır — keyflip ikisini de okur ve geçişte
birleştirir; her hesap hepsini görür. **claude.ai Chat** ise bulutta;
`keyflip chat` bunu masaüstü uygulamasının kendi oturum çerezi üzerinden okur —
**deneyseldir** (belgesiz API), taze bir Cloudflare çerezi gerektirir; uygulama
yeni kullanıldıysa çalışır, aksi halde 403 dönebilir. Yalnız masaüstünün o an
girişli olduğu hesabı görür. (Uygulama tercihleri, `design/`, worktree'ler
global/boş — orada taşınacak hesap-bazlı veri yok.)

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

### Skill kur ve failover proxy

```bash
keyflip skill add anthropics/skills   # GitHub / ./dizin / file.tgz'den skill kur
keyflip skill list | keyflip skill remove <ad>   # yalnız keyflip'in kurduklarına dokunur

keyflip proxy start --wire            # yerel failover proxy başlat + Claude'u ona bağla
keyflip proxy status | keyflip proxy stats
keyflip proxy stop                    # durdur (ve bağlantıyı kaldır)
```

**Proxy komutla başlatılır** (asla her zaman-açık daemon değil): çalışırken her
API isteğini aktif hesaba yönlendirir ve istemciye bir bayt gitmeden önce
`429`/`5xx` olursa **sıradaki sağlıklı hesaba geçip yeniden dener** — kota-eşikli
`autoswitch`'in veremeyeceği istek-seviyesi failover. Yalnız `127.0.0.1` dinler.

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

**Tüm CLI yüzeyi 130+ MCP aracı olarak sunulur** — agent hiçbir şeyi kabuğa
dökmeden yapabilir: hesaplar (`keyflip_status/list/switch/next/add/account_remove`), provider'lar
(`keyflip_providers`, `keyflip_provider_use/add/remove`, `keyflip_test_provider`, `keyflip_speedtest`),
**filo** kontrol düzlemi (`keyflip_fleet_status/switch/send_account/collect/keys/trust`),
oturumlar (`keyflip_sessions`, `keyflip_resume_command`, archive/distill/compact), migrate + LAN
(`keyflip_migrate_*`, `keyflip_transfer_pull`), WebDAV sync (`keyflip_sync_test/push/pull`),
`keyflip://` linkleri (`keyflip_share/share_apply`), masaüstü gateway (`keyflip_gateway_*`), MCP-sunucu
kaydı (`keyflip_mcpreg_*`), dizin pin'leri (`keyflip_link/links`), tanılama
(`keyflip_doctor`, `keyflip_usage_history`), yedekler, skill'ler ve failover proxy. Her aracın düzgün JSON Şeması ve
salt-okunur/yıkıcı anotasyonu var; **değiştiren araçlar `confirm: true` ister**
ve açıklamaları agent'a önce kullanıcıya sormasını söyler. Sırlar MCP üzerinden
asla alınmaz — ör. provider anahtarı ekleme CLI'daki `--key-file`'a bırakılır.

Agent'a tüm bunları ne zaman ve nasıl kullanacağını öğreten paketli bir
**Claude Code skill'i** de var (rate-limit playbook'u, durum kodları, paralel
oturumlar):

```bash
keyflip panel [--open]         # yerel web paneli: hesaplar+kotalar, etkinlik takvimi, memory takımyıldızı, oturumlar
keyflip panel --export <f> [--anon]   # paylaşıma-güvenli STATİK snapshot yaz (oturum içeriği yok, sır yok)
keyflip menubar [--install]   # menü-çubuğu/tepsi eklentisi — macOS xbar/SwiftBar, Linux GNOME Argos/KDE kargos: hesap+kota tek bakışta, tıkla-geç
keyflip statusline install    # aktif hesap + kotayı Claude Code promptunda göster
keyflip install-skill      # ~/.claude/skills/keyflip dizinine kopyalar
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
gösterir. Önce yedek alır ve yalnızca dosya *ekler* (asla silmez).

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

> Deneysel: uygulama kapalıyken `config.json` girişini yeniden yazar. Kayıtlı
> token tamamen süresi dolmuşsa uygulama yeniden giriş isteyebilir; o hesabı
> yeniden `add` edin. Bir şey ters görünürse yedeği geri yükleyin.

> Geçiş Claude kapalıyken yapılmalıdır; yoksa Claude çıkarken değişikliğin
> üzerine yazabilir.
> - **Etkileşimli** (menü veya terminalde `keyflip <ad>`): Claude açıksa
>   **kapatılmadan önce sorulur** — *hayır* derseniz iptal edilir.
> - `--restart`: sormadan kapatıp yeniden açar (macOS).
> - `--force`: kapatmadan geçer — sonrasında Claude'u kendiniz yeniden başlatın. **Masaüstü uygulaması** başka bir hesapta çalışıyorsa paylaşılan girişi geri yazıp geçişi bozabilir; `--force` bunu tespit edince uyarır ve `--restart` önerir.
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

## Lisans

[MIT](LICENSE)

---

*Anthropic ile bağlantılı değildir. "Claude" ve "Claude Code", Anthropic'in ticari markalarıdır.*
