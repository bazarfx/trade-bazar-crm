/**
 * The serialisation choke point.
 *
 * Nothing leaves the server as a record except through here. Two rules meet in
 * this file, and both of them fail closed:
 *
 *  1. **Hidden fields are stripped on serialisation.** Hiding a field in the
 *     UI is not a security control — the permission matrix decides, and the
 *     value never crosses the wire. A caller that forgets to filter its own
 *     field list still cannot leak one, because the strip happens here rather
 *     than at the call site.
 *  2. **Some columns are never serialised at all**, for any role, including
 *     Admin. A password hash is not data the product displays; it is a
 *     credential, and the only correct number of ways for it to reach a client
 *     is zero.
 *
 * The output is also JSON-safe: RSC refuses a Prisma `Decimal`, and a `Date`
 * that crosses the boundary as an object formats differently on the two sides
 * of a hydration.
 */
import 'server-only';
import type { PermissionEngine } from '@crm/core';

/** A row as a caller sees it: flat, field-keyed, JSON-safe. */
export interface RecordRow extends Record<string, unknown> {
  id: string;
}

/** The minimum a field must declare to be serialised. `FieldMeta` satisfies it. */
export interface SerialisableField {
  key: string;
}

/**
 * Keys that never leave the server, whoever is asking.
 *
 * Deliberately a FLAT key set and not a per-module map: CLAUDE.md forbids
 * branching on a module slug, and slugs are Admin-editable data anyway — a
 * rename must not be able to unlock a credential. Costing one `Set.has` per
 * field on every table is the price of that guarantee.
 *
 * These are the physical column names (`User.passwordHash`,
 * `RefreshToken.tokenHash`), because a FieldDefinition's `systemColumn` is
 * what a projection is ultimately built from and config rows are Admin-written.
 */
export const NEVER_SERIALISED: ReadonlySet<string> = new Set(['passwordHash', 'tokenHash']);

/**
 * React hands these rows to client components, and the RSC serialiser refuses
 * anything that is not a plain value — a Prisma `Decimal` is a class instance
 * and throws on the boundary. Dates leave as ISO strings rather than `Date`s so
 * a cell formats them identically on both sides of a hydration; a money value
 * leaves as its exact digits, because a `Number()` round-trip loses precision.
 */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);

  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  if (kind === 'bigint') return String(value);
  if (kind !== 'object') return null;

  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plain(v);
    return out;
  }
  return String(value);
}

/**
 * Project one flat record down to what this actor may see.
 *
 * `row` is already field-keyed (the storage resolver flattened it) and carries
 * the record's real `id`. `fields` is the projection: only declared keys come
 * back, so a column nobody configured — and every column a future migration
 * adds — is absent by default rather than present by accident.
 *
 * Takes the engine rather than the Principal because the engine IS the object
 * that answers `hiddenFields`; handing it the Principal would mean rebuilding
 * an engine per row.
 */
export function serialiseRecord(
  engine: PermissionEngine,
  moduleSlug: string,
  row: Record<string, unknown>,
  fields: readonly SerialisableField[],
): RecordRow {
  const hidden = engine.hiddenFields(moduleSlug);

  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (hidden.has(f.key) || NEVER_SERIALISED.has(f.key)) continue;
    out[f.key] = plain(row[f.key]);
  }

  // `id` is written LAST and is not a field value: it is the record's identity,
  // which the UI needs as a React key and to open the record. Nothing stops an
  // Admin creating a field whose key is `id`, and a row whose identity had been
  // overwritten by a field value would collide with its neighbours and open the
  // wrong record. Callers pass the database id on `row.id`.
  out['id'] = String(row['id'] ?? '');
  return out as RecordRow;
}

/** `serialiseRecord` over a page of rows. */
export function serialiseMany(
  engine: PermissionEngine,
  moduleSlug: string,
  rows: readonly Record<string, unknown>[],
  fields: readonly SerialisableField[],
): RecordRow[] {
  return rows.map((row) => serialiseRecord(engine, moduleSlug, row, fields));
}
