'use client';

import { useState } from 'react';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { api, ApiClientError } from '@/lib/client-api';
import type { EditorSection } from './draft';

const COLUMN_CHOICES = [1, 2, 3, 4] as const;

interface SectionFormProps {
  slug: string;
  /** null = create a new section; otherwise edit this one. */
  section: EditorSection | null;
  onSaved: (section: EditorSection) => void;
  onClose: () => void;
}

/**
 * Create/rename form for a section. Unlike field placement, a section is a
 * real config row, so submitting hits the server immediately — the parent only
 * folds the returned row back into its draft. Validation lives in
 * sectionCreateSchema/sectionUpdateSchema on the server (packages/shared);
 * here we only keep the submit button honest.
 */
export function SectionForm({ slug, section, onSaved, onClose }: SectionFormProps) {
  const [label, setLabel] = useState(section?.label ?? '');
  const [columns, setColumns] = useState(section?.columns ?? 4);
  const [isCollapsible, setIsCollapsible] = useState(section?.isCollapsible ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({ label: label.trim(), columns, isCollapsible });
      const res = section
        ? await api<{ section: EditorSection }>(`/api/modules/${slug}/sections/${section.id}`, {
            method: 'PATCH',
            body,
          })
        : await api<{ section: EditorSection }>(`/api/modules/${slug}/sections`, {
            method: 'POST',
            body,
          });
      onSaved(res.section);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Something went wrong — try again.');
      setSaving(false);
    }
  }

  return (
    <FullScreenOverlay
      title={section ? 'Edit section' : 'Add section'}
      onClose={onClose}
      trackPrefix={`${slug}.section-form`}
    >
      <form onSubmit={submit} noValidate className="mx-auto max-w-xl px-8 py-10">
        <label htmlFor="section-label" className="mb-1.5 block text-sm font-medium text-heading">
          Section name
        </label>
        <input
          id="section-label"
          type="text"
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={100}
          data-track={`${slug}.section-form.label.input`}
          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-heading outline-none focus:border-primary"
        />

        <p className="mb-1.5 mt-6 text-sm font-medium text-heading">Columns</p>
        <div role="group" aria-label="Columns" className="inline-flex overflow-hidden rounded border border-border">
          {COLUMN_CHOICES.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={columns === n}
              onClick={() => setColumns(n)}
              data-track={`${slug}.section-form.columns.select`}
              className={`px-4 py-1.5 text-sm ${
                columns === n ? 'bg-primary text-surface' : 'bg-surface text-heading hover:bg-background'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-body">How many fields sit side by side inside this section.</p>

        <label className="mt-6 flex items-center gap-2 text-sm text-heading">
          <input
            type="checkbox"
            checked={isCollapsible}
            onChange={(e) => setIsCollapsible(e.target.checked)}
            data-track={`${slug}.section-form.collapsible.toggle`}
            className="rounded border-border"
          />
          Collapsible on the form
        </label>

        {error && (
          <p role="alert" className="mt-6 rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
            {error}
          </p>
        )}

        <div className="mt-8 flex gap-3">
          <button
            type="submit"
            disabled={!label.trim() || saving}
            data-track={`${slug}.section-form.save.click`}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-surface disabled:opacity-60"
          >
            {saving ? 'Saving…' : section ? 'Save section' : 'Add section'}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-track={`${slug}.section-form.cancel.click`}
            className="rounded border border-border px-4 py-2 text-sm text-heading hover:bg-background"
          >
            Cancel
          </button>
        </div>
      </form>
    </FullScreenOverlay>
  );
}
