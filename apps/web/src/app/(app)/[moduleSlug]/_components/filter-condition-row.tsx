'use client';

import { FIELD_TYPE_SPECS } from '@crm/shared';
import type { FieldType } from '@crm/shared';
import { FieldError, Input, Select } from '@/components/ui';
import {
  OPERATOR_LABELS,
  valueControlFor,
  type DraftCondition,
} from './filter-model';

/**
 * One condition in the filter rail: an operator and whatever value control
 * that operator needs.
 *
 * BOTH sides are derived, never configured. The operator list is
 * `FIELD_TYPE_SPECS[type].operators` — the registry, and the only place
 * operators are decided — and the value control is chosen by the field's
 * storage kind. There is no per-field list anywhere in this file, no branch on
 * a field key and nothing that knows which module it is drawing.
 */

export interface PickerOption {
  value: string;
  label: string;
}

export interface ConditionRowProps {
  slug: string;
  /** the field this row filters — label included so errors can name it */
  field: { key: string; label: string; type: FieldType };
  draft: DraftCondition;
  onChange: (next: DraftCondition) => void;
  /**
   * The choices for a picker: the field's own picklist, the module's statuses,
   * or the user list. Resolved by the rail, because only the rail knows which
   * of those a given field maps to — the same split the record form uses.
   */
  options: PickerOption[];
  /** why there are no options, when a picker type has none to offer */
  optionsNote: string | null;
  error: string | null;
}

/**
 * The condition controls, measured on `CRM _ Leads_Filter By leads` where the
 * ticked `Account Open Date` row carries `[Age in ▾] [2] [Days ▾]` beneath it:
 * `Frame 482697/482698/482699` — **18 tall**, `pad 4`, `r:4`, `bg #ffffff`,
 * a `#e5e7eb` hairline, and a 10×10 chevron. They sit at x=318 against a row
 * at x=294, i.e. indented 24 to line up with the row's LABEL rather than its
 * checkbox, and are spaced 4 apart.
 *
 * Two departures, both measured rather than guessed:
 *
 *  - The file sets their text at 6px, which is below every step of the type
 *    scale and below the 10px it uses for the rail's own rows. 10px is the
 *    nearest real step — the precedent `sort-menu.tsx` documents.
 *  - Its 67/27/67 widths belong to Zoho's own three-part date-age operator.
 *    Ours are generated from `FIELD_TYPE_SPECS`, so the controls flex and the
 *    measured CHROME is what carries over.
 *
 * `tone="canvas"` supplies the primitive's named `h-9`/`px-3`; every override
 * below is ARBITRARY on purpose. Two competing utilities for one property
 * resolve by STYLESHEET order, not by attribute order, and Tailwind emits the
 * named scale before any bracketed value — which is why the `h-8` that used to
 * be here never applied at all, and why `bg-surface` (emitted after
 * `bg-background`) is the one plain utility that can win.
 *
 * The colour is the same trap and the reason it is written the long way. The
 * file paints these controls' text `#6b7280` — `--body`, the rail's own colour
 * — but `FIELD_BASE` in `components/ui/input.tsx` carries `text-heading`, and
 * `.text-heading` is emitted AFTER `.text-body`, so a plain `text-body` here
 * would silently lose and the operator and value boxes would keep reading
 * darker than the row above them. A bracketed value is emitted after both and
 * wins without touching the shared primitive. The token is still the token:
 * `var(--body)` is what `text-body` itself resolves to.
 */
const CONTROL =
  'h-[18px] min-w-0 bg-surface px-[4px] text-[10px] leading-none text-[color:var(--body)]';

/** The 24px the file indents a ticked row's controls by, to the label's x. */
export const CONDITION_INDENT = 'ml-6';

export function ConditionRow({
  slug,
  field,
  draft,
  onChange,
  options,
  optionsNote,
  error,
}: ConditionRowProps) {
  const operators = FIELD_TYPE_SPECS[field.type].operators;
  const control = valueControlFor(field.type, draft.operator);
  const errorId = error === null ? undefined : `filter-${field.key}-error`;

  /** Switching operator keeps the typed value where it still makes sense and
   *  drops it where it does not — carrying "50" into an `is empty` row would
   *  leave a value the compiler ignores sitting in state. */
  function changeOperator(operator: DraftCondition['operator']) {
    const next = valueControlFor(field.type, operator);
    const keeps = next === control;
    onChange({
      ...draft,
      operator,
      value: keeps ? draft.value : '',
      value2: keeps ? draft.value2 : '',
      values: keeps ? draft.values : [],
    });
  }

  function renderValue() {
    switch (control) {
      case 'none':
        return null;

      case 'range':
        return (
          <div className="flex w-full items-center gap-1">
            <ValueInput
              slug={slug}
              type={field.type}
              value={draft.value}
              label={`${field.label} from`}
              invalid={error !== null}
              describedBy={errorId}
              onChange={(value) => onChange({ ...draft, value })}
            />
            <span className="shrink-0 text-[10px] text-body">and</span>
            <ValueInput
              slug={slug}
              type={field.type}
              value={draft.value2}
              label={`${field.label} to`}
              invalid={error !== null}
              describedBy={errorId}
              onChange={(value2) => onChange({ ...draft, value2 })}
            />
          </div>
        );

      case 'days':
        return (
          <Input
            type="number"
            min={0}
            step={1}
            value={draft.value}
            aria-label={`${field.label} days`}
            aria-invalid={error !== null || undefined}
            aria-describedby={errorId}
            onChange={(e) => onChange({ ...draft, value: e.target.value })}
            className={`${CONTROL} grow basis-[64px]`}
            data-track={`${slug}.filter.field.value`}
          />
        );

      case 'multi':
        // A list operator with real options gets checkboxes; one without gets
        // a comma-separated box rather than a dead control. Which operators
        // exist is the registry's call, so the UI adapts instead of hiding one.
        return options.length > 0 ? (
          <ul className="flex max-h-40 w-full flex-col gap-1 overflow-y-auto rounded border border-border p-1">
            {options.map((option) => (
              <li key={option.value}>
                {/* 16px box, 8px gap, 10px label — the rail's own row anatomy. */}
                <label className="flex cursor-pointer items-center gap-2 text-[10px] text-heading">
                  <input
                    type="checkbox"
                    checked={draft.values.includes(option.value)}
                    onChange={(e) =>
                      onChange({
                        ...draft,
                        values: e.target.checked
                          ? [...draft.values, option.value]
                          : draft.values.filter((v) => v !== option.value),
                      })
                    }
                    className="h-4 w-4 shrink-0 rounded accent-primary"
                    data-track={`${slug}.filter.field.value`}
                  />
                  <span className="truncate" title={option.label}>
                    {option.label}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <Input
            value={draft.value}
            placeholder="Value, value…"
            aria-label={`${field.label} values`}
            aria-invalid={error !== null || undefined}
            aria-describedby={errorId}
            onChange={(e) =>
              onChange({
                ...draft,
                value: e.target.value,
                values: e.target.value
                  .split(',')
                  .map((v) => v.trim())
                  .filter((v) => v !== ''),
              })
            }
            className={`${CONTROL} grow basis-[64px]`}
            data-track={`${slug}.filter.field.value`}
          />
        );

      case 'select':
        return options.length > 0 ? (
          <Select
            value={draft.value}
            aria-label={field.label}
            aria-invalid={error !== null || undefined}
            aria-describedby={errorId}
            onChange={(e) => onChange({ ...draft, value: e.target.value })}
            className={`${CONTROL} grow basis-[64px]`}
            data-track={`${slug}.filter.field.value`}
          >
            <option value="">Select…</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        ) : (
          <ValueInput
            slug={slug}
            type={field.type}
            value={draft.value}
            label={field.label}
            invalid={error !== null}
            describedBy={errorId}
            onChange={(value) => onChange({ ...draft, value })}
          />
        );

      default:
        return (
          <ValueInput
            slug={slug}
            type={field.type}
            value={draft.value}
            label={field.label}
            invalid={error !== null}
            describedBy={errorId}
            onChange={(value) => onChange({ ...draft, value })}
          />
        );
    }
  }

  return (
    // Measured: 8px under the row's label and indented to the LABEL's x, not
    // the checkbox's — the file's `[Age in ▾] [2] [Days ▾]` starts at 318
    // against a row at 294.
    <div className={`mt-2 ${CONDITION_INDENT} flex flex-col gap-1`}>
      {/* One line, 4px apart, exactly as the file lays its three out. It wraps
          because a range, a picker list or a long operator name cannot share
          172px of rail with anything else. */}
      <div className="flex flex-wrap items-center gap-1">
        <Select
          value={draft.operator}
          aria-label={`${field.label} condition`}
          onChange={(e) => changeOperator(e.target.value as DraftCondition['operator'])}
          className={`${CONTROL} grow basis-[80px]`}
          data-track={`${slug}.filter.field.operator`}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </option>
          ))}
        </Select>

        {renderValue()}
      </div>

      {/* A picker with nothing to pick says why, rather than looking broken. */}
      {optionsNote !== null && options.length === 0 && control !== 'none' ? (
        <p className="text-[10px] text-muted">{optionsNote}</p>
      ) : null}

      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

/** The plain value box, typed by the field's storage kind. */
function ValueInput({
  slug,
  type,
  value,
  label,
  invalid,
  describedBy,
  onChange,
}: {
  slug: string;
  type: FieldType;
  value: string;
  label: string;
  invalid: boolean;
  describedBy: string | undefined;
  onChange: (value: string) => void;
}) {
  const storage = FIELD_TYPE_SPECS[type].storage;
  const inputType =
    storage === 'number'
      ? 'number'
      : type === 'DATE_TIME'
        ? 'datetime-local'
        : storage === 'date'
          ? 'date'
          : 'text';

  return (
    <Input
      type={inputType}
      value={value}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value)}
      className={`${CONTROL} grow basis-[64px]`}
      data-track={`${slug}.filter.field.value`}
    />
  );
}
