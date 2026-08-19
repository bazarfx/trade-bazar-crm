'use client';

import { useState } from 'react';
import { STATUS_TAGS, type StatusCreateInput, type StatusTagValue } from '@crm/shared';
import { ApiClientError } from '@/lib/client-api';
import { TAG_NOTES, TagChip, useColorSwatches } from './status-meta';

/**
 * The one status form, shared by create and edit — the caller decides which
 * route the payload travels to. Server refusals are shown VERBATIM: a
 * guardrail reason (422 GUARDRAIL, e.g. re-tagging the last CONVERTED
 * carrier) is authored next to the rule in @crm/core, so re-wording it here
 * would let the two drift apart.
 */
interface StatusFormProps {
  slug: string;
  /** Null for create. Structural subset of StatusDto so the form never has
   *  to import the server-only lib. */
  initial: { name: string; tag: StatusTagValue; color: string | null } | null;
  /** Only feeds the submit button's data-track (`create.submit` / `edit.submit`). */
  mode: 'create' | 'edit';
  onSave: (input: StatusCreateInput) => Promise<void>;
  onCancel: () => void;
}

export function StatusForm({ slug, initial, mode, onSave, onCancel }: StatusFormProps) {
  // Lowercased once so swatch matching works whatever case the row stores —
  // the schema accepts both and both mean the same colour.
  const initialColor = initial?.color?.toLowerCase() ?? null;

  const [name, setName] = useState(initial?.name ?? '');
  const [tag, setTag] = useState<StatusTagValue>(initial?.tag ?? 'NEUTRAL');
  const [color, setColor] = useState<string | null>(initialColor);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameErrors, setNameErrors] = useState<string[]>([]);

  // Resolved from tokens.css in the browser, so the swatch and the hex this
  // form persists are provably the same colour.
  const swatches = useColorSwatches();

  // A pre-existing colour outside the fixed row (seeded, older config, or a
  // palette that has since moved on) stays offered, so opening the form never
  // silently discards it. Only decidable once the row itself has resolved.
  const customColor =
    swatches !== null && initialColor !== null && !swatches.some((s) => s.hex === initialColor)
      ? initialColor
      : null;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNameErrors([]);
    try {
      await onSave({ name: name.trim(), tag, color });
      // On success the caller closes the overlay; this form unmounts.
    } catch (err) {
      if (err instanceof ApiClientError) {
        setNameErrors(err.fields?.name ?? []);
        setError(err.message);
      } else {
        setError('Something went wrong. Try again.');
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-2xl px-8 py-8">
      {error !== null && (
        <div
          role="alert"
          className="mb-6 rounded border border-error bg-surface px-4 py-3 text-sm text-error"
        >
          {error}
        </div>
      )}

      <label htmlFor="status-name" className="block text-sm font-medium text-heading">
        Name
      </label>
      <input
        id="status-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={60}
        placeholder="e.g. Follow-up scheduled"
        data-track={`${slug}.statuses.form.name.input`}
        className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-heading outline-none focus:border-primary"
      />
      {nameErrors.map((msg) => (
        <p key={msg} className="mt-1 text-xs text-error">
          {msg}
        </p>
      ))}
      <p className="mt-1 text-xs text-body">Display only — renaming never changes behaviour.</p>

      <fieldset className="mt-8">
        <legend className="text-sm font-medium text-heading">Tag</legend>
        <p className="mt-1 text-xs text-body">
          The tag is what the system reads. Six tags are reporting buckets; CONVERTED and
          SIGNED_UP carry webhook behaviour.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {STATUS_TAGS.map((t) => (
            <label
              key={t}
              className={`flex cursor-pointer items-center gap-3 rounded border px-3 py-2 ${
                t === tag ? 'border-primary bg-background' : 'border-border bg-surface'
              }`}
            >
              <input
                type="radio"
                name="tag"
                value={t}
                checked={t === tag}
                onChange={() => setTag(t)}
                data-track={`${slug}.statuses.form.tag.select`}
                className="accent-primary"
              />
              <TagChip tag={t} />
              <span className="text-xs text-body">{TAG_NOTES[t]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-8">
        <legend className="text-sm font-medium text-heading">Colour</legend>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setColor(null)}
            aria-label="No colour"
            aria-pressed={color === null}
            title="No colour"
            data-track={`${slug}.statuses.form.color.select`}
            className={`flex h-8 w-8 items-center justify-center rounded border bg-surface text-xs text-body ${
              color === null ? 'border-primary ring-1 ring-primary' : 'border-border'
            }`}
          >
            —
          </button>
          {swatches?.map((s) => (
            <button
              key={s.token}
              type="button"
              onClick={() => setColor(s.hex)}
              aria-label={s.label}
              aria-pressed={color === s.hex}
              title={s.label}
              data-track={`${slug}.statuses.form.color.select`}
              className={`h-8 w-8 rounded border ${
                color === s.hex ? 'border-heading ring-2 ring-primary' : 'border-border'
              }`}
              style={{ backgroundColor: s.hex }}
            />
          ))}
          {customColor !== null && (
            <button
              type="button"
              onClick={() => setColor(customColor)}
              aria-label="Current colour"
              aria-pressed={color === customColor}
              title="Current colour"
              data-track={`${slug}.statuses.form.color.select`}
              className={`h-8 w-8 rounded border ${
                color === customColor ? 'border-heading ring-2 ring-primary' : 'border-border'
              }`}
              style={{ backgroundColor: customColor }}
            />
          )}
        </div>
      </fieldset>

      <div className="mt-10 flex items-center gap-3 border-t border-border pt-6">
        <button
          type="submit"
          disabled={saving}
          data-track={`${slug}.statuses.${mode}.submit`}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : initial ? 'Save changes' : 'Create status'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-track={`${slug}.statuses.form.cancel`}
          className="rounded border border-border px-4 py-2 text-sm text-heading hover:bg-background"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
