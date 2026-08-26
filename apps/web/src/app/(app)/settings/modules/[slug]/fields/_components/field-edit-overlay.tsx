'use client';

import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  FIELD_TYPE_SPECS,
  fieldUpdateSchema,
  type DependencyReport,
  type FieldUpdateInput,
} from '@crm/shared';
import type { FieldDto } from '@/lib/config/fields';
import { api, ApiClientError } from '@/lib/client-api';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, Checkbox, FieldError, FieldLabel, Input, Textarea } from '@/components/ui';
import {
  FormErrorBanner,
  OptionsEditor,
  SectionSelect,
  ValidationEditor,
  applyServerFieldErrors,
  messageOf,
  numberOrUndefined,
  pruneValidation,
  stringOrUndefined,
  type SectionDto,
  type ValidationRules,
} from './field-form-shared';

interface FieldEditOverlayProps {
  slug: string;
  moduleLabel: string;
  field: FieldDto;
  sections: SectionDto[];
  onClose: () => void;
  onSaved: (field: FieldDto, warning?: string) => void;
  onDeleted: (field: FieldDto) => void;
}

export function FieldEditOverlay({
  slug,
  moduleLabel,
  field,
  sections,
  onClose,
  onSaved,
  onDeleted,
}: FieldEditOverlayProps) {
  const [formError, setFormError] = useState<string | null>(null);
  const [dependencies, setDependencies] = useState<DependencyReport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const spec = FIELD_TYPE_SPECS[field.type];
  // Spec §4.3: system fields keep label, help text, section and order
  // editable; required flag, validation and options are locked because
  // assignment, matching and logging depend on them.
  const locked = field.isSystem;

  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FieldUpdateInput>({
    // raw: validation still runs, but submit receives the actual form values —
    // zod would otherwise strip the option `id`s the reconciler diffs on.
    resolver: zodResolver(fieldUpdateSchema, undefined, { raw: true }),
    defaultValues: {
      label: field.label,
      helpText: field.helpText ?? '',
      // A sectionId pointing at a since-deleted section would 422 on save;
      // default to the first live section, where the builder renders it anyway.
      sectionId: sections.some((s) => s.id === field.sectionId)
        ? field.sectionId
        : sections[0]?.id ?? null,
      isRequired: field.isRequired,
      // Scope stored rules to the known keys for this storage kind — a stray
      // key in the Json column must not trip the strict schema on submit.
      validation: pruneValidation(spec.storage, (field.validation ?? {}) as ValidationRules) ?? {},
      // Retired options stay out of the editor — omitting them from a PATCH
      // is what keeps them retired.
      options: field.options
        .filter((o) => !o.isDeleted)
        .map((o) => ({ id: o.id, label: o.label, value: o.value, color: o.color ?? undefined })),
    },
  });

  const { fields: optionRows, append, remove, move } = useFieldArray({ control, name: 'options' });

  async function onSubmit(values: FieldUpdateInput) {
    setFormError(null);
    const payload: FieldUpdateInput = {
      label: values.label,
      helpText: values.helpText ? values.helpText : null,
      sectionId: values.sectionId ?? null,
    };
    if (!locked) {
      payload.isRequired = values.isRequired ?? false;
      // null (not undefined) so clearing every rule actually clears the column.
      payload.validation = pruneValidation(spec.storage, values.validation) ?? null;
      if (spec.hasOptions) {
        // `value` is never sent back: stored values are immutable and the
        // server derives values for new options from their labels.
        payload.options = (values.options ?? []).map((o) => ({
          id: o.id,
          label: o.label,
          color: o.color,
        }));
      }
    }

    try {
      const { field: updated } = await api<{ field: FieldDto }>(
        `/api/modules/${slug}/fields/${field.id}`,
        { method: 'PATCH', body: JSON.stringify(payload) },
      );
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiClientError && applyServerFieldErrors(err, setError)) return;
      setFormError(messageOf(err));
    }
  }

  /**
   * Two-step delete: the first call runs un-confirmed and a 409 DEPENDENCIES
   * answer renders the guardrail report in place, so the Admin confirms with
   * eyes open (spec §13). The delete is soft either way.
   */
  async function requestDelete(confirmed: boolean) {
    setDeleteBusy(true);
    setFormError(null);
    try {
      await api<{ ok: boolean }>(
        `/api/modules/${slug}/fields/${field.id}${confirmed ? '?confirmed=1' : ''}`,
        { method: 'DELETE' },
      );
      onDeleted(field);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'DEPENDENCIES' && err.dependencies) {
        setDependencies(err.dependencies);
      } else {
        setFormError(messageOf(err));
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  const optionsListError = (errors.options as { message?: string } | undefined)?.message;

  return (
    <FullScreenOverlay title={`Edit field — ${moduleLabel}`} onClose={onClose} trackPrefix={`${slug}.fields`}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="mx-auto max-w-3xl px-8 py-8">
        {/* Type and key are fixed at creation — recreate instead of retype. */}
        <p className="text-xs text-body">
          {spec.label} · <span className="font-mono">{field.key}</span>
        </p>

        <FieldLabel htmlFor="field-label" className="mt-4" required>
          Label
        </FieldLabel>
        <Input
          id="field-label"
          autoFocus
          data-track={`${slug}.fields.label.input`}
          aria-invalid={!!errors.label}
          {...register('label')}
        />
        <FieldError>{errors.label?.message}</FieldError>

        <SectionSelect
          slug={slug}
          sections={sections}
          reg={register('sectionId')}
          error={errors.sectionId?.message}
        />

        <FieldLabel htmlFor="field-help" className="mt-6">
          Help text
        </FieldLabel>
        <Textarea
          id="field-help"
          rows={2}
          data-track={`${slug}.fields.helpText.input`}
          aria-invalid={!!errors.helpText}
          {...register('helpText')}
        />
        <FieldError>{errors.helpText?.message}</FieldError>

        <div className="mt-6">
          <Checkbox
            id="field-required"
            label="Required"
            disabled={locked}
            data-track={`${slug}.fields.isRequired.input`}
            {...register('isRequired')}
          />
        </div>

        {locked && (
          <p className="mt-4 rounded border border-border bg-background px-3 py-2 text-xs text-body">
            System field — assignment, matching and logging depend on it. The required flag,
            validation rules and options are locked; label, help text and section stay editable.
          </p>
        )}

        {spec.hasOptions && (
          <OptionsEditor
            slug={slug}
            rows={optionRows.map((r) => ({ key: r.id, value: r.value }))}
            regLabel={(i) => register(`options.${i}.label`)}
            regColor={(i) => register(`options.${i}.color`, { setValueAs: stringOrUndefined })}
            labelErrorAt={(i) => errors.options?.[i]?.label?.message}
            colorErrorAt={(i) => errors.options?.[i]?.color?.message}
            listError={optionsListError}
            onAdd={() => append({ label: '' })}
            onRemove={remove}
            onMove={move}
            disabled={locked}
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
          disabled={locked}
        />

        {dependencies && (
          <div className="mt-6 rounded border border-error bg-[var(--globalcolors-red-10)] p-4">
            <h3 className="text-sm font-medium text-heading">
              Deleting “{field.label}” affects:
            </h3>
            {dependencies.views.length > 0 && (
              <>
                <p className="mt-2 text-xs font-medium text-heading">Saved views</p>
                <ul className="mt-1 list-inside list-disc text-xs text-body">
                  {dependencies.views.map((v) => (
                    <li key={v.id}>{v.name}</li>
                  ))}
                </ul>
              </>
            )}
            {dependencies.layouts.length > 0 && (
              <>
                <p className="mt-2 text-xs font-medium text-heading">Layouts</p>
                <ul className="mt-1 list-inside list-disc text-xs text-body">
                  {dependencies.layouts.map((l) => (
                    <li key={l.id}>{l.target}</li>
                  ))}
                </ul>
              </>
            )}
            {dependencies.imports.length > 0 && (
              <>
                <p className="mt-2 text-xs font-medium text-heading">Import presets</p>
                <ul className="mt-1 list-inside list-disc text-xs text-body">
                  {dependencies.imports.map((i) => (
                    <li key={i.id}>{i.filename}</li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-3 text-xs text-body">
              The field disappears from forms; historical values stay on records and in the
              timeline.
            </p>
            {/* The one solid-error button in the product: confirming a
                destructive act after the guardrail report has been read. */}
            <Button
              size="sm"
              loading={deleteBusy}
              onClick={() => requestDelete(true)}
              data-track={`${slug}.fields.delete.confirm`}
              className="mt-3 border border-error bg-error text-surface hover:bg-error/90"
            >
              {deleteBusy ? 'Deleting…' : 'Delete anyway'}
            </Button>
          </div>
        )}

        <FormErrorBanner message={formError} />

        <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
          <Button
            type="submit"
            disabled={deleteBusy}
            loading={isSubmitting}
            data-track={`${slug}.fields.submit.click`}
          >
            {isSubmitting ? 'Saving…' : 'Save field'}
          </Button>
          <Button
            variant="secondary"
            onClick={onClose}
            data-track={`${slug}.fields.cancel.click`}
          >
            Cancel
          </Button>
          <span className="flex-1" aria-hidden="true" />
          {!locked && !dependencies && (
            <Button
              variant="destructive"
              disabled={isSubmitting}
              loading={deleteBusy}
              onClick={() => requestDelete(false)}
              data-track={`${slug}.fields.delete.click`}
            >
              {deleteBusy ? 'Deleting…' : 'Delete field'}
            </Button>
          )}
        </div>
      </form>
    </FullScreenOverlay>
  );
}
