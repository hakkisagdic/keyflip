# JetBrains IDE'leri için keyflip

[keyflip](https://github.com/hakkisagdic/keyflip) için yardımcı eklenti: aktif Claude
hesabını durum çubuğunda gösterir, hesap değiştirir, hepsini bir araç penceresinde listeler
ve yerel paneli açar — editörden çıkmadan. [VS Code yardımcısının](../vscode-keyflip)
IntelliJ Platform sürümü.

> 🇬🇧 [English README](README.md)

> IDE'nin Claude entegrasyonu **CLI'ın kimlik deposunu paylaşır**, bu yüzden keyflip ile
> yapılan bir geçiş ona da uygulanır — bu eklenti yalnızca kolaylık arayüzüdür. Token'ları
> **kendisi asla ele almaz**: yalnızca `keyflip --json` okur ve belgelenen switch / rebind /
> panel komutlarını çalıştırır.

## Gereksinimler

- IntelliJ Platform üzerinde bir JetBrains IDE'si, **2023.2+** (build 232+)
- `keyflip` kurulu ve PATH'te (veya ayarlarda yol ayarlı)
- En az bir kayıtlı hesap (`keyflip add`)

## Özellikler

- **Durum çubuğu**: aktif hesap tek bakışta (üzerine gelince CLI + masaüstü uygulaması +
  aktif provider). 60 sn'de bir yenilenir; ağ gerektirmez (sıcak yolda kota çekmez).
  **Masaüstü uygulaması CLI'dan farklı bir hesaptaysa uyarı (`⚠`) gösterir** (`--restart` ile
  geçiş bunu düzeltir). **Tıklayınca geçiş yapar.**
- **Claude Accounts araç penceresi** (sağ panel): tüm kayıtlı hesaplar; aktif olan işaretli,
  kotası gösterilir; **bir satıra çift tıklayınca o hesaba geçer** (önce onaylar). Araç
  çubuğundan yenile.
- **keyflip: Switch Claude Account** (durum çubuğuna tıklama da): kayıtlı hesapların açılır
  listesi — yakalama durumu (`cli ✓ | app ✓`) ve güncel 5s/7g kotayı gösterir → onayla → geç
  (gerekiyorsa masaüstü uygulamasını kapatıp açar) → Claude entegrasyonunun yeni oturumu
  görmesi için **IDE'yi yeniden başlatmayı** önerir.
- **keyflip: Re-link Chat History (taşınan klasör)**: bir proje klasörünü
  taşıdıktan/yeniden adlandırdıktan sonra Claude sohbet geçmişini yeni yola yeniden bağlar
  (`keyflip sessions rebind` çalıştırır; yeni yol varsayılan olarak proje kök dizinidir).
- **keyflip: Open Dashboard**: `keyflip panel --open`'ı entegre terminalde başlatır (yerel,
  salt-okunur web panosu; Ctrl-C durdurur).
- **keyflip: Show Account Status**: tam CLI + masaüstü uygulaması + provider durumunu bir
  iletişim kutusunda gösterir.

Tüm eylemler **Tools › keyflip** altındadır.

## Ayarlar

**Settings/Preferences › Tools › keyflip** açın:

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| Keyflip executable path | `keyflip` | keyflip çalıştırılabilirinin yolu (varsayılan: PATH'ten çöz). |

## Derleme ve kurulum (yerel, Marketplace olmadan)

```bash
cd jetbrains-keyflip
./gradlew buildPlugin
# → build/distributions/jetbrains-keyflip-<sürüm>.zip
```

Ardından IDE'de: **Settings/Preferences › Plugins › ⚙ › Install Plugin from Disk…** ve
`build/distributions/` içindeki zip'i seçin.

Geliştirme sırasında eklenti yüklü bir sandbox IDE çalıştırmak için:

```bash
./gradlew runIde
```

> **Gradle wrapper JAR:** bu depo wrapper yapılandırmasını ve betiklerini içerir ama ikili
> `gradle/wrapper/gradle-wrapper.jar` dosyasını içermez. `./gradlew` onun eksik olduğunu
> bildirirse, sistemdeki bir Gradle 8.x ile bir kez oluşturun
> (`gradle wrapper --gradle-version 8.9`) veya derlemeyi doğrudan sistem Gradle'ı ile çalıştırın
> (`gradle buildPlugin`).

Marketplace'te yayınlamak bir vendor hesabı gerektirir ve henüz kurulmadı.

## Geliştirme

IDE host'u olmadan çalışabilen tüm mantık
[`KeyflipModels.kt`](src/main/kotlin/dev/keyflip/KeyflipModels.kt) içindedir (`--json`
ayrıştırma + görünüm-modeli şekillendirme — IntelliJ import'u yok) ve
[`KeyflipModelsTest.kt`](src/test/kotlin/dev/keyflip/KeyflipModelsTest.kt) ile birim-testlidir:

```bash
./gradlew test
```

`KeyflipCli.kt` ikiliyi çalıştırır; `dev/keyflip/` geri kalanı ince IntelliJ tutkalıdır
(durum çubuğu widget'ı, araç penceresi, eylemler, ayarlar). VS Code yardımcısının CLI
sözleşmelerini ve geçiş-öncesi-onay / geçiş-sonrası-yeniden-başlatma davranışını birebir
yansıtır.
