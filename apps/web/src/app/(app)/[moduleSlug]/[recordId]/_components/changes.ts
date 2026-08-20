/**
 * Reading an `AuditLog.changes` diff.
 *
 * The record engine writes `{ fieldKey: { from, to } }` and nothing else, but
 * this runs over rows that may have been written months ago by an older shape
 * of the writer — and invariant 2 forbids ever UPDATEing the log to tidy them.
 * So every accessor here answers "not a diff I can read" rather than throwing:
 * one malformed row from 2026 must never blank a whole timeline.
 *
 * No 'use client' on purpose — the server page collects the ids it has to
 * resolve from these same diffs, and both sides must read them identically.
 */

export interface ChangePair {
  from: unknown;
  to: unknown;
}

/** `{ from, to }` if this value is one, else null. */
export function changePair(value: unknown): ChangePair | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!('from' in v) && !('to' in v)) return null;
  return { from: v['from'] ?? null, to: v['to'] ?? null };
}

/** Every `[key, { from, to }]` pair in a diff, in the order it was written. */
export function changeEntries(changes: Record<string, unknown> | null): [string, ChangePair][] {
  if (!changes) return [];
  const out: [string, ChangePair][] = [];
  for (const [key, value] of Object.entries(changes)) {
    const pair = changePair(value);
    if (pair) out.push([key, pair]);
  }
  return out;
}

/**
 * A key turned into something a floor manager reads, for the keys that are not
 * field keys — `duplicateOf`, `matchReason` — and for a field an Admin has
 * since soft-deleted, whose label no longer resolves. Splits camelCase and
 * snake_case, then capitalises: `matchReason` -> "Match reason".
 */
export function humanise(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
