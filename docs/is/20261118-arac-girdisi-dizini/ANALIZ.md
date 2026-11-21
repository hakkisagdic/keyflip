# 20261118-arac-girdisi-dizini: Sohbet dizinine dosya yazan araç girdileri

Karar: go (kuyrukta; iki öncelikli projeden sonra). Boyut L. touches: kişisel veri (yeni saklanan içerik, sır riski).

## Bugün ne var
- Dizin `src/convindex.js` (build, chunkConversation, lexical, semantic, contextPack); okuma katmanı `src/conversations.js`; Claude ayrıştırıcı `src/transcript.js` (feedLine).
- Depo SQLite değil: `<configDir>/conv-index/` altında `meta.json`, `chunks/<key>.jsonl`, `tokens/*.t32` (BM25 süzgeci), `vectors/*.f32` (isteğe bağlı gömme). FTS yok, her sorguda tüm parçalar taranır. Dizin `secretpaths.js` SECRET_DIRS içinde: git, yedek ve migrate dışı.
- `transcript.feedLine` yalnız `text` bloklarını alır; `tool_use` için sadece araç ADI saklanır, `input` atılır; `tool_result` atlanır. Bu yüzden heredoc ile yazılan satırlar aranamaz.
- Tetik: `keyflip conv index [--embed|--watch|--schedule]`; zamanlı iş (`schedule.js`, job conv) her 30 dk `conv index --embed` çalıştırır. Değişmeyen kaynak stat ile atlanır; büyüyen oturum baştan ayrıştırılır.
- Kaynaklar: Claude Code, Codex, Kiro (CLI+IDE), Cursor, opencode, Gemini, Copilot, Qoder, Command Code. Araç girdisi taşıyanlar: Claude (`tool_use.input`), Qoder ve Command Code (Claude biçimli), Codex (`custom_tool_call`, `function_call`), Kiro (`toolUse` blokları). Bu makinede dizin: claude 285, codex 284, kiro 4404 kaynak.
- Boşluk: `claudeSources` yalnız `<proje>/<oturum>.jsonl` okur; `<oturum>/subagents/agent-*.jsonl` HİÇ dizinlenmiyor (bu makinede 11.436 dosya, 12,7 GB; üst düzey 300 dosya). Alt ajan satırlarında `sessionId` (ana oturum) ve `agentId` var.
- Mevcut sohbet parçaları maskesiz saklanır; maske yalnız uzak gömme ucuna giderken (`safeForEmbedding`) ve `conv show` çıktısında var. Kazıma işlevleri hazır: `secretscan.redactShapes`, `redactLines`, `scanLabeled`; `secretpaths.isSecretFile`.
- Boyut (yalnız dosya boyutu): dizin 0,92 GB (vektör 552 MB, parça 250 MB, süzgeç 110 MB, meta 9,6 MB); kaynak `~/.claude/projects` 15,6 GB.

## Ne değişecek
- Yeni `src/writeindex.js`: Claude biçimli satırlardan yazma girdisi çıkarır; depo `<configDir>/conv-index/writes/` (aynı SECRET_DIR kapsamında): `events/<yolanahtarı>.jsonl` (ts, oturum, ajan, araç, tür, blob özeti, satır sayısı, olay kimliği), `blobs/<ab>/<sha256>` (maskeli, kırpılmış gövde), `paths.json`.
- Kapsam: Write, Edit (old/new), MultiEdit, NotebookEdit; Bash yalnız dosya yazanlar (`> >>`, `tee`, `sed -i`, `python -c` ile yazma, `cat > f <<EOF`). Yazma saymayız: `git commit`/`gh pr` heredoc'u, `2>/dev/null`. Diğer araç girdileri (Read, Grep, Glob, WebFetch, Task istemi) saklanmaz: içerik değil sorgu; ürettikleri yazma zaten Write/Bash olarak görünür. Çıktılar hiç saklanmaz.
- `conv index` içinde ek geçiş (alt ajan klasörleri dahil, sohbet dizinine alt ajan EKLENMEZ); oturum başına bayt ofseti kontrol noktası, dosya küçülürse baştan.
- Gömme tarafı: araç çağrısı başına tek satır özet ("wrote 120 lines to <yol>") normal parçalara girer. Not: bu CHUNK_SCHEME artışı ister (142 MB yeniden ayrıştırma) ya da özetler ayrı kaynak olarak yazılır; ikincisi seçildi.
- CLI: `keyflip conv writes search "<ifade>" [--path <parça>]`, `keyflip conv file <yol> [--history] [--at <ISO>] [--out f] [--json]`; MCP: salt-okunur `keyflip_conv_writes` (yalnız yol, zaman, satır sayısı, ≤400 karakter maskeli parça).
- Kararlar: maskeleme `redactShapes`+`redactLines`, gövde özeti MASKELİ gövdeden (düşük entropili sırrın özetten sözlükle bulunmasın); `isSecretFile` yollarının (.env, anahtar dosyaları) gövdesi saklanmaz, yalnız özet satırı; kırpma 64 KiB (ilk 48 KiB + son 16 KiB + `«keyflip_truncated N bytes»`); olay kimliği = sha1(oturum dosyası + tool_use id), bu yüzden yeniden dizinleme idempotent; göreli yol olay `cwd`'sine göre çözülür, çözülemeyen hedef `(bash:belirsiz)` altında yalnız ifadeyle aranır; arama düz alt dize/regex (BM25 değil).
- Geri kazanım: olaylar ts, sonra dosya sırasıyla; Write içeriği kurar, Edit old→new uygular (bulunamazsa boşluk), `>>` ekler, `sed -i`/python tekrar oynatılmaz, "oynatılamaz" diye listelenir. Çıktı güven düzeyi taşır: tam (zincir Write ile başlıyor, boşluk yok) / kısmi. Maskeli aralıklar ve kırpılmış gövdeler sayılıp belirtilir.

## Kabul kontrolleri
Hepsi `HOME=<deneme-ev> KEYFLIP_CONFIG_DIR=<deneme-yapı>` ile sahte oturumlarda; gerçek ev dizinine dokunulmaz.
- K1 Verilen: oturumda Bash `cat > <proje>/notes.md <<EOF` ile 20 satır (içinde "MAVIKEDI-4711"). Zaman: `keyflip conv index` sonra `keyflip conv writes search "MAVIKEDI-4711"` ve `keyflip conv writes search --path notes.md`. Sonra: ikisi de bu olayı, oturum kimliği ve 20 satır ile bulur.
- K2 Aynı oturumda bir `tool_result` içine "SADECEKCIKTI-99" koy. Sonra: arama 0 sonuç; `grep -r SADECEKCIKTI-99 <yapı>/conv-index/writes` boş.
- K3 Write girdisine sahte anahtar `sk-ant-` + 30 rastgele harf, `.env` benzeri satıra `API_KEY=hunter2xyz` koy. Sonra: `grep -r` ile ikisi de `writes/` altında bulunmaz, `«keyflip_redacted»` görünür; `conv file` çıktısında da maskeli.
- K4 5 MB'lık bir Write girdisi. Sonra: blob ≤ 64 KiB + işaret; başı ve sonu okunur, `truncated` bayrağı var, işlem hata vermez ve bellek şişmez.
- K5 İki oturumda aynı gövdeyi yaz. Sonra: `writes/blobs` altında tek dosya, `events` altında iki olay.
- K6 Oturumda sırayla Write(3 satır), Edit(bir satırı değiştir), heredoc `>>` (2 satır ekle). Sonra: `keyflip conv file <yol> --history` üç kaydı zaman sırasıyla verir; `--at <Edit'ten sonraki an>` Edit sonrası içeriği, parametresiz son içeriği (3 satır, biri değişmiş, 2 satır eklenmiş) verir; `--out` dosyası sahte oturumdaki beklenen metinle bayt bayt aynıdır; `sed -i` olayı "oynatılamaz" diye görünür.
- K7 Aynı yol hem ana oturumda hem `<oturum>/subagents/agent-X.jsonl` içinde yazılmış. Sonra: geçmiş her iki kaynaktan olayları, alt ajan işaretiyle birlikte listeler; `conv list` sayısı değişmez (alt ajanlar sohbet dizinine girmez).
- K8 `conv index` iki kez, sonra `--force` hariç bir kez daha. Sonra: olay sayısı ve blob sayısı değişmez; ikinci çalıştırma yeni oturum ayrıştırmaz (rapor `reused`), süre ilkinin çok altında.
- K9 Büyüme ölçümü (yalnız sayı yazan akış betiği, içerik yazmaz): tek gerçek 270 MB oturumda ölçüldü: dosya 270,9 MB; sohbet metni 11,3 MB; araç sonuçları 20,4 MB; araç girdileri 13,5 MB. Dosya yazan girdiler: Write 297 çağrı/1,28 MB, Edit 361/0,41 MB, Bash yazma ~2758 çağrı/3,5 MB (3407 heredoc'un yalnız 1437'si dosya yazıyor, 122'si git/gh). Toplam ≈5,2 MB = dosyanın %1,9'u; yinelenen Write/Edit 72 çağrı/0,23 MB; en büyük girdi 35 KB (64 KiB sınırına takılan yok). Özet satırları ~3,4 bin çağrı × ~100 bayt ≈ 0,35 MB. Kabul: yeni geçiş tüm `~/.claude/projects` için çalıştırıldığında `du` artışı, sahibin onayladığı tavanı (aşağıda soru 1) aşmaz; sonucu TEST.md'ye yaz. Düz ölçekleme (%1,9 × 15,6 GB ≈ 0,3 GB) tahmindir; alt ajan oranı ölçülmedi.
- K10 Regresyon: `npm test` yeşil; `conv search/context/show/list` çıktısı ve sıralaması önceki hâliyle aynı (test/convindex.test.js, conversations.test.js, conv-cli.test.js, mcp.test.js); `conv index --schedule-status` değişmez; `writes/` dizini SECRET_DIRS kapsamında (git/yedek/migrate dışı).

## Riskler
- Sır/kişisel veri: yeni, kalıcı bir ikinci kopya; kalıp tabanlı maske düzyazıdaki parolayı kaçırır. Önlem: `isSecretFile` gövde atlama, maske önce hash sonra, 0600, SECRET_DIR, MCP'de kısa parça. Üçüncü kişi/müvekkil verisi dosya gövdesinde olabilir.
- Yanlış geri kazanım: oynatılamayan sed/python, Read'in göremediği önceki içerik, kırpma ve maske yüzünden çıkan dosya gerçeğe uymayabilir. Önlem: güven düzeyi alanı, "tam" yalnız kanıtlı zincirde; sessizce "tam" denmez.
- Ölçek ve süre: ilk geçiş 15,6 GB, 11.436 alt ajan dosyası; canlı oturumun 30 dk'da bir baştan ayrıştırılması. Önlem: ofset kontrol noktası, arka plan + kilit, süre bütçesi; heredoc/yönlendirme ayrımı için sınıflandırıcı regex yanlış pozitif verir (git commit) ve sahte yol bulabilir.
- Bozulabilecek mevcut özellikler (regresyon): conv search/context/show, MCP conv araçları, zamanlı conv işi, meta.json yeniden kullanım yolu (CHUNK_SCHEME artırılmaz).
- Claude Code eski transkriptleri siler: depo kaynağından uzun yaşar, bu yüzden silinen oturumun veri sahibi sorusu açık (soru 1).

## Sahibe sorular
1. Saklama süresi ve tavan: kaynak oturum silindikten sonra da kalsın mı? Öneri: süresiz kalsın, `conv writes prune --older-than` elle, toplam 2 GB uyarısı. Geri alınır (kalırsa silinebilir; silinen geri gelmez).
2. Kapsam: Claude hesabı başına ve müvekkil/hukuk gibi hassas proje oturumları da girsin mi? Öneri: hepsi, `conv.writes.exclude` proje listesiyle dışlanabilir. Geri alınır.
3. Genel ürün mü: keyflip herkese açık ürün; bu özellik açık gelsin mi? Öneri: varsayılan KAPALI, `conv.writes.enabled` ya da `conv index --writes` ile açılır, zamanlı iş sahip açana dek dokunmaz. Geri alınır.
4. MCP: model ajanı (dolayısıyla model sağlayıcısı) maskeli yazma gövdelerini görsün mü? Öneri: MCP yalnız yol/zaman/≤400 karakter; tam gövde ve geri kazanım yalnız CLI'dan. Geri alınır.

## Boyut
L: yeni bir alan (depo + iki CLI komutu + MCP aracı), tahmini 900+ satır, birden fazla geliştirici dilimi. Dilimler:
- D1 çıkarıcı + depo (Claude/alt ajan, maske, kırpma, hash, ofset, idempotent; K2-K5, K7, K8).
- D2 arama + özet satırları + MCP (K1, K10).
- D3 `conv file` geri kazanım (K6).
- D4 diğer ajanlar: Codex, Kiro, Qoder, Command Code (ayrı iş, ayrı onay).
K9 D1 bitince ölçülür.
