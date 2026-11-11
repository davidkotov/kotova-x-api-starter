import 'server-only';

// Server-side settings for calling the Kotova X API. Read here and nowhere else;
// none of them may be prefixed with NEXT_PUBLIC_.
//
//   KOTOVA_API_KEY              your secret key (ktv_sk_...)
//   KOTOVA_API_BASE             optional; default https://api.kotova.io/x/v1
//                               (https only; plain http only for a loopback host)
//   APP_SESSION_SECRET          signs the cookie that lists the orders created in a
//                               browser (required in production)
//   APP_ORIGIN                  optional; the origin(s) allowed to POST to /api/kx
//   KOTOVA_END_USER_IP_HEADER   optional; a header your host sets to the visitor's IP
//   TRUSTED_PROXY_HOPS          optional; proxies in front of the app that append to
//                               X-Forwarded-For
//   KOTOVA_DEV_END_USER_IP      optional, development only; a public IP to send as
//                               end_user_ip when no trusted one is found
//
// See README.md, "Configuration" and "Before you deploy".

import { randomBytes } from 'node:crypto';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Configuration details (API host, missing settings) are shown only outside production. */
export const SHOW_CONFIG_DETAILS = !IS_PRODUCTION;

export const DEFAULT_API_BASE = 'https://api.kotova.io/x/v1';

const warned = new Set<string>();

/** Logs a configuration warning once per server process (never a secret or an IP). */
export function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[kx] ${message}`);
}

// ----------------------------------------------------------------------------- API base and key

export type ApiBase = { ok: true; url: string; host: string } | { ok: false; problem: string };

/**
 * KOTOVA_API_BASE, checked: the key travels with every keyed call, so it must
 * never go out in cleartext. https is required; http is accepted only for a
 * loopback host (a local test API).
 */
export function apiBase(): ApiBase {
  const raw = (process.env.KOTOVA_API_BASE || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: 'KOTOVA_API_BASE is not a valid URL.' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { ok: false, problem: 'KOTOVA_API_BASE must be a plain base URL (no credentials, query or fragment).' };
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return { ok: true, url: raw, host: url.host };
  }
  return { ok: false, problem: 'KOTOVA_API_BASE must be an https:// URL (plain http:// only for localhost).' };
}

export function apiKey(): string | null {
  const key = (process.env.KOTOVA_API_KEY || '').trim();
  return key || null;
}

/** localhost, *.localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  const v4 = ipv4ToNumber(host);
  return v4 !== null && v4 >>> 24 === 127;
}

// ----------------------------------------------------------------------------- session secret

export type SessionSecret = { ok: true; secret: string } | { ok: false; problem: string };

const MIN_SECRET_LENGTH = 32;
const DEV_SECRET = Symbol.for('kx.devSessionSecret');

/**
 * APP_SESSION_SECRET signs the cookie that lists the orders created in a
 * browser. In production it is required. In development a random one is made
 * for the life of the dev server (kept across hot reloads), with a warning:
 * orders created before a restart can no longer be opened in this app.
 */
export function sessionSecret(): SessionSecret {
  const raw = (process.env.APP_SESSION_SECRET || '').trim();
  if (raw) {
    return raw.length >= MIN_SECRET_LENGTH
      ? { ok: true, secret: raw }
      : { ok: false, problem: `APP_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters (for example: openssl rand -hex 32).` };
  }
  if (IS_PRODUCTION) {
    return { ok: false, problem: 'APP_SESSION_SECRET is not set (for example: openssl rand -hex 32). See .env.example.' };
  }
  const store = globalThis as unknown as Record<symbol, string | undefined>;
  if (!store[DEV_SECRET]) {
    store[DEV_SECRET] = randomBytes(32).toString('hex');
    warnOnce(
      'APP_SESSION_SECRET is not set: using a random secret until this dev server stops. Orders created before a restart cannot be opened in the app afterwards. Set it in .env.local (openssl rand -hex 32).',
    );
  }
  return { ok: true, secret: store[DEV_SECRET] as string };
}

// ----------------------------------------------------------------------------- allowed origins

/**
 * APP_ORIGIN: comma-separated origins (https://swap.example.com) allowed to
 * POST to the proxy. Empty when not set or not valid.
 */
export function allowedOrigins(): string[] {
  const raw = (process.env.APP_ORIGIN || '').trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.origin);
      else warnOnce(`APP_ORIGIN: ignoring "${value}" (not an http(s) origin).`);
    } catch {
      warnOnce(`APP_ORIGIN: ignoring "${value}" (not a URL).`);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- end-user IP

/**
 * The visitor's IP for `end_user_ip` on POST /quote, or null. Some sources
 * check where the end user is; without the IP the API skips them (quote warning
 * `end_user_ip_missing`).
 *
 * Nothing is trusted by default: a header can only be believed when your host
 * sets it, so you name it.
 *
 *   KOTOVA_END_USER_IP_HEADER  a header that your host sets (or overwrites) to the
 *                              visitor's IP, one address only: x-vercel-forwarded-for
 *                              (Vercel), cf-connecting-ip (Cloudflare, origin reachable
 *                              only through Cloudflare), fly-client-ip (Fly.io),
 *                              x-real-ip (your nginx sets it from $remote_addr).
 *   TRUSTED_PROXY_HOPS         N proxies in front of the app, each appending to
 *                              X-Forwarded-For: the visitor is the N-th entry from the
 *                              right. Entries further left are chosen by the visitor.
 *
 * The header is tried first, then the hops. Only a public unicast address is
 * sent (the API's rules). With neither set, nothing is sent, except that
 * outside production KOTOVA_DEV_END_USER_IP stands in, so sources that need
 * the IP can be tried from a local machine.
 */
export function endUserIp(headers: Headers): string | null {
  const trusted = trustedClientIp(headers);
  if (trusted) return trusted;
  if (!IS_PRODUCTION) return devEndUserIp();
  return null;
}

function trustedClientIp(headers: Headers): string | null {
  const headerName = (process.env.KOTOVA_END_USER_IP_HEADER || '').trim().toLowerCase();
  if (headerName) {
    if (headerName === 'x-forwarded-for' || headerName === 'forwarded') {
      warnOnce(`KOTOVA_END_USER_IP_HEADER=${headerName} is ignored: its left entries are chosen by the visitor. Use TRUSTED_PROXY_HOPS instead.`);
    } else if (!/^[a-z0-9-]{1,64}$/.test(headerName)) {
      warnOnce('KOTOVA_END_USER_IP_HEADER is not a valid header name; it is ignored.');
    } else {
      const value = headers.get(headerName);
      // One address only: a list means something appended to the header.
      if (value && !value.includes(',')) {
        const ip = publicUnicastIp(value);
        if (ip) return ip;
      }
    }
  }

  const hops = trustedProxyHops();
  if (hops) {
    const xff = headers.get('x-forwarded-for');
    if (xff) {
      const entries = xff.split(',').map((s) => s.trim());
      const entry = entries.length >= hops ? entries[entries.length - hops] : '';
      const ip = entry ? publicUnicastIp(entry) : null;
      if (ip) return ip;
    }
  }
  return null;
}

function trustedProxyHops(): number | null {
  const raw = (process.env.TRUSTED_PROXY_HOPS || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  warnOnce('TRUSTED_PROXY_HOPS must be a whole number from 1 to 10; it is ignored.');
  return null;
}

function devEndUserIp(): string | null {
  const raw = (process.env.KOTOVA_DEV_END_USER_IP || '').trim();
  if (!raw) return null;
  const ip = publicUnicastIp(raw);
  if (!ip) warnOnce('KOTOVA_DEV_END_USER_IP is not a public unicast IP address; it is ignored.');
  return ip;
}

// ----------------------------------------------------------------------------- public unicast check
//
// The same rules the API applies to `end_user_ip` (anything else is a 400
// invalid_request, reason not_public_unicast, and the whole quote fails).
//
// IPv4, not public: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
// 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24,
// 203.0.113/24, 224/4, 240/4. An octet with a leading zero ("010.0.0.1") is
// refused: some parsers read it as octal.
// IPv6: only global unicast 2000::/3, minus 2001::/23, 2001:db8::/32 and
// 3fff::/20. 6to4 (2002::/16) is judged by the IPv4 address it embeds, and an
// IPv4-mapped address (::ffff:a.b.c.d, dotted or hex) is that IPv4 address.

/** Dotted quad -> unsigned 32-bit number; strict: four 0-255 octets, no leading zeros. */
function ipv4ToNumber(text: string): number | null {
  const octets = text.split('.');
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    if (octet.length > 1 && octet.startsWith('0')) return null;
    const n = Number(octet);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/** IPv6 text -> eight 16-bit groups, or null. "::" stands for at least one group; an IPv4 tail must be strict. */
function ipv6Groups(text: string): number[] | null {
  let value = text;
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (v4Tail) {
    if (v4Tail.index === 0 || value[v4Tail.index - 1] !== ':') return null;
    const v4 = ipv4ToNumber(v4Tail[1]);
    if (v4 === null) return null;
    value = `${value.slice(0, v4Tail.index)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const given = head.length + tail.length;
  if (halves.length === 2 ? given > 7 : given !== 8) return null;
  if (![...head, ...tail].every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return [...head, ...Array<string>(8 - given).fill('0'), ...tail].map((group) => parseInt(group, 16));
}

const IPV4_NOT_PUBLIC = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((cidr) => {
  const [address, length] = cidr.split('/');
  const prefix = Number(length);
  return { base: ipv4ToNumber(address) as number, mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0 };
});

const IPV6_NOT_PUBLIC_IN_GLOBAL = ['2001::/23', '2001:db8::/32', '3fff::/20'].map((cidr) => {
  const [address, length] = cidr.split('/');
  return { groups: ipv6Groups(address) as number[], prefix: Number(length) };
});

const MAX_IP_TEXT = 64;

function isPublicIpv4Number(value: number): boolean {
  return !IPV4_NOT_PUBLIC.some(({ base, mask }) => (value & mask) >>> 0 === base);
}

function inIpv6Range(groups: number[], range: { groups: number[]; prefix: number }): boolean {
  for (let i = 0, left = range.prefix; i < 8 && left > 0; i += 1, left -= 16) {
    const bits = Math.min(16, left);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((groups[i] & mask) !== (range.groups[i] & mask)) return false;
  }
  return true;
}

/**
 * The address in the form the API accepts when it is public unicast, else
 * null. Accepts "[v6]:port", "v4:port", a zone id and the IPv4-mapped form;
 * IPv4 (also IPv4-mapped) comes back as a dotted quad, IPv6 in lower case.
 */
export function publicUnicastIp(raw: string): string | null {
  let text = raw.trim();
  if (!text || text.length > MAX_IP_TEXT) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed) text = bracketed[1];
  text = text.replace(/%[0-9a-zA-Z]+$/, '');
  text = text.replace(/^::ffff:(?=\d{1,3}(\.\d{1,3}){3}$)/i, '');
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  if (v4WithPort) text = v4WithPort[1];

  if (!text.includes(':')) {
    const v4 = ipv4ToNumber(text);
    return v4 !== null && isPublicIpv4Number(v4) ? text : null;
  }

  const groups = ipv6Groups(text);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = groups[6] * 0x10000 + groups[7];
    return isPublicIpv4Number(v4) ? numberToIpv4(v4) : null;
  }
  if ((groups[0] & 0xe000) !== 0x2000) return null;
  if (IPV6_NOT_PUBLIC_IN_GLOBAL.some((range) => inIpv6Range(groups, range))) return null;
  if (groups[0] === 0x2002 && !isPublicIpv4Number(groups[1] * 0x10000 + groups[2])) return null;
  return text.toLowerCase();
}
