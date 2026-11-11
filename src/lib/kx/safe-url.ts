// Links and images from the API (notice links, explorer, tracking and order
// pages, resolve_url, icons) are used only when they are https URLs: never
// javascript:, data:, http: or anything else.

/** The URL when it is https (and carries no credentials), else null. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
