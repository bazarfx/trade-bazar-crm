'use client';

import type { ReactNode } from 'react';
import { FIELD_TYPE_SPECS, type FieldType, type StatusTagValue } from '@crm/shared';
import { StatusChip } from '@/components/ui';
import { CheckIcon } from './icons';

/**
 * How a value is drawn, decided by the field's TYPE — never by its key, its
 * label or the module it belongs to. A module an Admin invents next year gets
 * every renderer below for free, because the only question this file asks is
 * "what type is this field".
 */
export interface CellField {
  key: string;
  type: FieldType;
  systemColumn: string | null;
  /**
   * The field's picklist options, when it has any.
   *
   * A picklist STORES a value and DISPLAYS a label, and the two are not the
   * same string — `source` stores the `LeadSource` enum member `ARK_TERMINAL`
   * and reads "ARK Terminal". Most seeded options happen to use one string for
   * both, which hides the difference until an Admin renames an option: the
   * stored value never changes, so a renderer echoing the raw value would keep
   * showing the OLD label forever, here and in every timeline diff.
   */
  options?: readonly { value: string; label: string }[];
}

export interface StatusOption {
  id: string;
  name: string;
  tag: StatusTagValue;
  color: string | null;
}

/**
 * The system column a status field maps to — the same name on the core tables
 * and on the generic `records` table. Keying on the COLUMN rather than on a
 * field key, a label or a module slug is what makes the status chip appear on
 * every module that has a pipeline and on none that does not.
 */
const STATUS_COLUMN = 'statusId';

/** Nothing to show. Matches the DataTable's own placeholder. */
const EMPTY = '—';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A fixed, locale-free format read in UTC.
 *
 * `toLocaleDateString` renders differently on the server and in the browser —
 * different ICU data, different timezone — and that lands as a hydration
 * mismatch on the busiest column of the busiest screen.
 *
 * TODO(record engine): render in the workspace timezone once there is one to
 * read; UTC is the only choice that is identical on both sides today.
 */
function shortDate(iso: string, withTime: boolean): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  const day = String(d.getUTCDate()).padStart(2, '0');
  const date = `${day} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
  if (!withTime) return date;

  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${date}, ${hh}:${mm}`;
}

function BooleanCell({ value }: { value: boolean }) {
  // A tick and a dash, not "true"/"false": the column is scanned, not read.
  // The accessible name sits on the wrapper because the icon itself is
  // decorative — it is one of two glyphs standing in for one of two words.
  return value ? (
    <span role="img" aria-label="Yes" className="inline-flex text-success">
      <CheckIcon className="h-4 w-4" />
    </span>
  ) : (
    <span role="img" aria-label="No">
      {EMPTY}
    </span>
  );
}

/**
 * A picklist value (or array of them) as the labels it names.
 *
 * A value with no matching option is one whose option the Admin retired —
 * invariant 4 keeps the record's data readable, so the raw value is shown
 * rather than a gap. Returns null when there is nothing to resolve, so the
 * caller falls through to the plain renderers.
 */
export function optionLabel(field: CellField | undefined, value: unknown): string | null {
  const options = field?.options;
  if (!options || options.length === 0) return null;

  const labelFor = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    return options.find((o) => o.value === v)?.label ?? v;
  };

  if (Array.isArray(value)) {
    const parts = value.map(labelFor).filter((v): v is string => v !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return labelFor(value);
}

/** `{ attachmentId, name, size, contentType }` — files store an id, never a URL. */
function attachmentName(value: Record<string, unknown>): string | null {
  const name = value['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

export interface RenderCellArgs {
  field: CellField | undefined;
  value: unknown;
  statusById: Map<string, StatusOption>;
  /**
   * id → name for every user this page mentions, resolved by the caller in one
   * query. A USER_LOOKUP column stores an id (the only stable handle for a
   * person the Admin can rename), and an Owner column reading `9f3c…` is a
   * column nobody can act on. An id with no entry still renders as itself —
   * a name that cannot be resolved must not become a gap.
   */
  userNames?: ReadonlyMap<string, string>;
}

export function renderFieldCell({ field, value, statusById, userNames }: RenderCellArgs): ReactNode {
  // A column with no field behind it can only have come from stale config;
  // fall through to the plain renderer rather than throwing on a read path.
  if (field && field.systemColumn === STATUS_COLUMN) {
    if (typeof value !== 'string') return EMPTY;
    const status = statusById.get(value);
    // A status the Admin soft-deleted is still referenced by older records —
    // invariant 4 keeps that data readable, so show the id rather than a gap.
    if (!status) return value;
    // `tag` drives the tone, ALWAYS. Renaming "Converted" to "Funded" must not
    // change a single pixel of this chip.
    return <StatusChip name={status.name} tag={status.tag} color={status.color} />;
  }

  if (value === null || value === undefined || value === '') return EMPTY;

  const type = field?.type;

  // A picklist value is a KEY into the field's options — resolve it to the
  // label the Admin last typed. `hasOptions` is asked of the type registry so
  // this covers every picklist type there is and no type that is not one.
  if (type !== undefined && FIELD_TYPE_SPECS[type].hasOptions) {
    const label = optionLabel(field, value);
    if (label !== null) return label;
  }

  if (type === 'DATE' || type === 'DATE_TIME') {
    if (typeof value !== 'string') return EMPTY;
    return shortDate(value, type === 'DATE_TIME') ?? EMPTY;
  }

  if (type === 'CHECKBOX' || type === 'TOGGLE') {
    return <BooleanCell value={value === true} />;
  }

  if (type === 'USER_LOOKUP') {
    if (typeof value !== 'string') return EMPTY;
    const name = userNames?.get(value);
    // The title is set HERE rather than left to the table's own tooltip: that
    // one is derived from the raw value, so it would hover the id over the
    // name. Falls back to the id, which is what the timeline shows too.
    return <span title={name ?? value}>{name ?? value}</span>;
  }

  if (type === 'RECORD_LINK') {
    if (typeof value !== 'string') return EMPTY;
    // A link whose target is a small config/core table (group, campaign) has
    // its names injected as `options` by the page — the same substitution the
    // status column gets. Resolve through them first; the id is the fallback,
    // never a gap.
    // TODO(record engine): a batched cross-module title lookup for links into
    // arbitrary generic modules, which these options do not cover.
    const linked = optionLabel(field, value);
    return <span title={linked ?? value}>{linked ?? value}</span>;
  }

  if (type === 'FILE' || type === 'IMAGE') {
    if (typeof value !== 'object' || Array.isArray(value)) return EMPTY;
    return attachmentName(value as Record<string, unknown>) ?? EMPTY;
  }

  // MULTI_SELECT and LANGUAGE_PICKER arrive as arrays; so can a JSONB value an
  // older field version wrote. One join covers all of them.
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
    return parts.length > 0 ? parts.join(', ') : EMPTY;
  }

  if (typeof value === 'boolean') return <BooleanCell value={value} />;
  if (typeof value === 'string' || typeof value === 'number') return String(value);

  return EMPTY;
}
