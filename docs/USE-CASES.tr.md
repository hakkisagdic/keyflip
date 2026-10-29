# keyflip — Eksiksiz Kullanım Senaryosu Kataloğu

> keyflip'in **her** iş akışının ve varyasyonunun kapsamlı, kendi kendine yeten
> turu. NotebookLM'e (veya herhangi bir belge aracına) anlatım videosu kaynağı olarak
> bırakılmak üzere yazıldı. İngilizce aynası: [`USE-CASES.md`](./USE-CASES.md).

---

## 0. Zihinsel model (önce bunu oku)

keyflip, tek makinede birden çok Anthropic / Claude hesabını yönetir. İyi kullanmak
için dört fikri aklında tut:

**Dört giriş yüzeyi.** Bir "hesap" dört bağımsız yüzeyde açık olabilir; keyflip'in işi
hepsini aynı hesaba bakar tutmaktır:

| Yüzey | Girişin durduğu yer | Not |
|---|---|---|
| **CLI** (Claude Code) | macOS Keychain `Claude Code-credentials`, yoksa `~/.claude/.credentials.json` | Çoğu geçişin dokunduğu yer. |
| **Masaüstü** (Claude.app) | uygulamanın kendi token + oturum çerezi (makineye bağlı safeStorage) | İsteğe bağlı; ayrı yakalanır. |
| **Tarayıcı** (claude.ai) | tarayıcının çerezleri | **Claude Chrome uzantısının kendi girişi yoktur** — bunu miras alır. |
| **Uzantı köprüsü** | native-messaging host | Tarayıcı hesabı ≠ CLI/masaüstü hesabıysa bağlanmayı reddeder ("user mismatch"). |

**Hesaplar vs. sağlayıcılar (provider).** **Hesap** bir OAuth aboneliğidir
(Pro/Max/Team). **Sağlayıcı** ise farklı bir *API uç noktasıdır* (relay, gateway,
Bedrock, OpenRouter, özel base URL); keyflip bunu `settings.json`'ı yamalayarak Claude
Code'a gösterir. Hesap değiştirmek *kimin faturalandığını* değiştirir; sağlayıcı
değiştirmek *isteklerin nereye gittiğini*.

**Oturumlar hesaptan bağımsızdır.** Sohbet transkriptleri `~/.claude/projects`
altında yaşar ve hiçbir hesaba ait değildir — saklaması, taşıması ve birleştirmesi her
zaman güvenlidir.

**keyflip'in daima uyduğu güvenlik kuralları.** Onay olmadan asla geçiş/çıkış/silme
yapmaz; sırlar yalnız OS kimlik deposuna gider, asla komut satırına yazılmaz;
mutasyonlar sıralı ve işlemseldir (transactional); `--json` makine-okunur çıktı verir.

---

## 1. İlk çalıştırma — hesaplarını yakalamak

Yalnızca keyflip'in *yakaladığı* hesaplar arasında geçiş yapabilirsin. Yakalamak, canlı
bir girişi okuyup saklamaktır. Sana uyan yolu seç:

### 1.1 Tam rehberli kurulum — `keyflip onboard`
**Amaç:** birkaç hesabı sıfırdan, mümkün olduğunca elini değdirmeden kurmak.
```bash
keyflip onboard              # her hesap için: giriş → yakala (CLI + tarayıcı) →
                             # canlı CLI'yi ona yönlendir → istersen masaüstünü de yakala
                             # → sohbetleri eşitle → "başka? " → tekrarla
keyflip onboard --manual     # aynısı, ama kod/URL yapıştırarak (örn. e-posta kodlu giriş)
```
- Hesaplar arasında tarayıcıyı öncekinden çıkış yaptırır; böylece 2. hesap temiz bir
  giriş olur (Enter'a basmak ilkinden çıkış yapar).
- Etkileşimli (TTY gerekir). Normal bir terminalde çalıştır, tercihen masaüstü
  uygulamasının kendi terminalinde **değil**.
- **Varyasyon:** sorulunca `s` yazarak masaüstü yakalamayı atla (yalnız CLI kullanıyorsan).

### 1.2 Daha hafif sihirbaz — `keyflip setup`
**Amaç:** mevcut girişi yakala, sonra her yeni girişi otomatik algıla.
```bash
keyflip setup                # şimdi yakalar; sonra /logout→/login (veya masaüstü) izler
                             # ve her yeni hesabı sen `d` yazana dek kaydeder
```

### 1.3 Şu an açık olanı yakala — `keyflip add`
**Amaç:** *mevcut* girişi tek seferde, betiklenebilir şekilde yakalamak.
```bash
keyflip add                  # şu an açık hesabı/hesapları kaydet: CLI + masaüstü
keyflip add work             # ...ismini "work" koyarak
keyflip add work --app       # yalnız MASAÜSTÜ uygulaması girişini yakala
keyflip add work --token creds.json    # dosyadan ham kimlik içe aktar
some-cmd | keyflip add work --token -   # ...veya stdin'den (sır asla argv'de değil)
```

### 1.4 Resmî tarayıcı girişi, izole — `keyflip login`
**Amaç:** mevcut girişini bozmadan, sıfırdan giriş yaparak hesap eklemek.
```bash
keyflip login                        # izole bir dizinde resmî `claude auth login`
keyflip login work --email a@b.com   # e-postayı önceden doldur
keyflip login --fresh                # önce tarayıcının claude.ai'ını temizle (uyumsuzluğu önle)
keyflip login --manual               # kodu/URL'yi kendin yapıştır (e-posta kodu, SSO)
```
- Tek insan adımı: açılan tarayıcıda onaylamak.
- **Dikkat:** OAuth tarayıcının mevcut claude.ai oturumunu kullanır. Tarayıcı *başka*
  bir hesaptaysa keyflip ONU yakalar ve uyarır. `--fresh` veya önce
  `keyflip browser logout` ile çöz.

---

## 2. Durumu görmek (her zaman güvenli, onay gerekmez)

```bash
keyflip status               # her yüzeyin hangi hesapta olduğu (CLI + masaüstü)
keyflip status --json        # {"cli":{"email":…},"app":{"name":…,"email":…}}
keyflip list                 # tüm yakalı hesaplar, her yüzeyde hangisi aktif
keyflip list --usage         # + her hesabın 5s / 7g kota kullanımı
keyflip list --usage --json  # makine-okunur kullanım + headroomPct + usageStatus
keyflip doctor               # yapılandırma + giriş + uç nokta erişilebilirliği + gerçek masaüstü giriş kontrolü
                             # + her arka plan servisi: kurulu / tutuluyor / son çıktı
```
- `list` bir **web** sütunu ve tarayıcı/uzantı alt bilgisi gösterir, uyumsuzlukta uyarır.
- `doctor`'daki **desktop app session** kontrolü uygulamanın kendi çerez veritabanını okur;
  claude.ai'nin artık kabul etmediği bir yakalama sağlıklı görünmek yerine rapor edilir.
  `list` uygulamanın yanına `(signed out on disk…)` yazar, `list --json` ise
  `appSessionLive` / `appSessionExpires` alanlarını taşır.
- `usageStatus` sabitleri: `ok`, `expired` (hesabı yeniden `add`'le), `throttled`
  (**bilinmiyor**, rate-limit kanıtı değil), `error`, `no-creds`/`no-token`.

### Arkada gerçekten çalışan bir şey var mı?

keyflip zamanlayıcıya dört iş koyabiliyor; `keyflip doctor` her birini üç ayrı bilgi olarak
raporlar — dosya kurulu mu, sistem onu tutuyor mu, son çıktısını ne zaman verdi:

```bash
keyflip doctor
#   ✓ background services — 2 of 4 scheduled — dream: off · refresh: nightly at 04:30 ·
#     spoke 9 h ago · daemon: off · conv: every 30 min · spoke 13 min ago

keyflip doctor --json        # her iş bir satır: installed, loaded, lastRun, cadenceMs, does, install
keyflip refresh --schedule-status    # iş bazında: launchd/cron, tutuluyor mu, son çıktı, log yolu
keyflip conv index --schedule-status
keyflip dream status
```

Fiş (receipt) yalnızca söz verildiğini kanıtlar; uyarılar söz ile kanıt arasındaki boşluğa
yanar: launchd'in hiç almadığı bir plist, kurulumundaki aralığın iki katından uzun süredir
sessiz bir iş, ve günlerce tazeleyen bir şey olmayan sohbet indeksi. `--json` içindeki
`loaded: null`, doctor'ın sisteme sormadığı anlamına gelir (koşucu yok) — "çalışmıyor" demek
asla değildir.

---

## 3. Hesap değiştirmek (onay gerekir — faturalandırmayı değiştirir)

```bash
keyflip work                 # "work"a geç (Claude'u kapatmadan önce sorar)
keyflip 2                    # liste numarasıyla geç
keyflip work --force         # yerinde takas; çalışan Claude Code bir sonraki istekte alır
keyflip work --restart       # masaüstü uygulamasını da kapat & yeniden aç (tam geçiş)
keyflip work --browser       # tarayıcıyı + Chrome uzantısını da bu hesaba HİZALA
keyflip next                 # bir sonraki kayıtlı hesaba dön
keyflip next --strategy best            # en çok kotası olanı seç
keyflip next --strategy next-available  # tükenmemiş ilk hesap
```
- **Canlı bir Claude Code sohbetinde:** `--force` tercih et — oturum hiçbir şey
  kapatmadan yeni hesapta devam eder.
- **`--browser`** o hesabın kayıtlı tarayıcı oturumunu geri yükler (onboard/login
  sırasında yakalanan), tarayıcıyı kapatıp açar ki uzantı yeniden bağlansın.
- Her geçiş sohbetleri de hesaplar arası eşitler (masaüstü açıksa ertelenir).
- **`--restart` sonrası keyflip doğrular:** birkaç saniye bekler ve masaüstü uygulamasının
  çerez veritabanını yeniden okur. Claude giriş ekranıyla açıldıysa (claude.ai kayıtlı oturumu
  döndürmüş ya da iptal etmiştir) temiz bir geçiş bildirmez, uyarır. Çözüm: uygulamada bir kez
  giriş yapıp `keyflip add <ad>` çalıştırmak — o çerezi otomatik hiçbir şey üretemez.

---

## 4. Rate limit / kota tavanına takılmak

```bash
keyflip list --usage --json                 # 1) headroomPct > 0 olan adayları bul
keyflip work --force                         # 2) onaydan sonra taze bir hesaba geç
keyflip next --strategy best                 # ...veya en iyisini keyflip seçsin
keyflip autoswitch --threshold 90 -y         # uzun gözetimsiz koşular: CLI kimliğini %90'da
                                             #   otomatik döndür (uygulamaya dokunmaz)
```
- `autoswitch` **devre kesicisi** açık (sürekli başarısız) hesapları atlar ve her
  yük devretmeyi kaydeder.
- İstek düzeyinde yük devretme (istek ortası 429/5xx) için proxy'ye bak (§10).

---

## 5. Tarayıcı & Claude Chrome uzantısı (macOS)

Uzantı tarayıcının claude.ai oturumunu miras alır; uyumsuzluk onu engeller.
```bash
keyflip browser status               # tarayıcının claude.ai hesabı + uyumsuzluk bayrağı
keyflip browser logout               # claude.ai oturumunu temizle (geri alınabilir; önce tarayıcıyı kapat)
keyflip browser capture work         # tarayıcının claude.ai oturumunu bir HESABA kaydet
keyflip browser sync                 # AKTİF hesabın kayıtlı tarayıcı oturumunu geri yükle
keyflip browser sync work            # ...belirli bir hesabın oturumunu geri yükle
keyflip browser status --browser brave   # tek tarayıcı hedefle (chrome|brave|edge|arc)
```
- Oturumlar, tarayıcı o hesapken `onboard`/`login` sırasında otomatik yakalanır;
  `browser capture <hesap>` istediğin zaman yapar, `browser sync` ve `<ad> --browser`
  geri oynatır. Capture, claude.ai'da *başka* hesapla girişli bir tarayıcıyı reddeder —
  o çerezleri yanlış adın altına koymamak için.
- Burada kaydedilen, `keyflip chat --as <hesap>`ın okuduğu şeydir: yakalanmış bir tarayıcı
  oturumu, o hesabın bulut Chat geçmişini ona geçmeden okunur kılar.

---

## 6. Sağlayıcılar — 3. taraf uç noktalar (relay, gateway, Bedrock, OpenRouter)

OAuth aboneliği yerine özel base URL / API anahtarı istediğinde kullan.
```bash
keyflip provider add relay --base-url https://relay.example --key-file key.txt
cat key.txt | keyflip provider add relay --base-url https://relay.example --key-file -
keyflip provider add relay --base-url … --auth-scheme api-key --model haiku=claude-haiku-4-5
keyflip use relay            # Claude Code'u ona yönlendir (yeniden başlatma yok — ayar sıcak yüklenir)
keyflip provider off         # OAuth aboneliğine geri dön
keyflip provider list        # hangi sağlayıcılar var / hangisi aktif
keyflip speedtest relay      # sağlayıcının aday uç noktalarından en hızlısını seç
keyflip test relay           # bir gerçek istek → auth ok mu? (auth/ağ/4xx/5xx)
keyflip gateway use relay     # MASAÜSTÜ uygulamasını bir sağlayıcı üstünden yönlendir (uygulamayı yeniden başlat)
keyflip gateway off | status
```
- Sağlayıcı değiştirmek OAuth hesabını **değiştirmez**; `provider off` geri getirir.
- Anahtarı asla argv'ye koyma — daima `--key-file <dosya|->`.

---

## 7. İkinci hesabı paralel çalıştırmak (tek terminal)

```bash
keyflip run work -y -- --resume         # Claude Code'u YALNIZ bu terminalde "work" olarak çalıştır
keyflip run work --share-history -y     # ...sohbet geçmişini de paylaşarak
keyflip run work --no-share             # geçmişi de izole et
keyflip link work                       # BU dizin ağacını "work"a eşle;
keyflip run                             #   sonra buradaki düz `run` onu kullanır
keyflip link --remove                   # eşlemeyi kaldır
```
- `CLAUDE_CONFIG_DIR` ile izole eder; diğer terminaller ve masaüstü kendi hesabında
  kalır. **Uyarı:** oturum içi token yenileme, aynı hesabın diğer canlı kopyalarını
  çıkış yaptırabilir.

---

## 8. Geçmiş sohbetleri bulmak & sürdürmek (yerel, hesaptan bağımsız)

```bash
keyflip sessions                       # tüm Claude Code sohbetlerini listele, tüm hesaplar
keyflip sessions --search "oauth"      # transkriptlerde ara
keyflip sessions --here                # yalnız bu dizinde başlayan oturumlar
keyflip resume 3                       # liste 3 için sürdürme komutunu yazdır
keyflip resume <id> --run              # orijinal dizininde `claude --resume <id>` başlat
keyflip cowork                         # Claude masaüstü Cowork oturumlarına göz at (tüm hesaplar)
keyflip cowork --search T | --all
keyflip chat                           # claude.ai bulut Sohbetlerini listele (DENEYSEL)
keyflip chat get <kısa-id|başlık>      # bir sohbeti oku (listelemedeki kısa id yeterli)
keyflip chat search "<sözcükler>"      # başlıkla bul
keyflip chat --as <hesap>              # BAŞKA kayıtlı hesabı oku, geçiş yapmadan
keyflip foreign --list                 # bu makinedeki DİĞER ajanların oturum dosyalarını bul
keyflip foreign <dosya> [--format md|html|json]   # birini aynı görünüme normalize et
```
- `resume` proje kapsamlıdır — transkriptin orijinal dizinine `cd`'yi kendisi halleder.
- `chat`, bir claude.ai oturum çerezini kullanır ve çerezi kendisi bulur; her sonuçta
  nereden okunduğu yazar: uygulamanın çerezi, yoksa claude.ai'a girişli bir tarayıcı
  (güncel sürümler `sessionKey`'i yalnız bellekte tutar), o da yoksa hesabın kayıtlı
  anlık kopyası. Taze bir Cloudflare doğrulaması gerekir: 403 bayatlık demek (çıkış
  yapıldığı değil) — `keyflip chat --flush` uygulamayı bir kez kapatıp açar ve tekrar
  dener. `--as <hesap>`, o hesabın kayıtlı tarayıcı oturumunu okur
  (`keyflip browser capture <hesap>` onu kaydeder; `browser sync` tarayıcıya geri yazar —
  ters yöndedirler; keyflip uzaklaştığı hesabın uygulama girişini de tazeler) — çerezler
  yalnızca yakalandıkları makine+tarayıcıda çözülür.
  Yalnız başlıklar — içerik: `keyflip recall`.
- `conv`, Cursor'ü yerel olarak okur — editörün `state.vscdb`'si (DB dosyası başına değil,
  composer başına bir sohbet), `cursor-agent` CLI deposu ve `agent-transcripts` aynası — `foreign`
  ise doğrudan gösterdiğiniz bir Cursor SQLite DB'sini hâlâ normalize eder (yanındaki `-wal` önce
  oynatılır ki içindeki yeni sohbetler kaçmasın; WAL vardır ama içeri alınamıyorsa bunu söyler).
  `foreign` ayrıca opencode / Gemini / **Qoder CLI** JSONL ve Copilot YAML okur;
  doğrudan gösterdiğiniz bir dosya düz JSON ya da Aider'ın `.aider.chat.history.md` dosyası da
  olabilir. Keşif yeniden-eskiye sıralıdır ve araç başına bir dosya kotası taşır, böylece
  çok dosyası olan bir araç diğerlerini ezmez; aracın oturum olmayan klasörleri (`log/`,
  `snapshot/`, `tool-output/`, Qoder'ın `subagents/`) atlanır — tıpkı kimlik/sır görünümlü
  dosyalar (`auth.json`, `credentials.json`, `oauth*.json`) gibi: keyflip canlı bir token'ı
  asla sohbet olarak çizmez. Tanımadığı bir biçim boş sohbet değil, hatadır.

---

## 9. Sohbetleri hesaplar arasında eşitlemek

`consolidate`, masaüstü uygulamasının **dizinlerini** eşitler. Tek bir *iş* için ulaşılabilir bir nesne
yapmaz — kota görevin ortasında tükenince bozulan şey tam olarak budur:

```bash
keyflip consolidate                    # her hesabın sohbet dizini TÜM sohbetleri gösterir
keyflip consolidate --watch            # uygulama kapalıyken periyodik olarak yeniden eşitle
keyflip consolidate --watch --interval 60
```
- Uygulama çalışırken deposu kilitli olur; tek atış modu kapat→eşitle→aç önerir
  (`-y` ile soruyu atla). Her geçişte de otomatik çalışır.
- Birleşim, Claude Desktop'ın Recents ve Cowork depolarını temel uygulamada **ve çalışmayan her
  instance kopyasında** kapsar (`~/.keyflip-instances/<araç>/<slug>/User Data/`); bir kopyada
  açılan sohbet hepsinde görünür. `instance.pid`'i canlı kopya atlanır ve sonuçta adıyla bildirilir;
  `--no-instances` yalnızca temel uygulamayla sınırlar.
- İki hesap farklı transcript'ler için aynı `local_*.json` adını meşru olarak kullanabilir; keyflip
  birini sessizce düşürmek yerine `local_<cliSessionId>.json` adına (gerçek çakışmada sayı ekiyle)
  geri düşer.
- Yalnızca UUID adlı klasörler hesap sayılır; uygulamanın kendi defteri
  (`skills-plugin/<org>/<hesap>/`, aynı düzende) ne okunur ne yazılır — önceden bir consolidate
  geçişi içine pointer dağıtırdı. Bir hesapta kullanıcının sildiği sohbet (uygulama dizinin yanına
  `deleted_<id>` bırakır) başka hesabın klasöründen geri kopyalanmaz. `keyflip cowork` eşitlenmiş
  sohbeti bir kez listeler: veri klasörü hâlâ yanında duran kopya, o yoksa en son aktif olan.

### 9.1 Hesaplar arası tek adlandırılmış görev — `keyflip threads`

Senaryo: gmail üzerinde görevin ortasındasın, 5 saatlik tavan dolar, yahoo'ya geçersin ve Claude Code
aynı projede **yeni** bir oturum açar. İki oturum, üstine işi planladığın bir claude.ai sohbeti.
Hiçbir şey kaybolmaz, ama hiçbir şey senin *tek nesnen* de değildir — `keyflip chat` diğer hesaba parça
parça erişir, `keyflip sessions --search` ise görev değil satır döndürür.

```bash
keyflip threads suggest                  # ZATEN 2+ adlandırılmış hesaba bölünmüş iş, proje klasörü başına
keyflip threads create fatura --title "Fatura akışı" --session 1a2b3c4d
keyflip threads add fatura 9f8e7d6c --account yahoo   # önek yeterli; keyflip TAM id'yi yazar
keyflip threads add fatura 3b0c…e1a4 --chat            # bir claude.ai sohbeti de üye olabilir
keyflip threads show fatura              # üyeler + birleşik görünüm
keyflip threads show fatura --timeline    # yalnız kronolojik turlar, kimin hangi hesapta söylediğiyle
keyflip threads show fatura --md         # birleşik belge, basılır — hiçbir şey yazılmaz
keyflip threads open fatura               # işin son durduğu yer, ona sahip hesabın kimliğiyle sürdür
keyflip threads where 1a2b3c4d            # bu oturumu hangi thread'ler içeriyor (tersten arama)
keyflip threads remove fatura 9f8e7d6c    # tek üyeyi ayır; oturumun kendisi yerinde kalır
keyflip threads drop fatura -y            # adı UNUT — her transkript ve her atama sağ çıkar
```

- **Bu bir kap değil, bir ad.** `~/.config/keyflip/threads/fatura.json` yalnız `{kind, id, account,
  project, addedAt}` listeler, düzyazı taşımaz. Transkriptler asla yer değiştirmez, yani aynı oturum iki
  hesabın listesinde birden meşru biçimde durur — amaç bu, hata değil — ve thread'i düşürmek bir mesajı
  kaybedemez.
- **`suggest`, "işim nerede bölündü?" sorusunu sen sayıp dökmeden yanıtlar.** Bir klasörde **iki veya
  daha fazla adlandırılmış hesap** arar; bir hesap artı atanmamış oturum içeren klasör raporlanmaz
  (onları `keyflip sessions assign <id> <hesap>` ile ata) ve bir thread'in adlandırdığı şeyler düşürülür
  — görevleri adlandırdıkça liste küçülür.
- **Birleşik görünüm sınırlarında dürüsttür.** Her tur üyesini ve hesabını taşır; tarihsiz turlar iki
  kararın arasına sıkıştırılmak yerine başta grup olarak kalır; bir bulut sohbeti offline tur katkısı
  yapamaz ve `unavailable` altında, okuyacak `keyflip chat get …` komutuyla listelenir; `threads.mergeMaxMiB`
  (varsayılan 8 — buradaki transkriptler 24 MB'a çıkıyor) eşiklerini aşan üye sessizce
  kısa sayılmaz, kesilmiş diye sayılır.
- **Diskte sohbet metni senin tercihindir ve çift kapılıdır.** `keyflip threads mirror fatura`,
  `thread-mirror/fatura.md` dosyasını yalnız `keyflip config set threads.mirror true` sonrasında yazar; o
  dizin kayıtlı bir sır dizinidir (0600, asla versiyonlanmaz, yedeklenmez, senkronlanmaz) ve ayna, durum
  reposunda bir git remote varsa tamamen reddeder. Onu açana kadar aynı belgeyi ekranda görmek istersen
  `--md` hiçbir şey yazmaz.
- **Bir thread, bu makinede olmayan işi adlandırabilir ve bunu söyler.** Üye okuma anında çözümlenir:
  transkripti burada olmayan bir oturum sessizce düşürülmek yerine `resolved: false` ve
  `no transcript on this machine (last seen in <proje>)` gerekçesiyle döner. **Ne taşınır:** `threads/`
  sıradan versiyonlanmış durumdur ve `keyflip backup` onu taşır; `keyflip migrate` / `sync` paketleri ise
  küratörlü hesap verisidir — ayna düzyazısını içermezler, thread pointer'ları da arkalarından gitmez,
  yani bir thread kendine ad veren makinede kalır.
- Agent'lar bunun tamamını MCP üzerinden yapar: salt-okunur `keyflip_threads` (`slug`, `timeline`,
  `suggest`, tersten `id`) ve `confirm` isteyen `keyflip_thread_create|add|remove|drop|mirror`.

---

## 10. İstek düzeyinde yük devretme proxy'si (istek üzerine başlar, asla daemon değil)

```bash
keyflip proxy start --wire             # localhost proxy başlat + Claude Code'u ona bağla
keyflip proxy status                   # açık mı? hangi portta? hesap başına toplamlar
keyflip proxy stats                    # istek, token, cache okuma/yazma, ~liste fiyatı harcaması
keyflip proxy stop                     # durdur ve settings.json bağını çöz
keyflip tier                           # her hesabın planı + bir modelin ona yönlendirilip yönlendirilemeyeceği
keyflip cost rates [model]             # ücret kartı: cache kademeleri, 200K primi, hızlı mod
keyflip cost prices [--refresh]        # hangi fiyat tablosu kullanılıyor; herkese açık listeden tazele
```
- Açıkken her isteği aktif hesaba yönlendirir ve istemci bir bayt görmeden **429/5xx'te
  bir sonraki sağlıklı hesaba yük devreder.** İstek ortası limitlerin olası olduğu uzun
  gözetimsiz koşular için ideal.
- İsteğe bağlı istek bazında yönlendirme: `~/.config/keyflip/proxy-routes.json` (bir
  sonraki istekte yeniden okunur): model/yol/başlık/token boyutuna göre ilk-eşleşen
  kurallar, sticky sohbetler, `fallback: off|retry|model-chain`, başlık/gövde transform'ları
  ve özel router betiği. Kural yalnız o an kullanılabilir bir hesabı adlandırabilir;
  geçersiz dosya yok sayılır ve her sorun adıyla gösterilir.

```bash
keyflip proxy routes [init]            # yönlendirme dosyası, hataları ve politika
keyflip proxy explain --model claude-opus-4 --tokens 200000   # nereye gider, neden?
```
- **Plana duyarlı.** Her hesabın abonelik planı yakalanan girişten okunur; Free bir hesap
  Opus sınıfında atlanır, Sonnet/Haiku yine yönlenir. Yalnız **bilinen ve düşük** plan
  engeller (bilinmeyen plan, Claude olmayan model ve sağlayıcı modu serbesttir); her hesap
  reddederse proxy hiçbir şey göndermeden 503 döner. `keyflip tier <hesap> <plan|auto>`
  override'ı sabitler/siler; `proxy.tierFilter=false` filtreyi kapatır.
- **Harcama istek bazında fiyatlanır.** `proxy stats` cache okuma/yazmasını ve tahmini
  liste fiyatı maliyetini ekler (cache okuma 0.1×, 5 dk yazım 1.25×, 1 sa yazım 2×, 200K'yı
  geçen prompt tümüyle 2× giriş / 1.5× çıkış, hızlı mod 6×); `keyflip cost rates` kartı
  yazar. Tarihli bir anlık görüntüden tahmin — fatura değil.
- **Fiyat tablosu kendini tazeler.** `keyflip cost prices --refresh` herkese açık fiyat
  listesini çeker, Claude satırlarını ayırır, doğrular ve önbelleğe alır; sonraki tüm
  tahminler yeni fiyatlarla hesaplanırken paketlenmiş anlık görüntü taban olarak kalır.
  Ağa yalnız `--refresh` dokunur, bozuk önbellek bütünüyle yok sayılır ve sha-256 pin'i
  (`cost.pricesSha256`, `--pin`) tutmayan bir yenilemeyi reddeder — keyflip az önce
  çektiğini kendisi asla pinlemez. Canlı bir satır ücreti yükseltebilir ya da paketlenmiş
  tabloda hiç olmayan bir modeli ekleyebilir, ama ücreti paketlenmiş anlık görüntünün altına
  düşüremez.

---

## 11. Yedekleme & geri yükleme (keyflip'in kendi meta verisi; sır yok)

```bash
keyflip backup now                     # keyflip meta verisini anlık yedekle (hesap listesi, ayar)
keyflip backup list
keyflip backup restore 1               # numara/isimle geri yükle (önce güvenlik yedeği alır)
keyflip backup prune 5                 # yalnız en yeni 5'i tut
```

---

## 12. Başka makineye taşımak (hesaplar + sohbetler)

Dört taşıma yolu, aynı şifreli paket. Neyin varsa ona göre seç:

### 12.1 Dosyayla — `keyflip migrate`
```bash
keyflip migrate export bundle.json --passphrase-file pass.txt   # TÜM hesap +
                                     # sağlayıcı + her oturum transkripti, şifreli
keyflip migrate import bundle.json --passphrase-file pass.txt   # yeni makinede BİRLEŞTİR
keyflip migrate import bundle.json --force                      # ...mevcutların üstüne yaz
keyflip migrate export bundle.json --no-sessions --no-providers # yalnız hesaplar
```
- **BİRLEŞTİR = birleşim (union):** hedefte zaten olan hiçbir şey **ezilmez, korunur**;
  `--force` hariç. Böylece oradaki oturumlarla birleşir.
- **Paket akış (stream) hâlindedir; büyük geçmiş belleğe sığmak zorunda değildir.** Export bir kayıt
  akışı yazar (`KEYFLIP-MIGRATE-STREAM/2`): önce küçük metadata katmanı, sonra her transkript
  128 KiB'lik parçalar halinde; import satır satır okur ve her oturumu ancak bildirilen bayt sayısı
  tuttuğunda yeniden adlandırır. `--passphrase-file` ile her kayıt ayrı ayrı AES-256-GCM ile
  mühürlenir ve bir öncekine zincirlenir; kurcalanmış, sırası değişmiş veya kesilmiş paket reddedilir.
  Ölçülen tepe RSS: 2 GB (4 oturumlu) şifreli sette ~300 MB. Eski tek-string paketler 256 MB'ın
  altında hâlâ içe aktarılır; üstünde kaynak makinede güncel keyflip ile yeniden dışa aktarın.

### 12.2 Bulut relay ile (LAN yok) — WebDAV
```bash
keyflip migrate push --url https://dav.example/kf.enc --passphrase-file pass.txt   # kaynak
keyflip migrate pull --url https://dav.example/kf.enc --passphrase-file pass.txt   # hedef (önizler + birleştirir)
```
`push`/`pull` paketi hâlâ bellekte kurar, bu yüzden 256 MB üstündeki transkript setini reddeder;
büyük geçmiş için 12.1'deki akışlı dosya export'unu kullanın (veya `--no-sessions` ekleyip
transkriptleri ayrıca kopyalayın).

### 12.3 Canlı, LAN üstünde makineden makineye — `keyflip transfer`
```bash
# KAYNAK makinede:
keyflip transfer serve                 # tek-kullanımlık kod + çalıştırılacak komutu gösterir
# HEDEF makinede (eşi UDP beacon ile otomatik bulur):
keyflip transfer pull --code K7Q29FMR
keyflip transfer pull 192.168.1.20:8787 --code K7Q29FMR   # ...veya host'u doğrudan çevir
keyflip transfer serve --ttl 300 --no-discovery           # daha uzun pencere, beacon yok
```
- Paket kodla şifrelenir; dinleyici tek atış, hız-sınırlı ve otomatik süre dolumludur.
  Dosya yok, bulut yok.

### 12.4 Yalnız hesaplar — `keyflip export/import`
```bash
keyflip export - | gpg -c > accounts.gpg      # hesaplar + tokenlar (SIRLAR)
gpg -d accounts.gpg | keyflip import -
```
- **Not:** masaüstü ve tarayıcı girişleri makineye bağlıdır — yeni makinede
  `keyflip onboard` ile yeniden yakala.

---

## 13. Cihazlar arası eşitleme (iki makineyi eşte tut)

```bash
keyflip sync test --url https://dav.example/kf --user u --pass-file p.txt
keyflip sync push --url … --passphrase-file pass.txt      # şifreli push
keyflip sync pull --url … --passphrase-file pass.txt      # önizle + uygula (önce güvenlik yedeği)
# Ya da sıfır yapılandırma: KEYFLIP_CONFIG_DIR'ı Dropbox/iCloud klasörüne göster.
```

---

## 14. Bir hesap/sağlayıcı işaretçisini paylaşmak

```bash
keyflip share relay                    # → keyflip:// bağlantısı (sağlayıcı, anahtarla)
keyflip share relay --no-secrets       # ...anahtarı atla
keyflip share work                     # hesap bağlantısı YALNIZ İŞARETÇİdir (asla token değil)
keyflip import 'keyflip://…'           # önizle + onayla + uygula
```

---

## 15. Beceriler (skill) & MCP (ajanlara keyflip'i öğret)

```bash
keyflip install-skill                  # paketli keyflip skill'i → Claude + tespit edilen diğer ajanlar
keyflip skill agents                   # skill hedefleri; ● = o araç bu makinede
keyflip skill add owner/repo           # herhangi bir skill → tespit edilen her ajan (ya da --agents a,b)
keyflip skill sync                     # kaynakları yeniden uygula; senin düzenlediğin kopyaya dokunmaz
keyflip skill list | remove <ad>       # ajan başına durum; yalnız keyflip'in kurduklarını kaldırır
keyflip mcp --setup                    # keyflip'in MCP sunucusunu nasıl kaydedeceğini göster
keyflip mcpreg add ctx -- some-server  # MCP sunucularını bir kez yönet, Code + Desktop'a yansıt
keyflip mcpreg list | enable | disable | remove | import
```
- **MCP araçları ile** (shell'e göre tercih et): `keyflip_status`, `keyflip_list`,
  `keyflip_switch`, `keyflip_switch_plan`, `keyflip_verify`, `keyflip_refresh`,
  `keyflip_refresh_schedule`, `keyflip_llm`,
  `keyflip_next`, `keyflip_login`, `keyflip_logout`,
  `keyflip_browser_status/_logout`, `keyflip_consolidate`, `keyflip_history_audit`,
  `keyflip_memory_audit`, `keyflip_history_scrub`, `keyflip_memory_redact`, `keyflip_secrets_policy`,
  `keyflip_secrets_tolerate`, `keyflip_chains`,
  `keyflip_chains_tighten`,
  `keyflip_migrate_export/_import`, sağlayıcılar, yedekler, oturumlar, proxy… Mutasyon
  araçları `confirm: true` ister; `keyflip_switch_plan`/`keyflip_verify`/`keyflip_llm`/
  `keyflip_history_audit`/`keyflip_memory_audit`/`keyflip_secrets_policy`/`keyflip_chains` salt-okunurdur, yani bir ajan onay istemeden önce
  geçişin tutacağını, o hesabın hâlâ kimlik doğrulayıp doğrulamadığını, arka plan görevinin hangi modeli
  — kimin kotasını — kullanacağını, eski bir commit'te hâlâ okunabilir bir sır olup olmadığını, hangi
  bulguların kullanıcı tarafından "beklenen" sayıldığını ve bir
  hesabın hangi yakalamasının bayat, hangi rakiple tek depoyu paylaştığını ya da herkese okunabilir
  olduğunu kontrol edebilir.
  `keyflip_refresh_schedule`, `refresh --all`'ı her geceki zamanlayıcıya koyar (model çağırmaz, kota
  harcamaz) ve bir Claude oturumu kimlik bilgisini hâlâ tutuyorsa `changed: false` ile reddeder.
- **Sohbet aramasını güncel tutmak.** `keyflip conv index --schedule [--interval N]` sohbet indeksini bir
  zamanlayıcıya koyar (macOS'ta launchd, Linux'ta cron) böylece `keyflip conv search` az önce yaptığınız
  sohbeti bulur, bir günlük bayat olana değil. **Gece saatinde değil, aralıkla** çalışır, çünkü günlük
  indeks bir gün geride kalırdı; geçiş kademelidir (değişmeyen bir transcript tek `stat()` demektir) ve
  yalnızca yeni ya da değişen parçaları **yerel** modelle gömer — bulut modeli yok, kota yok. MCP'de aynı
  iş `keyflip_conv_index_schedule` (`action:"status"|"install"|"remove"`, `interval` dakika cinsinden).
- **Sohbet aramasının ölçülmüş değeri.** Canlı 1.869 sohbetlik / 117.503 chunk'lık indeks üzerinde,
  rastgele bir *mesajdan* (yani hiçbir chunk sınırı öne geçmesin diye) yazılmış 84 geliştirici tarzı
  soru: BM25 hit@1 0,49 / hit@5 0,83 / MRR 0,63; vektör listesi tek başına 0,24 / 0,43 / 0,32; hibrit ise
  — gönderilen 1:0,25 ağırlıkla — tam olarak BM25 sayılarına düşüyor. Transkriptlerde nadir terim
  anlamdan daha iyi bir sinyal; bu yüzden hibrit bilinçli olarak BM25'i yerinden etmiyor (1:0,5 →
  0,46; 1:1 → 0,45; 1:2 → 0,25). Tur bazlı chunk'lar sıralamada nötr (84 soruda bir-iki soru) ve
  kazandırdığı şey geri verilen metin: soru her zaman cevabın yanında; kopya katlama ise sayfa
  yuvalarının %9,3'ünü — aynı 84 soruda 840 yuvanın 78'i — sayfanın zaten gösterdiği bir paragrafı
  tekrarlamaktan kurtarıp adlandırılmış `alsoIn` ikizlerine çeviriyor. Vektörler CPU ister — 117.033
  chunk'ın tamamını taramak ve gömmek 2 saat 35 dakika sürdü — bu yüzden indeks kademeli gömer ve
  semantik liste hafif kalır.
- **İki hesabın sohbetini ayırmak.** `keyflip conv list --account yahoo` ve
  `keyflip conv search "release plan" --account gmail` şu soruyu yanıtlar: "bunu hangisi yazdı?" Hesap
  önce sizin sözünüzden gelir (`keyflip sessions assign`); hiçbir şey söylemediğiniz yerde keyflip'in kendi
  geçiş zaman çizelgesinden okunur (`active -> <profil>`, `kiro -> <slug>`, `codex -> <slug>`) — her yüzey
  kendi çizelgesini tutar, dolayısıyla bir Kiro geçişi asla bir Claude oturumunu yeniden etiketlemez.
  `conv list` tahmin edilen adın sonuna `*` koyar; gerekçeyi ve güveni `keyflip conv show <id>` yazar.
  Kayıtlı her geçişten eski bir sohbet, silinmiş bir hesap ya da keyflip'in hesabını tutmadığı bir araç
  (Qoder, Gemini) hesap göstermez — dürüst cevap "bilinmiyor"dur, tahmin değil.

---

## 16. Temizlik, sıfırlama & kaldırma (yıkıcı — daima onaylı)

```bash
keyflip reset --soft                   # YALNIZ çalışma-zamanı durumunu temizle (kullanım geçmişi,
                                       # kesiciler, proxy durumu, önbellek, log); hesapları KORUR
keyflip reset                          # FABRİKA sıfırlaması: TÜM keyflip verisini SİL (hesaplar,
                                       # sağlayıcılar, yedekler). Uygulama kurulu kalır.
keyflip reset --logout                 # ...canlı yüzeylerden de çıkış yap
keyflip reset --force --logout         # TAM sıfır: tüm Claude Code'ları kapat + çıkış, Chrome'u
                                       # kapat + uzantı çıkışı, masaüstünü kapat + çıkış,
                                       # tüm yedekleri + tüm auth'u sil
keyflip reset --logout --no-desktop    # CLI + tarayıcıdan çıkış yap ama masaüstüne dokunma
keyflip uninstall                      # keyflip'i bu makineden kaldır (verini korur)
keyflip uninstall --purge              # ...tüm keyflip verisini de sil
```
- `reset`/`uninstall` `~/.claude/projects`'e (transkriptlerin) asla dokunmaz.
  `uninstall` bir kaynak checkout'unu silmez. `--force` yoksa sorarlar.

---

## 17. Kesişen varyasyonlar

- **`--json`** (okuma komutlarında) → stdout'ta tam bir JSON nesnesi (`schemaVersion: 1`),
  insan metni stderr'de, hatalar `{"error":{…}}` + çıkış 1. Betikleme için kullan.
- **`-y` / `--yes`** → onay sorularını atla (otomasyon için).
- **`--force`** → yıkıcı komutun sorusunu atla, ya da import/merge'de üstüne yaz.
- **`KEYFLIP_CONFIG_DIR`** → keyflip yapılandırmasını taşı (örn. eşitlenen bir klasöre).
- **`CLAUDE_CONFIG_DIR`** → `run`'ın terminal başına izole ettiği şey.
- **Sırlar** → daima `--key-file`/`--token`/`--pass-file`/`--passphrase-file` ile
  (bir dosya ya da stdin için `-`); asla komut satırı argümanı olarak değil.

---

## 18. Önerilen video akışı (NotebookLM için)

1. **Problem** — tek makine, çok Claude hesabı, birbirinden ayrışan dört yüzey.
2. **Yakala** — `keyflip onboard` iki hesabı elini değdirmeden kurar.
3. **Gör** — `keyflip list --usage` kimin aktif, kimde kota kaldığını gösterir.
4. **Geç** — rate limit → `keyflip next --strategy best` → işe geri dön.
5. **Tam hizalama** — `keyflip work --browser` CLI + uygulama + tarayıcı + uzantıyı hizalar.
6. **Sohbet kaybetme** — hesaplar arası `keyflip consolidate` ve `keyflip resume`.
7. **Makine taşı** — `keyflip transfer serve` / `pull` her şeyi LAN üstünde taşır ve
   oradakiyle BİRLEŞTİRİR.
8. **Temiz çıkış** — `keyflip reset --soft` vs fabrika `reset` vs `uninstall`.

---

*Her komutun içinde `--help` düzeyinde kullanım gömülüdür; argümansız/geçersiz
çalıştırırsan tam bayrakları görürsün. Bu katalog keyflip'in bu yazı anındaki tüm
yüzeyini yansıtır.*
