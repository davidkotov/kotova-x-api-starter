'use client';

// Orders created in this browser, so the app can list and reopen them. The
// API is the record: GET /orders lists every order of your account.

import type { Provider } from './types';

const KEY = 'kx_recent_orders';
const MAX = 20;

export interface RecentOrder {
  id: string;
  createdAt: string;
  /** "0.01 BTC" */
  from: string;
  /** "0.25 ETH" */
  to: string;
  /** The order's source (the one that executes it), never the quote's. */
  source?: string;
  /** Kotova X, shown with the list (display requirements). */
  provider?: Provider;
  /** The quote's source, when the order was placed with a fallback source instead. */
  quotedSource?: { slug: string; name: string; reason: string } | null;
  /** Warnings of the 201 (GET /orders/{id} does not repeat them). */
  warnings?: { code: string; message: string }[];
}

export function readRecentOrders(): RecentOrder[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((o): o is RecentOrder => !!o && typeof (o as RecentOrder).id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberOrder(order: RecentOrder): void {
  try {
    const list = readRecentOrders().filter((o) => o.id !== order.id);
    list.unshift(order);
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Storage blocked (private window): the order page still works by its URL.
  }
}

export function findRecentOrder(id: string): RecentOrder | null {
  return readRecentOrders().find((o) => o.id.toUpperCase() === id.toUpperCase()) ?? null;
}
