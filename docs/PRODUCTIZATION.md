# keyflip — Productization plan

> Status: **plan.** How keyflip goes from an open-source CLI to a paid product **without breaking its
> brand promises** (local-first, zero-telemetry, zero-dependency). The licensing primitive ships as
> `src/license.js` (offline Ed25519 verification, no phone-home); everything else here is the
> business/infra layer around it.

## 1. Model: open-core + offline signed licenses

keyflip's differentiators are privacy and locality. A phone-home license server would betray that, so:

- **Open core, free forever:** single-machine account switching, providers, proxy, sessions, backup,
  migrate, foreign-session import, the base MCP surface. This stays MIT/open on npm — it's the funnel.
- **Paid tiers unlock advanced features** via an **offline, signed license** — a token
  `{ tier, email, expiry, issued }` signed with an **Ed25519** key (the same crypto the fleet already
  uses for origin auth). keyflip verifies the signature **locally** against an embedded public key.
  No network call, works air-gapped, nothing to leak. (`src/license.js`: `verify` / `activate` /
  `tier` / `requireTier`.)
- **Enforcement:** each paid command handler calls `license.requireTier(ctx, feature)` at the top;
  the same gate guards the corresponding MCP tools. Free users get a clear upgrade message, never a crash.

### Tiers (starting point — tune with data)

| Tier | Price (indicative) | Unlocks |
|---|---|---|
| **Free** | $0 (open source) | switch, providers, proxy, sessions, backup, migrate, foreign import, base MCP |
| **Pro** | ~$8–12/mo | fleet, orchestrator/jobs/fanout, cost intelligence, budgets, notify, autoswitch, router+cache |
| **Team** | ~$6–10/seat/mo | team pool (RBAC), policy engine, vault backend, swarm (own-fleet exec), audit export, SSO |
| **Enterprise** | custom | self-host license issuer, priority support, custom policy, procurement/invoicing |

Feature→tier map lives in `license.FEATURES` so it's one edit to re-slice.

## 2. Payment gateway — Turkey-based seller (researched 2026-07; **re-verify rates before signing up**)

**Hard constraint: Stripe does NOT support Türkiye-registered businesses** — you cannot open a native
Stripe account with a TR entity. (Workarounds: a US LLC via Stripe Atlas — extra cost/complexity — or
use an MoR that pays out to Turkey.) So the realistic choices are a **Merchant of Record (MoR)** for
global sales and/or a **local Turkish PSP** for domestic cards.

### Tax context (big win, decide the structure around it)
- **Service-export exemption raised to 100% from 1 Jan 2026** for digital products "utilized abroad";
  **export VAT is 0%**. Selling to non-TR customers is very tax-efficient for a TR entity.
- **1% withholding** on e-commerce intermediary payouts (since Jan 2025) applies to local PSP flows.
- You need a registered business; a **şahıs şirketi (sole proprietorship) is enough** for PayTR/iyzico.

### Option A — Merchant of Record (global customers; MoR remits all foreign VAT/tax for you)

| Provider | Fee (≈) | All-in @ $300/mo | Payout to TR | TRY? | Subs | Notes |
|---|---|---|---|---|---|---|
| **Lemon Squeezy** | 5% + $0.50, +1% intl payout | **~6.6%** (lowest MoR) | bank/PayPal/Wise | no | yes | Cheapest MoR. Acquired by Stripe (2024) → migrating to "Stripe Managed Payments" (35+ countries, expanding) — **verify TR is live** before committing. |
| **Polar.sh** | 5% + $0.50 (+1.5% intl cards) | ~8% | via Stripe Connect | **yes (TRY)** | yes | Dev/OSS-friendly; can land funds in a TR bank in TRY. Newer. |
| **Paddle** | 5% + $0.50 + $15 SWIFT/payout | ~10% | wire / Payoneer | no (USD/EUR/GBP) | yes | Most established, rock-solid; highest cost; TR sellers supported. |
| **Gumroad** | ~10% flat | ~10% | PayPal | no | limited | Simplest for a first license-key sale; high fee. |

### Option B — Local Turkish PSP (domestic customers; TRY, installments/"taksit", e-fatura)

| Provider | Commission (≈) | Settlement | Subs | Intl cards | Requirement |
|---|---|---|---|---|---|
| **PayTR** | **~1–2.2%** (lowest) | next day | yes (no extra fee) | yes (USD/EUR) | tax reg / şahıs OK |
| **iyzico** | ~2.2–4.3% (+ ~199 TL/mo for subscriptions) | weekly | yes | limited (strict 3DS) | NFC chip-ID KYC |
| **Param / iPara** | ~2.2% (iPara volume-based from ~1%) | varies | yes | yes | company |
| **Shopier** | ~3–5% | Wednesdays | **one-time only** | possible | easiest onboarding |
| **Bank virtual POS** (Garanti/İş/YKB…) via **Craftgate/PayTR** aggregator | **~1.5–2.5%** (negotiable, taksit) | per bank | yes | yes | company + bank agreement (**"POS alarak ilerleriz"** path) |

### Recommendation (my pick — "en uygun / en düşük masraflı")

keyflip's revenue is mostly **international** (a global dev tool), and the founder is TR-based, so:

1. **Primary: a Merchant of Record for the global launch → lowest cost-of-effort.** Pick order:
   **Lemon Squeezy** (cheapest, ~6.6% — *if* TR payout is live post-migration) → else **Polar.sh**
   (pays TRY, dev-friendly) → **Paddle** (fallback, pricier but bulletproof). The MoR's ~5–8% *buys
   you out of registering for VAT in dozens of countries* — for a solo founder that's almost always
   cheaper all-in than a bare gateway. **Zero own-infra to build for cards.**
2. **Add PayTR for Turkish customers** once a şahıs şirketi exists — lowest raw fee (~1–2%), taksit,
   next-day, e-fatura. Route TR cards to PayTR, everyone else to the MoR.
3. **Absolute-lowest-fee path (more build): bank virtual POS via Craftgate/PayTR + our own checkout +
   license-issuer.** Only worth it at real volume. **Never handle raw card data yourself** (PCI-DSS
   scope is enormous) — the bank/PSP tokenizes; you build only the checkout page + webhook →
   license-issuer orchestration. This is the "kendimiz yazarız / POS alarak ilerleriz" option, done
   safely.

**Chosen default to build against: Lemon Squeezy (MoR) primary + PayTR (local) secondary**, both feeding
the same license-issuer. This gets a global paid launch live fastest with the least fee/effort, and the
PayTR leg captures TR customers at the lowest domestic rate. Re-verify LS Turkey eligibility first; if
it's not live, swap in Polar.sh with no other change (same webhook→issuer contract).

**Fulfillment flow (provider-agnostic):** `payment succeeded` webhook → a tiny **license-issuer**
service verifies the webhook signature, signs an Ed25519 license for `{tier, email, expiry}`, and
delivers it (email + customer portal). Subscription lifecycle (renew/cancel/refund) re-issues or
shortens `expiry`. The issuer is the ONLY component holding the private key (in a KMS/secret store,
never in git). The SAME issuer serves any provider — MoR or PayTR — so the payment choice is swappable.

Sources (re-verify — rates/eligibility drift): Lemon Squeezy supported countries + getting-paid docs;
Paddle supported-countries + get-paid docs; the Türkiye SaaS-payments cost breakdown at
ceaksan.com/en/saas-payment-infrastructure-turkey; iyzico/PayTR 2026 komisyon comparisons (moyduz,
wionsoft, poskomisyon).

## 3. Components & phased roadmap

**Phase 1 — licensing primitive (in-repo, ships first):**
`src/license.js` (offline verify + tier gate) + `keyflip license status|activate` + MCP tools. Gate the
paid commands. *Deliverable: the product can distinguish free vs paid locally.* ✅ (built in Wave-3)

**Phase 2 — issuer + payment:**
- Pick MoR (Paddle/Lemon Squeezy). Configure products = tiers, monthly/annual.
- **license-issuer**: a serverless function (Cloudflare Workers / small Node) that (a) verifies the
  provider webhook signature, (b) signs a license with the private key (stored in the platform's secret
  store / KMS, never in git), (c) delivers it. Also a `/renew` + `/revoke` path.
- Private key management: generate offline; keep in the issuer's secret manager; publish only the
  public key (embedded in `license.js` at release, and on the website for verification transparency).

**Phase 3 — public website:**
- Static marketing site (Astro / Next static export) — hero, feature tour, pricing, docs, changelog.
- Pricing page → MoR hosted checkout. Docs from the existing README/SKILL (single source).
- Customer portal = the MoR's hosted portal (manage subscription, re-download license) → minimal custom UI.
- Host on Cloudflare Pages / Netlify / Vercel. Domain + TLS. Zero backend for the marketing site.

**Phase 4 — admin panel:**
- v1 = the MoR dashboard (customers, subscriptions, revenue) + the issuer's logs.
- v2 = a thin custom admin: reissue/revoke a license, look up a customer, toggle a feature flag,
  view aggregate (opt-in) metrics. Auth via the MoR or a simple admin SSO. Keep it minimal.

**Phase 5 — distribution & growth:**
- npm (free core), Homebrew tap, Scoop bucket, the existing install scripts.
- `keyflip upgrade` already self-updates; add a release channel.
- **Telemetry stays opt-in only** (brand promise). If added, it's an explicit `keyflip telemetry on`
  with a documented, minimal, non-secret payload — never default-on.
- Support: GitHub issues (free), email/priority (paid). Docs + FAQ on the site.

## 4. Brand-consistency guardrails (non-negotiable)

- **No phone-home** for license checks (offline signature verification only).
- **No secrets leave the machine** — licensing changes nothing here; creds stay in the OS store /
  encrypted files.
- **Free tier stays genuinely useful** (the core switch/manage workflow), so keyflip remains the
  obvious open tool; paid = scale/team/automation.
- **Zero runtime dependencies** preserved — `license.js` uses only `node:crypto`.

## 5. Open questions (decide before Phase 2)

- Perpetual-with-updates vs subscription? (Subscription fits the MoR model + ongoing cost of features.)
- Seat definition for Team (per-user vs per-machine).
- Grace period + offline expiry behavior (recommend: warn, then soft-degrade to free on hard expiry).
- Piracy stance: accept that a determined user can patch an open-source binary; optimize for honest
  customers + convenience, not DRM. (The value is the hosted issuer + updates + support, not lock-in.)
