# VS Code için keyflip

[keyflip](https://github.com/hakkisagdic/keyflip) için durum-çubuğu yardımcısı:
aktif Claude hesabını gösterir, hesap değiştirir ve yerel paneli açar — editörden
çıkmadan.

> 🇬🇧 [English README](README.md)

> VS Code **Claude Code eklentisi CLI'ın kimlik deposunu paylaşır**, bu yüzden
> keyflip ile yapılan bir geçiş ona da uygulanır — bu eklenti yalnızca kolaylık arayüzüdür.

## Gereksinimler

- `keyflip` kurulu ve PATH'te (veya ayarlarda `keyflip.path` ayarlı)
- En az bir kayıtlı hesap (`keyflip add`)

## Özellikler

- **Hesaplar kenar çubuğu** (Explorer → *Claude Accounts*): tüm kayıtlı hesapların ağacı;
  aktif olan işaretli, kotası gösterilir; **bir satıra tıklayınca o hesaba geçer**. Görünüm
  başlığından yenile.
- **Durum çubuğu**: aktif hesap tek bakışta (üzerine gelince CLI + masaüstü uygulaması
  + aktif provider). 60 sn'de bir yenilenir; ağ gerektirmez (sıcak yolda kota çekmez).
  **Masaüstü uygulaması CLI'dan farklı bir hesaptaysa uyarı rengine döner** (`--browser`/
  `--restart` ile geçiş bunu düzeltir).
- **`keyflip: Re-link Chat History`**: bir proje klasörünü taşıdıktan/yeniden adlandırdıktan
  sonra Claude sohbet geçmişini yeni yola yeniden bağla (`keyflip sessions rebind` çalıştırır;
  yeni yol varsayılan olarak mevcut workspace klasörüdür).
- **`keyflip: Switch Claude Account`** (durum çubuğuna tıklama da): kayıtlı hesapların
  QuickPick listesi — yakalama durumu (`cli ✓ | app ✓`) ve güncel 5s/7g kotayı gösterir →
  onayla → geç (gerekiyorsa masaüstü uygulamasını kapatıp açar) → Claude eklentisinin
  yeni oturumu görmesi için pencere yeniden yükleme önerir.
- **`keyflip: Open Dashboard`**: `keyflip panel --open`'ı entegre terminalde başlatır
  (yerel, salt-okunur web panosu; Ctrl-C durdurur).
- **`keyflip: Show Account Status`**: tam CLI + masaüstü uygulaması + provider durumunu
  bir çıktı kanalında gösterir.

## Ayarlar

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `keyflip.path` | `keyflip` | keyflip çalıştırılabilirinin yolu (varsayılan: PATH'ten çöz). |

## Kurulum (yerel, marketplace olmadan)

```bash
cd vscode-keyflip
npx --yes @vscode/vsce package        # keyflip-vscode-<sürüm>.vsix üretir
code --install-extension keyflip-vscode-*.vsix
```

Marketplace'te yayınlamak bir publisher hesabı gerektirir ve henüz kurulmadı.

## Geliştirme

VS Code host'u olmadan çalışabilen tüm mantık [`lib.js`](lib.js) içindedir (çıktı
ayrıştırma + görünüm-modeli şekillendirme) ve ana depodan birim-testlidir
(`node --test test/vscode-lib.test.js`). `extension.js` ince VS Code tutkalıdır.
