'use client';

import ApiIcon from './ApiIcon';
import { safeHttpsUrl } from '@/lib/kx/safe-url';
import type { FallbackSource, Source, SourceNotice } from '@/lib/kx/types';

/**
 * A source notice word for word, with the part equal to `link_text` rendered
 * as a link to `link_url` (https only; otherwise the words stay as plain
 * text). Never shorten, reword or translate it here: ask the API for the
 * user's language (`lang`) instead.
 */
export function NoticeText({ notice }: { notice: SourceNotice }) {
  const { text, link_text: linkText } = notice;
  const linkUrl = safeHttpsUrl(notice.link_url);
  const at = linkText ? text.indexOf(linkText) : -1;
  const link = linkUrl ? (
    <a href={linkUrl} target="_blank" rel="noopener noreferrer">
      {linkText || linkUrl}
    </a>
  ) : (
    <span>{linkText}</span>
  );
  if (at < 0) {
    if (!linkUrl) return <span lang={notice.lang}>{text}</span>;
    // link_text is part of text by contract; if it ever is not, keep the text
    // unchanged and put the link after it.
    return (
      <span lang={notice.lang}>
        {text} {link}
      </span>
    );
  }
  return (
    <span lang={notice.lang}>
      {text.slice(0, at)}
      {link}
      {text.slice(at + linkText.length)}
    </span>
  );
}

/**
 * The notices the user must see before confirming: the quote's source notice
 * and, directly next to it, the notices of the fallback sources the order may
 * be placed with (`retry_next_best_source`, on by default), in an expandable
 * section. With fallback off, only the quote's source is tried, so only its
 * notice is needed.
 */
export function SourceNotices({
  source,
  fallbacks,
  fallbackEnabled,
  fromTicker,
  toTicker,
}: {
  source: Source;
  fallbacks: FallbackSource[];
  fallbackEnabled: boolean;
  fromTicker: string;
  toTicker: string;
}) {
  return (
    <section className="notice" aria-label="Source notices">
      <p>
        <NoticeText notice={source.notice} />
      </p>
      {fallbackEnabled && fallbacks.length > 0 && (
        <details className="notice-fallbacks">
          <summary>
            {`If ${source.name} can't take the order, it is placed with the next best source (${fallbacks.length} more).`}
          </summary>
          <ol>
            {fallbacks.map((f, i) => (
              <li key={f.source.slug}>
                <span className="faint tabular">{i + 1}.</span>
                <ApiIcon icon={f.source.icon} size={16} />
                <span>
                  <NoticeText notice={f.source.notice} />
                  <span className="faint" style={{ display: 'block', marginTop: 2 }}>
                    Offer there: {f.from.amount} {fromTicker} &rarr; {f.to.amount} {toTicker}
                    {f.requirements.refund_address === 'required' ? ' · only with a refund address' : ''}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {!fallbackEnabled && fallbacks.length > 0 && (
        <p className="faint" style={{ marginTop: 8 }}>
          Fallback is off: only {source.name} is tried.
        </p>
      )}
    </section>
  );
}
