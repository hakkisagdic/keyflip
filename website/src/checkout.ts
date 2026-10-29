// CHECKOUT — the commercial side of the site, read from ONE file.
//
// checkout.config.json holds the facts that change when the business changes:
// the price of each tier, where to pay, and where to manage the subscription.
// Everything else (names, blurbs, feature lists) is translated copy and stays
// in the page files. Keeping the two apart is the point: the price a visitor
// reads and the button they click can never drift apart, because there is only
// one price field.
//
// Nothing here is a secret. A checkout link is a public payment page; a portal
// link is a public customer-portal page. Both are meant to be in git.
//
// Until the payment accounts exist, every URL is empty and `salesOpen` is
// false — the pricing page then renders exactly what it always rendered
// ("coming soon") instead of linking to a 404.
import raw from './checkout.config.json';
import type { Locale } from './i18n';

export type Region = 'TR' | 'GLOBAL';
export type Cycle = 'monthly' | 'yearly';

export interface ProviderCheckout {
  region: Region;
  monthly: string;
  yearly: string;
}

export interface TierPlan {
  price: string;
  providers: Record<string, ProviderCheckout>;
  portals: Record<string, string>;
}

export interface CheckoutConfig {
  salesOpen: boolean;
  currency: string;
  tiers: Record<string, TierPlan>;
}

export const checkoutConfig = raw as unknown as CheckoutConfig;

// One purchasable option: a provider, the region it serves, the billing cycle
// and the link. Built from the flat config so a page never has to know how the
// config is nested.
export interface CheckoutOption {
  tier: string;
  provider: string;
  region: Region;
  cycle: Cycle;
  url: string;
}

// A place to manage an existing subscription (re-download the license, update
// the card, cancel).
export interface PortalLink {
  tier: string;
  provider: string;
  url: string;
}

// Are the paid tiers on sale right now? The switch lives in the config so the
// page never has to guess.
export function salesOpen(): boolean {
  return checkoutConfig.salesOpen === true;
}

// The published price of a tier (empty string when the tier has no price).
export function planPrice(tier: string): string {
  const p = checkoutConfig.tiers?.[tier];
  return p && typeof p.price === 'string' ? p.price : '';
}

// Every checkout option of a tier that actually has a URL. An empty URL means
// "not configured yet" and is skipped, so the page shows only real links.
export function checkoutOptions(tier: string): CheckoutOption[] {
  const p = checkoutConfig.tiers?.[tier];
  if (!p || !p.providers) return [];
  const out: CheckoutOption[] = [];
  for (const provider of Object.keys(p.providers)) {
    const entry = p.providers[provider];
    if (!entry) continue;
    if (entry.monthly) {
      out.push({ tier, provider, region: entry.region, cycle: 'monthly', url: entry.monthly });
    }
    if (entry.yearly) {
      out.push({ tier, provider, region: entry.region, cycle: 'yearly', url: entry.yearly });
    }
  }
  return out;
}

// Every portal link of a tier that actually has a URL.
export function portalLinks(tier: string): PortalLink[] {
  const p = checkoutConfig.tiers?.[tier];
  if (!p || !p.portals) return [];
  const out: PortalLink[] = [];
  for (const provider of Object.keys(p.portals)) {
    const url = p.portals[provider];
    if (url) out.push({ tier, provider, url });
  }
  return out;
}

// Every configured portal across all tiers (the activation page shows them all,
// because a buyer who lost the email does not remember which tier they bought).
export function allPortalLinks(): PortalLink[] {
  const out: PortalLink[] = [];
  for (const tier of Object.keys(checkoutConfig.tiers || {})) {
    for (const l of portalLinks(tier)) out.push(l);
  }
  // Same provider in two tiers -> one link.
  const seen = new Set<string>();
  return out.filter((l) => {
    if (seen.has(l.provider)) return false;
    seen.add(l.provider);
    return true;
  });
}

// Brand names — the same in every language.
const PROVIDER_NAMES: Record<string, string> = {
  iyzico: 'iyzico',
  paytr: 'PayTR',
  lemonsqueezy: 'Lemon Squeezy',
  stripe: 'Stripe',
};

export function providerLabel(provider: string): string {
  return PROVIDER_NAMES[provider] || provider;
}

// Which market a provider serves.
export function regionLabel(region: Region, locale: Locale): string {
  if (region === 'TR') return 'Türkiye';
  return locale === 'tr' ? 'Uluslararası' : 'International';
}

// Billing cycle.
export function cycleLabel(cycle: Cycle, locale: Locale): string {
  if (locale === 'tr') return cycle === 'monthly' ? 'aylık' : 'yıllık';
  return cycle === 'monthly' ? 'monthly' : 'yearly';
}
