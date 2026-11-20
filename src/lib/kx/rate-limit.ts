import 'server-only';

// Per-visitor limits of /api/kx (the proxy, route.ts).
//
// Every call through the proxy spends your account's API budget, and an
// unfunded order counts toward your account's open-order cap. Without these
// limits one visitor could use them up for everyone. The limits run in the
// app itself, so they move with it to any host.
//
//   name           requests                          default
//   orders         POST /api/kx/orders               10 per 600 s
//   quote          POST /api/kx/quote                30 per 60 s
//   validate       POST /api/kx/addresses/validate   20 per 60 s
//   order_status   GET  /api/kx/orders/{id}          30 per 60 s
//   all            everything under /api/kx         120 per 60 s
//
// A request counts toward its own rule and `all`. Over a limit, the proxy
// answers 429 `rate_limited` with Retry-After, before calling the API: no
// order is created, and the page waits and asks again. An order request sent
// again with the same Idempotency-Key (the page does that when an answer got
// lost) is not counted twice, so the order's outcome can always be read.
//
// RATE_LIMITS overrides the defaults: "off" turns every limit off; otherwise a
// comma-separated list of name=limit/seconds or name=off, e.g.
// "orders=5/600,quote=60/60". Windows are fixed (they start on multiples of
// their length) and at most 3600 s.
//
// Where the counts live:
//   - with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or Vercel's
//     KV_REST_API_URL and KV_REST_API_TOKEN), in that Redis (Upstash REST API,
//     no client library), shared by every instance of the app. Use a database
//     of its own for this app: keys start with "kxrl:";
//   - otherwise in this server process. Exact on one long-running server (a
//     VPS); on a serverless host each instance counts on its own, so the limits
//     are only approximate there.
// When Redis cannot be reached the counts fall back to this process, so the
// app keeps working.
//
// Visitors are told apart by their IP, from the same trusted source as the
// end-user IP (server.ts visitorAddress: KOTOVA_END_USER_IP_HEADER or
// TRUSTED_PROXY_HOPS). Without one, every visitor shares one count. The IP is
// stored only as a salted hash.

import { createHash } from 'node:crypto';
import { warnOnce } from './server';

export type LimitName = 'orders' | 'quote' | 'validate' | 'order_status' | 'all';

export interface LimitRule {
  limit: number;
  windowSeconds: number;
}

export const DEFAULT_LIMITS: Readonly<Record<LimitName, LimitRule>> = {
  orders: { limit: 10, windowSeconds: 600 },
  quote: { limit: 30, windowSeconds: 60 },
  validate: { limit: 20, windowSeconds: 60 },
  order_status: { limit: 30, windowSeconds: 60 },
  all: { limit: 120, windowSeconds: 60 },
};

const NAMES = Object.keys(DEFAULT_LIMITS) as LimitName[];
const MAX_WINDOW_SECONDS = 3600;
const KEY_PREFIX = 'kxrl:';

// ----------------------------------------------------------------------------- configuration

type Limits = Map<LimitName, LimitRule>;

let parsed: { raw: string; limits: Limits } | null = null;

/** The limits in force: DEFAULT_LIMITS with RATE_LIMITS applied (a rule turned off is missing). */
export function activeLimits(): Limits {
  const raw = (process.env.RATE_LIMITS ?? '').trim();
  if (parsed?.raw === raw) return parsed.limits;
  const limits = parseLimits(raw);
  parsed = { raw, limits };
  return limits;
}

/** RATE_LIMITS -> limits; an entry that cannot be read is ignored (with a warning) and its default kept. */
export function parseLimits(raw: string): Limits {
  const limits: Limits = new Map(NAMES.map((name) => [name, { ...DEFAULT_LIMITS[name] }]));
  if (!raw) return limits;
  if (raw.toLowerCase() === 'off') return new Map();
  for (const entry of raw.split(',')) {
    const item = entry.trim();
    if (!item) continue;
    const m = /^([a-z_]+)\s*=\s*(?:(off)|(\d+)\s*\/\s*(\d+))$/i.exec(item);
    const name = m?.[1].toLowerCase() as LimitName | undefined;
    if (!m || !name || !NAMES.includes(name)) {
      warnOnce(`RATE_LIMITS: "${item}" is not name=limit/seconds or name=off (names: ${NAMES.join(', ')}); it is ignored.`);
      continue;
    }
    if (m[2]) {
      limits.delete(name);
      continue;
    }
    const limit = Number(m[3]);
    const windowSeconds = Number(m[4]);
    if (limit < 1 || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) {
      warnOnce(`RATE_LIMITS: "${item}" needs a limit of at least 1 and a window of 1 to ${MAX_WINDOW_SECONDS} s; it is ignored.`);
      continue;
    }
    limits.set(name, { limit, windowSeconds });
  }
  return limits;
}

// ----------------------------------------------------------------------------- stores

interface Store {
  /** Adds one to `key` and returns the new count; the key expires after `ttlSeconds`. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Sets `key` when it is not set yet (true), or leaves it (false); it expires after `ttlSeconds`. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

const MAX_MEMORY_KEYS = 50_000;

/** Counts in this server process. */
export class MemoryStore implements Store {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry;
    if (entry) this.entries.delete(key);
    return null;
  }

  private sweep() {
    if (this.entries.size < MAX_MEMORY_KEYS) return;
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    // Still full of live keys: drop the oldest (Map keeps insertion order).
    while (this.entries.size >= MAX_MEMORY_KEYS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    if (entry) {
      entry.count += 1;
      return entry.count;
    }
    this.sweep();
    this.entries.set(key, { count: 1, expiresAt: this.now() + ttlSeconds * 1000 });
    return 1;
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.sweep();
    this.entries.set(key, { count: 1, expiresAt: this.now() + ttlSeconds * 1000 });
    return true;
  }
}

const REDIS_TIMEOUT_MS = 1500;

/** Counts in Redis, over the Upstash REST API (a pipeline per call). */
export class UpstashStore implements Store {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async pipeline(commands: (string | number)[][]): Promise<unknown[]> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      cache: 'no-store',
      signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Redis answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: string }[];
    if (!Array.isArray(body) || body.length !== commands.length) throw new Error('Redis answered in an unexpected shape');
    return body.map((item) => {
      if (item?.error) throw new Error(`Redis: ${item.error}`);
      return item?.result;
    });
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const [count] = await this.pipeline([
      ['INCR', key],
      ['EXPIRE', key, ttlSeconds],
    ]);
    const n = Number(count);
    if (!Number.isFinite(n)) throw new Error('Redis answered INCR with something other than a number');
    return n;
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const [result] = await this.pipeline([['SET', key, '1', 'NX', 'EX', ttlSeconds]]);
    return result === 'OK';
  }
}

const memory = new MemoryStore();
let redis: { url: string; token: string; store: UpstashStore } | null = null;

/** The shared Redis when it is configured, else null (counts stay in this process). */
function redisStore(): UpstashStore | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();
  if (!url || !token) return null;
  if (!/^https:\/\//i.test(url)) {
    warnOnce('The rate-limit Redis URL must start with https://; the limits count in this process instead.');
    return null;
  }
  if (redis?.url !== url || redis.token !== token) redis = { url, token, store: new UpstashStore(url, token) };
  return redis.store;
}

/** Redis when it answers, this process when it does not (the app keeps working). */
async function withFallback<T>(op: (store: Store) => Promise<T>): Promise<T> {
  const shared = redisStore();
  if (shared) {
    try {
      return await op(shared);
    } catch (err) {
      warnOnce(`The rate-limit Redis could not be reached (${err instanceof Error ? err.message : 'error'}); counting in this process for now.`);
    }
  }
  return op(memory);
}

// ----------------------------------------------------------------------------- the check

export type LimitResult =
  | { ok: true }
  | { ok: false; name: LimitName; limit: number; windowSeconds: number; retryAfterSeconds: number };

export interface LimitCheck {
  /** The rules this request counts toward (its own rule and `all`). */
  names: readonly LimitName[];
  /** The visitor (server.ts visitorAddress), or null when none could be read. */
  visitor: string | null;
  /** POST /orders: its Idempotency-Key. A key already counted is not counted again. */
  repeatKey?: string | null;
  /** For tests. */
  store?: Store;
  now?: number;
}

/** A salted hash of the visitor: the IP itself is never stored. */
function visitorId(visitor: string | null): string {
  if (!visitor) {
    warnOnce(
      'Rate limits: no trusted visitor IP (set KOTOVA_END_USER_IP_HEADER or TRUSTED_PROXY_HOPS), so all visitors share one count.',
    );
  }
  return createHash('sha256')
    .update(`kxrl|${process.env.APP_SESSION_SECRET ?? ''}|${visitor ?? 'unidentified'}`)
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Counts this request toward its rules and says whether it may go on. Over a
 * limit: the rule (the one that frees up last, when several are over) and the
 * seconds until its window ends.
 */
export async function checkVisitorLimits(check: LimitCheck): Promise<LimitResult> {
  const limits = activeLimits();
  let rules = check.names
    .map((name) => ({ name, rule: limits.get(name) }))
    .filter((r): r is { name: LimitName; rule: LimitRule } => !!r.rule);
  if (rules.length === 0) return { ok: true };

  const id = visitorId(check.visitor);
  const run = <T>(op: (store: Store) => Promise<T>) => (check.store ? op(check.store) : withFallback(op));

  // The same order request again (same Idempotency-Key): not counted again.
  const orders = rules.find((r) => r.name === 'orders');
  if (orders && check.repeatKey) {
    const key = `${KEY_PREFIX}repeat:${id}:${createHash('sha256').update(check.repeatKey).digest('base64url').slice(0, 22)}`;
    const first = await run((store) => store.claim(key, orders.rule.windowSeconds));
    if (!first) rules = rules.filter((r) => r.name !== 'orders');
  }

  const nowSeconds = (check.now ?? Date.now()) / 1000;
  const counts = await Promise.all(
    rules.map(async ({ name, rule }) => {
      const window = Math.floor(nowSeconds / rule.windowSeconds);
      const count = await run((store) => store.incr(`${KEY_PREFIX}${name}:${id}:${window}`, rule.windowSeconds + 1));
      const retryAfterSeconds = Math.max(1, Math.ceil((window + 1) * rule.windowSeconds - nowSeconds));
      return { name, rule, count, retryAfterSeconds };
    }),
  );
  const over = counts.filter((c) => c.count > c.rule.limit).sort((a, b) => b.retryAfterSeconds - a.retryAfterSeconds)[0];
  if (!over) return { ok: true };
  return { ok: false, name: over.name, limit: over.rule.limit, windowSeconds: over.rule.windowSeconds, retryAfterSeconds: over.retryAfterSeconds };
}
