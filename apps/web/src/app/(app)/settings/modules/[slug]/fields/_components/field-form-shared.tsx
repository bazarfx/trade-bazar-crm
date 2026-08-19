'use client';

import type { FieldValues, Path, UseFormRegisterReturn, UseFormSetError } from 'react-hook-form';
import type { FieldCreateInput, StorageKind } from '@crm/shared';
import type { ApiClientError } from '@/lib/client-api';

/**
 * Pieces shared by the create and the edit overlay. The two overlays keep
 * separate forms because they validate against separate schemas
 * (fieldCreateSchema vs fieldUpdateSchema) — sharing markup, not types, is
 * what keeps both forms exactly as strict as their server counterpart.
 */

/** What GET /api/modules/[slug]/sections serialises per row. */
export interface SectionDto {
  id: string;
  label: string;
  columns: number;
  displayOrder: number;
  isCollapsible: boolean;
}

/** The shared validation-rules shape, derived from the schema so the form
 *  can never drift from what the server accepts. */
export type ValidationRules = NonNullable<FieldCreateInput['validation']>;
export type ValidationRuleName = keyof ValidationRules;

// One look for every input in both overlays — mirrors the login form.
export const inputClass =
  'w-full rounded border border-border bg-surface px-3 py-2 text-sm text-heading outline-none focus:border-primary disabled:opacity-60';
export const labelClass = 'mb-1.5 block text-sm font-medium text-heading';
export const fieldErrorClass = 'mt-1 text-xs text-error';
export const smallButtonClass =
  'rounded border border-border px-2 py-1 text-xs text-heading hover:bg-background disabled:opacity-40';

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Empty inputs must travel as ABSENT, not as '' or NaN — the shared zod
 *  schemas treat present keys as meaningful. */
export function numberOrUndefined(v: unknown): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

export function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Keep only the rules that apply to the field's storage kind. Switching type
 * mid-create leaves stale keys in form state (e.g. minLength after moving to
 * NUMBER); sending them would mis-describe the field forever.
 */
export function pruneValidation(
  storage: StorageKind,
  v: ValidationRules | null | undefined,
): ValidationRules | undefined {
  if (!v) return undefined;
  const out: ValidationRules = {};
  if (storage === 'number') {
    if (v.min !== undefined) out.min = v.min;
    if (v.max !== undefined) out.max = v.max;
  } else if (storage === 'text') {
    if (v.minLength !== undefined) out.minLength = v.minLength;
    if (v.maxLength !== undefined) out.maxLength = v.maxLength;
    if (v.regex !== undefined && v.regex !== '') out.regex = v.regex;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map the server's { fields: { key: [messages] } } validation shape onto
 * react-hook-form. Returns false when the error carried no field map, so the
 * caller falls back to the form-level banner.
 */
export function applyServerFieldErrors<T extends FieldValues>(
  err: ApiClientError,
  setError: UseFormSetError<T>,
): boolean {
  if (!err.fields || Object.keys(err.fields).length === 0) return false;
  for (const [key, messages] of Object.entries(err.fields)) {
    // Server keys are the schema's top-level keys, which ARE the form's field
    // names — the cast restates that, it does not invent paths.
    setError(key as Path<T>, { type: 'server', message: messages[0] ?? 'Invalid value' });
  }
  return true;
}

/** The login form's non-field error banner, verbatim. */
export function FormErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-4 rounded bg-error/10 px-3 py-2 text-xs text-error">
      {message}
    </p>
  );
}

// ── section select ────────────────────────────────────────────────────────

interface SectionSelectProps {
  slug: string;
  sections: SectionDto[];
  reg: UseFormRegisterReturn;
  error?: string | undefined;
}

export function SectionSelect({ slug, sections, reg, error }: SectionSelectProps) {
  // A module with no live sections stores sectionId null; the builder re-homes
  // such fields at render time, so there is simply nothing to choose here.
  if (sections.length === 0) return null;
  return (
    <div className="mt-6">
      <label htmlFor="field-section" className={labelClass}>
        Section
      </label>
      <select
        id="field-section"
        data-track={`${slug}.fields.section.input`}
        aria-invalid={!!error}
        className={inputClass}
        {...reg}
      >
        {sections.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className={fieldErrorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

// ── validation rules editor ───────────────────────────────────────────────

interface ValidationEditorProps {
  slug: string;
  storage: StorageKind;
  /** Register accessor — keeps each overlay's form generics out of here. */
  reg: (name: ValidationRuleName) => UseFormRegisterReturn;
  errorFor: (name: ValidationRuleName) => string | undefined;
  disabled?: boolean;
}

function RuleInput({
  slug,
  id,
  label,
  type,
  reg,
  error,
  disabled,
}: {
  slug: string;
  id: string;
  label: string;
  type: 'number' | 'text';
  reg: UseFormRegisterReturn;
  error: string | undefined;
  disabled: boolean | undefined;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-body">
        {label}
      </label>
      <input
        id={id}
        type={type}
        step={type === 'number' ? 'any' : undefined}
        disabled={disabled}
        data-track={`${slug}.fields.validation.input`}
        aria-invalid={!!error}
        className={inputClass}
        {...reg}
      />
      {error && (
        <p role="alert" className={fieldErrorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

export function ValidationEditor({ slug, storage, reg, errorFor, disabled }: ValidationEditorProps) {
  // Only numeric and textual storage carries admin-set rules; every other
  // kind validates structurally by type alone.
  if (storage !== 'number' && storage !== 'text') return null;

  return (
    <fieldset className="mt-6">
      <legend className={labelClass}>Validation</legend>
      {storage === 'number' ? (
        <div className="grid grid-cols-2 gap-4">
          <RuleInput slug={slug} id="field-validation-min" label="Minimum" type="number" reg={reg('min')} error={errorFor('min')} disabled={disabled} />
          <RuleInput slug={slug} id="field-validation-max" label="Maximum" type="number" reg={reg('max')} error={errorFor('max')} disabled={disabled} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <RuleInput slug={slug} id="field-validation-min-length" label="Min length" type="number" reg={reg('minLength')} error={errorFor('minLength')} disabled={disabled} />
          <RuleInput slug={slug} id="field-validation-max-length" label="Max length" type="number" reg={reg('maxLength')} error={errorFor('maxLength')} disabled={disabled} />
          <RuleInput slug={slug} id="field-validation-regex" label="Pattern (regex)" type="text" reg={reg('regex')} error={errorFor('regex')} disabled={disabled} />
        </div>
      )}
    </fieldset>
  );
}

// ── picklist options editor ───────────────────────────────────────────────

/** Render metadata per row. `key` is react-hook-form's generated array key;
 *  `value` is the immutable stored value shown under existing options. */
export interface OptionRowDescriptor {
  key: string;
  value?: string | undefined;
}

interface OptionsEditorProps {
  slug: string;
  rows: OptionRowDescriptor[];
  regLabel: (index: number) => UseFormRegisterReturn;
  regColor: (index: number) => UseFormRegisterReturn;
  labelErrorAt: (index: number) => string | undefined;
  colorErrorAt: (index: number) => string | undefined;
  /** Array-level error, e.g. "Add at least one option". */
  listError?: string | undefined;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  disabled?: boolean;
}

export function OptionsEditor({
  slug,
  rows,
  regLabel,
  regColor,
  labelErrorAt,
  colorErrorAt,
  listError,
  onAdd,
  onRemove,
  onMove,
  disabled,
}: OptionsEditorProps) {
  return (
    <fieldset className="mt-6">
      <legend className={labelClass}>Options</legend>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={row.key} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <input
                aria-label="Option label"
                placeholder="Option label"
                disabled={disabled}
                data-track={`${slug}.fields.option.input`}
                aria-invalid={!!labelErrorAt(i)}
                className={inputClass}
                {...regLabel(i)}
              />
              {labelErrorAt(i) && (
                <p role="alert" className={fieldErrorClass}>
                  {labelErrorAt(i)}
                </p>
              )}
              {/* Stored values are immutable — records reference them forever —
                  so an existing option shows its value instead of an input. */}
              {row.value !== undefined && (
                <p className="mt-1 truncate font-mono text-xs text-body" title={row.value}>
                  value: {row.value}
                </p>
              )}
            </div>
            <div className="w-32 shrink-0">
              <input
                aria-label="Option colour"
                placeholder="#RRGGBB"
                disabled={disabled}
                data-track={`${slug}.fields.option.input`}
                aria-invalid={!!colorErrorAt(i)}
                className={inputClass}
                {...regColor(i)}
              />
              {colorErrorAt(i) && (
                <p role="alert" className={fieldErrorClass}>
                  {colorErrorAt(i)}
                </p>
              )}
            </div>
            {!disabled && (
              <div className="flex shrink-0 gap-1 pt-2">
                <button
                  type="button"
                  aria-label="Move option up"
                  disabled={i === 0}
                  onClick={() => onMove(i, i - 1)}
                  data-track={`${slug}.fields.option.reorder`}
                  className={smallButtonClass}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Move option down"
                  disabled={i === rows.length - 1}
                  onClick={() => onMove(i, i + 1)}
                  data-track={`${slug}.fields.option.reorder`}
                  className={smallButtonClass}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label="Remove option"
                  onClick={() => onRemove(i)}
                  data-track={`${slug}.fields.option.remove`}
                  className={smallButtonClass}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {listError && (
        <p role="alert" className={fieldErrorClass}>
          {listError}
        </p>
      )}
      {!disabled && (
        <button
          type="button"
          onClick={onAdd}
          data-track={`${slug}.fields.option.add`}
          className="mt-2 rounded border border-border px-3 py-1.5 text-sm text-heading hover:bg-background"
        >
          + Add option
        </button>
      )}
    </fieldset>
  );
}
