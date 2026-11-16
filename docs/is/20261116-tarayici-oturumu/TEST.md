# TEST: 20261116-tarayici-oturumu

Dal `is/20261116-tarayici-oturumu`, mod `function`. Gerçek CLI, geçici HOME + fixture tarayıcı dizini + sahte `claude` ile çalıştırıldı. Çalışan gerçek Chrome yalnız `--yes`siz yollarda kullanıldı (PID önce/sonra aynı); yeniden açma gerektiren adımlar kapalı Brave fixture'ında koşuldu. Cookie değeri yalnız fixture.

| Kontrol | Sonuç | Kanıt |
|---|---|---|
| K1 `sync` --yes'siz, Chrome açık: plan, çıkış != 0, PID aynı | geçti | `test/browsersync-cli.test.js` K1 (gerçek `pgrep` önce/sonra eşit, çıkış 1, "nothing was changed") |
| K2 `--yes`: plan önce, sonra geri yükleme, doğrulama satırı | geçti | K2 (çıktı sırası Plan < restored < could not verify; cookie DB'de sessionKey var). Açık tarayıcıyı kapatıp yeniden açma yolu birim testte sahte tarayıcıyla: `browserplan.test.js` |
| K3 MCP `confirm`siz dokunmaz, açıklama restart der | geçti | K3 (JSON-RPC: plan + `needsConfirm`, Chrome PID aynı, `synced:[]`); `mcp.test.js` "described as a restart" |
| K4 iki yüzey görünür, uyarı, `--for` | geçti | K4 (CLI alpha / masaüstü beta, "DIFFERENT"; `--for desktop`=beta, `cli`=alpha, hesap adı); K4b: `--for`suz sync tahmin yürütmez, çıkış != 0 |
| K5 kayıtlı oturum yok: yüklemez, 2 adım, çıkış != 0 | geçti | K5 (cookie DB değişmedi, "1. sign into claude.ai", "2. keyflip browser capture --account"); K5b başka hesabın kaydı yüklenmez |
| K6 capture --account, list `web ✓`, başka hesapta reddet | kısmen | K6: okunamayan oturumda kaydetmez, çıkış 1, dosya oluşmaz; K6b: kayıtlı oturumlu hesap `web ✓`, kayıtsız `web —`. Yürütülmedi: gerçek Keychain gerektiren "kaydetti" ve "other-account reddi" CLI uçtan uca; mevcut `app-preserve.test.js` koruması yeşil |
| K7 cookie yok/yanlış org: başarı denmez, verified:false | geçti | K7 (`--json`: `verified:false`, state `unreadable`; "browser session is" yok); sınıflar `browserplan.test.js` classify |
| K8 çıktıda cookie/token yok; yalnız fixture | geçti | tüm CLI/MCP testlerinde `noSecret` (fixture değeri ve `sessionKey=` aranır, bulunmadı); repoda e-posta/yol eklenmedi (diff grep) |
| K9 `npm test`, lint | geçti | `npm test`: 2230 test, 2226 geçti, 0 kaldı, 4 atlandı; `npm run lint` hata 0 (çıkış 0) |
| Regresyon: browserswitch.align, logout/capture koruması, onboard saveBrowserSession, list web | geçti | `browserswitch.test.js`, `app-preserve.test.js`, `browser.test.js` hepsi yeşil (56 test birlikte); K6b list |

## Eklenen test
`test/browsersync-cli.test.js` (10 test; K1 ve K3 çalışan gerçek Chrome yoksa, K2/K7 Brave açıksa atlanır).

## Kalanlar
Başarısız kontrol yok. Notlar:
- Gözlenen: doğrulanamayan sync çıkış kodu 0 verir (ANALIZ'in kararı: uyarı satırı + `verified:false`); beklenen buydu.
- K6'nın Keychain gerektiren olumlu yolu ve K2'nin açık tarayıcıyı gerçekten kapatıp açma adımı canlı makinede yürütülmedi (kullanıcının tarayıcısını yeniden başlatır); birim testlerle kapsandı.
