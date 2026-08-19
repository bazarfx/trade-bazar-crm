import { SYSTEM_TAGS, type StatusTagValue } from '@crm/shared';

/**
 * Status semantics. System behaviour keys off the TAG, never the name —
 * names, colours and order are Admin-editable data.
 *
 * Pure functions over status rows: used by the config service (web) to guard
 * edits, and by the ARK webhook pipeline (worker) to resolve targets.
 */

export interface StatusRow {
  id: string;
  name: string;
  tag: StatusTagValue;
  displayOrder: number;
  isDeleted: boolean;
}

/**
 * The status a pipeline moves a record to for a given tag.
 * DETERMINISTIC: lowest displayOrder wins, id breaks a tie. Two statuses may
 * share a tag; the webhook must never pick one at random.
 */
export function pickStatusByTag(statuses: StatusRow[], tag: StatusTagValue): StatusRow | null {
  const live = statuses
    .filter((s) => !s.isDeleted && s.tag === tag)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  return live[0] ?? null;
}

/**
 * Guard for delete / re-tag. A module that HAS a status carrying a system tag
 * (CONVERTED, SIGNED_UP) must always keep at least one active status with that
 * tag — otherwise the webhook pipeline has nowhere to move a record and the
 * only conversion path in the product silently dies.
 */
export function guardTagChange(
  statuses: StatusRow[],
  targetId: string,
  change: { newTag?: StatusTagValue; deleting?: boolean },
): { ok: true } | { ok: false; reason: string } {
  const target = statuses.find((s) => s.id === targetId && !s.isDeleted);
  if (!target) return { ok: false, reason: 'Status not found' };

  const isSystemTag = (SYSTEM_TAGS as readonly string[]).includes(target.tag);
  if (!isSystemTag) return { ok: true };

  const losesTag = change.deleting || (change.newTag !== undefined && change.newTag !== target.tag);
  if (!losesTag) return { ok: true };

  const others = statuses.filter(
    (s) => !s.isDeleted && s.id !== targetId && s.tag === target.tag,
  );
  if (others.length > 0) return { ok: true };

  return {
    ok: false,
    reason:
      `This is the last active status tagged ${target.tag}. The webhook pipeline ` +
      `moves records to that tag; add another status carrying it first.`,
  };
}
