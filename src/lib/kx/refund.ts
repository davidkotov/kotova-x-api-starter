// Refund address helpers.
//
// Recommend a refund address on every order (in the same form as the recipient
// address); require it only when the quote says `requirements.refund_address:
// "required"`. Where the source accepts it, the address travels with the order,
// so a refund needs no extra step, and fallback sources that need one stay
// eligible.

import type { FallbackSource } from './types';

/** Fallback sources that are skipped when the order has no refund address. */
export function fallbacksNeedingRefund(fallbacks: readonly FallbackSource[]): FallbackSource[] {
  return fallbacks.filter((f) => f.requirements.refund_address === 'required');
}
