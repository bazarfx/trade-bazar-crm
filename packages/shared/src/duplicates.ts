import { z } from 'zod';
import type { FieldType } from './field-types.js';

/**
 * Duplicate review (spec §6.6): an incoming record matching an existing one is
 * CREATED and FLAGGED — never blocked, never auto-merged. The review queue
 * resolves flagged pairs; "merge" is a decision a person records AFTER moving
 * the data by hand, so the only resolutions that exist are the three below.
 * There is deliberately no MERGE operation anywhere in the API.
 */

export const DUPLICATE_RESOLUTIONS = ['KEPT_BOTH', 'MERGED', 'DISMISSED'] as const;
export type DuplicateResolution = (typeof DUPLICATE_RESOLUTIONS)[number];

/** A flag's lifecycle: PENDING until a permitted user picks a resolution. */
export const DUPLICATE_STATUSES = ['PENDING', ...DUPLICATE_RESOLUTIONS] as const;
export type DuplicateStatusValue = (typeof DUPLICATE_STATUSES)[number];

/** `POST /api/modules/{slug}/duplicates/{flagId}/resolve` */
export const duplicateResolveSchema = z
  .object({ resolution: z.enum(DUPLICATE_RESOLUTIONS) })
  .strict();

export type DuplicateResolveInput = z.infer<typeof duplicateResolveSchema>;

/** `?status=` on `GET /api/modules/{slug}/duplicates`. */
export const duplicateStatusSchema = z.enum(DUPLICATE_STATUSES);

// ── outbound shapes ───────────────────────────────────────────────────────

/**
 * One side of a flagged pair. `values` is field-keyed and already serialised —
 * hidden fields were stripped on the server, so the client renders whatever
 * arrives without asking permission questions it cannot answer.
 */
export interface DuplicateSideDto {
  id: string;
  values: Record<string, unknown>;
}

/** What the queue needs to draw a field row — a CellField plus its label. */
export interface DuplicateQueueFieldDto {
  key: string;
  label: string;
  type: FieldType;
  systemColumn: string | null;
  options: { value: string; label: string }[];
}

export interface DuplicateFlagDto {
  id: string;
  /** what matched: 'phone' | 'name_language' — written by the record engine */
  matchReason: string;
  /**
   * The field keys that reason was decided on, so the queue can point at the
   * rows that matched instead of only naming the reason in a chip. Derived
   * server-side from the module's own field definitions — the client never
   * guesses which key is "the phone".
   */
  matchedFieldKeys: string[];
  confidence: string;
  status: DuplicateStatusValue;
  createdAt: string;
  /**
   * Either side is null when the record is outside the viewer's scope or was
   * soft-deleted since the flag was written. The flag itself still lists — a
   * pair half of which you cannot see is still a pair someone must settle.
   */
  primary: DuplicateSideDto | null;
  candidate: DuplicateSideDto | null;
}

export interface DuplicateQueueDto {
  flags: DuplicateFlagDto[];
  /** how many flags match the requested status in total, not just this page */
  total: number;
  /** the module's visible fields, so the pair renders without a second fetch */
  fields: DuplicateQueueFieldDto[];
}
