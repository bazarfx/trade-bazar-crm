'use client';

import { useState } from 'react';
import type { ColumnSpec, FilterNode, SavedViewDto, SortSpec } from '@crm/shared';
import { api, ApiClientError } from '@/lib/client-api';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, Checkbox, FieldError, FieldLabel, Input } from '@/components/ui';

/**
 * "Save Filter" — naming the applied filter so it becomes a `SavedView`.
 *
 * Full screen, like every other create form in this product (CLAUDE.md, UI
 * rules) — there are no small modal windows here, and a save dialog is not the
 * place to start.
 *
 * A view stores the filter, the columns and the sort. It never stores a
 * RESULT: applying one still runs through the repository, which ANDs the tree
 * under the reader's own scope filter. That is why a view an admin publishes
 * is safe to share — it shows each reader their own rows, and can only ever
 * narrow what they could already see.
 */
export interface SaveViewOverlayProps {
  slug: string;
  /** module.labelPlural, for the title — never a hardcoded module name. */
  labelPlural: string;
  filters: FilterNode | null;
  columns: ColumnSpec[];
  sort: SortSpec[] | null;
  /**
   * Whether this actor may publish a view or pin a default. Both change what
   * OTHER people see when they open the module, so the API gates them on the
   * layout config permission; the toggles mirror that rather than offering a
   * switch whose save then 403s.
   */
  canShare: boolean;
  onSaved: (view: SavedViewDto) => void;
  onClose: () => void;
}

export function SaveViewOverlay({
  slug,
  labelPlural,
  filters,
  columns,
  sort,
  canShare,
  onSaved,
  onClose,
}: SaveViewOverlayProps) {
  const [name, setName] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { view } = await api<{ view: SavedViewDto }>(`/api/modules/${slug}/views`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          columns,
          filters,
          sort,
          // Only sent when the actor may set them: an omitted flag is not a
          // privileged write, a `false` one still is not, but sending either
          // from a UI that could not honour the answer is noise.
          ...(canShare ? { isShared, isDefault } : {}),
        }),
      });
      onSaved(view);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? // The API answers with per-field messages; the only field this form
            // has is the name, so they belong under it.
            (err.fields?.['name']?.[0] ?? err.message)
          : 'Could not save this filter.',
      );
      setSaving(false);
    }
  }

  const trimmed = name.trim();

  return (
    <FullScreenOverlay
      title={`Save ${labelPlural} filter`}
      trackPrefix={`${slug}.view`}
      onClose={onClose}
    >
      <div className="mx-auto max-w-2xl px-6 py-10">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed !== '' && !saving) void save();
          }}
        >
          <FieldLabel htmlFor="saved-view-name" required>
            Add Name
          </FieldLabel>
          <Input
            id="saved-view-name"
            value={name}
            maxLength={80}
            required
            autoFocus
            placeholder="Enter..."
            onChange={(e) => setName(e.target.value)}
            data-track={`${slug}.view.save.name`}
          />
          <FieldError>{error}</FieldError>

          <p className="mt-2 text-xs text-body">
            The filter, the visible columns and the sort are saved together, so reopening this
            view rebuilds the whole list.
          </p>

          <div className="mt-6 flex flex-col gap-3">
            <Checkbox
              checked={isShared}
              disabled={!canShare}
              onChange={(e) => setIsShared(e.target.checked)}
              label="Share with everyone"
              data-track={`${slug}.view.save.share`}
            />
            <Checkbox
              checked={isDefault}
              disabled={!canShare}
              onChange={(e) => setIsDefault(e.target.checked)}
              label={`Make this the default view for ${labelPlural}`}
              data-track={`${slug}.view.save.default`}
            />
            {!canShare ? (
              // A disabled control with no explanation reads as a broken one.
              <p className="text-xs text-muted">
                Publishing a view and pinning a default change what everyone else sees when they
                open {labelPlural}, so both need the layout permission. Your filter still saves
                privately.
              </p>
            ) : null}
          </div>

          <div className="mt-8 flex items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={trimmed === ''}
              data-track={`${slug}.view.save.submit`}
            >
              Save Filter
            </Button>
            <Button variant="secondary" onClick={onClose} data-track={`${slug}.view.save.cancel`}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </FullScreenOverlay>
  );
}
