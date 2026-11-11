'use client';

import ApiIcon from './ApiIcon';
import { safeHttpsUrl } from '@/lib/kx/safe-url';
import type { Provider } from '@/lib/kx/types';

/**
 * Display requirement: "Kotova X" by name and icon wherever a quote or an
 * order is shown. Both come from the `provider` block of the API (quotes,
 * orders, GET /sources): the icon loads at runtime from `icon.url`, with
 * `icon.fallback_url` as the retry. The name is shown as given, the icon
 * unmodified at 24 px, both linked to `website_url` (when it is https).
 */
export default function KotovaXMark({ provider, prefix }: { provider: Provider | null | undefined; prefix?: string }) {
  if (!provider) return null;
  const href = safeHttpsUrl(provider.website_url);
  const mark = (
    <>
      <ApiIcon icon={provider.icon} size={24} />
      <span>{provider.name}</span>
    </>
  );
  return (
    <span className="kx-mark">
      {prefix && <span className="muted">{prefix}</span>}
      {href ? (
        <a className="kx-mark-link" href={href} target="_blank" rel="noopener noreferrer">
          {mark}
        </a>
      ) : (
        <span className="kx-mark-link">{mark}</span>
      )}
    </span>
  );
}
