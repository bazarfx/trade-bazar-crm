/**
 * Timeline timestamps: "2 hours ago", with the exact moment in the tooltip.
 *
 * Both formats are computed the same way on the server and in the browser —
 * fixed month names, read in UTC — because `toLocaleString` uses the ICU data
 * and timezone of whichever side ran it, and a timeline is the one screen
 * where every row would then mismatch on hydration.
 *
 * The relative form takes `nowMs` as an ARGUMENT rather than reading
 * `Date.now()`: the caller seeds it with the server's clock so the first
 * client render is byte-identical to the server's, then ticks it forward.
 *
 * TODO(record engine): render in the workspace timezone once there is one to
 * read; UTC is the only choice that is identical on both sides today.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `20 Aug 2026, 14:32 UTC` — the tooltip form, never abbreviated. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = MONTHS[d.getUTCMonth()] ?? '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** `just now` / `4 minutes ago` / `3 days ago`, falling back to the date. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  // A timestamp in the future means clock skew between the app server and the
  // database, not a scheduled event — "in 3 seconds" would read as a bug.
  const delta = Math.max(nowMs - then, 0);

  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), 'minute');
  if (delta < DAY) return plural(Math.floor(delta / HOUR), 'hour');
  if (delta < 30 * DAY) return plural(Math.floor(delta / DAY), 'day');

  // Past a month "47 days ago" stops being useful; the date itself is.
  return absoluteTime(iso).split(',')[0] ?? absoluteTime(iso);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/*
 * Day grouping follows the file's one rule: UTC on both sides. A local-time
 * "Today" would be truer to the reader's morning, but the headers are
 * server-rendered — grouping in each runtime's own timezone makes the server
 * and the browser disagree about how many headers the list even has, which is
 * a structural hydration failure, not a wording nit. `nowMs` follows the same
 * seeding pattern as `relativeTime`. The workspace-timezone TODO above covers
 * these two the day it lands.
 */

/** Same string ⇔ same UTC calendar day — the timeline's grouping key. */
export function utcDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

/** `Today` / `Yesterday` / `18 Aug 2026`, on the UTC calendar. */
export function dayLabel(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const days = Math.floor((utcMidnight(nowMs) - utcMidnight(then)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(then);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

function utcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
