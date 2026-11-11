'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import ApiIcon from './ApiIcon';
import { servingSources, type Leg } from '@/lib/kx/catalog';

const MAX_ROWS = 200;

/**
 * Pick a currency on a network. Lists the legs usable on this side (`send` for
 * "You send", `receive` for "You receive") in the API's order; legs no enabled
 * source can pair with the other side come last, marked.
 */
export default function AssetPicker({
  side,
  legs,
  current,
  other,
  excluded,
  onSelect,
  onClose,
}: {
  side: 'from' | 'to';
  legs: Leg[];
  current: Leg | null;
  other: Leg | null;
  excluded: ReadonlySet<string>;
  onSelect: (leg: Leg) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const usable = legs.filter((l) => (side === 'from' ? l.send : l.receive));
    const matching = q
      ? usable.filter((l) =>
          [l.ticker, l.currency, l.name, l.currencyName, l.networkName, l.network].some((v) => v.toLowerCase().includes(q)),
        )
      : usable;
    const withState = matching.map((leg) => {
      const sameAsOther = !!other && other.key === leg.key;
      const pairs = !other || sameAsOther || (side === 'from' ? servingSources(leg, other, excluded) : servingSources(other, leg, excluded)).length > 0;
      return { leg, pairs };
    });
    // Keep the API's order, pairable legs first.
    return [...withState.filter((r) => r.pairs), ...withState.filter((r) => !r.pairs)];
  }, [legs, side, query, other, excluded]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <h2 id={titleId}>{side === 'from' ? 'You send' : 'You receive'}</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="dialog-search">
          <input
            ref={searchRef}
            type="search"
            className="input"
            placeholder="Search currency or network"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search currency or network"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ul className="dialog-list">
          {rows.slice(0, MAX_ROWS).map(({ leg, pairs }) => (
            <li key={leg.key}>
              <button
                type="button"
                className="dialog-item"
                aria-current={current?.key === leg.key ? 'true' : undefined}
                onClick={() => onSelect(leg)}
              >
                <ApiIcon icon={leg.icon} size={28} placeholder={leg.ticker} />
                <span className="dialog-item-text">
                  <span>
                    <strong>{leg.ticker}</strong> <span className="muted">{leg.currencyName}</span>
                  </span>
                  <span className="small faint">{leg.networkName}</span>
                </span>
                {!pairs && other && <span className="small faint">No source for {other.ticker}</span>}
              </button>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p className="dialog-note">Nothing matches &ldquo;{query}&rdquo;.</p>}
        {rows.length > MAX_ROWS && (
          <p className="dialog-note">
            Showing {MAX_ROWS} of {rows.length}. Type to narrow the list.
          </p>
        )}
      </div>
    </div>
  );
}
