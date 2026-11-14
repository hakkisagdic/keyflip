# Durum Panosu Şeması (`status.json`)

Keyflip Kontrol Merkezi (`apps/menubar` ve `keyflip daemon control-center`), makine veya geliştirme ortamındaki herhangi bir dış toplayıcının ürettiği genel bir **Durum Panosu (`status.json`)** dosyasını izleyebilir ve menü çubuğunda gösterebilir.

Ürün kodunda herhangi bir yönetici aracına, kişiye veya projeye özel sabit yol ya da isim gömülü değildir:
- **Varsayılan yol (ayar):** `menubar.statusFile` (`~/.polyctl/admin/status.json`)
- **Özelleştirme:**
  - CLI veya Daemon üzerinden: `keyflip config set menubar.statusFile ~/path/to/status.json`
  - Menü çubuğu uygulaması **Tercihler** bölümünden veya `KEYFLIP_STATUS_FILE` ortam değişkeniyle.
- **Dosya yoksa:** Durum panosu bölümü menü çubuğu penceresinde tamamen gizlenir; hata üretilmez.

---

## 1. JSON Şeması

```json
{
  "updated": "2026-11-14T18:25:00Z",
  "sections": [
    {
      "id": "quotas",
      "title": "Kotalar",
      "rows": [
        {
          "label": "Claude Max (birincil)",
          "value": "%82 (5s)",
          "status": "warn",
          "detail": "Sıfırlama 19:40",
          "since": "2026-11-14T18:00:00Z"
        },
        {
          "label": "Kiro Aylık",
          "value": "0.21 / 50",
          "status": "ok",
          "detail": "Sıfırlama 1 Ara",
          "since": "2026-11-14T18:20:00Z"
        }
      ]
    },
    {
      "id": "services",
      "title": "Servisler",
      "rows": [
        {
          "label": "Yerel Yönlendirici",
          "value": "çalışıyor",
          "status": "ok",
          "detail": "127.0.0.1:8092",
          "since": "2026-11-14T09:00:00Z"
        }
      ]
    }
  ],
  "owner_needed": [
    {
      "project": "keyflip",
      "text": "feat/control-center dalı incelemeye hazır"
    }
  ]
}
```

---

## 2. Alan Tanımları

| Alan | Tür | Zorunlu | Açıklama |
|---|---|---|---|
| `updated` | `string` (ISO-8601) | Evet | Dosyanın üretildiği zaman damgası. Şu andan **20 dakikadan eskiyse** arayüzde `"veri eski"` uyarısı gösterilir. |
| `sections` | `Array<Section>` | Evet | Açılır/kapanır durum bölümleri listesi. |
| `sections[].id` | `string` | Evet | Bölüm kimliği. Standart kimlikler: `quotas`, `projects`, `agents`, `services`, `backups`, `embedding`, `machine` (özel kimlikler de desteklenir). |
| `sections[].title` | `string` | Evet | Kullanıcıya gösterilecek bölüm başlığı. |
| `sections[].rows` | `Array<Row>` | Evet | Bölüm içindeki durum satırları. |
| `rows[].label` | `string` | Evet | Satırın sol etiketi. |
| `rows[].value` | `string` | Evet | Satırın sağ değer metni. |
| `rows[].status` | `"ok" \| "warn" \| "bad" \| "unknown"` | Evet | Satırın sağlık durumu. Sıralamada her zaman **`bad` en üstte, ardından `warn`, sonra `ok` ve `unknown`** gelir. |
| `rows[].detail` | `string` | Hayır | İkincil açıklama metni. |
| `rows[].since` | `string` | Hayır | Durumun başlangıç zamanı veya süresi. |
| `owner_needed` | `Array<OwnerItem>` | Hayır | Sahipten/kullanıcıdan karar veya eylem bekleyen maddeler. |
| `owner_needed[].project` | `string` | Evet | İlgili proje veya bileşen adı. |
| `owner_needed[].text` | `string` | Evet | Beklenen eylem veya karar açıklaması. |

---

## 3. Arayüz Davranış Kuralları

1. **Menü Çubuğu Rozeti (`owner_needed`):**
   - `owner_needed` dizisinde eleman varsa (`count > 0`), menü çubuğu simgesinde bekleyen karar sayısı rozet (`• <sayı>`) olarak görünür ve açılır pencerenin en üstünde **Sahipten Bekleyenler** kutusu listelenir.
2. **Öncelikli Sıralama (`bad` ve `warn` üstte):**
   - Her bölümün satırları (`rows`), kaynak dosyadaki sıradan bağımsız olarak önem derecesine göre kararlı biçimde sıralanır: `bad` (0) → `warn` (1) → `ok` (2) → `unknown` (3).
3. **Açılır / Kapanır Bölümler:**
   - Her `section` başlığı tıklanarak açılıp kapatılabilir (`DisclosureGroup`); başlıkta bölüm içindeki `bad` ve `warn` sayıları özet rozet olarak gösterilir.
4. **Bayat Veri Uyarısı (20 Dakika Kuralı):**
   - `updated` alanı (veya geçersizse dosya değiştirilme zamanı) 20 dakikadan (`1200` saniye) eskiyse pano başlığında **"veri eski"** uyarısı gösterilir.
