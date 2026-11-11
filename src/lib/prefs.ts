'use client';

// Small per-browser preferences (rate type, filters). Every access is wrapped:
// private windows and blocked site data must not break the page.

const PREFIX = 'kx_';

export function readPref(name: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + name);
  } catch {
    return null;
  }
}

export function writePref(name: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + name);
    else window.localStorage.setItem(PREFIX + name, value);
  } catch {
    // Storage blocked: the preference lasts until the page is reloaded.
  }
}

export function readListPref(name: string): string[] {
  const raw = readPref(name);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
