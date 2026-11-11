'use client';

import ApiIcon from './ApiIcon';
import type { SourceInfo } from '@/lib/kx/types';

/** At most 20 slugs per quote (`exclude_sources`). */
export const MAX_EXCLUDED = 20;

/**
 * Switch sources on or off. Switched-off sources are sent in `exclude_sources`
 * with every quote.
 */
export default function SourceFilter({
  sources,
  excluded,
  disabled,
  onToggle,
}: {
  sources: SourceInfo[];
  excluded: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (slug: string) => void;
}) {
  if (sources.length === 0) return <p className="hint">The source list could not be loaded.</p>;
  return (
    <div>
      <p className="hint">Switched-off sources are left out of your quotes.</p>
      <ul className="source-list">
        {sources.map((s) => {
          const on = !excluded.has(s.slug);
          const atLimit = on && excluded.size >= MAX_EXCLUDED;
          return (
            <li key={s.slug}>
              <label>
                <input type="checkbox" checked={on} disabled={disabled || atLimit} onChange={() => onToggle(s.slug)} />
                <ApiIcon icon={s.icon} size={20} />
                <span style={{ flex: 1 }}>{s.name}</span>
                {s.status !== 'active' && <span className="tag">Unavailable</span>}
                {s.freeze_protection && <span className="tag">No freeze</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
