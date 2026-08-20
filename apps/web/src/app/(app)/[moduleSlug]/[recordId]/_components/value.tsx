'use client';

import type { ReactNode } from 'react';
import {
  optionLabel,
  renderFieldCell,
  type CellField,
  type StatusOption,
} from '@/app/(app)/[moduleSlug]/_components/cell';

/**
 * How a stored value is drawn on the detail screen and in its timeline.
 *
 * The list already answers that question by field TYPE, so this delegates to
 * `renderFieldCell` rather than growing a second formatter that would drift
 * from it. It adds exactly one thing the list cannot do: a USER_LOOKUP stores
 * a user id, and the list has no batched lookup to turn that into a name. The
 * detail page resolves the handful of ids one record and its timeline mention,
 * so the resolution happens HERE — in the screen that has the names — rather
 * than by editing a formatter another screen shares.
 */

/** A field as the detail screen needs it: what the cell needs, plus its label. */
export interface DetailField extends CellField {
  label: string;
}

export interface RenderValueArgs {
  /** undefined for a diff key that is not a field — `matchReason`, say. */
  field: DetailField | undefined;
  value: unknown;
  statusById: Map<string, StatusOption>;
  userNameById: Map<string, string>;
}

export function renderValue({
  field,
  value,
  statusById,
  userNameById,
}: RenderValueArgs): ReactNode {
  if (field?.type === 'USER_LOOKUP' && typeof value === 'string' && value !== '') {
    // A user who was deleted after the row was written has no name left to
    // resolve. Showing the id beats showing nothing: it is still the thread
    // back to who did what, which is the whole point of the log.
    return userNameById.get(value) ?? value;
  }
  return renderFieldCell({ field, value, statusById });
}

/**
 * The `title` tooltip for a truncated value — only for values that ARE text.
 * A chip or a tick renders its own tooltip, and stringifying it here would put
 * "[object Object]" in the attribute.
 */
export function valueTooltip({
  field,
  value,
  statusById,
  userNameById,
}: RenderValueArgs): string | undefined {
  if (field?.type === 'USER_LOOKUP' && typeof value === 'string' && value !== '') {
    return userNameById.get(value) ?? value;
  }
  if (typeof value === 'string' && statusById.has(value)) return statusById.get(value)?.name;
  // The tooltip is what a TRUNCATED value reads as in full, so it has to be the
  // same string the cell drew — a picklist showing "ARK Terminal" must not
  // tooltip as `ARK_TERMINAL`.
  const label = optionLabel(field, value);
  if (label !== null) return label;
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
