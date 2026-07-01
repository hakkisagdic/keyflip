# ccswitch — Claude Hesap Değiştirici

[English](README.md) | **Türkçe**

Birden çok **Anthropic / Claude Code** hesabı arasında tek tıkla (veya tek komutla) geçiş yapın.
Hesaplarınıza bir kez giriş yapın, sonra tekrar tekrar çıkış/giriş yapmadan aralarında dolaşın.

**Çok platformlu:** macOS, Linux ve Windows. Saf Node.js, sıfır çalışma zamanı bağımlılığı.

[![CI](https://github.com/hakkisagdic/ccswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/hakkisagdic/ccswitch/actions/workflows/ci.yml)

---

## Neden güvenli

- **OAuth token'larınız işletim sisteminin kimlik deposunda kalır.** macOS'ta bu Keychain'dir; Linux/Windows'ta Claude'un kendi `~/.claude/.credentials.json` dosyasıdır. ccswitch token'ları bu yuvalar *arasında* kopyalar — yeni bir düz-metin token dosyası eklemez ve bu depo **hiçbir kimlik bilgisi içermez**.
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
curl -fsSL https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.sh | bash
```

**Windows — PowerShell** (Başlat Menüsü / Masaüstü kısayolu da oluşturur):

```powershell
irm https://raw.githubusercontent.com/hakkisagdic/ccswitch/main/install.ps1 | iex
```

**npm ile (her işletim sistemi):**

```bash
npm install --global git+https://github.com/hakkisagdic/ccswitch.git
```

**Klondan:**

```bash
git clone https://github.com/hakkisagdic/ccswitch.git && cd ccswitch && ./install.sh   # Windows'ta: .\install.ps1
```

Kurulum kodu `~/.local/share/ccswitch`'e yerleştirir, `ccswitch`'i `~/.local/bin`'e bağlar ve `PATH`'e ekler. Kaldırmak için `./uninstall.sh` (veya `npm uninstall -g ccswitch`).

---

## İlk kurulum (hesapları bul ve kaydet)

Elle yapılandırılacak bir şey yok — ccswitch **şu an giriş yaptığınız hesabı algılar** ve profili e-postanızdan otomatik adlandırır.

1. Claude'da **ilk** hesabınıza girişli olduğunuzdan emin olun, sonra `ccswitch add` çalıştırın.
2. Claude'da `/login` ile **ikinci** hesabınıza geçin, sonra yine `ccswitch add`.
3. İstediğiniz kadar hesap için tekrarlayın.

macOS'ta ilk Keychain okumasında **"Always Allow"** (Her Zaman İzin Ver) sorusu çıkar — onaylayın.

---

## Günlük kullanım

`ccswitch` çalıştırın (veya macOS/Windows'ta **"Claude Account Switcher"** başlatıcısını açın) ve numarayla hesap seçin:

```
        Claude Account Switcher (ccswitch)
  Active: alice@example.com

  → [1] alice@example.com
    [2] bob@example.org

  [number] switch   [a] save current   [d] delete   [r] refresh   [q] quit
```

Claude / Claude Code açıksa ccswitch önce **"Geçiş için Claude kapatılacak — devam edilsin mi?"** diye sorar. **Evet**'te Claude'u kapatır, geçer ve yeniden açar (macOS); **hayır**'da iptal eder, hiçbir şey değişmez.

### CLI

```bash
ccswitch                       # etkileşimli menü (↑/↓ + Enter)
ccswitch add [ad] [--app]      # girişli hesap(lar)ı kaydet — CLI + masaüstü uygulaması
ccswitch <ad|numara>           # o hesaba geç (Claude'u kapatmadan önce sorar)
ccswitch <ad> --restart        # ...sormadan Claude'u kapatıp yeniden açar
ccswitch <ad> --force          # ...Claude'u kapatmadan takas eder (kendiniz yeniden başlatın)
ccswitch next                  # sıradaki kayıtlı hesaba dön
ccswitch next --strategy best  # ...veya kalan kotaya göre seç (ayrıca: next-available)
ccswitch status                # her yüzey hangi hesapta (CLI + masaüstü uygulaması)
ccswitch list [--usage]        # hesaplar; --usage her hesabın 5s/7g kullanımını ekler
ccswitch autoswitch            # kullanımı izle; eşikte CLI hesabını otomatik değiştir
ccswitch link [ad|--remove]    # bu dizin ağacını `run` için bir hesaba eşle
ccswitch run <ad> [-- argümanlar]  # PARALEL oturum: o hesap YALNIZCA bu terminalde
ccswitch add <ad> --token <dosya|->   # ham kimlik bilgisini headless içe aktar
ccswitch mcp [--setup]         # agent'lar için stdio üzerinden MCP sunucusu
ccswitch install-skill         # agent'lara ccswitch'i öğreten Claude Code skill'ini kur
ccswitch export [dosya|-]      # hesapları dosyaya yedekle (SIR İÇERİR)
ccswitch import <dosya|->      # yedekten hesapları geri yükle (--force üzerine yazar)
ccswitch remove <ad|numara>    # kayıtlı hesabı sil
ccswitch clean [--logout]      # ccswitch verisini sıfırla; --logout her yerden çıkış da yapar
ccswitch upgrade               # ccswitch'in kendisini güncelle (kurulum yöntemini algılar)
```

Genel bayraklar: `--json` (makine-okunur stdout — tek JSON nesnesi, `schemaVersion: 1`,
insan metni stderr'e; script/status-line için ideal) ve `--debug` (ayrıntılı log).
`ccs` kısa takma ad olarak çalışır. Günde en fazla bir kez pasif "yeni sürüm var"
bildirimi görünür (asla bir komutu engellemez).

### Güvenilirlik garantileri

- Her değişiklik **süreçler-arası kilit** altında çalışır — iki ccswitch çağrısı
  bir geçişi asla iç içe geçiremez.
- Geçiş **işlemseldir**: canlı kimlik yazımı başarısız olursa hesap işaretçisi
  geri alınır; yarım kalmış geçiş durumu asla oluşmaz.
- Kayıtlı blob'lar geri yüklenmeden önce **doğrulanır**; bozuk profiller geri
  yüklenmek yerine temiz bir "yeniden ekle" mesajıyla reddedilir.
- Süresi dolmak üzere olan OAuth token'ları geçişte **otomatik yenilenir**
  (kimliğe canlı bir Claude oturumu sahipse atlanır; hatalar yüksek sesle uyarır).
- Kilitli macOS Keychain **"keychain kilitli"** olarak okunur ("kimlik yok" değil),
  5 sn zaman aşımıyla; profil deposu dosyalara düşerek çalışmaya devam eder.

### Kullanıma göre otomatik geçiş (`autoswitch`)

`ccswitch autoswitch --threshold 90 --interval 60 --strategy next-available`
aktif hesabı izler ve 5s/7g kullanımı eşiği aşınca **CLI kimliğini otomatik
olarak** seçilen hesaba takas eder — hiçbir şeyi kapatmadan (Claude Code yeni
hesabı bir sonraki isteğinde alır). Başlangıçta bir kez onay ister (`-y` ile
scriptlenebilir) ve masaüstü uygulamasına asla dokunmaz. `ccswitch link <ad>`
ile dizinleri hesaplara sabitleyin: adsız `ccswitch run`, en yakın bağlı üst
dizini kullanır.

### Agent'lar için: MCP sunucusu ve skill

Agent'lar CLI'ı tahmin etmek zorunda kalmasın — ccswitch **MCP** konuşur:

```bash
claude mcp add ccswitch -- ccswitch mcp     # veya: ccswitch mcp --setup
```

Araçlar: `ccswitch_status`, `ccswitch_list` (`include_usage` ile),
`ccswitch_switch`, `ccswitch_next` — düzgün JSON Şemaları, salt-okunur/yıkıcı
anotasyonları; **değiştiren araçlar `confirm: true` ister** ve açıklamaları
agent'a önce kullanıcıya sormasını söyler. MCP üzerinden geçiş her zaman
yerinde yapılır (uygulamayı kullanıcının altından asla kapatmaz).

Agent'a tüm bunları ne zaman ve nasıl kullanacağını öğreten paketli bir
**Claude Code skill'i** de var (rate-limit playbook'u, durum kodları, paralel
oturumlar):

```bash
ccswitch install-skill      # ~/.claude/skills/ccswitch dizinine kopyalar
```

### Paralel oturumlar (`run`)

`ccswitch run <ad>` Claude Code'u o hesapla **yalnızca geçerli terminalde**
başlatır — diğer tüm terminaller, masaüstü uygulaması ve VS Code mevcut
hesabında kalır; iki hesap yan yana çalışabilir. `~/.claude`
özelleştirmeleriniz (settings, keybindings, CLAUDE.md, skills, commands,
agents) symlink'lerle sizinle gelir (`--no-share` = çıplak profil); konuşma
geçmişi hesap-başına kalır (`--share-history` ile paylaşılabilir). `--`
sonrası her şey `claude`'a iletilir (ör. `ccswitch run is -- --resume`).
Oturum token'ı yenilerse ccswitch çıkışta profile geri kaydeder.

> ⚠️ **Önce onay ister** (`-y` ile atlanır): paralel oturumdaki bir token
> yenilemesi o hesabın refresh token'ını döndürür ve *aynı hesabın diğer canlı
> kopyalarını* düşürebilir.

### Headless içe aktarma (`add --token`)

`ccswitch add <ad> --token <dosya|->`, ham bir kimlik JSON blob'unu
(`{"claudeAiOauth":{...}}`) giriş akışı olmadan hesap olarak kaydeder — CI
veya makine hazırlama için. Blob **dosyadan veya stdin'den okunur, asla
argv'den değil**. TTY'de onay ister; pipe'lı/scriptli kullanım `--force`
geçmelidir ve mevcut bir hesabın üzerine yazmak her zaman `--force` ister.

### VS Code

VS Code Claude Code eklentisi CLI'ın kimlik deposunu paylaşır; yani her
ccswitch geçişi ona da uygulanır (almak için pencereyi yenileyin).
[`vscode-ccswitch/`](vscode-ccswitch/) içindeki ince eklenti, status bar'a
hesap göstergesi ve QuickPick geçiş ekler — yerel kurulum için README'sine bakın.

### Geçişten sonra tüm oturumlarınızı görmek (macOS)

Claude **masaüstü uygulaması** "Recents" listesini hesap-başına bir dizinde tutar:
`~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/` —
bu yüzden her hesap varsayılan olarak yalnızca kendi altında açtığınız Code
oturumlarını gösterir.

ccswitch her geçişte (uygulama kapalıyken) bu dizini **birleştirir** — diğer
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
bir önbellektir). ccswitch bu yüzden **ikisini de** yakalar ve takas eder —
her hesabın masaüstü girişi bir kez yakalandıktan sonra `ccswitch <ad>` hem
CLI'ı hem masaüstü uygulamasını aynı hesaba çevirir.

Masaüstü girişi CLI'dan **bağımsızdır** — aynı anda farklı hesaplarda bile
olabilirler. `ccswitch add` **o an girişli ne varsa** yakalar: CLI girişi
ve/veya masaüstününki (otomatik algılanır). Hesap başına: giriş yapın
(uygulama ve/veya CLI), `ccswitch add` çalıştırın, bitti. `ccswitch list` her
hesapta nelerin yakalandığını gösterir (`[cli ✓|— | app ✓|—]`); uygulamanın
hesabı otomatik tanınamazsa adını siz verin (`ccswitch add <ad> --app`).

Sonrasında `ccswitch <ad>` (uygulama kapatılıp yeniden açılarak) CLI kimliğini
**ve** masaüstü girişini (token + oturum çerezi) takas eder — elle yeniden
giriş yok. `config.json` ve çerez veritabanı önce yedeklenir
(`~/.config/ccswitch/backups/`).

> Deneysel: uygulama kapalıyken `config.json` girişini yeniden yazar. Kayıtlı
> token tamamen süresi dolmuşsa uygulama yeniden giriş isteyebilir; o hesabı
> yeniden `add` edin. Bir şey ters görünürse yedeği geri yükleyin.

> Geçiş Claude kapalıyken yapılmalıdır; yoksa Claude çıkarken değişikliğin
> üzerine yazabilir.
> - **Etkileşimli** (menü veya terminalde `ccswitch <ad>`): Claude açıksa
>   **kapatılmadan önce sorulur** — *hayır* derseniz iptal edilir.
> - `--restart`: sormadan kapatıp yeniden açar (macOS).
> - `--force`: kapatmadan geçer — sonrasında Claude'u kendiniz yeniden başlatın.
> - Etkileşimsiz (pipe/CI) ve Claude açıkken bayraksız: uygulamanızı beklenmedik
>   şekilde kapatmak yerine reddeder.

---

## Nasıl çalışır

| Parça | macOS | Linux / Windows |
|------|-------|-----------------|
| Canlı giriş token'ı | Keychain kaydı `Claude Code-credentials` | `~/.claude/.credentials.json` |
| Kayıtlı profil token'ları | Keychain kayıtları `ccswitch:<ad>` | `~/.config/ccswitch/creds/<ad>.cred` (0600) |
| Hesap kimliği | `~/.claude.json` içinde `oauthAccount` + `userID` | aynı |
| Profil metadata'sı (sır içermez) | `~/.config/ccswitch/<ad>.json` (0600) | aynı |

Arka uç otomatik algılanır: bir kimlik **dosyası** zaten varsa o kullanılır
(her OS); yoksa macOS Keychain kullanır. Geçiş, kayıtlı token'ı canlı yuvaya
kopyalar **ve** `~/.claude.json`'daki iki alanı günceller. *Ayrılırken*
ccswitch önce mevcut hesabın (muhtemelen yenilenmiş) token'ını yeniden kaydeder
— hiç kaydetmediğiniz girişli bir hesabı bile otomatik kaydeder, token'ı kaybolmaz.

### Güvenlik notları

- **Yapılandırma bütünlüğü:** `~/.claude.json` yazımları atomiktir ve dosya
  modunu korur; dosya var ama geçerli JSON değilse ccswitch ayarlarınızı ezme
  riskine girmek yerine dokunmayı reddeder.
- **macOS Keychain:** token'lar `security -i`'ye **stdin** üzerinden (hex
  kodlu) verilerek yazılır; sır asla süreç tablosunda görünmez;
  `/usr/bin/security` mutlak yolla çağrılır. (Yalnızca stdin satır bütçesine
  sığmayan bloblar argv yazımına düşer.)
- **Dışa aktarmalar:** `ccswitch export` dosyaları giriş sırları içerir —
  `0600` ile ve yüksek sesli uyarıyla yazılırlar; taşıma için `-` ile stdout'a
  verip şifreleyin (ör. gpg), içe aktardıktan sonra silin.
- Geçişi Claude kapalıyken yapın. macOS uygulaması/`--restart` sizin yerinize
  kapatıp açar; diğerlerinde Claude çalışıyorsa ccswitch uyarır ve geçişten
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
  yapıp `ccswitch add` çalıştırın.
- **"keychain kilitli":** login keychain'in kilidini açın; ccswitch'in kendi
  profil deposu otomatik olarak dosyalara düşer, çalışmaya devam edersiniz.

---

## Kaldırma

```bash
./uninstall.sh            # macOS/Linux: CLI + uygulamayı kaldır, kayıtlı profilleri tut
./uninstall.sh --purge    # kayıtlı profilleri de sil
npm uninstall -g ccswitch # npm ile kurulduysa (her OS)
```

---

## Lisans

[MIT](LICENSE)

---

*Anthropic ile bağlantılı değildir. "Claude" ve "Claude Code", Anthropic'in ticari markalarıdır.*
