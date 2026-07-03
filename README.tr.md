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
> çerez/token'ını *çözmesi* gerekenler (uygulamanın hesabını otomatik algılama ve
> `keyflip chat`) şimdilik **yalnız macOS** — Windows bunları DPAPI ile şifreler
> (henüz eklemediğimiz farklı bir şema).

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
keyflip setup                 # yönlendirmeli sihirbaz: her hesaba giriş yap, otomatik yakalanır
keyflip login [ad] [--email x]     # resmi tarayıcı akışıyla giriş yap, izole + yakala
keyflip add [ad] [--app]      # girişli hesap(lar)ı kaydet — CLI + masaüstü uygulaması
keyflip browser [status|logout]    # tarayıcı claude.ai hesabını kontrol/sıfırla (Chrome uzantısı)
keyflip <ad|numara>           # o hesaba geç (Claude'u kapatmadan önce sorar)
keyflip <ad> --restart        # ...sormadan Claude'u kapatıp yeniden açar
keyflip <ad> --force          # ...Claude'u kapatmadan takas eder (kendiniz yeniden başlatın)
keyflip next                  # sıradaki kayıtlı hesaba dön
keyflip next --strategy best  # ...veya kalan kotaya göre seç (ayrıca: next-available)
keyflip provider add <ad> --base-url <url> --key-file -   # 3. taraf endpoint kaydet
keyflip use <ad>              # Claude Code'u bir provider'a yönlendir (geri: keyflip provider off)
keyflip doctor                # config, giriş ve endpoint erişilebilirliğini tanıla
keyflip backup now|list|restore <n>   # keyflip metadata anlık görüntüsü (sırsız)
keyflip usage --history       # hesap-başına kullanım eğilimi + failover olayları
keyflip status                # her yüzey hangi hesapta (CLI + masaüstü uygulaması)
keyflip list [--usage]        # hesaplar; --usage her hesabın 5s/7g kullanımını ekler
keyflip autoswitch            # kullanımı izle; eşikte CLI hesabını otomatik değiştir
keyflip link [ad|--remove]    # bu dizin ağacını `run` için bir hesaba eşle
keyflip run <ad> [-- argümanlar]  # PARALEL oturum: o hesap YALNIZCA bu terminalde
keyflip add <ad> --token <dosya|->   # ham kimlik bilgisini headless içe aktar
keyflip mcp [--setup]         # agent'lar için stdio üzerinden MCP sunucusu
keyflip install-skill         # agent'lara keyflip'i öğreten Claude Code skill'ini kur
keyflip export [dosya|-]      # hesapları dosyaya yedekle (SIR İÇERİR)
keyflip import <dosya|->      # yedekten hesapları geri yükle (--force üzerine yazar)
keyflip remove <ad|numara>    # kayıtlı hesabı sil
keyflip reset [--soft]        # FABRİKA sıfırlaması: TÜM keyflip verisini SİL (--soft hesapları korur)
keyflip clean [--logout]      # TÜM keyflip verisini sil; --logout her yerden çıkış da yapar
keyflip uninstall [--purge]   # keyflip'i bu makineden kaldır (--purge veriyi de siler)
keyflip upgrade               # keyflip'in kendisini güncelle (kurulum yöntemini algılar)
```

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
keyflip doctor                  # config + giriş + endpoint erişilebilirliği
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

### Agent'lar için: MCP sunucusu ve skill

Agent'lar CLI'ı tahmin etmek zorunda kalmasın — keyflip **MCP** konuşur:

```bash
claude mcp add keyflip -- keyflip mcp     # veya: keyflip mcp --setup
```

**Tüm CLI yüzeyi ~20 MCP aracı olarak sunulur** — agent hiçbir şeyi kabuğa
dökmeden yapabilir: hesaplar (`keyflip_status/list/switch/next`), provider'lar
(`keyflip_providers`, `keyflip_provider_use/add`, `keyflip_test_provider`),
oturumlar (`keyflip_sessions`, `keyflip_resume_command`), tanılama
(`keyflip_doctor`, `keyflip_usage_history`), yedekler, skill'ler
(`keyflip_skills`, `keyflip_skill_add/remove`) ve failover proxy
(`keyflip_proxy_status/control`). Her aracın düzgün JSON Şeması ve
salt-okunur/yıkıcı anotasyonu var; **değiştiren araçlar `confirm: true` ister**
ve açıklamaları agent'a önce kullanıcıya sormasını söyler. Sırlar MCP üzerinden
asla alınmaz — ör. provider anahtarı ekleme CLI'daki `--key-file`'a bırakılır.

Agent'a tüm bunları ne zaman ve nasıl kullanacağını öğreten paketli bir
**Claude Code skill'i** de var (rate-limit playbook'u, durum kodları, paralel
oturumlar):

```bash
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
[`vscode-keyflip/`](vscode-keyflip/) içindeki ince eklenti, status bar'a
hesap göstergesi ve QuickPick geçiş ekler — yerel kurulum için README'sine bakın.

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
> - `--force`: kapatmadan geçer — sonrasında Claude'u kendiniz yeniden başlatın.
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
keyflip reset --logout       # (fabrika ya da --soft) ek olarak tüm canlı yüzeylerden ÇIKIŞ:
                             #   CLI + tarayıcı (claude.ai) + masaüstü uygulaması
keyflip reset --logout --no-desktop   # ...ama masaüstü uygulamasını girişli bırak
                             #   (ör. şu an onu kullanıyorsan)
keyflip clean --logout       # aynı silme + her yerden çıkış (uyumluluk için korundu)

keyflip uninstall            # keyflip'i bu makineden kaldır, kayıtlı veriyi tut
keyflip uninstall --purge    # ...ve kayıtlı veriyi + Keychain öğelerini de sil
```

`uninstall`, keyflip'in nasıl kurulduğunu (`install.sh` düzeni ya da npm global)
otomatik algılar ve doğru şeyleri kaldırır; canlı Claude oturumuna asla dokunmaz
(çıkış da yapmak istiyorsan önce `keyflip clean --logout` çalıştır) ve bir kaynak
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
