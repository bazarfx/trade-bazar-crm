'use client';

import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  FIELD_TYPES,
  FIELD_TYPE_SPECS,
  fieldCreateSchema,
  type FieldCreateInput,
  type FieldType,
} from '@crm/shared';
import type { FieldDto } from '@/lib/config/fields';
import { api, ApiClientError } from '@/lib/client-api';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import {
  FormErrorBanner,
  OptionsEditor,
  SectionSelect,
  ValidationEditor,
  applyServerFieldErrors,
  fieldErrorClass,
  inputClass,
  labelClass,
  messageOf,
  numberOrUndefined,
  pruneValidation,
  stringOrUndefined,
  type SectionDto,
} from './field-form-shared';

/** Derived types are computed server-side; the palette never offers them. */
const CREATABLE_TYPES = FIELD_TYPES.filter((t) => !FIELD_TYPE_SPECS[t].isDerived);

interface FieldCreateOverlayProps {
  slug: string;
  moduleLabel: string;
  /** The palette choice — pre-selects the type, still changeable pre-save. */
  initialType: FieldType;
  sections: SectionDto[];
  onClose: () => void;
  onSaved: (field: FieldDto, warning?: string) => void;
}

export function FieldCreateOverlay({
  slug,
  moduleLabel,
  initialType,
  sections,
  onClose,
  onSaved,
}: FieldCreateOverlayProps) {
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    getValues,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FieldCreateInput>({
    resolver: zodResolver(fieldCreateSchema),
    defaultValues: {
      label: '',
      type: initialType,
      sectionId: sections[0]?.id ?? null,
      helpText: '',
      isRequired: false,
      isUnique: false,
      options: FIELD_TYPE_SPECS[initialType].hasOptions ? [{ label: '' }] : [],
      validation: {},
    },
  });

  const type = watch('type');
  const spec = FIELD_TYPE_SPECS[type];

  const { fields: optionRows, append, remove, move } = useFieldArray({ control, name: 'options' });

  // Changing type pre-save re-shapes the form: a type that cannot be unique
  // must not submit isUnique (the schema rejects it), and an options type
  // needs at least one row for the editor to be usable.
  useEffect(() => {
    const s = FIELD_TYPE_SPECS[type];
    if (!s.canBeUnique) setValue('isUnique', false);
    if (s.hasOptions) {
      if ((getValues('options')?.length ?? 0) === 0) setValue('options', [{ label: '' }]);
    } else {
      setValue('options', []);
    }
  }, [type, getValues, setValue]);

  async function onSubmit(values: FieldCreateInput) {
    setFormError(null);
    const s = FIELD_TYPE_SPECS[values.type];
    const payload: FieldCreateInput = {
      label: values.label,
      type: values.type,
      sectionId: values.sectionId ?? null,
      helpText: values.helpText ? values.helpText : null,
      isRequired: values.isRequired,
      isUnique: s.canBeUnique ? values.isUnique : false,
      options: s.hasOptions ? values.options : undefined,
      // Rules for a storage kind the type does not have are stale leftovers
      // from a pre-save type switch — never send them.
      validation: pruneValidation(s.storage, values.validation),
    };

    try {
      const { field, warning } = await api<{ field: FieldDto; warning?: string }>(
        `/api/modules/${slug}/fields`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      onSaved(field, warning);
    } catch (err) {
      if (err instanceof ApiClientError && applyServerFieldErrors(err, setError)) return;
      setFormError(messageOf(err));
    }
  }

  // Array-level message ("Add at least one option") and per-row messages both
  // live under errors.options; the cast reads the root message defensively.
  const optionsListError = (errors.options as { message?: string } | undefined)?.message;

  return (
    <FullScreenOverlay title={`New field — ${moduleLabel}`} onClose={onClose} trackPrefix={`${slug}.fields`}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mx-auto max-w-3xl px-8 py-8">
        <label htmlFor="field-label" className={labelClass}>
          Label
        </label>
        <input
          id="field-label"
          autoFocus
          data-track={`${slug}.fields.label.input`}
          aria-invalid={!!errors.label}
          className={inputClass}
          {...register('label')}
        />
        {errors.label && (
          <p role="alert" className={fieldErrorClass}>
            {errors.label.message}
          </p>
        )}

        <label htmlFor="field-type" className={`${labelClass} mt-6`}>
          Type
        </label>
        <select
          id="field-type"
          data-track={`${slug}.fields.type.input`}
          aria-invalid={!!errors.type}
          className={inputClass}
          {...register('type')}
        >
          {CREATABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_SPECS[t].label}
            </option>
          ))}
        </select>
        {errors.type && (
          <p role="alert" className={fieldErrorClass}>
            {errors.type.message}
          </p>
        )}

        <SectionSelect
          slug={slug}
          sections={sections}
          reg={register('sectionId')}
          error={errors.sectionId?.message}
        />

        <label htmlFor="field-help" className={`${labelClass} mt-6`}>
          Help text
        </label>
        <textarea
          id="field-help"
          rows={2}
          data-track={`${slug}.fields.helpText.input`}
          aria-invalid={!!errors.helpText}
          className={inputClass}
          {...register('helpText')}
        />
        {errors.helpText && (
          <p role="alert" className={fieldErrorClass}>
            {errors.helpText.message}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-8">
          <label htmlFor="field-required" className="flex items-center gap-2 text-sm text-heading">
            <input
              id="field-required"
              type="checkbox"
              data-track={`${slug}.fields.isRequired.input`}
              {...register('isRequired')}
            />
            Required
          </label>
          <label
            htmlFor="field-unique"
            className={`flex items-center gap-2 text-sm ${spec.canBeUnique ? 'text-heading' : 'text-body'}`}
          >
            <input
              id="field-unique"
              type="checkbox"
              disabled={!spec.canBeUnique}
              data-track={`${slug}.fields.isUnique.input`}
              {...register('isUnique')}
            />
            Unique
            {!spec.canBeUnique && <span className="text-xs">({spec.label} fields cannot be unique)</span>}
          </label>
        </div>
        {errors.isUnique && (
          <p role="alert" className={fieldErrorClass}>
            {errors.isUnique.message}
          </p>
        )}

        {spec.hasOptions && (
          <OptionsEditor
            slug={slug}
            rows={optionRows.map((r) => ({ key: r.id }))}
            regLabel={(i) => register(`options.${i}.label`)}
            regColor={(i) => register(`options.${i}.color`, { setValueAs: stringOrUndefined })}
            labelErrorAt={(i) => errors.options?.[i]?.label?.message}
            colorErrorAt={(i) => errors.options?.[i]?.color?.message}
            listError={optionsListError}
            onAdd={() => append({ label: '' })}
            onRemove={remove}
            onMove={move}
          />
        )}

        <ValidationEditor
          slug={slug}
          storage={spec.storage}
          reg={(name) =>
            register(`validation.${name}`, {
              setValueAs: name === 'regex' ? stringOrUndefined : numberOrUndefined,
            })
          }
          errorFor={(name) => errors.validation?.[name]?.message}
        />

        <FormErrorBanner message={formError} />

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
          <button
            type="submit"
            disabled={isSubmitting}
            data-track={`${slug}.fields.submit.click`}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-surface disabled:opacity-60"
          >
            {isSubmitting ? 'Saving…' : 'Create field'}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-track={`${slug}.fields.cancel.click`}
            className="rounded border border-border px-4 py-2 text-sm text-heading hover:bg-background"
          >
            Cancel
          </button>
        </div>
      </form>
    </FullScreenOverlay>
  );
}
