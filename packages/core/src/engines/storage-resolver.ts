/**
 * Hybrid storage resolver.
 *
 * Core modules (leads, deals, users, deposits, campaigns) live in real tables
 * with real indexes and foreign keys — that is where the volume is.
 * Admin-created modules share the generic `records` table, so creating a module
 * needs no DDL, no migration and no deploy.
 *
 * NOTHING outside this file may know which is which. Every engine, route and
 * component works identically against both. If a caller branches on module
 * slug, that branch is a bug.
 */

import type { FieldType } from '@crm/shared';
import type { FieldLocation } from './filter-compiler.js';

export interface FieldMeta {
  key: string;
  type: FieldType;
  /** real column name on a core table; null = lives in the JSONB container */
  systemColumn: string | null;
}

export interface ModuleMeta {
  slug: string;
  isCore: boolean;
  fields: FieldMeta[];
}

/** Prisma delegate names for the core modules. */
const CORE_DELEGATES: Record<string, string> = {
  leads: 'lead',
  deals: 'deal',
  users: 'user',
  deposits: 'deposit',
  campaigns: 'campaign',
};

export class StorageResolver {
  private readonly byKey: Map<string, FieldMeta>;

  constructor(private readonly meta: ModuleMeta) {
    this.byKey = new Map(meta.fields.map((f) => [f.key, f]));
  }

  /** Prisma delegate to query. Generic modules always use `record`. */
  get delegate(): string {
    return this.meta.isCore ? (CORE_DELEGATES[this.meta.slug] ?? 'record') : 'record';
  }

  /** Extra where clause pinning generic queries to this module. */
  get discriminator(): Record<string, unknown> {
    return this.meta.isCore ? {} : { module: { slug: this.meta.slug } };
  }

  /** JSONB container column for custom values. */
  get jsonColumn(): string {
    return this.meta.isCore ? 'custom' : 'data';
  }

  /**
   * Resolve a field key to its physical location.
   * Throws on unknown keys — silently dropping a filter condition widens the
   * result set, which can leak records past a permission scope.
   */
  resolve = (fieldKey: string): FieldLocation => {
    const f = this.byKey.get(fieldKey);
    if (!f) throw new Error(`Unknown field "${fieldKey}" on module "${this.meta.slug}"`);
    return { column: f.systemColumn, jsonColumn: this.jsonColumn, key: f.key, type: f.type };
  };

  /** Split an inbound payload into real columns and the JSONB blob. */
  partition(input: Record<string, unknown>): { columns: Record<string, unknown>; json: Record<string, unknown> } {
    const columns: Record<string, unknown> = {};
    const json: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      const f = this.byKey.get(k);
      if (!f) continue; // unknown keys are dropped on write — the schema is the contract
      if (f.systemColumn) columns[f.systemColumn] = v;
      else json[k] = v;
    }
    return { columns, json };
  }

  /** Recombine a database row back into a flat, field-keyed record. */
  flatten(row: Record<string, unknown>): Record<string, unknown> {
    const blob = (row[this.jsonColumn] ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { id: row['id'] };
    for (const f of this.meta.fields) {
      out[f.key] = f.systemColumn ? row[f.systemColumn] : blob[f.key];
    }
    return out;
  }
}
