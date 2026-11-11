// /api/kx/** is the browser's only way to the Kotova X API.
//
// A narrow proxy: it forwards only the endpoints this app uses and adds the
// secret key on the server, so the browser never sees it.
//
//   GET  /api/kx/currencies            GET  /currencies          keyless, cached 60 s
//   GET  /api/kx/sources?lang=         GET  /sources             keyless, cached 60 s
//   POST /api/kx/quote                 POST /quote               end_user_ip added here
//   POST /api/kx/addresses/validate    POST /addresses/validate
//   POST /api/kx/orders                POST /orders              Idempotency-Key passed on
//   GET  /api/kx/orders/X-XXXXXX?lang= GET  /orders/{id}          only orders created in this browser
//
// Only JSON answers are passed back (anything else becomes a 502
// upstream_invalid_response), with the headers the page needs: Retry-After,
// X-Request-Id, Idempotent-Replayed, the rate-limit headers and the API's Date.
//
// Before you deploy this publicly, rate-limit /api/kx/quote,
// /api/kx/addresses/validate, /api/kx/orders and /api/kx/orders/{id} per
// visitor: every call spends your account's API budget (README, "Before you
// deploy").

import { NextResponse, type NextRequest } from 'next/server';
import {
  allowedOrigins,
  apiBase,
  apiKey,
  endUserIp,
  IS_PRODUCTION,
  isLoopbackHost,
  sessionSecret,
  SHOW_CONFIG_DETAILS,
  warnOnce,
} from '@/lib/kx/server';
import { isOrderId, ORDERS_COOKIE, orderCookieWith, readOrderIds } from '@/lib/kx/order-cookie';
import type { paths } from '@/lib/kx/api-types';
import type { Lang, QuoteRequest } from '@/lib/kx/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// POST /orders may try the quote's fallback sources one after another: the API
// can take up to 90 s to answer, and the proxy waits up to 100 s for it. The
// function may run 10 s longer, so a late answer still ends as this proxy's
// JSON proxy_timeout, not as the host's error page (your host's plan must
// allow it; see README, "Before you deploy").
export const maxDuration = 110;

type Method = 'get' | 'post';

/** Every (path, method) pair the vendored OpenAPI document defines. */
type ApiOperation = {
  [P in keyof paths]: {
    [M in Method]: [NonNullable<paths[P][M]>] extends [never] ? never : { path: P; method: M };
  }[Method];
}[keyof paths];

type Route = ApiOperation & {
  /** Keyed endpoints carry the secret key; keyless ones never do. */
  keyed: boolean;
  /** Pass `lang` on, as a supported language; every other query parameter is dropped. */
  lang?: boolean;
  /** Keep the answer in memory for this long (keyless catalogue only). */
  cacheMs?: number;
  timeoutMs: number;
};

// A path or method that is not in the OpenAPI document fails the type check.
const ROUTES: readonly Route[] = [
  { path: '/currencies', method: 'get', keyed: false, cacheMs: 60_000, timeoutMs: 15_000 },
  { path: '/sources', method: 'get', keyed: false, lang: true, cacheMs: 60_000, timeoutMs: 15_000 },
  { path: '/quote', method: 'post', keyed: true, timeoutMs: 25_000 },
  { path: '/addresses/validate', method: 'post', keyed: true, timeoutMs: 15_000 },
  // Creating an order may try the quote's fallback sources in a row (up to 90 s at the API).
  { path: '/orders', method: 'post', keyed: true, timeoutMs: 100_000 },
  // A read may refresh the order from its source first.
  { path: '/orders/{id}', method: 'get', keyed: true, lang: true, timeoutMs: 20_000 },
];

const ORDER_ID = /^X-[A-Z0-9]{6}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,64}$/;
const END_USER_IP: keyof QuoteRequest = 'end_user_ip';
const MAX_BODY_BYTES = 16 * 1024;
const LANGS = ['en', 'de', 'it', 'es', 'fr', 'ru'] as const satisfies readonly Lang[];

/** Response headers passed back to the browser (the API's names, lower case). */
const PASS_HEADERS = [
  'retry-after',
  'x-request-id',
  'idempotent-replayed',
  'x-kotova-quote-cache',
  'x-kotova-status-refreshed',
  'ratelimit',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-kotova-weight',
];

function matchRoute(method: string, segments: string[]): Route | null {
  const m = method.toLowerCase();
  for (const route of ROUTES) {
    if (route.method !== m) continue;
    const parts = route.path.split('/').slice(1);
    if (parts.length !== segments.length) continue;
    const ok = parts.every((part, i) => {
      if (part === '{id}') return ORDER_ID.test(segments[i]);
      return part === segments[i];
    });
    if (ok) return route;
  }
  return null;
}

/** "de-AT" -> "de"; anything that is not a supported language -> "en". */
function normaliseLang(value: string | null): Lang {
  const primary = (value ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(primary) ? (primary as Lang) : 'en';
}

// ----------------------------------------------------------------------------- answers of the proxy itself

/** An error in the API's own shape, for failures of this proxy. */
function proxyError(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return NextResponse.json(
    { error: { code, message, request_id: null, ...(details ? { details } : {}), doc_url: 'https://docs.kotova.io/x/api/errors' } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** A missing or wrong setting: logged on the server; shown in detail only outside production. */
function notConfigured(problem: string) {
  warnOnce(problem);
  return proxyError(500, 'proxy_not_configured', SHOW_CONFIG_DETAILS ? problem : 'This app is not configured yet.');
}

// ----------------------------------------------------------------------------- request checks

/**
 * Quotes and orders spend your budget: only this app's own pages may POST.
 * Sec-Fetch-Site (sent by current browsers) must be same-origin. With
 * APP_ORIGIN set, Origin must be one of those origins; otherwise an Origin
 * header, when present, must match the Host (or X-Forwarded-Host) header.
 */
function originAllowed(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.get('origin');
  const pinned = allowedOrigins();
  if (pinned.length) return !!origin && pinned.includes(origin);
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [req.headers.get('x-forwarded-host'), req.headers.get('host')].filter(Boolean);
  return hosts.includes(originHost);
}

type BodyRead = { ok: true; text: string } | { ok: false };

/** The request body, refused when it is (or says it is) larger than `max` bytes. */
async function readBody(req: NextRequest, max: number): Promise<BodyRead> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) return { ok: false };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

// ----------------------------------------------------------------------------- calling the API

type UpstreamFailure = { ok: false; code: 'proxy_timeout' | 'proxy_unreachable' | 'upstream_invalid_response'; status?: number };
type Upstream = { ok: true; status: number; headers: Headers; text: string; json: unknown } | UpstreamFailure;

function isJsonType(contentType: string | null): boolean {
  return !!contentType && /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType.trim());
}

async function callApi(url: URL, init: { method: string; headers: Headers; body?: string }, timeoutMs: number): Promise<Upstream> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, code: timedOut ? 'proxy_timeout' : 'proxy_unreachable' };
  }
  if (res.status === 304) return { ok: true, status: 304, headers: res.headers, text: '', json: null };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, code: 'proxy_timeout' };
  }
  // Only the API's JSON is passed on: an HTML error page of a CDN or load
  // balancer must never be served from this app's origin.
  if (!isJsonType(res.headers.get('content-type'))) return { ok: false, code: 'upstream_invalid_response', status: res.status };
  try {
    return { ok: true, status: res.status, headers: res.headers, text, json: JSON.parse(text) };
  } catch {
    return { ok: false, code: 'upstream_invalid_response', status: res.status };
  }
}

function upstreamFailure(up: UpstreamFailure) {
  switch (up.code) {
    case 'proxy_timeout':
      return proxyError(504, 'proxy_timeout', 'The Kotova X API did not answer in time.');
    case 'proxy_unreachable':
      return proxyError(504, 'proxy_unreachable', 'The Kotova X API could not be reached.');
    default:
      return proxyError(
        502,
        'upstream_invalid_response',
        `The Kotova X API answer could not be read${up.status ? ` (HTTP ${up.status})` : ''}.`,
        up.status ? { upstream_status: up.status } : undefined,
      );
  }
}

function passHeaders(upstream: Headers): [string, string][] {
  const out: [string, string][] = [
    ['Content-Type', 'application/json; charset=utf-8'],
    ['Cache-Control', 'no-store'],
  ];
  for (const name of PASS_HEADERS) {
    const value = upstream.get(name);
    if (value) out.push([name, value]);
  }
  // The API's clock, so the page can count a quote's expires_at down without
  // trusting the visitor's clock.
  const apiDate = upstream.get('date');
  if (apiDate) out.push(['x-kx-api-date', apiDate]);
  return out;
}

type ErrorShape = { code?: unknown; request_id?: unknown; details?: Record<string, unknown> };

function errorOf(json: unknown): ErrorShape | null {
  if (!json || typeof json !== 'object' || !('error' in json)) return null;
  const error = (json as { error?: unknown }).error;
  return error && typeof error === 'object' ? (error as ErrorShape) : null;
}

// ----------------------------------------------------------------------------- keyless catalogue cache

type Cached = { body: string; headers: [string, string][]; etag: string | null; at: number };

/** One entry per path and language: a handful at most. */
const cache = new Map<string, Cached>();
const MAX_CACHE_ENTRIES = 16;
/** On an API error or rate limit, serve the last good copy for up to this long (stale-if-error). */
const STALE_IF_ERROR_MS = 60 * 60_000;

function serveCached(entry: Cached, state: 'hit' | 'revalidated' | 'stale') {
  return new Response(entry.body, { status: 200, headers: [...entry.headers, ['x-kx-cache', state]] });
}

async function catalogue(route: Route, url: URL, headers: Headers): Promise<Response> {
  const key = url.toString();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (route.cacheMs ?? 0)) return serveCached(cached, 'hit');
  if (cached?.etag) headers.set('If-None-Match', cached.etag);

  const up = await callApi(url, { method: 'GET', headers }, route.timeoutMs);
  const stale = cached && Date.now() - cached.at < STALE_IF_ERROR_MS ? cached : null;
  if (!up.ok) return stale ? serveCached(stale, 'stale') : upstreamFailure(up);
  if (up.status === 304) {
    if (!cached) return upstreamFailure({ ok: false, code: 'upstream_invalid_response', status: 304 });
    cached.at = Date.now();
    return serveCached(cached, 'revalidated');
  }
  if ((up.status === 429 || up.status >= 500) && stale) return serveCached(stale, 'stale');

  const outHeaders = passHeaders(up.headers);
  if (up.status === 200) {
    if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { body: up.text, headers: outHeaders, etag: up.headers.get('etag'), at: Date.now() });
  }
  return new Response(up.text, { status: up.status, headers: outHeaders });
}

// ----------------------------------------------------------------------------- the handler

async function handle(req: NextRequest, rawSegments: string[]): Promise<Response> {
  const route = matchRoute(req.method, rawSegments);
  if (!route) return proxyError(404, 'not_found', 'This app does not forward that endpoint.');
  // Order ids are upper case at the API.
  const segments = route.path === '/orders/{id}' ? [rawSegments[0], rawSegments[1].toUpperCase()] : rawSegments;

  if (route.method === 'post') {
    if (!originAllowed(req)) return proxyError(403, 'forbidden_origin', "Requests must come from this app's own pages.");
    const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return proxyError(415, 'unsupported_media_type', 'Send the request body as Content-Type: application/json.');
    }
  }

  const base = apiBase();
  if (!base.ok) return notConfigured(base.problem);
  const key = route.keyed ? apiKey() : null;
  if (route.keyed && !key) return notConfigured('KOTOVA_API_KEY is not set on the server. See .env.example.');
  // Orders are opened only by the browser that created them (signed cookie).
  const secret = route.keyed ? sessionSecret() : null;
  if (secret && !secret.ok) return notConfigured(secret.problem);

  const url = new URL(`${base.url}/${segments.map(encodeURIComponent).join('/')}`);
  if (route.lang) url.searchParams.set('lang', normaliseLang(req.nextUrl.searchParams.get('lang')));

  const headers = new Headers({ Accept: 'application/json' });
  if (key) headers.set('Authorization', `Bearer ${key}`);

  if (route.cacheMs) return catalogue(route, url, headers);

  const createdHere = secret?.ok ? readOrderIds(req.cookies.get(ORDERS_COOKIE)?.value, secret.secret) : [];
  if (route.path === '/orders/{id}' && !createdHere.includes(segments[1])) {
    return proxyError(404, 'order_not_found', 'This app shows only the orders created in this browser.', { id: segments[1] });
  }

  let body: string | undefined;
  let quoteBody: Record<string, unknown> | null = null;
  if (route.method === 'post') {
    const raw = await readBody(req, MAX_BODY_BYTES);
    if (!raw.ok) return proxyError(413, 'payload_too_large', 'The request body is too large.', { max_bytes: MAX_BODY_BYTES });
    let json: unknown;
    try {
      json = raw.text ? JSON.parse(raw.text) : {};
    } catch {
      return proxyError(400, 'invalid_request', 'The request body is not valid JSON.', { reason: 'invalid_json' });
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return proxyError(400, 'invalid_request', 'The request body must be a JSON object.', { reason: 'invalid_type' });
    }
    const obj = json as Record<string, unknown>;
    if (route.path === '/quote') {
      // The end user's IP is decided here, never by the browser.
      delete obj[END_USER_IP];
      const ip = endUserIp(req.headers);
      if (ip) obj[END_USER_IP] = ip;
      quoteBody = obj;
    }
    if (route.path === '/orders') {
      const idem = req.headers.get('idempotency-key');
      if (idem !== null) {
        if (!IDEMPOTENCY_KEY.test(idem)) {
          return proxyError(400, 'invalid_request', 'Idempotency-Key must be 8-64 characters of A-Z a-z 0-9 _ - : .', {
            field: 'Idempotency-Key',
            reason: 'invalid_format',
          });
        }
        headers.set('Idempotency-Key', idem);
      }
    }
    body = JSON.stringify(obj);
    headers.set('Content-Type', 'application/json');
  }

  const method = route.method.toUpperCase();
  let up = await callApi(url, { method, headers, body }, route.timeoutMs);

  // An end_user_ip the API does not take would fail the whole quote: ask once
  // more without it (the sources that need it are then skipped).
  if (up.ok && up.status === 400 && quoteBody && END_USER_IP in quoteBody) {
    const error = errorOf(up.json);
    if (error?.code === 'invalid_request' && error.details?.field === END_USER_IP) {
      console.warn('[kx] The API refused end_user_ip; asking for the quote again without it.');
      delete quoteBody[END_USER_IP];
      up = await callApi(url, { method, headers, body: JSON.stringify(quoteBody) }, route.timeoutMs);
    }
  }
  if (!up.ok) return upstreamFailure(up);
  noteForIntegrator(route, segments, up.json);

  const outHeaders = passHeaders(up.headers);
  // Remember the orders this browser created, so it (and only it) can open them.
  if (route.path === '/orders' && secret?.ok) {
    const createdId = createdOrderId(up.status, up.json);
    if (createdId) {
      const secure = req.nextUrl.protocol === 'https:' || (IS_PRODUCTION && !isLoopbackHost(req.nextUrl.hostname));
      outHeaders.push(['Set-Cookie', orderCookieWith(createdId, createdHere, secret.secret, secure)]);
    }
  }
  return new Response(up.text, { status: up.status, headers: outHeaders });
}

/**
 * Answers only you, the integrator, can act on: the server log says what to do
 * (with the id to quote), while your users are pointed to SUPPORT_CONTACT
 * (src/lib/support.ts).
 */
function noteForIntegrator(route: Route, segments: string[], json: unknown): void {
  const error = errorOf(json);
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'affiliate_inactive') {
    warnOnce('The API answers affiliate_inactive: API access for this key is paused. Write to api@kotova.io with your key ID.');
    return;
  }
  const reason = error?.details?.reason;
  if (route.path === '/orders' && code === 'source_error' && (reason === 'outcome_unknown' || reason === 'idempotency_outcome_unknown')) {
    const requestId = typeof error?.request_id === 'string' ? error.request_id : '-';
    console.warn(`[kx] POST /orders ${requestId}: the source may hold the order (${String(reason)}). Write to api@kotova.io with this request id.`);
    return;
  }
  if (route.path === '/orders/{id}' && json && typeof json === 'object') {
    const detail = (json as { status_detail?: { reason?: unknown } | null }).status_detail;
    if (detail?.reason === 'payout_on_hold') {
      warnOnce(`Order ${segments[1]}: the source holds the payout (payout_on_hold). Write to api@kotova.io with the order id.`);
    }
  }
}

/**
 * The order an answer to POST /orders names: the 201 (also an Idempotency-Key
 * replay), a 409 quote_already_used for this browser's quote, or a 500 whose
 * order was created but could not be read back.
 */
function createdOrderId(status: number, json: unknown): string | null {
  if (status === 201 && json && typeof json === 'object') {
    const id = (json as { id?: unknown }).id;
    return isOrderId(id) ? id : null;
  }
  const error = errorOf(json);
  const id = error?.details?.order_id;
  if ((error?.code === 'quote_already_used' || error?.code === 'internal_error') && isOrderId(id)) return id;
  return null;
}

type Ctx = { params: { path?: string[] } };

export async function GET(req: NextRequest, ctx: Ctx) {
  return handle(req, ctx.params.path ?? []);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return handle(req, ctx.params.path ?? []);
}
