// Refund address helpers.
//
// Recommend a refund address on every order (in the same form as the recipient
// address); require it only when the quote says `requirements.refund_address:
// "required"`. Where the source accepts it, the address travels with the order,
// so a refund needs no extra step, and fallback sources that need one stay
// eligible.

import type { FallbackSource, QuoteSource, RefundAddressForwarding, SourceInfo } from './types';

/**
 * How a source uses the refund address (`refund_address_forwarding`), from a
 * quote's source block or GET /sources. An order's own source block does not
 * carry it; the order says `refund.forwarded` instead.
 */
export function refundForwarding(source: QuoteSource | SourceInfo | null | undefined): RefundAddressForwarding | null {
  return source?.refund_address_forwarding ?? null;
}

// The switches below end in `default` because the value is an extensible enum:
// a value this app does not know yet gets the generic wording.

/** What happens to the refund address at this source, in one sentence. */
export function refundForwardingHint(sourceName: string, forwarding: RefundAddressForwarding | null): string {
  switch (forwarding) {
    case 'at_creation':
      return `It is sent to ${sourceName} with the order, so a refund needs no extra step.`;
    case 'when_needed':
      return `${sourceName} takes it only when a refund is needed; until then it is kept on file.`;
    case 'none':
      return `${sourceName} handles refunds itself; the address is kept for support.`;
    default:
      return 'It is sent to the source with the order where the source accepts it.';
  }
}

/** For an order whose refund address was not sent to the source (`refund.forwarded: false`). */
export function refundOnFileHint(sourceName: string, forwarding: RefundAddressForwarding | null): string {
  switch (forwarding) {
    case 'when_needed':
      return `${sourceName} takes it only when a refund is needed; until then it is kept on file.`;
    case 'none':
      return `${sourceName} handles refunds itself; the address is kept for support.`;
    default:
      return `Not sent to ${sourceName} with the order; it is kept on file.`;
  }
}

/** Fallback sources that are skipped when the order has no refund address. */
export function fallbacksNeedingRefund(fallbacks: readonly FallbackSource[]): FallbackSource[] {
  return fallbacks.filter((f) => f.requirements.refund_address === 'required');
}
