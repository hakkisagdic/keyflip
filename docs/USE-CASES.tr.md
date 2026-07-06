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
keyflip doctor               # yapılandırma + giriş + uç nokta erişilebilirlik raporu
```
- `list` bir **web** sütunu ve tarayıcı/uzantı alt bilgisi gösterir, uyumsuzlukta uyarır.
- `usageStatus` sabitleri: `ok`, `expired` (hesabı yeniden `add`'le), `throttled`
  (**bilinmiyor**, rate-limit kanıtı değil), `error`, `no-creds`/`no-token`.

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
keyflip browser sync                 # AKTİF hesabın kayıtlı tarayıcı oturumunu geri yükle
keyflip browser sync work            # ...belirli bir hesabın oturumunu geri yükle
keyflip browser status --browser brave   # tek tarayıcı hedefle (chrome|brave|edge|arc)
```
- Oturumlar `onboard`/`login` sırasında tarayıcı o hesaptayken otomatik yakalanır;
  `browser sync` ve `<ad> --browser` onları geri oynatır.

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
keyflip chat get <id>                  # bir sohbeti oku
```
- `resume` proje kapsamlıdır — transkriptin orijinal dizinine `cd`'yi kendisi halleder.
- `chat` taze bir Cloudflare çerezi ister (uygulamayı kullandıktan hemen sonra çalışır)
  ve yalnız masaüstünün hesabını görür; 403 = "uygulamayı bir kez aç ve tekrar dene".

---

## 9. Sohbetleri hesaplar arasında eşitlemek

```bash
keyflip consolidate                    # her hesabın sohbet dizini TÜM sohbetleri gösterir
keyflip consolidate --watch            # uygulama kapalıyken periyodik olarak yeniden eşitle
keyflip consolidate --watch --interval 60
```
- Uygulama çalışırken deposu kilitli olur; tek atış modu kapat→eşitle→aç önerir
  (`-y` ile soruyu atla).
- Ayrıca her geçişte otomatik çalışır.

---

## 10. İstek düzeyinde yük devretme proxy'si (istek üzerine başlar, asla daemon değil)

```bash
keyflip proxy start --wire             # localhost proxy başlat + Claude Code'u ona bağla
keyflip proxy status                   # açık mı? hangi portta? hesap başına toplamlar
keyflip proxy stats                    # hesap başına istek/token toplamları
keyflip proxy stop                     # durdur ve settings.json bağını çöz
```
- Açıkken her isteği aktif hesaba yönlendirir ve istemci bir bayt görmeden **429/5xx'te
  bir sonraki sağlıklı hesaba yük devreder.** İstek ortası limitlerin olası olduğu uzun
  gözetimsiz koşular için ideal.

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

### 12.2 Bulut relay ile (LAN yok) — WebDAV
```bash
keyflip migrate push --url https://dav.example/kf.enc --passphrase-file pass.txt   # kaynak
keyflip migrate pull --url https://dav.example/kf.enc --passphrase-file pass.txt   # hedef (önizler + birleştirir)
```

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
keyflip install-skill                  # ajanlara keyflip'i öğreten Claude Code skill'ini kur
keyflip skill add owner/repo           # GitHub'dan (veya ./dizin, ya da file.tgz) skill kur
keyflip skill list | remove <ad>       # yalnız keyflip'in kurduğu skill'leri kaldırır
keyflip mcp --setup                    # keyflip'in MCP sunucusunu nasıl kaydedeceğini göster
keyflip mcpreg add ctx -- some-server  # MCP sunucularını bir kez yönet, Code + Desktop'a yansıt
keyflip mcpreg list | enable | disable | remove | import
```
- **MCP araçları ile** (shell'e göre tercih et): `keyflip_status`, `keyflip_list`,
  `keyflip_switch`, `keyflip_next`, `keyflip_login`, `keyflip_logout`,
  `keyflip_browser_status/_logout`, `keyflip_consolidate`,
  `keyflip_migrate_export/_import`, sağlayıcılar, yedekler, oturumlar, proxy… Mutasyon
  araçları `confirm: true` ister.

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
