// API error -> what the user reads, which inputs it belongs to, and what the
// app does next. Branch on `code` (stable), never on `message` (may change);
// unknown codes fall back to the HTTP status.
// Reference: https://docs.kotova.io/x/api/errors

import { SUPPORT_CONTACT } from '../support';
import { KxError } from './client';
import type { AddressField } from './types';

export type ErrorField = AddressField | 'amount';

export type NextStep =
  | 'none' // show the message
  | 'requote' // fetch a new quote (its notices are shown again) and let the user confirm again
  | 'retry_same_key' // send the same order request again with the same Idempotency-Key
  | 'wait' // wait `retryAfterSeconds`, then the user may try again
  | 'open_order' // an order exists: open `orderId`
  | 'contact_support'; // outcome unknown: do not create another order

export interface DescribedError {
  message: string;
  /** The inputs the error belongs to; empty for a general error. */
  fields: ErrorField[];
  next: NextStep;
  retryAfterSeconds?: number;
  orderId?: string;
  requestId: string | null;
  code: string;
}

const ADDRESS_FIELDS: readonly AddressField[] = ['to_address', 'to_memo', 'refund_address', 'refund_memo'];

const FIELD_LABEL: Record<AddressField, string> = {
  to_address: 'recipient address',
  to_memo: 'recipient memo',
  refund_address: 'refund address',
  refund_memo: 'refund memo',
};

const TRIED_REASON: Record<string, string> = {
  disabled: 'not available',
  paused: 'paused',
  busy: 'busy',
  rejected: 'refused the order',
  unavailable: 'could not create it',
  rate_limited: 'rate limited',
  invalid_address: 'refused the address',
  internal: 'failed at Kotova X',
  outcome_unknown: 'outcome unknown',
  refund_address_required: 'skipped, needs a refund address',
  deadline: 'skipped, out of time',
};

const NO_SOURCE_REASON: Record<string, string> = {
  excluded_by_request: 'switched off by you',
  freeze_protection: 'left out by freeze protection',
  rate_type_unsupported: "doesn't offer this rate type",
  end_user_ip_required: "needs the end user's IP",
  refund_address_required: 'needs a refund address',
  create_budget_exhausted: 'not taking API orders right now',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function isAddressField(v: unknown): v is AddressField {
  return typeof v === 'string' && (ADDRESS_FIELDS as readonly string[]).includes(v);
}

/** `details.field` plus `details.fields` (when the source did not say which one it meant). */
export function addressFieldsOf(details: Record<string, unknown>, fallback: AddressField): AddressField[] {
  const out: AddressField[] = [];
  if (isAddressField(details.field)) out.push(details.field);
  if (Array.isArray(details.fields)) {
    for (const f of details.fields) if (isAddressField(f) && !out.includes(f)) out.push(f);
  }
  return out.length ? out : [fallback];
}

function joinOr(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** "Tried: SideShift (busy), ChangeNOW (refused the order)." from details.sources_tried. */
export function describeSourcesTried(details: Record<string, unknown>, nameOf: (slug: string) => string): string | null {
  const tried = details.sources_tried;
  if (!Array.isArray(tried) || tried.length === 0) return null;
  const parts = tried.map((entry) => {
    const e = (entry ?? {}) as { source?: unknown; reason?: unknown };
    const reason = str(e.reason);
    return `${nameOf(str(e.source))} (${TRIED_REASON[reason] ?? reason})`;
  });
  return `Tried: ${parts.join(', ')}.`;
}

export function describeKxError(err: unknown, nameOf: (slug: string) => string = (s) => s): DescribedError {
  if (!(err instanceof KxError)) {
    return { message: 'Something went wrong. Please try again.', fields: [], next: 'none', requestId: null, code: 'unexpected' };
  }
  const d = err.details;
  const base = { requestId: err.requestId, code: err.code, retryAfterSeconds: err.retryAfterSeconds ?? undefined, fields: [] as ErrorField[] };
  const withTried = (message: string) => {
    const tried = describeSourcesTried(d, nameOf);
    return tried ? `${message} ${tried}` : message;
  };
  const network = str(d.network).toUpperCase();

  switch (err.code) {
    // No answer, or no readable one: the request may or may not have been
    // processed. For POST /orders that means "send it again with the same
    // Idempotency-Key and the same body" (retry_same_key); elsewhere the
    // message is shown.
    case 'network_error':
      return { ...base, message: 'The app server could not be reached. Check your connection.', next: 'retry_same_key' };
    case 'client_timeout':
      return { ...base, message: 'The app server did not answer in time.', next: 'retry_same_key' };
    case 'proxy_timeout':
      return { ...base, message: 'The Kotova X API did not answer in time.', next: 'retry_same_key' };
    case 'proxy_unreachable':
      return { ...base, message: 'The Kotova X API could not be reached.', next: 'retry_same_key' };
    case 'upstream_invalid_response':
      return { ...base, message: 'The Kotova X API answer could not be read.', next: 'retry_same_key' };
    case 'unreadable_response':
      // A success status whose body could not be read (see client.ts): on
      // POST /orders the order may well exist, and a repeat answers it.
      return { ...base, message: 'The answer could not be read.', next: 'retry_same_key' };

    // This app's own checks (nothing reached the API).
    case 'proxy_not_configured':
      // The server says how much it can tell (details only outside production).
      return { ...base, message: err.message || 'This app is not configured yet.', next: 'none' };
    case 'forbidden_origin':
      return { ...base, message: "Requests must come from this app's own pages.", next: 'none' };
    case 'unsupported_media_type':
    case 'payload_too_large':
      return { ...base, message: `The request was refused (${err.code}).`, next: 'none' };
    case 'unauthorized':
    case 'key_revoked':
      return { ...base, message: `The API refused this app's key (${err.code}). Check KOTOVA_API_KEY on the server.`, next: 'none' };
    case 'affiliate_inactive':
      // What to do is logged on the server for you (the proxy); the user can only ask you.
      return { ...base, message: `This site cannot get offers or create orders right now. Please contact ${SUPPORT_CONTACT}.`, next: 'none' };

    case 'invalid_request': {
      const field = str(d.field);
      const reason = str(d.reason);
      if (reason === 'too_many_decimals') {
        return { ...base, fields: ['amount'], message: `Too many decimals: at most ${str(d.max_fraction_digits)} for this currency.`, next: 'none' };
      }
      if (isAddressField(field)) {
        return { ...base, fields: [field], message: `The ${FIELD_LABEL[field]} was refused (${reason || err.message}).`, next: 'none' };
      }
      return { ...base, message: `The request was refused (${field || '-'}: ${reason || err.message}).`, next: 'none' };
    }

    case 'unknown_currency':
    case 'currency_unavailable':
      return {
        ...base,
        message: `${str(d.currency)} on ${network} cannot be ${d.side === 'to' ? 'received' : 'sent'} right now.`,
        next: 'none',
      };
    case 'same_currency':
      return { ...base, message: 'Pick two different currencies.', next: 'none' };
    case 'pair_unavailable':
      return { ...base, message: 'No source offers this pair right now.', next: 'none' };
    case 'no_source_available': {
      const reasons = Array.isArray(d.reasons) ? (d.reasons as { reason?: unknown; sources?: unknown }[]) : [];
      const list = reasons
        .map((r) => {
          const label = NO_SOURCE_REASON[str(r.reason)] ?? str(r.reason);
          const names = Array.isArray(r.sources) ? r.sources.map((s) => nameOf(str(s))).join(', ') : '';
          return names ? `${label} (${names})` : label;
        })
        .join('; ');
      return {
        ...base,
        message: list ? `No source can quote this with your settings: ${list}.` : 'No source can quote this right now. Try another amount, or again later.',
        next: 'none',
      };
    }
    case 'amount_below_min':
      return { ...base, fields: ['amount'], message: `Below the minimum of ${str(d.min_from_amount)} ${str(d.currency)}.`, next: 'none' };
    case 'amount_above_max':
      return { ...base, fields: ['amount'], message: `Above the maximum of ${str(d.max_from_amount)} ${str(d.currency)}.`, next: 'none' };

    case 'refund_address_required':
      return {
        ...base,
        fields: ['refund_address'],
        message: `${nameOf(str(d.source))} needs a refund address on ${network} for this order.`,
        next: 'none',
      };
    case 'invalid_address': {
      const fields = addressFieldsOf(d, 'to_address');
      const labels = fields.map((f) => FIELD_LABEL[f]);
      if (d.reason === 'rejected_by_source') {
        const source = nameOf(str(d.source));
        const message =
          fields.length > 1
            ? `${source} refused the ${joinOr(labels)} and did not say which. Check each of them.`
            : `${source} refused the ${labels[0]}: ${err.message}`;
        return { ...base, fields, message: withTried(message), next: 'none' };
      }
      return {
        ...base,
        fields,
        message: `The ${joinOr(labels)} does not match the ${network || 'network'} format.`,
        next: 'none',
      };
    }
    case 'memo_not_supported': {
      const field: AddressField = d.field === 'refund_memo' ? 'refund_memo' : 'to_memo';
      return { ...base, fields: [field], message: `${network} does not take a memo. Leave it empty.`, next: 'none' };
    }

    case 'quote_expired':
      return { ...base, message: 'The offer expired. Here is a new one: check the amounts and the notices, then confirm again.', next: 'requote' };
    case 'quote_not_found':
      return { ...base, message: 'That offer is no longer available. Here is a new one: check it, then confirm again.', next: 'requote' };
    case 'quote_already_used': {
      const orderId = str(d.order_id);
      if (orderId) return { ...base, orderId, message: `An order was already created from this offer: ${orderId}.`, next: 'open_order' };
      // order_id is null while an order from this offer is being created, or
      // when its outcome is unknown: never a new offer (that could place a
      // second order), only the same request again.
      return { ...base, message: 'An order from this offer may be in progress or may already exist.', next: 'retry_same_key' };
    }
    case 'idempotency_in_progress':
      return { ...base, message: 'Your order is still being created...', next: 'retry_same_key' };
    case 'idempotency_conflict':
      return { ...base, message: 'This request conflicts with an earlier one. Check the offer and confirm again.', next: 'requote' };

    case 'rate_limited': {
      const seconds = err.retryAfterSeconds ?? 0;
      return {
        ...base,
        message: d.reason === 'fanout' ? `Too many live offers this minute. Try again in ${seconds} s.` : `Too many requests right now. Try again in ${seconds} s.`,
        next: 'wait',
      };
    }
    case 'order_cap_reached':
      return {
        ...base,
        message:
          d.cap === 'created_24h'
            ? `The daily order limit is reached (${str(d.current)}/${str(d.limit)}).`
            : `Too many orders are waiting for a deposit (${str(d.current)}/${str(d.limit)}). Fund one or wait for one to expire.`,
        next: 'wait',
      };

    case 'internal_error': {
      const orderId = str(d.order_id);
      if (orderId) return { ...base, orderId, message: `Your order ${orderId} was created. Opening it...`, next: 'open_order' };
      // With sources_tried, nothing was created and the quote and the key were
      // released: a new quote, not a repeat (each repeat would be a new request).
      if (Array.isArray(d.sources_tried) && d.sources_tried.length > 0) {
        return { ...base, message: withTried('Kotova X could not create the order, and nothing was created. Here is a new offer: check it, then confirm again.'), next: 'requote' };
      }
      return { ...base, message: `Something failed at Kotova X (request ${err.requestId ?? '-'}).`, next: 'retry_same_key' };
    }
    case 'source_error': {
      if (d.reason === 'outcome_unknown' || d.reason === 'idempotency_outcome_unknown') {
        return {
          ...base,
          message: withTried(
            `The source did not confirm the order, and it may exist there. Do not create another order for this swap: contact ${SUPPORT_CONTACT} with request ${err.requestId ?? '-'}.`,
          ),
          next: 'contact_support',
        };
      }
      if (d.retryable === true) {
        return { ...base, message: withTried('No source created the order. Here is a new offer: check it, then confirm again.'), next: 'requote' };
      }
      return { ...base, message: withTried(`${nameOf(str(d.source))} refused the order. Here is a new offer: check it, then confirm again.`), next: 'requote' };
    }
    case 'source_unavailable':
      return { ...base, message: withTried('No source can take the order right now. Here is a new offer.'), next: 'requote' };
    case 'sources_unavailable':
      return { ...base, message: `The sources could not be reached. Trying again in ${err.retryAfterSeconds ?? 10} s.`, next: 'wait' };
    case 'service_unavailable':
      return { ...base, message: 'The Kotova X API is unavailable right now. Please try again shortly.', next: 'wait' };
    case 'order_not_found':
      return { ...base, message: 'This app shows only the orders created in this browser.', next: 'none' };
    default:
      // Any other 5xx (a host's error page without an API error code, or a
      // code this app does not know): the outcome is unknown, so POST /orders
      // is sent again with the same key and body.
      if (err.status >= 500) {
        const known = err.code.startsWith('http_') ? '' : ` ${err.code}`;
        return { ...base, message: `The server answered with an error (HTTP ${err.status}${known}).`, next: 'retry_same_key' };
      }
      if (err.status === 429) {
        return { ...base, message: `Too many requests right now. Try again in ${err.retryAfterSeconds ?? 10} s.`, retryAfterSeconds: err.retryAfterSeconds ?? 10, next: 'wait' };
      }
      return { ...base, message: err.message || 'Something went wrong. Please try again.', next: 'none' };
  }
}

/**
 * POST /orders answers that settle an earlier attempt with the same
 * Idempotency-Key and body whose outcome is unknown. The API checks the key
 * before anything else about the order: an attempt that created the order is
 * answered with it (201, Idempotent-Replayed) and one still running with
 * idempotency_in_progress, so an answer given after that check proves that no
 * earlier attempt created anything. Answers given before it (authentication,
 * rate limits, an outage, a malformed request, this app's own checks, an error
 * in this app) say nothing about the earlier attempt and never settle it.
 */
const SETTLING_CODES: ReadonlySet<string> = new Set([
  'quote_expired',
  'quote_not_found',
  'quote_already_used', // with order_id (open_order); without one it is retry_same_key
  'idempotency_conflict',
  'order_cap_reached',
  'invalid_address',
  'memo_not_supported',
  'refund_address_required',
  'source_error', // except outcome_unknown (contact_support)
  'source_unavailable',
  'internal_error', // with order_id or sources_tried; a plain one is retry_same_key
]);

export function settlesOrderRequest(d: DescribedError): boolean {
  if (d.next === 'open_order') return true;
  if (d.next === 'retry_same_key' || d.next === 'contact_support') return false;
  return SETTLING_CODES.has(d.code);
}
