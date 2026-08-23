# keyflip Mimarisi

[English](./ARCHITECTURE.md) | **Turkce**

> keyflip'in ic mimarisi, modul organizasyonu, veri akisi, guvenlik modeli
> ve coklu platform stratejisinin kapsamli bir genel bakisi.

---

## Icerik Tablosu

- [Dizin Yapisi](#dizin-yapisi)
- [Modul Kategorileri](#modul-kategorileri)
- [Veri Akisi: Hesap Degistirme](#veri-akisi-hesap-degistirme)
- [Guvenlik Modeli](#guvenlik-modeli)
- [Coklu Platform Stratejisi](#coklu-platform-stratejisi)
- [Genisleme Noktalari](#genisleme-noktalari)

---

## Dizin Yapisi

```
keyflip/
├── bin/               CLI giris noktasi (keyflip.js)
├── src/               Kaynak modulleri (100+ dosya)
├── test/              Test paketi (node:test, 1200+ test)
├── docs/              Ek dokumantasyon
├── skills/            Claude Code beceri tanimlari
├── issuer/            Lisans yayinlama iskeleti
├── .github/workflows/ CI (ci.yml) ve yayinlama (publish.yml)
└── package.json       Sifir calisma zamani bagimliligi
```

### Temel Dizinler

| Dizin | Amac |
|-------|------|
| `bin/` | CLI'yi baslatan tek giris noktasi (`keyflip.js`) |
| `src/` | Sorumluluga gore organize edilmis tum uygulama mantigi |
| `test/` | `src/` yapisini yansitan birim ve entegrasyon testleri |
| `docs/` | Genisletilmis dokumantasyon (mimari, kullanim senaryolari, SSO, tasima) |
| `skills/` | Yapay zeka destekli is akislari icin Claude Code beceri tanimlari |
| `issuer/` | Lisans yayinlama servisi iskeleti |

---

## Modul Kategorileri

keyflip'in `src/` dizini mantiksal kategorilere ayrilmis 100'den fazla modul icerir:

### Temel Hesap Yonetimi

keyflip'in temeli - profilleri, yapilandirmayi ve CLI komutlarini yonetir.

| Modul | Sorumluluk |
|-------|------------|
| `core.js` | Merkezi orkestrasyon, profil aktivasyonu ve hesap degistirme mantigi |
| `profiles.js` | Profil CRUD islemleri, profil depolama ve dogrulama |
| `cli.js` | CLI arguman ayristirma ve komut dagitimi |
| `commands.js` | Komut kayit defteri ve isleyici tanimlari |
| `config.js` | Yapilandirma dosyasi yonetimi (yollar, varsayilanlar, okuma/yazma) |
| `menu.js` | Profil secimi icin etkilesimli menu sistemi |
| `platform.js` | Platform algilama ve isletim sistemine ozel yol cozumleme |
| `lock.js` | Esanli erisimi onlemek icin dosya kilitleme |
| `txn.js` | Geri alma destekli islemsel operasyonlar |

### Saglayicilar

Farkli yapay zeka servisleri ve yonlendirme mantigi icin coklu saglayici destegi.

| Modul | Sorumluluk |
|-------|------------|
| `provider.js` | Saglayici soyutlamasi ve kaydi |
| `provusage.js` | Saglayici bazinda kullanim takibi ve analitik |
| `proxy.js` | Proxy yapilandirmasi ve tunelleme |
| `router.js` | Birden fazla saglayici arasinda istek yonlendirme |
| `breaker.js` | Saglayici yedeklemesi icin devre kesici deseni |

### Oturumlar

Oturum yasam dongusu yonetimi, transkript isleme ve geri cagirma.

| Modul | Sorumluluk |
|-------|------------|
| `session.js` | Tekil oturum yasam dongusu (olusturma, devam ettirme, sonlandirma) |
| `sessions.js` | Oturum koleksiyonu yonetimi ve listeleme |
| `sessionmap.js` | Oturum-profil eslestirmesi |
| `sessionedit.js` | Oturum meta verisi duzenleme |
| `transcript.js` | Konusma transkripti depolama ve erisimi |
| `recall.js` | Transkriptler arasi oturum geri cagirma ve arama |

### Filo ve Transfer

Coklu cihaz senkronizasyonu, takim yonetimi ve veri transferi.

| Modul | Sorumluluk |
|-------|------------|
| `fleet.js` | Filo yonetimi (birden fazla cihaz/ornek) |
| `transfer.js` | Cihazlar arasi profil transferi |
| `lantransfer.js` | LAN tabanli yerel ag transferi |
| `relaytransfer.js` | Araci uzerinden relay tabanli transfer |
| `relayserver.js` | Relay sunucu uygulamasi |
| `sync.js` | Yapilandirma senkronizasyonu |
| `teampool.js` | Takim hesap havuzu ve paylasimli erisim |

### Bagam Katmani

Proje duyarli bagam yonetimi, kontrol noktasi ve is birligi.

| Modul | Sorumluluk |
|-------|------------|
| `context.js` | Bagam soyutlamasi ve yasam dongusu |
| `projctx.js` | Projeye ozel bagam baglama |
| `checkpoint.js` | Durum kontrol noktasi ve geri yukleme |
| `ctxsync.js` | Oturumlar arasi bagam senkronizasyonu |
| `handoff.js` | Ajanlar/kullanicilar arasi oturum devri |
| `rulesmodel.js` | Bagam duyarli degistirme icin kurallar modeli |

### Guvenlik

Kimlik bilgisi depolama, gizli tarama, OAuth ve sifreleme.

| Modul | Sorumluluk |
|-------|------------|
| `secretscan.js` | Ciktilarda gizli bilgi algilama ve sansur |
| `secretpaths.js` | Bilinen gizli dosya yolu tanimlari |
| `vault.js` | Sifreli kimlik bilgisi kasasi |
| `wincrypt.js` | Windows DPAPI kimlik bilgisi sifreleme |
| `oauth.js` | OAuth akis uygulamasi |
| `login.js` | Kimlik dogrulama ve giris isleme |

### Masaustu ve Tarayici Entegrasyonu

Claude masaustu uygulamasi, tarayici otomasyonu ve uygulama duzeyi oturum yonetimi.

| Modul | Sorumluluk |
|-------|------------|
| `claude.js` | Claude masaustu uygulamasi entegrasyonu |
| `appauth.js` | Masaustu uygulamasi kimlik dogrulama |
| `appsessions.js` | Masaustu uygulamasi oturum yonetimi |
| `browser.js` | Tarayici profili ve cerez yonetimi |
| `chat.js` | Sohbet arayuzu entegrasyonu |
| `cowork.js` | Birlikte calisma ve is birligi ozellikleri |
| `desktopgw.js` | Uygulamalar arasi iletisim icin masaustu gecidi |

### TUI ve Panel

Terminal arayuzu bilesenleri ve gorsel sunum.

| Modul | Sorumluluk |
|-------|------------|
| `tui.js` | Terminal arayuzu cercevesi ve render |
| `panel.js` | Panel duzeni ve bilesimi |
| `style.js` | ANSI stillendirme ve renk yonetimi |
| `menubar.js` | Menu cubugu bileseni |

### MCP (Model Context Protocol)

Yapay zeka araci birlikte calisabilirligi icin MCP sunucu entegrasyonu.

| Modul | Sorumluluk |
|-------|------------|
| `mcp.js` | MCP sunucu uygulamasi |
| `mcpreg.js` | MCP sunucu kaydi ve kesfetme |

### Yardimci Araclar

Dosya sistemi yardimlari, kodlama, veri formati okuyuculari ve cesitli araclar.

| Modul | Sorumluluk |
|-------|------------|
| `fsutil.js` | Dosya sistemi yardimcilari (guvenli okuma/yazma, gecici dosyalar) |
| `qr.js` | Transfer baglantilari icin QR kod olusturma |
| `embed.js` | Gomme yardimcilari |
| `llm.js` | LLM etkilesim yardimcilari |
| `sqliteread.js` | SQLite veritabani okuyucu (Claude yerel DB icin) |
| `yamlread.js` | YAML dosya ayristirici |
| `walmerge.js` | WAL (Write-Ahead Log) birlestirme islemleri |

### Diger Moduller

Otomasyon, izleme ve sistem entegrasyonunu kapsayan ozellestirilmis ozellikler.

| Modul | Sorumluluk |
|-------|------------|
| `autoswitch.js` | Kurallara dayali otomatik hesap degistirme |
| `autoswitchservice.js` | Otomatik degistirme icin arka plan servisi |
| `backup.js` | Profil yedekleme ve geri yukleme |
| `brain.js` | Akilli karar motoru |
| `budget.js` | Kullanim butcesi yonetimi |
| `cost.js` | Maliyet takibi ve tahmini |
| `doctor.js` | Sistem sagligi teshisleri |
| `groups.js` | Profil grubu yonetimi |
| `history.js` | Komut ve degistirme gecmisi |
| `license.js` | Lisans dogrulama ve yonetimi |
| `links.js` | Paylasilabilir baglanti olusturma |
| `log.js` | Yapilandirilmis gunlukleme |
| `memory.js` | Kalici bellek deposu |
| `migrate.js` | Surumler arasi yapilandirma goci |
| `notify.js` | Bildirim sistemi (masaustu, terminal) |
| `onboard.js` | Ilk calistirma karsilama akisi |
| `orchestrator.js` | Cok adimli islem orkestrasyonu |
| `policy.js` | Erisim politikasi uygulama |
| `schedule.js` | Zamanlanmis islemler (rotasyon, temizlik) |
| `share.js` | Kullanicilar arasi profil paylasimi |
| `shellhook.js` | Kabuk kanca entegrasyonu (cd, prompt) |
| `skill.js` | Beceri tanimi ve yurutme |
| `skillstore.js` | Beceri pazaryeri ve depolama |
| `surface.js` | Yuzey algilama (terminal, IDE, masaustu) |
| `swarm.js` | Coklu ajan suru koordinasyonu |
| `uninstall.js` | Temiz kaldirma isleyicisi |
| `update.js` | Kendi kendine guncelleme mekanizmasi |
| `usage.js` | Kullanim istatistikleri ve raporlama |
| `vcs.js` | Surum kontrol sistemi entegrasyonu |
| `wsl.js` | Linux icin Windows Alt Sistemi destegi |

---

## Veri Akisi: Hesap Degistirme

keyflip'in temel islemi yapay zeka araci hesaplari arasinda gecis yapmaktir. Tam akis:

```
Kullanici Istegi (CLI / TUI / Otomatik tetikleme)
        │
        ▼
┌─────────────────┐
│    cli.js       │  Komut ve argumanlari ayristir
│    commands.js  │  Isleyiciye dagit
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    core.js      │  Degistirmeyi orkestre et
│    lock.js      │  Dosya kilidi al (esanli degistirmeleri onle)
│    txn.js       │  Islemsel operasyonu baslat
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   profiles.js   │  Hedef profil kimlik bilgilerini yukle
│   config.js     │  Yapilandirma dosyalarini oku/guncelle
│   platform.js   │  Isletim sistemine ozel kimlik yollarini coz
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   vault.js      │  Kasadan kimlik bilgilerini coz
│   wincrypt.js   │  (Windows) Cozme icin DPAPI kullan
│   secretscan.js │  Kazara gizli bilgi ifsa kontrolu
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   claude.js     │  Claude yapilandirmasina kimlik bilgilerini yaz
│   browser.js    │  Tarayici oturum cerezlerini guncelle
│   appsessions.js│  Masaustu uygulama oturumlarini senkronize et
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   session.js    │  Oturum kaydini olustur/guncelle
│   history.js    │  Degistirme olayini kaydet
│   notify.js     │  Bildirim gonder
└─────────────────┘
```

### Temel Tasarim Ilkeleri

1. **Islemsel Guvenlik**: Her degistirme operasyonu bir islem icinde sarmalanir (`txn.js`). Herhangi bir adim basarisiz olursa, tum operasyon onceki duruma geri alinir.

2. **Kilit Tabanli Esanlilik**: Dosya kilitleri (`lock.js`) birden fazla keyflip orneginin kimlik bilgilerini ayni anda degistirmesini onler.

3. **Platform Soyutlamasi**: `platform.js` tum isletim sistemine ozel yollari ve davranislari cozer, temel mantigin platformdan bagimsiz kalmasini saglar.

4. **Kimlik Bilgisi Izolasyonu**: Kimlik bilgileri bellekte gerekenden fazla tutulmaz. Kasa talep uzerine cozer ve kullanim sonrasi temizler.

---

## Guvenlik Modeli

### Kimlik Bilgisi Depolama

- **Kasa sifreleme**: Kimlik bilgileri, mumkun oldugunda platforma ozgu sifreleme kullanan sifreli bir kasada (`vault.js`) saklanir
- **Windows DPAPI**: Windows'ta `wincrypt.js`, donanim bagli sifreleme icin Veri Koruma API'sini kullanir
- **Dosya izinleri**: Yapilandirma dosyalari kisitlayici izinlerle (600/700) yazilir

### Gizli Bilgi Taramasi

- **Cikti taramasi**: `secretscan.js` tum ciktilari kazara kimlik bilgisi sizintisi icin tarar
- **Yol algilama**: `secretpaths.js` bilinen gizli dosya konumlarinin bir kaydini tutar
- **Sansur**: Algilanan gizli bilgiler `keyflip_redacted` isaretcileriyle degistirilir

### Islemsel Butunluk

- **Atomik islemler**: `txn.js` profil degistirmelerinin atomik olmasini saglar - ya tamamen tamamlanir ya da tamamen geri alinir
- **Kilit dosyalari**: `lock.js` esanli erisim senaryolarinda yaris kosullarini onler
- **Degistirmede yedekleme**: Herhangi bir degisiklikten once onceki durum korunur

### Erisim Kontrolu

- **Politika uygulama**: `policy.js` hangi profillerin hangi baglamlarda erisilebilir oldugunu kisitlayabilir
- **Butce limitleri**: `budget.js` kontrolsuz harcamayi onlemek icin kullanim sinirlarini uygular
- **Denetim izi**: `history.js` tum islemlerin eksiksiz bir kaydini tutar

---

## Coklu Platform Stratejisi

keyflip, birlesik bir kod tabani ile macOS, Linux ve Windows'u destekler:

### Platform Algilama (`platform.js`)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   macOS     │     │    Linux     │     │   Windows   │
├─────────────┤     ├──────────────┤     ├─────────────┤
│ ~/Library/  │     │ ~/.config/   │     │ %APPDATA%   │
│ Keychain    │     │ Secret Svc   │     │ DPAPI       │
│ launchd     │     │ systemd      │     │ Task Sched  │
└─────────────┘     └──────────────┘     └─────────────┘
        │                   │                    │
        └───────────────────┼────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  platform.js  │
                    │ (soyutlama)   │
                    └───────────────┘
```

### Temel Platform Farkliliklari

| Konu | macOS | Linux | Windows |
|------|-------|-------|---------|
| Yapilandirma yolu | `~/Library/Application Support/` | `~/.config/` | `%APPDATA%` |
| Kimlik sifreleme | Keychain Access | libsecret | DPAPI (`wincrypt.js`) |
| Arka plan servisi | launchd | systemd | Gorev Zamanlayicisi |
| Kabuk entegrasyonu | zsh/bash | bash/zsh/fish | PowerShell/cmd |
| WSL destegi | Yok | Yok | `wsl.js` |

### CI Matrisi

GitHub Actions CI boru hatti tum desteklenen platformlarda ve Node.js surumlerinde test yapar:

- **Isletim Sistemi**: ubuntu-latest, macos-latest, windows-latest
- **Node.js**: 18, 20, 22

---

## Genisleme Noktalari

### MCP Sunucu (`mcp.js`, `mcpreg.js`)

keyflip, yapay zeka araclarinin hesaplari programatik olarak yonetmesine olanak taniyan bir MCP (Model Context Protocol) sunucusu sunar. Bu sunucu sunlari saglar:
- Yapay zeka oturumlari icinden otomatik hesap degistirme
- Arac odakli profil sorgulari
- Herhangi bir MCP uyumlu istemci ile entegrasyon

### Otomatik Degistirme Kurallari (`autoswitch.js`, `rulesmodel.js`)

Asagidakilere dayali otomatik profil degistirme:
- Calisma dizini (proje tabanli)
- Git uzak URL'si
- Zaman tabanli zamanlamalar
- Maliyet/butce esikleri

### Beceri Sistemi (`skill.js`, `skillstore.js`)

Yeni yetenekler eklemek icin genisletilebilir beceri sistemi:
- Ozel degistirme stratejileri
- Saglayiciya ozel mantik
- Takim is akisi otomasyonu

---

## Tasarim Felsefesi

1. **Sifir calisma zamani bagimliligi**: Tum uygulama yalnizca Node.js yerlesik modulleri uzerinde calisir, tedarik zinciri riskini en aza indirir ve hizli kurulumlari saglar.

2. **Baslangicindan sonuna ES Modulleri**: Tam ESM ile modern JavaScript, agac sallama farkindiligi ve temiz iceri/disari aktarma sinirlari saglar.

3. **Once test yaklasimi**: Node.js yerlesik test calistiricisi kullanilarak 1200'den fazla test, harici test cercevesi gerekmez.

4. **Kademeli aciklama**: Temel kullanim icin basit `keyflip switch`, guc kullanicilari ve takimlar icin derin ozellikler mevcuttur.

5. **Varsayilan olarak guvenlik**: Sifreli depolama, gizli bilgi taramasi ve islemsel guvenlik her zaman aktiftir - istege bagli ozellikler degildir.
