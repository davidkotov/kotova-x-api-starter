'use client';

import ApiIcon from './ApiIcon';
import type { Provider } from '@/lib/kx/types';

/** Where the Kotova X name and icon link to: the Kotova X app. */
const KOTOVA_X_URL = 'https://app.kotova.io';

/**
 * Display requirement: "Kotova X" by name and icon wherever a quote or an
 * order is shown. Both come from the `provider` block of the API (quotes,
 * orders, GET /sources): the icon loads at runtime from `icon.url`, with
 * `icon.fallback_url` as the retry. The name is shown as given, the icon
 * unmodified at 24 px, both linked to the Kotova X app (KOTOVA_X_URL).
 */
export default function KotovaXMark({ provider, prefix }: { provider: Provider | null | undefined; prefix?: string }) {
  if (!provider) return null;
  return (
    <span className="kx-mark">
      {prefix && <span className="muted">{prefix}</span>}
      <a className="kx-mark-link" href={KOTOVA_X_URL} target="_blank" rel="noopener noreferrer">
        <ApiIcon icon={provider.icon} size={24} />
        <span>{provider.name}</span>
      </a>
    </span>
  );
}
