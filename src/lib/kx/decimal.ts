// Amount helpers. The API takes and returns decimal strings ("0.05"): no
// exponent, no sign, at most min(network decimals, 12) fraction digits. Amounts
// typed by the user stay strings all the way to the API.

/** Normalise what the user typed into an amount field (comma to dot, digits and one dot). */
export function cleanAmountInput(raw: string): string {
  let s = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  if (s.startsWith('.')) s = `0${s}`;
  return s;
}

/**
 * A typed amount as a request amount, or null when it is not a positive
 * decimal. Extra fraction digits are cut (never rounded up).
 */
export function toRequestAmount(value: string, maxFractionDigits: number): string | null {
  const s = value.trim();
  if (!/^[0-9]+(\.[0-9]*)?$/.test(s)) return null;
  let [int, frac = ''] = s.split('.');
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.slice(0, Math.max(0, Math.min(12, Math.floor(maxFractionDigits)))).replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return /[1-9]/.test(out) ? out : null;
}

/** Drop trailing zeros ("1.2300" -> "1.23"). */
export function trimAmount(value: string | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** 1 / rate, to 8 significant digits, for the "1 TO = x FROM" line. */
export function invertRate(rate: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return '';
  const inv = 1 / n;
  return trimAmount(inv >= 1e-6 ? inv.toPrecision(8) : inv.toFixed(18));
}
