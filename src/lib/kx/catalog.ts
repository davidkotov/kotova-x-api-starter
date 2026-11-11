// The catalogue the pickers use, built from GET /currencies (currencies with
// their networks and the sources per direction) and GET /sources (names,
// icons, policies and the Kotova X provider block).

import type { Currency, CurrencyList, CurrencyNetwork, Icon, Provider, SourceInfo, SourceList } from './types';

/** One currency on one network: what the user picks. */
export interface Leg {
  /** `${CURRENCY}|${network}`, unique per leg. */
  key: string;
  /** API identifiers. */
  currency: string;
  network: string;
  /** Display ticker on this network (e.g. BTCB on BSC). */
  ticker: string;
  /** Display name on this network, e.g. "Tether (TRC20)". */
  name: string;
  currencyName: string;
  networkName: string;
  type: Currency['type'];
  icon: Icon | null;
  memo: CurrencyNetwork['memo'];
  decimals: number;
  send: boolean;
  receive: boolean;
  sendSources: string[];
  receiveSources: string[];
}

export interface Catalog {
  /** In the API's order (most used first). */
  legs: Leg[];
  byKey: Map<string, Leg>;
  /** GET /sources rows, in display order; empty when that call failed. */
  sources: SourceInfo[];
  sourceBySlug: Map<string, SourceInfo>;
  /** Kotova X, from GET /sources. */
  provider: Provider | null;
}

export function legKey(currency: string, network: string): string {
  return `${currency.toUpperCase()}|${network.toLowerCase()}`;
}

export function buildCatalog(currencies: CurrencyList, sources: SourceList | null): Catalog {
  const legs: Leg[] = [];
  for (const c of currencies.data) {
    for (const n of c.networks) {
      if (!n.send && !n.receive) continue;
      legs.push({
        key: legKey(c.currency, n.network),
        currency: c.currency.toUpperCase(),
        network: n.network.toLowerCase(),
        ticker: n.ticker || c.currency,
        name: n.name || `${c.name} (${n.network_name})`,
        currencyName: c.name,
        networkName: n.network_name,
        type: c.type,
        icon: n.icon ?? c.icon ?? null,
        memo: n.memo,
        decimals: n.decimals,
        send: n.send,
        receive: n.receive,
        sendSources: n.send ? n.send_sources : [],
        receiveSources: n.receive ? n.receive_sources : [],
      });
    }
  }
  const sorted = [...(sources?.data ?? [])].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
  return {
    legs,
    byKey: new Map(legs.map((l) => [l.key, l])),
    sources: sorted,
    sourceBySlug: new Map(sorted.map((s) => [s.slug, s])),
    provider: sources?.provider ?? null,
  };
}

/**
 * Sources that can serve from -> to: from.send_sources and to.receive_sources,
 * minus the ones the user switched off. Empty means a quote would fail, so the
 * pair is not offered.
 */
export function servingSources(from: Leg, to: Leg, excluded: ReadonlySet<string>): string[] {
  const receive = new Set(to.receiveSources);
  return from.sendSources.filter((slug) => receive.has(slug) && !excluded.has(slug));
}

/** Fraction digits a request amount may have on this leg. */
export function maxFractionDigits(leg: Leg): number {
  return Math.max(0, Math.min(leg.decimals, 12));
}

/** A starting amount for the send field, before the user types one. */
export function defaultAmount(leg: Leg): string {
  if (leg.type === 'stablecoin') return '100';
  if (leg.currency === 'BTC') return '0.01';
  return '0.1';
}
