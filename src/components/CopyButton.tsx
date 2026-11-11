'use client';

import { useEffect, useRef, useState } from 'react';

export default function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className="btn btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard blocked: the value is on screen to copy by hand.
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
