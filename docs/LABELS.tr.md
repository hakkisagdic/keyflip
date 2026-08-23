# GitHub Etiketleri

[English](./LABELS.md) | **Turkce**

> keyflip deposu icin onerilen GitHub etiketleri. Sorunlari ve cekme
> isteklerini kategorize etmek icin bu etiketleri tutarli sekilde kullanin.

---

## Sorun Turu

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `bug` | `#d73a4a` | Bir sey dogru calismiyor |
| `feature` | `#a2eeef` | Yeni ozellik veya istek |
| `enhancement` | `#84b6eb` | Mevcut islevsellikte iyilestirme |
| `docs` | `#0075ca` | Dokumantasyon iyilestirmeleri |
| `question` | `#d876e3` | Daha fazla bilgi isteniyor |
| `discussion` | `#f9d0c4` | Acik uclu tartisma konusu |

## Oncelik

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `priority: critical` | `#b60205` | Derhal duzeltilmeli |
| `priority: high` | `#d93f0b` | Mevcut donemde ele alinmali |
| `priority: medium` | `#fbca04` | Onemli ama acil degil |
| `priority: low` | `#0e8a16` | Olsa iyi olur, mumkun oldugunda ele alin |

## Platform

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `platform: macos` | `#c5def5` | macOS'a ozel |
| `platform: linux` | `#c5def5` | Linux'a ozel |
| `platform: windows` | `#c5def5` | Windows'a ozel |
| `platform: wsl` | `#c5def5` | Linux icin Windows Alt Sistemine ozel |

## Modul Alani

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `area: core` | `#d4c5f9` | Temel hesap degistirme mantigi |
| `area: providers` | `#d4c5f9` | Saglayici sistemi ve yonlendirme |
| `area: sessions` | `#d4c5f9` | Oturum yonetimi |
| `area: fleet` | `#d4c5f9` | Filo ve transfer ozellikleri |
| `area: security` | `#d4c5f9` | Guvenlik, kasa ve gizli tarama |
| `area: tui` | `#d4c5f9` | Terminal arayuzu ve panel |
| `area: mcp` | `#d4c5f9` | MCP sunucu entegrasyonu |
| `area: desktop` | `#d4c5f9` | Masaustu ve tarayici entegrasyonu |
| `area: context` | `#d4c5f9` | Bagam katmani ve proje farkindiligi |
| `area: cli` | `#d4c5f9` | CLI komutlari ve arguman ayristirma |

## Is Akisi

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `good first issue` | `#7057ff` | Yeni baslayanlara uygun |
| `help wanted` | `#008672` | Ekstra ilgi gerekiyor |
| `wontfix` | `#ffffff` | Bu uzerinde calisilmayacak |
| `duplicate` | `#cfd3d7` | Bu sorun veya cekme istegi zaten var |
| `invalid` | `#e4e669` | Bu dogru gorunmuyor |

## Durum

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `status: triage` | `#ededed` | Triyaj ve kategorizasyon gerekiyor |
| `status: blocked` | `#b60205` | Baska bir sorun veya dis bagimlilik tarafindan engellenmis |
| `status: in-progress` | `#fbca04` | Su anda uzerinde calisiliyor |
| `status: needs-review` | `#0e8a16` | Incelemeye hazir |
| `status: stale` | `#ededed` | Son zamanlarda etkinlik yok |

## CI/CD

| Etiket | Renk | Aciklama |
|--------|------|----------|
| `ci` | `#f9d0c4` | CI/CD boru hatlariyla ilgili |
| `dependencies` | `#0366d6` | Bagimlilik guncellemeleri |
| `breaking-change` | `#b60205` | Kirilma degisikligi getirir |
| `release` | `#0e8a16` | Surumlerle ilgili |

---

## Kullanim Kilavuzu

1. **Her sorun** en az bir tur etiketi olmali (`bug`, `feature`, `docs`, vb.)
2. **Her sorun** triyaj edildikten sonra bir oncelik etiketi olmali
3. **Platform etiketleri** istege baglidir - yalnizca sorun platforma ozel oldugunda ekleyin
4. **Alan etiketleri** sorunlari dogru bakimciya yonlendirmeye yardimci olur
5. **Durum etiketleri** bir sorunun yasam dongusunu takip eder

## CLI ile Etiket Uygulama

```bash
# Etiket olustur
gh label create "priority: high" --color "d93f0b" --description "Mevcut donemde ele alinmali"

# Tum etiketleri listele
gh label list

# Bir soruna etiket uygula
gh issue edit 42 --add-label "bug,priority: high,platform: macos"
```
