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

/** 12px controls at the rail's density; the form's 14px would not fit 230px. */
const CONTROL = 'h-8 text-xs';

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
          <div className="flex items-center gap-1">
            <ValueInput
              slug={slug}
              type={field.type}
              value={draft.value}
              label={`${field.label} from`}
              invalid={error !== null}
              describedBy={errorId}
              onChange={(value) => onChange({ ...draft, value })}
            />
            <span className="shrink-0 text-xs text-body">and</span>
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
            className={CONTROL}
            data-track={`${slug}.filter.field.value`}
          />
        );

      case 'multi':
        // A list operator with real options gets checkboxes; one without gets
        // a comma-separated box rather than a dead control. Which operators
        // exist is the registry's call, so the UI adapts instead of hiding one.
        return options.length > 0 ? (
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded border border-border p-1">
            {options.map((option) => (
              <li key={option.value}>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-heading">
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
            className={CONTROL}
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
            className={CONTROL}
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
    <div className="mt-1 flex flex-col gap-1">
      <Select
        value={draft.operator}
        aria-label={`${field.label} condition`}
        onChange={(e) => changeOperator(e.target.value as DraftCondition['operator'])}
        className={CONTROL}
        data-track={`${slug}.filter.field.operator`}
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_LABELS[operator]}
          </option>
        ))}
      </Select>

      {renderValue()}

      {/* A picker with nothing to pick says why, rather than looking broken. */}
      {optionsNote !== null && options.length === 0 && control !== 'none' ? (
        <p className="text-xs text-muted">{optionsNote}</p>
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
      className={`${CONTROL} min-w-0`}
      data-track={`${slug}.filter.field.value`}
    />
  );
}
