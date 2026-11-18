// Lightning payouts: a receive leg whose address_format is `lightning_invoice`
// (BTC on the `lightning` network). The payout pays a BOLT11 invoice of an
// exact amount, so the API asks for:
//
//   POST /quote    amount_type "to" with the invoice amount, rate_type "fixed"
//                  (else 400 invalid_request)
//   POST /orders   to_address = the invoice: a mainnet BOLT11 invoice of exactly
//                  the quoted amount, valid for at least 10 more minutes
//                  (else 422 invalid_lightning_invoice)
//
// POST /addresses/validate reads an invoice's amount and expiry (`invoice`),
// so this app needs no BOLT11 decoder of its own.
// https://docs.kotova.io/x/api/orders#lightning-payouts

import { formatTime } from '../format';
import { kx } from './client';
import { maxFractionDigits, type Leg } from './catalog';
import { fractionDigits, trimAmount } from './decimal';

/** POST /orders refuses an invoice with less time left than this. */
export const INVOICE_MIN_REMAINING_MS = 10 * 60 * 1000;
/**
 * The payout can only be made once the deposit has confirmed. A BTC or XMR
 * deposit may take a while, so warn below this much time left (as
 * app.kotova.io does).
 */
const SLOW_DEPOSIT_WARN_MS = 23 * 60 * 1000;
const SLOW_DEPOSIT_NETWORKS: ReadonlySet<string> = new Set(['btc', 'xmr']);

export interface InvoiceInfo {
  /** The invoice as sent to the API (see invoiceText). */
  text: string;
  /** A mainnet BOLT11 invoice. */
  valid: boolean;
  /** In BTC; null when the invoice has no amount (or is not an invoice). */
  amount: string | null;
  /** When the invoice stops being payable (ms); null when it is not an invoice. */
  expiresAt: number | null;
}

/** A receive leg that pays out to a Lightning invoice. */
export function isLightningPayout(leg: Leg | null | undefined): boolean {
  return leg?.addressFormat === 'lightning_invoice';
}

/**
 * The invoice as this app sends it: without a `lightning:` prefix (a wallet's
 * copy button or a QR code may add one) and in lower case (BOLT11 is
 * case-insensitive; QR codes often use upper case).
 */
export function invoiceText(raw: string): string {
  return raw.trim().replace(/^lightning:(?:\/\/)?/i, '').toLowerCase();
}

const cache = new Map<string, InvoiceInfo>();

/** The invoice's amount and expiry, from POST /addresses/validate (weight 1; cached per invoice). */
export async function readInvoice(leg: Leg, text: string, signal?: AbortSignal): Promise<InvoiceInfo> {
  const key = `${leg.key}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await kx.validateAddress({ currency: leg.currency, network: leg.network, address: text, memo: null }, signal);
  const expiresAt = res.data.invoice ? Date.parse(res.data.invoice.expires_at) : NaN;
  const info: InvoiceInfo = {
    text,
    valid: res.data.valid === true && res.data.invoice !== null,
    amount: res.data.invoice?.amount ?? null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  };
  if (cache.size > 50) cache.clear();
  cache.set(key, info);
  return info;
}

/** Why POST /orders would refuse this invoice for `leg`, or null. */
export function invoiceProblem(info: InvoiceInfo, leg: Leg, now: number): string | null {
  if (!info.valid) return 'This is not a Lightning invoice. Paste a mainnet BOLT11 invoice: it starts with lnbc.';
  if (info.amount === null) return 'This invoice has no amount. Create one for the exact amount you want to receive.';
  const digits = maxFractionDigits(leg);
  if (fractionDigits(info.amount) > digits) {
    return `The invoice asks for ${trimAmount(info.amount)} ${leg.ticker}, more decimals than an order takes (${digits}). Create one for a whole number of satoshis.`;
  }
  if (info.expiresAt !== null) {
    const left = info.expiresAt - now;
    if (left <= 0) return 'This invoice has expired. Create a new one.';
    if (left < INVOICE_MIN_REMAINING_MS) {
      return `This invoice expires at ${formatTime(new Date(info.expiresAt).toISOString())}. Create one that stays valid for at least 10 more minutes.`;
    }
  }
  return null;
}

/** A warning when the invoice may expire before a slow deposit has confirmed, or null. */
export function invoiceExpiryWarning(info: InvoiceInfo, from: Leg | null, now: number): string | null {
  if (!info.valid || info.expiresAt === null || !from || !SLOW_DEPOSIT_NETWORKS.has(from.network)) return null;
  const left = info.expiresAt - now;
  if (left < INVOICE_MIN_REMAINING_MS || left >= SLOW_DEPOSIT_WARN_MS) return null;
  return `The invoice expires in ${Math.max(1, Math.floor(left / 60_000))} min. A ${from.ticker} deposit may take longer to confirm, and the payout is made only after that: an invoice valid for an hour or more is safer.`;
}
