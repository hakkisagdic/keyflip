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
  "products": {
    "price_1QZexampleStripeProYr000": { "tier": "pro",  "months": 12 },
    "ls_variant_200012":              { "tier": "team", "months": 12 },
    "iyz_prod_pro_monthly":           { "tier": "pro",  "months": 1  },
    "paytr_team_12m":                 { "tier": "team", "months": 12 }
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
mkdir -p issuer/private
node -e '
  const crypto = require("crypto"), fs = require("fs");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // Private: PKCS8 DER -> issuer/private/issuer.key, 0600, never committed.
  fs.writeFileSync("issuer/private/issuer.key",
    privateKey.export({ type: "pkcs8", format: "der" }), { mode: 0o600 });
  fs.chmodSync("issuer/private/issuer.key", 0o600);
  // Public: single-line base64 SPKI DER -> paste into src/license.js PUBKEY_B64.
  console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64"));
'
```

- The **private key** stays at `issuer/private/issuer.key`, `0600`, and is
  **gitignored** (`issuer/private/` is in the repo `.gitignore`). It never leaves
  the issuer host, is never logged, and is never passed on `argv`.
- The **public key** is the single line printed above. Paste it into
  `src/license.js` as `PUBKEY_B64` and ship that. It is the SPKI-DER base64 the
  client's `createPublicKey(..., { format: 'der', type: 'spki' })` expects, so a
  token this issuer signs verifies green in `license.js` `verify()`.

Confirm the round-trip in a throwaway script before release: sign a payload with
`issuer/private/issuer.key`, set `license.setPublicKey(pubB64)`, and assert
`license.verify(token).valid === true`.

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
