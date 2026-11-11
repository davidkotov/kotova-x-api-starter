'use client';

// The catalogue, shared by every component on the page: one fetch per minute
// per tab, refreshed only while the tab is visible.

import { useCallback, useEffect, useState } from 'react';
import { kx, KxError } from './client';
import { buildCatalog, type Catalog } from './catalog';

const TTL_MS = 60_000;

let cached: { catalog: Catalog; at: number } | null = null;
let inflight: Promise<Catalog> | null = null;
const listeners = new Set<(c: Catalog | null, e: string | null) => void>();

async function loadCatalog(): Promise<Catalog> {
  const [currencies, sources] = await Promise.all([
    kx.currencies(),
    // Sources add names, icons and the provider block; swaps work without them.
    kx.sources().catch(() => null),
  ]);
  return buildCatalog(currencies.data, sources?.data ?? null);
}

function refresh(force = false): void {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return;
  if (inflight) return;
  inflight = loadCatalog();
  inflight
    .then((catalog) => {
      cached = { catalog, at: Date.now() };
      listeners.forEach((l) => l(catalog, null));
    })
    .catch((err: unknown) => {
      const msg = err instanceof KxError ? `${err.code}: ${err.message}` : 'The currency list could not be loaded.';
      listeners.forEach((l) => l(cached?.catalog ?? null, msg));
    })
    .finally(() => {
      inflight = null;
    });
}

export function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(cached?.catalog ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (c: Catalog | null, e: string | null) => {
      setCatalog(c);
      setError(e);
    };
    listeners.add(listener);
    if (cached) setCatalog(cached.catalog);
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, TTL_MS);
    return () => {
      listeners.delete(listener);
      window.clearInterval(timer);
    };
  }, []);

  const retry = useCallback(() => refresh(true), []);
  return { catalog, error, loading: !catalog && !error, retry };
}
