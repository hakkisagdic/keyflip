# keyflip license issuer

Internal infrastructure for **minting keyflip license tokens** after a verified
purchase. Zero external dependencies — Node built-ins only (`crypto`, `http`,
`fs`, `path`, `url`), CommonJS, `>=18`.

The issuer is the **only** place that holds the Ed25519 **private key**. Clients
ship `src/license.js` with just the **public** key, so they verify a license
fully offline but can never mint one. See the crypto contract in
[`../src/license.js`](../src/license.js).

---

## The central-selection model

You (the owner) drive the whole issuer from **one file**: `issuer.config.json`.
Edit it, restart the server, done. Nothing else is a source of truth.

```jsonc
{
  // Payment providers this issuer will accept webhooks from. Must be a subset of
  // the four known adapters: iyzico, paytr, lemonsqueezy, stripe.
  "activeProviders": ["iyzico", "paytr", "lemonsqueezy", "stripe"],

  // Which provider serves a buyer from a given region. Exact ISO country code
  // match wins; everything else falls back to "default". "default" is REQUIRED.
  "regionRouting": {
    "TR": "iyzico",          // Turkey -> iyzico (see SECURITY: Stripe is not an option for TR sellers)
    "default": "lemonsqueezy"
  },

  // Map each provider's PRODUCT / PRICE id to the license it grants.
  // The key is whatever id that provider puts in its webhook payload:
  //   stripe        -> Price id, e.g. "price_1QZ..."
  //   lemonsqueezy  -> Variant id, e.g. "ls_variant_100012"
  //   iyzico        -> your product code, e.g. "iyz_prod_pro_yearly"
  //   paytr         -> your product code, e.g. "paytr_pro_12m"
  // tier is "pro" | "team"; months is a positive integer (1 = monthly, 12 = yearly).
  // Until you replace them, every id below is a "REPLACE_…" PLACEHOLDER: the
  // issuer refuses it (a purchase with that id mints nothing) and prints a
  // "not ready" warning at startup. See "Turning the switch on" below.
  "products": {
    "REPLACE_stripe_pro_yearly": { "tier": "pro",  "months": 12 },
    "REPLACE_lemonsqueezy_team_yearly": { "tier": "team", "months": 12 },
    "REPLACE_iyzico_pro_monthly":    { "tier": "pro",  "months": 1  },
    "REPLACE_paytr_team_yearly":     { "tier": "team", "months": 12 }
  },

  // Default license lifetime (days) when a product/flow doesn't override it.
  // 400 gives a yearly plan comfortable slack for clock skew + grace.
  "licenseTtlDaysDefault": 400
}
```

> `issuer.config.json` is **plain JSON — no comments allowed**. The `//` notes
> above document the *shape* only; the real file (checked in beside this README)
> has none. `config.js` validates the file at boot and **fails closed** (throws
> `BAD_ISSUER_CONFIG`) on anything malformed — an unknown provider, a route to a
> non-active provider, a missing `default`, a bad tier/months, etc.

`config.js` turns that file into three answers the server needs:

| function | answers |
| --- | --- |
| `providerForRegion(cfg, regionCode)` | which provider serves this buyer (falls back to `regionRouting.default`) |
| `tierForProduct(cfg, providerProductId)` | `{ tier, months }` for a purchased id, or `null` if unknown |
| `secretEnvFor(providerId)` | the **NAME** of the env var holding that provider's webhook secret (never the value) |

---

## Running the issuer

```bash
# 1. from the repo root
cd issuer

# 2. generate + protect the private key (once — see below)
#    ... produces issuer/private/issuer.key (mode 0600)

# 3. export each active provider's webhook secret into the environment (below)

# 4. start the webhook/issuer server (zero deps)
node server.js        # (the HTTP server module; reads process.env at request time)
```

`config.js` / `config.test.js` are standalone and need no key or secrets:

```bash
node --test issuer/**/*.test.js
```

---

## Generating & protecting the private key

The private key is an **Ed25519 PKCS8** key. Generate it locally and write it to
`issuer/private/issuer.key` with mode `0600` (owner read/write only):

```bash
node issuer/keygen.js
```

That writes the private key to `issuer/private/issuer.key` (`0600`, in a `0700`
directory) and prints **only the public key** — the single line you paste into
`src/license.js` as `PUBKEY_B64`. It refuses to overwrite an existing key unless
you pass `--force` (a second run must never silently destroy the signing key).

- The **private key** stays at `issuer/private/issuer.key`, `0600`, and is
  **gitignored** (`issuer/private/` is in the repo `.gitignore`). It never leaves
  the issuer host, is never logged, and is never passed on `argv`.
- The **public key** is the single line printed above. Paste it into
  `src/license.js` as `PUBKEY_B64` and ship that. It is the SPKI-DER base64 the
  client's `createPublicKey(..., { format: 'der', type: 'spki' })` expects, so a
  token this issuer signs verifies green in `license.js` `verify()`.

> **Back the private key up NOW, encrypted, off this machine.** It is the only
> thing that can sign a license. If it is lost, every license you have already
> sold becomes unverifiable for every new customer, and the only fix is to
> generate a new keypair and ship a new `PUBKEY_B64`. Keep it in a password
> manager or an encrypted backup — never in git, never in a chat, never in a
> shell history.

Confirm the round-trip in a throwaway script before release: sign a payload with
`issuer/private/issuer.key`, set `license.setPublicKey(pubB64)`, and assert
`license.verify(token).valid === true`. The shipped build already has the public
key embedded, so the shortest check is:

```bash
node issuer/sign.js --tier pro --email you@example.com   # prints a token
keyflip license activate <file-with-that-token>           # -> "activated: pro"
```

### Rotating the key

Generate a new keypair (`node issuer/keygen.js --force`), paste the **new**
public key into `src/license.js` `PUBKEY_B64`, publish a release — and
**reissue** every license you still owe customers, because licenses signed by
the old key stop verifying the moment the new key ships. There is no way around
this: the verification key is embedded in the client, so rotation is a client
update.

---

## Turning the switch on — the activation runbook

Everything below is an **owner** step; the code for it is already in the repo.
Do them in this order, and do not skip step 4.

| # | step | where | what "done" looks like |
|---|---|---|---|
| 1 | the keypair exists | `issuer/private/issuer.key` (0600) + `PUBKEY_B64` in `src/license.js` | `node issuer/keygen.js` printed the public key; it is pasted into `src/license.js` |
| 2 | the private key is backed up | your password manager / encrypted backup | you can restore it on a clean machine **and sign a token** |
| 3 | the PSP accounts exist | iyzico, PayTR, Lemon Squeezy, Stripe dashboards | you have the product/price ids and the webhook signing secrets |
| 4 | the product ids are filled in | `issuer/issuer.config.json` | no key starts with `REPLACE_` anymore |
| 5 | the checkout URLs are filled in | `website/src/checkout.config.json` | the Buy buttons point at real checkout pages, and `salesOpen` is `true` |
| 6 | the paywall is switched on | the environment that runs keyflip | `KEYFLIP_LICENSING=1` |

**Step 4 in detail.** Every product slot in `issuer.config.json` ships as a
`REPLACE_…` placeholder. Replace the **key** (not the value) with the real id
your provider sends in its webhook:

```jsonc
// before                          // after
"REPLACE_stripe_pro_yearly": {      "price_1QZrealProYearly000": {
  "tier": "pro", "months": 12         "tier": "pro", "months": 12
}                                  }
```

Id shapes: `stripe` → `price_1QZ…`, `lemonsqueezy` → `ls_variant_…`, `iyzico` →
your product code, `paytr` → your product code.

An unfilled slot is **refused**, not guessed: `tierForProduct()` returns `null`
for a `REPLACE_…` id, so a purchase carrying it mints nothing (HTTP 422) and the
event log records `webhook.unmapped` **with the product id in the note** — paste
that id straight into the config. The issuer also prints a `{"evt":"config",
"ready":false}` line at startup while any slot is unfilled, so you cannot miss it.

**Step 6 in detail.** `KEYFLIP_LICENSING=1` is what actually turns the paywall
on. Until then `requireTier()` is a no-op and every feature is free — that is
deliberate, so a half-finished launch never blocks a paying customer. Set it in
the environment that runs keyflip (your shell profile, a launchd plist, a
systemd `EnvironmentFile`, your CI release step) — **not** in a committed file.

---

## Setting each provider's webhook secret (env only)

Webhook signing secrets come from **`process.env` only** — never from
`issuer.config.json`, never from `argv`. `config.js` `secretEnvFor(providerId)`
returns the env var **NAME(s)**; the server reads `process.env[name]` at request
time and uses `crypto.timingSafeEqual` for every signature comparison.

| provider | env var name(s) | where to get it |
| --- | --- | --- |
| `stripe` | `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Developers → Webhooks → signing secret (`whsec_...`) |
| `lemonsqueezy` | `LEMONSQUEEZY_WEBHOOK_SECRET` | Lemon Squeezy → Settings → Webhooks → signing secret |
| `iyzico` | `IYZICO_WEBHOOK_SECRET` | iyzico merchant panel notification/callback secret |
| `paytr` | `PAYTR_MERCHANT_KEY`, `PAYTR_MERCHANT_SALT` | PayTR merchant panel (key **and** salt — a pair) |

```bash
export STRIPE_WEBHOOK_SECRET='whsec_...'
export LEMONSQUEEZY_WEBHOOK_SECRET='...'
export IYZICO_WEBHOOK_SECRET='...'
export PAYTR_MERCHANT_KEY='...'
export PAYTR_MERCHANT_SALT='...'
```

Use a process manager / secret store (systemd `EnvironmentFile` with `0600`, a
vault, etc.) — do **not** put these in a committed `.env`. (`.env`, `.env.*`,
`*.key`, `*.pem`, `secrets*` are all gitignored.)

---

## The admin panel — issue, reissue, revoke, look up

`admin.js` is the operator's view of the same issuer. It serves **both** a JSON
API under `/admin/api/*` and a tiny single-page UI at `/admin` (no build step,
no framework, no CDN — the UI is a thin client over the very same API, so
there is no privileged path the API cannot do).

Start the issuer with the admin token in the environment and open the panel:

```bash
export KEYFLIP_ISSUER_ADMIN_TOKEN='<a long random string>'
node server.js
# -> http://127.0.0.1:8787/admin
```

| method | path | what it does |
| --- | --- | --- |
| `GET` | `/admin/api/licenses?email=&tier=&status=&q=&limit=` | list issued licenses, newest first |
| `GET` | `/admin/api/licenses/:id` | look one up |
| `POST` | `/admin/api/licenses` | issue one — body `{ email, tier, months }` |
| `POST` | `/admin/api/licenses/:id/revoke` | revoke — body `{ reason }` |
| `POST` | `/admin/api/licenses/:id/reissue` | mint a replacement — body `{ months }` |
| `GET` | `/admin/api/events?limit=` | the webhook event log |

Every request needs `Authorization: Bearer <KEYFLIP_ISSUER_ADMIN_TOKEN>`. The
token is compared in constant time, and **with no token configured the panel
answers 503 and does nothing** — it fails closed, it never falls open because
someone forgot to set it. A token in the query string is *not* accepted (query
strings end up in logs).

```bash
curl -s -X POST http://127.0.0.1:8787/admin/api/licenses \
  -H "authorization: Bearer $KEYFLIP_ISSUER_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"customer@example.com","tier":"pro","months":12}'
```

The response carries the license **token exactly once** — that response is the
delivery channel to the customer. The token is never written to disk, never
logged and never put in the event log: `store.js` has no API that can hold one
(the store's `create()` takes no token argument at all), so a leaked state file
cannot unlock anything. `issuer/state/` (the license records, the event log and
the idempotency ledger) is gitignored.

**Revoke means what it can mean.** A keyflip license is verified *locally*
against an embedded public key with no phone-home — that is the product promise,
and it also means an already-activated license **cannot be un-activated from
the server**: at verify time there is nobody to ask. So `revoke` records the
revocation, marks the record in the panel and stops the issuer from reissuing
that license id; the customer's existing token stays valid until it **expires**.
To shorten a customer's access for real, **reissue** a fresh license with a
shorter expiry — they activate the new token and the old one stops mattering
when it lapses. A true remote kill-switch would require a phone-home check,
which keyflip deliberately refuses to ship.

---

## SECURITY

- **Private key never in git, never logged, never on argv.** It lives only at
  `issuer/private/issuer.key` (`0600`), which is gitignored. If it leaks, anyone
  can mint licenses — rotate by generating a new keypair and shipping a new
  `PUBKEY_B64` in `src/license.js`.
- **Webhook secrets never in git, never logged.** They exist only as environment
  variables read at request time. `config.js` deliberately resolves only the env
  var **NAME** and never reads the value, so a secret can't be captured into
  config, a log line, or an error message via this layer.
- **Verify before you trust.** Each provider adapter's `verifyWebhook` checks the
  signature over the **exact raw request bytes** (never re-serialized JSON) using
  `crypto.timingSafeEqual`; only then does `parseEvent` extract the purchase.
- **Fail closed.** `config.js` throws on a malformed config, and unknown product
  ids resolve to `null` — the issuer refuses to mint a license it can't map to a
  known tier rather than guessing.
- **Stripe is not available to TR-registered sellers**, per the productization
  decision. That is why `regionRouting.TR` points at **iyzico** (with **PayTR**
  as the other Turkish option) and Stripe is used only for non-TR regions via the
  `default` route. Do not route `TR` to `stripe`.

---

## Türkçe özet

Bu klasör, satın alma doğrulandıktan sonra keyflip **lisans jetonlarını üreten**
dahili altyapıdır. Tüm ayarlar tek dosyadan yönetilir: `issuer.config.json`
(hangi bölge hangi sağlayıcıya gider, hangi ürün hangi tier'ı verir, varsayılan
lisans süresi). **Özel Ed25519 anahtarı** yalnızca `issuer/private/issuer.key`
içinde (`0600`, git'e **asla** eklenmez) durur; istemciye yalnızca **açık**
anahtar gider. Sağlayıcı **webhook gizli anahtarları** yalnızca ortam
değişkenlerinden (`process.env`) okunur; `config.js` yalnızca değişkenin
**adını** çözer, değerini asla okumaz/loglamaz. Türkiye'de kayıtlı satıcılar
Stripe kullanamadığı için **TR bölgesi iyzico'ya** (alternatif olarak PayTR)
yönlendirilir; Stripe yalnızca TR dışı bölgelerde (`default`) kullanılır.

**Yönetim paneli** (`admin.js`): `/admin` altında tek sayfalık bir arayüz ve
`/admin/api/*` altında JSON API. Panel, `KEYFLIP_ISSUER_ADMIN_TOKEN` ortam
değişkeni olmadan **kapalıdır** (503) — "unutuldu" diye açılmaz. Token sabit
zamanlı karşılaştırmayla doğrulanır ve **yalnızca bir kez** gösterilen lisans
jetonu diske/loga asla yazılmaz. `revoke`, **çevrimdışı doğrulanan** bir
lisansı uzaklaştıramaz (doğrulama sırasında sorulacak bir sunucu yoktur);
gerçek kısaltma **reissue** ile yapılır: daha kısa süreli yeni bir lisans
minted edilir.

**Aktivasyon (sahibin yapacağı işler, sırayla):**

1. `node issuer/keygen.js` → özel anahtar `issuer/private/issuer.key` (`0600`),
   **açık** anahtar ekrana yazılır; `src/license.js` içindeki `PUBKEY_B64`
   satırına yapıştırılır.
2. **Özel anahtarı şimdi yedekleyin** (şifreli, bu makineden dışarıda). Kaybolursa
   bundan sonra hiçbir lisans imzalanamaz; tek çare yeni anahtar çifti üretip
   `PUBKEY_B64`'yi güncellemektir.
3. PSP hesapları açılır (iyzico / PayTR / Lemon Squeezy / Stripe); ürün/fiyat id'leri
   ve webhook imza gizli anahtarları alınır.
4. `issuer/issuer.config.json` içindeki her `REPLACE_…` **anahtarı** gerçek ürün
   id'siyle değiştirilir. Boş bırakılan slot **reddedilir** (tier verilmez),
   başlangıçta `{"evt":"config","ready":false}` uyarısı çıkar ve eşleşmeyen
   webhook olayında **ürün id'si loga yazılır** — hangi id'nin ekleneceği
   bellidir.
5. `website/src/checkout.config.json` içindeki gerçek checkout/portal adresleri
   yazılır ve `salesOpen` `true` yapılır.
6. **Ödeme duvarı açılır:** keyflip'in çalıştığı ortamda `KEYFLIP_LICENSING=1`
   (commit edilmiş bir dosyaya değil, ortama).

Anahtar değiştirme (rotasyon): yeni anahtar çifti üretilir, `PUBKEY_B64`
güncellenip yeni sürüm yayınlanır; **eskiden imzalanmış lisanslar yeni anahtarla
doğrulanamaz**, bu yüzden müşterilere lisans yeniden verilmelidir.
