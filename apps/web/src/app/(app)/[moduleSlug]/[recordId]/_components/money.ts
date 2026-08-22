/**
 * Money and ratios as the detail screen prints them.
 *
 * Amounts arrive as exact two-decimal DIGITS (`"12345.00"`) — the serialiser
 * never lets a Decimal round-trip through `Number()` — and leave here with
 * thousands grouping added by hand. Not `toLocaleString`: it reads the ICU
 * data and locale of whichever side ran it, and a panel rendered on the
 * server then hydrated in the browser would mismatch on every amount.
 *
 * No currency symbol on purpose: "INR only, or multi?" is an open item in
 * CLAUDE.md, and a symbol guessed here would be a fact the product has not
 * established. The column header says what the number is.
 */

/** `"12,345.00"`. Anything unreadable prints as a dash rather than NaN. */
export function formatMoney(digits: string | number | null | undefined): string {
  if (digits === null || digits === undefined || digits === '') return '—';
  const text = typeof digits === 'number' ? digits.toFixed(2) : String(digits);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return '—';
  const [, sign, whole = '0', fraction = ''] = match;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (fraction + '00').slice(0, 2);
  return `${sign}${grouped}.${cents}`;
}

/** `"12.5%"` from a 0–1 ratio; one decimal, because "12.50%" claims a
 *  precision a conversion rate over 40 leads does not have. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}
