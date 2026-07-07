# Porting keyflip beyond macOS (roadmap #2)

keyflip's account **switching, providers, sessions, backup, migrate, sync, transfer,
proxy** are cross-platform today. The **surface-capture / cross-account features that
read the OS credential store or decrypt browser/desktop secrets** are macOS-only. This
doc is the concrete map to finish Windows + Linux — written so the work is well-defined
before the (device-gated) implementation.

> Status: **planned.** Every macOS-only path already fails with a clear message; this
> doc says exactly what each platform needs and where.

## Support matrix

| Feature | macOS | Windows | Linux | Blocking primitive |
|---|:--:|:--:|:--:|---|
| Switch accounts (CLI cred) | ✅ | ✅ | ✅ | file store / (mac) Keychain |
| Providers, proxy, backup, sessions, migrate, sync, transfer | ✅ | ✅ | ✅ | none |
| CLI credential in OS keychain | ✅ Keychain | ⬜ Credential Manager / DPAPI | ⬜ libsecret (file fallback works) | secret store |
| Desktop-app login capture/switch | ✅ | ◑ (app exists) | ✖ (no app) | app token + Cookies decrypt |
| Detect desktop account | ✅ | ◑ | ✖ | `Claude Safe Storage` key |
| Browser (claude.ai) read / logout / **session snapshot+restore** | ✅ | ⬜ | ⬜ | cookie decrypt |
| Onboard browser+desktop capture | ✅ | ◑ | ◑ (browser only) | the two rows above |

✅ done · ◑ partial/feasible · ⬜ needs work · ✖ not applicable

## 1. Browser cookie decryption (`src/browser.js`, `src/chat.js`)

macOS uses Chromium's **v10** scheme: `AES-128-CBC`, key = `PBKDF2(safeStorageKey,
'saltysalt', 1003, 16, sha1)`, IV = 16 spaces; the `safeStorageKey` comes from the login
Keychain (`<Browser> Safe Storage`). `catalog(home)` hard-codes macOS `Application
Support` paths and Keychain service/account.

**Windows (DPAPI + AES-GCM v10):** ✅ CRYPTO SHIPPED — `src/wincrypt.js` (fixture-tested):
- `masterKey(localState)` reads `os_crypt.encrypted_key`, strips the `DPAPI` prefix, and
  DPAPI-decrypts it via **PowerShell** `[Security.Cryptography.ProtectedData]::Unprotect(...)`
  (zero-dep, current-user scope; the shell runner is injectable for tests).
- `decryptValue(value, key)` handles `v10`/`v11` = `AES-256-GCM` (3-byte prefix + 12-byte nonce +
  ciphertext + 16-byte tag) — round-trip-verified against Chromium's exact encryption.
- **Remaining (device-gated):** wire these into `appauth.js` account detection on a real Windows
  box (the reader now exists; the macOS path is untouched). **v20 (app-bound)** still can't be
  user-decrypted → the snapshot/restore fallback (copy encrypted rows verbatim) applies.
- Cookies DB: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Network\Cookies` (Brave/Edge analogous).

**Linux (libsecret / kwallet, AES-CBC v11 or v10):**
- Cookies DB: `~/.config/google-chrome/Default/Cookies` (Chromium `~/.config/chromium`, etc.).
- Key: from the desktop keyring via `secret-tool lookup application <chrome|chromium>`
  (libsecret). If no keyring (`v10`), Chromium uses the hard-coded password `"peanuts"`.
  Scheme is otherwise the macOS v10/v11 CBC math → reuse `chat.decryptCookie` with the
  platform key.

**Seam:** make `catalog(home)` / `safeKey(b)` platform-dispatched:
```js
function catalog(home, platform) {
  platform = platform || process.platform;
  if (platform === 'win32') return winCatalog(env());       // %LOCALAPPDATA% paths + Local State key
  if (platform === 'linux') return linuxCatalog(home);      // ~/.config paths + secret-tool
  return macCatalog(home);                                  // today's code
}
function safeKey(b, runner) { /* dispatch: security (mac) | PowerShell DPAPI (win) | secret-tool (linux) */ }
```
`decryptCookie` stays the crypto core; add a `v20`/GCM branch for Windows. The
snapshot/restore path (`snapshotClaudeCookies`/`restoreClaudeCookies`) is already
decrypt-free and only needs the platform Cookies path — it ports first and cheapest.

## 2. CLI credential store (`src/stores/`)

`HybridStore`→`KeychainStore` (macOS `security`) with a **`FileStore` fallback that
already works on every OS** (`<configDir>/creds/<name>.cred`, 0600). So switching works
cross-platform now. Optional hardening:
- **Windows:** back the store with Credential Manager (`cmdkey`/`PowerShell
  Get-StoredCredential`) or DPAPI-encrypt the `.cred` files.
- **Linux:** back with libsecret (`secret-tool store/lookup`).
Both are drop-in `Store` implementations behind `createStore()` (`src/stores/index.js`).
Not required for parity — the file store is the safe default.

## 3. Desktop app (`src/appauth.js`, `src/platform.js`)

- **Windows:** Claude Desktop exists. `config.json` lives at `%APPDATA%\Claude\config.json`
  (`ctx.appDataDir` already resolves this). The token cache is Electron `safeStorage` →
  **DPAPI** on Windows (not the mac `v10`+Keychain scheme), so `decryptBlob` +
  `getSafeStoragePassword` need a Windows branch (DPAPI unprotect, no keychain password).
  `isDesktopAppRunning`/`quitClaude`/`openClaude` already have `win32` branches; verify the
  process name + `taskkill`/`start` relaunch. Then capture/switch/detect all light up.
- **Linux:** no Claude desktop app → these features stay N/A (correct as-is). Onboard on
  Linux should do the **browser + CLI** capture and skip the desktop step (the loop already
  gates desktop capture on `ctx.appDataDir`, which is `null` on Linux — so this already
  degrades correctly; just confirm the messaging reads right).

**Seam:** `decryptBlob(b64, ctx)` and `getSafeStoragePassword(ctx)` dispatch on
`ctx.platform`; `detectAppAccount`'s allowlist/folder logic is already platform-neutral.

## 4. `keyflip onboard` on each platform (`cmdOnboard`)

Already structurally portable: the desktop step is gated on `ctx.appDataDir`, the browser
steps on `ctx.platform === 'darwin'`. To finish:
- **Windows:** flip the browser-clear/`saveBrowserSession` guards from `=== 'darwin'` to a
  `browserSupported(platform)` helper once §1 lands; desktop capture works once §3 lands.
- **Linux:** browser steps behind the same helper; desktop step already skipped.

## 5. Test strategy

- Unit-test the platform dispatchers with **fixtures** (a fake `Local State` + encrypted
  cookie for Windows; a `secret-tool` stub for Linux) — no real OS keyring needed, mirroring
  how `test/appauth.test.js` injects `ctx.safeStoragePassword` and `test/browser.test.js`
  stubs the `sqlite3` runner.
- Gate the true end-to-end (real keyring/DPAPI) tests behind an opt-in env var, like
  `test/keychain.real.test.js` (`KEYFLIP_REAL_KEYCHAIN=1`).
- CI: the existing suite already runs on Linux/Windows for the platform-neutral features;
  add a Windows job once §1/§3 land.

## Suggested order

1. **Browser snapshot/restore path on Windows+Linux** (decrypt-free, highest value for
   the extension-mismatch + browser-sync features) — just the Cookies path per platform.
2. **Windows desktop capture** (DPAPI `decryptBlob`) — unlocks detect/capture/switch there.
3. **Full cookie decryption** (Windows GCM + DPAPI key, Linux libsecret) for `browser status`.
4. **Optional keyring-backed credential stores.**
