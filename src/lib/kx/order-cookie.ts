import 'server-only';

// The orders created in a browser, in an httpOnly, SameSite=Strict cookie
// signed with APP_SESSION_SECRET (HMAC-SHA256).
//
// GET /orders/{id} answers every order of your account, made with any of its
// keys, addresses and transaction hashes included. The proxy holds that key,
// so it opens an order only for the browser that created it: POST /orders adds
// the new id to this cookie, and GET /api/kx/orders/{id} answers 404 for any id
// that is not in it, without calling the API.
//
// Value: "1~<expires, unix seconds>~<id>~<id>...", then "." and the signature
// (base64url). Newest id first, at most MAX_IDS.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ORDERS_COOKIE = 'kx_orders';
/** Only the order routes of the proxy need it. */
const COOKIE_PATH = '/api/kx/orders';
const MAX_IDS = 20;
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ORDER_ID = /^X-[A-Z0-9]{6}$/;
const VERSION = '1';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${ORDERS_COOKIE}|${payload}`).digest('base64url');
}

/** The ids in a valid, unexpired cookie; [] for anything else. */
export function readOrderIds(value: string | undefined, secret: string): string[] {
  if (!value || value.length > 1024) return [];
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return [];
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = Buffer.from(sign(payload, secret), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [];
  const [version, expires, ...ids] = payload.split('~');
  if (version !== VERSION || !(Number(expires) * 1000 > Date.now())) return [];
  return ids.filter((id) => ORDER_ID.test(id));
}

/** A Set-Cookie value that adds `id` (newest first) and renews the expiry. */
export function orderCookieWith(id: string, current: string[], secret: string, secure: boolean): string {
  const ids = [id, ...current.filter((x) => x !== id)].slice(0, MAX_IDS);
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = [VERSION, String(expires), ...ids].join('~');
  const attributes = [`Path=${COOKIE_PATH}`, `Max-Age=${MAX_AGE_SECONDS}`, 'HttpOnly', 'SameSite=Strict'];
  if (secure) attributes.push('Secure');
  return `${ORDERS_COOKIE}=${payload}.${sign(payload, secret)}; ${attributes.join('; ')}`;
}

export function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && ORDER_ID.test(value);
}
