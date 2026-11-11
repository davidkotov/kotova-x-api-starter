'use client';

// Browser-side calls. They go to this app's proxy (/api/kx/...), never to the
// API itself: the proxy holds the key.

import type {
  AddressValidation,
  ApiErrorBody,
  CurrencyList,
  Lang,
  Order,
  OrderRequest,
  Quote,
  QuoteRequest,
  SourceList,
  ValidateAddressRequest,
} from './types';

/**
 * The language this app asks the API for (source notices come back in it).
 * The UI is English only; if you translate it, send your UI language here
 * (en, de, it, es, fr or ru).
 */
export const UI_LANG: Lang = 'en';

/**
 * The error body: the API's (ErrorBody), or this app's own (the proxy's codes
 * such as proxy_timeout, or client_timeout from the browser).
 */
type ErrorLike = Partial<Omit<ApiErrorBody, 'code' | 'details' | 'request_id'>> & {
  code?: string;
  details?: Record<string, unknown>;
  request_id?: string | null;
};

/**
 * An error answer of the API (or of the proxy), with what the UI needs to act
 * on it. An answer without an error body (a host's HTML error page, a dropped
 * connection) gets the code `http_<status>` or `network_error`.
 */
export class KxError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, body: ErrorLike | null, retryAfter: string | null) {
    super(body?.message || `HTTP ${status}`);
    this.name = 'KxError';
    this.status = status;
    this.code = body?.code || (status === 0 ? 'network_error' : `http_${status}`);
    this.details = body?.details && typeof body.details === 'object' ? body.details : {};
    this.requestId = body?.request_id ?? null;
    const n = retryAfter != null ? Number(retryAfter) : NaN;
    this.retryAfterSeconds = Number.isFinite(n) && n >= 0 ? n : null;
  }
}

export interface KxResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * POST /orders may take up to 90 s at the API (fallback sources), the proxy
 * waits up to 100 s and its function may run 110 s (maxDuration). The browser
 * gives up after that; the app then asks again with the same Idempotency-Key.
 */
const CREATE_ORDER_TIMEOUT_MS = 120_000;

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<KxResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const timeout = opts.timeoutMs && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(opts.timeoutMs) : undefined;

  let res: Response;
  try {
    res = await fetch(`/api/kx/${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      signal: opts.signal ?? timeout,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new KxError(0, { code: 'client_timeout', message: 'No answer from the app server in time.' }, null);
    }
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new KxError(0, { message: 'The app server could not be reached.' }, null);
  }

  let json: unknown = null;
  let readable = true;
  try {
    json = await res.json();
  } catch {
    // Not JSON (a host's error page, or a dropped connection): see KxError.
    json = null;
    readable = false;
  }
  if (!res.ok) {
    const body = json && typeof json === 'object' && 'error' in json ? (json as { error: ErrorLike }).error : null;
    throw new KxError(res.status, body && typeof body === 'object' ? body : null, res.headers.get('retry-after'));
  }
  if (!readable || !json || typeof json !== 'object') {
    // A success status without a readable body (the connection dropped while
    // it arrived): for POST /orders the order may exist, so it is an error
    // the caller repeats with the same Idempotency-Key, never a success.
    throw new KxError(res.status, { code: 'unreadable_response', message: 'The answer could not be read.', request_id: res.headers.get('x-request-id') }, null);
  }
  return { data: json as T, status: res.status, headers: res.headers };
}

export const kx = {
  currencies: () => call<CurrencyList>('GET', 'currencies'),
  sources: (lang: Lang = UI_LANG) => call<SourceList>('GET', `sources?lang=${lang}`),
  quote: (body: QuoteRequest, signal?: AbortSignal) => call<Quote>('POST', 'quote', { body, signal }),
  validateAddress: (body: ValidateAddressRequest, signal?: AbortSignal) =>
    call<AddressValidation>('POST', 'addresses/validate', { body, signal }),
  createOrder: (body: OrderRequest, idempotencyKey: string) =>
    call<Order>('POST', 'orders', { body, headers: { 'Idempotency-Key': idempotencyKey }, timeoutMs: CREATE_ORDER_TIMEOUT_MS }),
  order: (id: string, lang: Lang = UI_LANG, signal?: AbortSignal) =>
    call<Order>('GET', `orders/${encodeURIComponent(id)}?lang=${lang}`, { signal }),
};

/** A fresh Idempotency-Key (8 to 64 of A-Z a-z 0-9 _ - : .). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
