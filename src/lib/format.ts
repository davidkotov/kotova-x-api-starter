// Display helpers.

/** "~45 s", "~12 min", "~2 h". */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return `~${Math.round(seconds)} s`;
  if (seconds < 5400) return `~${Math.round(seconds / 60)} min`;
  return `~${Math.round(seconds / 3600)} h`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "4:05" or "1:02:03". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** "bc1qxy2k...x0wlh" for long addresses. */
export function shortAddress(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return '';
  return value.length <= head + tail + 3 ? value : `${value.slice(0, head)}...${value.slice(-tail)}`;
}
