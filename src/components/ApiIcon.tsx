'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { safeHttpsUrl } from '@/lib/kx/safe-url';
import type { Icon } from '@/lib/kx/types';

/**
 * An icon object from the API, shown as the docs describe: load `url`, retry
 * once with `fallback_url` (https URLs only). When there is no icon (or both
 * URLs fail) it shows `placeholder` (e.g. a ticker) if given, otherwise
 * nothing. Icons are never built from a ticker or bundled with the app; a
 * source whose `icon` is null must not show a logo, so source icons are used
 * without a placeholder.
 */
export default function ApiIcon({
  icon,
  size = 24,
  alt = '',
  placeholder = null,
}: {
  icon: Icon | null | undefined;
  size?: number;
  alt?: string;
  placeholder?: string | null;
}) {
  const primary = safeHttpsUrl(icon?.url);
  const fallback = safeHttpsUrl(icon?.fallback_url);
  const [src, setSrc] = useState<string | null>(primary ?? fallback);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(primary ?? fallback);
    setFailed(false);
  }, [primary, fallback]);

  if (!src || failed) {
    if (!placeholder) return null;
    return (
      <span
        aria-hidden="true"
        className="icon-placeholder"
        style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size / 3)) }}
      >
        {placeholder.slice(0, 3).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, flexShrink: 0, objectFit: 'contain' }}
      onError={() => {
        if (fallback && src !== fallback) setSrc(fallback);
        else setFailed(true);
      }}
    />
  );
}
