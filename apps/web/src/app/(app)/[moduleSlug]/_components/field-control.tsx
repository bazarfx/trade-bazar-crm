'use client';

import type { ReactNode } from 'react';
import { Controller, useWatch, type Control, type UseFormRegister } from 'react-hook-form';
import type { FieldType } from '@crm/shared';
import { Checkbox, FieldError, FieldLabel, Input, Select, Textarea, cn } from '@/components/ui';

/**
 * THE field renderer. One switch on `FieldType`, in one file, for every module
 * in the product — a module an Admin invents next year gets every control
 * below for free, because the only question this file asks is "what type is
 * this field". Nothing here reads a field key, a label or a module slug.
 *
 * Everything a control needs that is NOT derivable from the type — the live
 * picklist, the users to choose an owner from, whether a required field can be
 * left to the engine — arrives on `FormField`, resolved by the form. That
 * split is what keeps this switch from growing a second axis.
 */

/**
 * The form's value bag. A record has no fixed shape — its fields are rows in
 * `FieldDefinition` — so the only honest static type is "keys to values", and
 * the generated Zod schema is what gives it meaning at runtime.
 */
export type RecordFormValues = Record<string, unknown>;

export interface PicklistOption {
  value: string;
  label: string;
}

export interface FormField {
  key: string;
  label: string;
  type: FieldType;
  helpText: string | null;
  /**
   * EFFECTIVE requiredness, not the FieldDefinition flag. A field the engine
   * fills itself on create is required in the database and optional on this
   * form, and the star, the blank option and the schema all have to agree —
   * so the form decides once and every consumer reads the same answer.
   */
  isRequired: boolean;
  /** `validation.maxLength`, when the Admin set one — drives the "0/50". */
  maxLength: number | null;
  /**
   * The choices for whichever picker this type needs: a DROPDOWN's own
   * picklist, the module's statuses, or the user list. Resolved by the form
   * because only the form knows which of those a given field maps to.
   */
  options: PicklistOption[];
  /**
   * RECORD_LINK target rows, or null when the target module could not be
   * resolved — the control then renders disabled and says why, rather than
   * offering an empty picker that looks broken.
   */
  linkOptions: PicklistOption[] | null;
  /** An extra line under the label, e.g. why a required field may be left blank. */
  hint: string | null;
}

/** Placeholders, verbatim from the Create Leads frame. */
const ENTER = 'Enter...';
const WRITE_HERE = 'Write here...';
/** The fig prints the accepted date shape in the input; `type=date` ignores a
 *  placeholder, so it becomes a hint line under the control instead. */
const DATE_HINT = 'DD/MM/YYYY';

/**
 * An `Attachment` model exists but no upload route does. A control that
 * pretended otherwise would collect a file and drop it on save, so it says
 * plainly what is missing — and stays out of the schema, so a required file
 * field cannot make the form unsubmittable.
 */
const FILE_NOTICE = 'File upload arrives with the storage slice';

const LINK_NOTICE =
  'This field links to another module. The field API does not carry the target ' +
  'module id, so there is nothing to list yet.';

/** Types whose control carries its own caption, so a FieldLabel above would
 *  print the same words twice. */
const SELF_LABELLING: ReadonlySet<FieldType> = new Set<FieldType>(['CHECKBOX', 'TOGGLE']);

/** Types rendered as a group of controls rather than one focusable input —
 *  a `<label for>` may only point at a form control, never at the group. */
const GROUPED: ReadonlySet<FieldType> = new Set<FieldType>(['MULTI_SELECT', 'LANGUAGE_PICKER']);

interface CharCounterProps {
  control: Control<RecordFormValues>;
  name: string;
  max: number;
}

/**
 * The design's `0/50`. Its own component so `useWatch` subscribes ONLY for the
 * fields that have a max length — a watch at form level would re-render every
 * control in a 33-field form on every keystroke.
 */
function CharCounter({ control, name, max }: CharCounterProps) {
  const value = useWatch({ control, name });
  const used = typeof value === 'string' ? value.length : 0;
  return (
    // aria-hidden: the input carries `maxLength`, which assistive tech already
    // announces. Reading a counter aloud on every keystroke is noise.
    <span
      aria-hidden="true"
      className={cn('shrink-0 text-xs tabular-nums', used >= max ? 'text-warning' : 'text-muted')}
    >
      {used}/{max}
    </span>
  );
}

export interface FieldControlProps {
  /** module slug — the `data-track` namespace, never a branch. */
  slug: string;
  field: FormField;
  register: UseFormRegister<RecordFormValues>;
  control: Control<RecordFormValues>;
  error: string | undefined;
}

export function FieldControl({ slug, field, register, control, error }: FieldControlProps) {
  const id = `record-field-${field.key}`;
  // One name for every field input on the form: the interaction logger is a
  // single delegated listener and the element it fires on identifies the rest.
  const track = `${slug}.form.field.input`;
  const invalid = error !== undefined;

  /** The blank row a picker needs so a value can be left unset. */
  const blankOption = (
    <option value="">{field.isRequired ? 'Select…' : '—'}</option>
  );

  function renderControl(): ReactNode {
    switch (field.type) {
      case 'SINGLE_LINE':
      case 'EMAIL':
      case 'URL':
        return (
          <Input
            id={id}
            type={field.type === 'EMAIL' ? 'email' : field.type === 'URL' ? 'url' : 'text'}
            placeholder={ENTER}
            // Hard-capping the input is what makes the counter mean something;
            // without it "51/50" is the first the user hears of the limit.
            maxLength={field.maxLength ?? undefined}
            data-track={track}
            aria-invalid={invalid}
            {...register(field.key)}
          />
        );

      case 'MULTI_LINE':
        return (
          <Textarea
            id={id}
            rows={4}
            placeholder={WRITE_HERE}
            maxLength={field.maxLength ?? undefined}
            data-track={track}
            aria-invalid={invalid}
            {...register(field.key)}
          />
        );

      case 'PHONE':
        return (
          // type=tel, not text: it brings the phone keypad on touch and tells
          // autofill what this is. The value is normalised to E.164 server-side
          // (spec §6.6), so local formats are accepted as typed.
          <Input
            id={id}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder={ENTER}
            data-track={track}
            aria-invalid={invalid}
            {...register(field.key)}
          />
        );

      case 'NUMBER':
      case 'DECIMAL':
      case 'CURRENCY':
      case 'PERCENT':
        return (
          <Input
            id={id}
            type="number"
            // NUMBER is whole by contract (the generated schema calls .int());
            // the other three accept fractions.
            step={field.type === 'NUMBER' ? 1 : 'any'}
            placeholder={ENTER}
            data-track={track}
            aria-invalid={invalid}
            {...register(field.key)}
          />
        );

      case 'DROPDOWN':
      case 'USER_LOOKUP':
        return (
          <Select id={id} data-track={track} aria-invalid={invalid} {...register(field.key)}>
            {blankOption}
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        );

      case 'RECORD_LINK':
        // No resolvable target module: disabled, with the reason on the
        // control itself. A disabled control with no explanation reads as a
        // broken one.
        if (field.linkOptions === null) {
          return (
            <Select id={id} disabled title={LINK_NOTICE} data-track={track} defaultValue="">
              <option value="">{LINK_NOTICE}</option>
            </Select>
          );
        }
        return (
          <Select id={id} data-track={track} aria-invalid={invalid} {...register(field.key)}>
            {blankOption}
            {field.linkOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        );

      case 'MULTI_SELECT':
      case 'LANGUAGE_PICKER':
        return (
          // A checkbox GROUP, not a custom listbox: every option is visible and
          // reachable with the keyboard, and there is no popup to trap focus
          // inside a full-screen overlay that already traps its own.
          <Controller
            control={control}
            name={field.key}
            render={({ field: bound }) => {
              const selected = Array.isArray(bound.value)
                ? bound.value.filter((v): v is string => typeof v === 'string')
                : [];
              return (
                <div
                  id={id}
                  role="group"
                  aria-label={field.label}
                  aria-invalid={invalid}
                  className="flex max-h-56 flex-col gap-2 overflow-y-auto rounded border border-border bg-background p-3"
                >
                  {field.options.length === 0 ? (
                    <p className="text-xs text-body">This field has no options yet.</p>
                  ) : (
                    field.options.map((o) => (
                      <Checkbox
                        key={o.value}
                        checked={selected.includes(o.value)}
                        onBlur={bound.onBlur}
                        onChange={(e) =>
                          bound.onChange(
                            e.target.checked
                              ? [...selected, o.value]
                              : selected.filter((v) => v !== o.value),
                          )
                        }
                        data-track={track}
                        label={
                          <span className="block truncate" title={o.label}>
                            {o.label}
                          </span>
                        }
                      />
                    ))
                  )}
                </div>
              );
            }}
          />
        );

      case 'DATE':
      case 'DATE_TIME':
        return (
          <Input
            id={id}
            type={field.type === 'DATE' ? 'date' : 'datetime-local'}
            data-track={track}
            aria-invalid={invalid}
            {...register(field.key)}
          />
        );

      case 'CHECKBOX':
      case 'TOGGLE':
        return (
          <Checkbox
            id={id}
            data-track={track}
            aria-invalid={invalid}
            label={
              <span className="block truncate" title={field.label}>
                {field.label}
              </span>
            }
            {...register(field.key)}
          />
        );

      case 'FILE':
      case 'IMAGE':
        return (
          // Deliberately NOT registered: a control that cannot produce a value
          // must not be part of the payload or of the generated schema.
          <Input
            id={id}
            disabled
            readOnly
            value=""
            title={FILE_NOTICE}
            placeholder={FILE_NOTICE}
            data-track={track}
          />
        );

      case 'FORMULA':
      case 'AUTONUMBER':
      default:
        // Derived types are filtered out before they reach this file
        // (FIELD_TYPE_SPECS[type].isDerived). This arm exists so a field type
        // added to the registry tomorrow renders something inert rather than
        // crashing a form that 40,000 records go through.
        return (
          <Input
            id={id}
            disabled
            readOnly
            value=""
            title="This field is computed and cannot be edited here."
            data-track={track}
          />
        );
    }
  }

  const help = field.helpText ? (
    <p className="mb-1.5 text-xs text-body">{field.helpText}</p>
  ) : null;

  const hint = field.hint ? <p className="mt-1 text-xs text-muted">{field.hint}</p> : null;

  // A checkbox carries its own caption, so a FieldLabel above it would print
  // the field's name twice.
  if (SELF_LABELLING.has(field.type)) {
    return (
      <div className="min-w-0">
        {help}
        {renderControl()}
        {hint}
        <FieldError>{error}</FieldError>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <FieldLabel
          // A group is not a form control, so `for` would point at nothing the
          // browser can focus.
          htmlFor={GROUPED.has(field.type) ? undefined : id}
          required={field.isRequired}
          className="min-w-0"
        >
          {/* Truncate with a tooltip, never wrap: an Admin-authored label has
              no length limit and a two-line label shifts the whole grid row. */}
          <span className="inline-block max-w-full truncate align-bottom" title={field.label}>
            {field.label}
          </span>
        </FieldLabel>
        {field.maxLength !== null ? (
          <CharCounter control={control} name={field.key} max={field.maxLength} />
        ) : null}
      </div>
      {help}
      {renderControl()}
      {field.type === 'DATE' || field.type === 'DATE_TIME' ? (
        <p className="mt-1 text-xs text-muted">{DATE_HINT}</p>
      ) : null}
      {hint}
      <FieldError>{error}</FieldError>
    </div>
  );
}
