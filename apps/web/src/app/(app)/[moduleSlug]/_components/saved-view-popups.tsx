'use client';

import { useState, type ReactNode } from 'react';
import type { ColumnSpec, FilterNode, SavedViewDto, SortSpec } from '@crm/shared';
import { api, ApiClientError } from '@/lib/client-api';
import { Checkbox, FieldError, Popup, PopupFooter } from '@/components/ui';

/**
 * The three saved-filter pop-ups the Figma file draws, at the size it draws
 * them. They replace the full-screen versions: CLAUDE.md's UI rules were
 * rewritten on 22 Aug 2026 because the file contradicts the old "no small
 * modals anywhere" rule, and overlay size now comes from the file. Full screen
 * still owns the big authoring surfaces (record form, field builder, layout
 * editor, roles matrix, review queue) — a dialog that asks for one name is not
 * one of them.
 *
 * ALL THREE MEASURED off `tools/figma/Zoho.fig`. The pop-up frames are all
 * named "Pop up", so they were located by their title text:
 *
 *   511x252  "Save Filter"               in `…_When user apply the filter then
 *                                            a save filter option pop ups`
 *   511x252  "Edit Name of Save Filter"  in `…_Saved filter Edit`
 *   511x203  "Delete Saved Filter"       in `…_Saved filter delete`
 *
 * Common frame, identical in all three:
 *
 *   FRAME "Pop up"  511x…  flex-col gap:24 pad:24  bg:#ffffff
 *                          border:#e5e7eb 1px  r:8
 *     FRAME  Title        @24,24  463x22  flex-row gap:16
 *            TEXT  Medium 18px #111827 + INSTANCE Icon/X 20x20 @443,0
 *     VECTOR Separator    @24,70  463x0   border:#e5e7eb 1px
 *     FRAME  Content      @24,94  463x…   flex-col gap:20
 *     FRAME  Frame 482701 @24,…   463x40  flex-row gap:18
 *            two FRAME "Buttons" 222x40, pad 8/18, r:4, label Medium 16px
 *
 * Every one of those numbers lives in `components/ui/popup.tsx`, which is why
 * nothing below restates a width, a gap or a button size. The heights differ
 * (252 vs 203) purely because the Content column differs, and the primitive is
 * content-sized for exactly that reason — the file itself draws this same
 * frame at 203, 242, 252, 353 and 378 depending on what is in it.
 *
 * Content, measured per pop-up:
 *
 *   Save / Edit  Content 463x70 → FRAME "Text Area" flex-col gap:8
 *                  FRAME "Label"      463x21  TEXT "Filter Name"
 *                                             Regular 14px #111827
 *                  FRAME "Input Base" 463x41  flex-row gap:12 pad:10/12
 *                                             bg:#ffffff border:#e5e7eb r:4
 *                    TEXT "Enter..."          Regular 14px #6b7280
 *   Delete       Content 463x21 → FRAME "Text Area" → FRAME "Label"
 *                  TEXT "Are you sure you want to delete this filter?"
 *                                             Regular 14px #111827
 *
 * Footer, measured:
 *
 *   Save / Edit  "Cancel" bg:#f6f8fa border:#e5e7eb label #111827
 *                "Save"   bg:#00667a             label #ffffff
 *   Delete       "Cancel" bg:#f6f8fa border:#e5e7eb label #111827
 *                "Delete" bg:#ef4444             label #ffffff
 *
 * → `PopupFooter`'s `cancel` (neutral) and `next` slots, the second with tone
 *   `primary` or `destructive`. The slot ORDER is the file's, not a choice.
 */

/* ------------------------------------------------------------------------- */

/**
 * The file's `Input Base`: 463x41, pad 10/12, gap 12, `bg #ffffff`,
 * `border #e5e7eb`, `r:4`, value/placeholder Regular 14px (`#111827` /
 * `#6b7280`). The inner 463 comes from the panel's own padding, so the width
 * is `w-full` rather than a number.
 *
 * NOT the shared `Input` primitive, and that is a measurement, not a
 * preference: `Input` is traced from the Leads header SEARCH BOX — 36 tall,
 * `bg #f6f8fa`, 12px text — which is a different control in the same file.
 * Passing `className="h-[41px] bg-surface text-sm"` to override it would leave
 * BOTH `bg-background` and `bg-surface` on the element, and Tailwind resolves
 * that by stylesheet order rather than attribute order (`cn` is a plain join —
 * see components/ui/button.tsx). The background that won would be whichever
 * utility the generated CSS happened to emit last, which is not something a
 * screen may depend on. So this states its own fills outright.
 *
 * The focus treatment matches `Input`'s deliberately: a 1px border recolour is
 * not a visible focus indicator for anyone with reduced colour vision.
 */
const POPUP_INPUT =
  'h-[41px] w-full rounded border border-border bg-surface px-3 text-sm text-heading ' +
  'placeholder:text-body ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** The file's `Label` row: Regular 14px `#111827`, 8px above the input. */
const POPUP_LABEL = 'mb-2 block text-sm text-heading';

/**
 * The file's `Text Area` column — label over control, `flex-col gap:8`. The
 * gap BETWEEN stacked rows is the Content frame's own `gap:20`, which the
 * primitive already applies, so this only owns the 8.
 */
function NameField({
  id,
  label,
  value,
  onChange,
  track,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  track: string;
  error: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={POPUP_LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        // 80 is `viewShape.name`'s cap in packages/shared — the ONE definition
        // of what a view name may be. The file draws a `0/50` counter beside
        // this input but leaves it `visible: false` on all three instances, so
        // no counter is drawn and no second number is invented here.
        maxLength={80}
        required
        autoFocus
        placeholder="Enter..."
        onChange={(e) => onChange(e.target.value)}
        data-track={track}
        className={POPUP_INPUT}
      />
      <FieldError>{error}</FieldError>
    </div>
  );
}

/**
 * The two publish toggles, and why they are here when the file draws no such
 * row on these three pop-ups.
 *
 * The file's own Content frame carries a `Checkboxes Component / Checkbox`
 * node (290x24, `flex-row gap:8`, a 20x20 box) — measured `visible: false` in
 * every instance, because Zoho's Save Filter dialog has nothing to put in it.
 * Ours does: `SavedView` stores `isShared` and `isDefault`, and both change
 * what OTHER people see when they open the module. Dropping the row to hold
 * the frame at exactly 252 tall would delete a capability the API already
 * enforces; the Content column is `flex-col gap:20` precisely so it can carry
 * more than one row, and the file itself draws this frame at five different
 * heights. So the WIDTH (511) is held and the height follows the content,
 * which is the rule CLAUDE.md actually states.
 */
function ShareToggles({
  slug,
  labelPlural,
  canShare,
  isShared,
  isDefault,
  onShared,
  onDefault,
}: {
  slug: string;
  labelPlural: string;
  canShare: boolean;
  isShared: boolean;
  isDefault: boolean;
  onShared: (next: boolean) => void;
  onDefault: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Checkbox
        checked={isShared}
        disabled={!canShare}
        onChange={(e) => onShared(e.target.checked)}
        label="Share with everyone"
        data-track={`${slug}.view.save.share`}
      />
      <Checkbox
        checked={isDefault}
        disabled={!canShare}
        onChange={(e) => onDefault(e.target.checked)}
        label={`Make this the default view for ${labelPlural}`}
        data-track={`${slug}.view.save.default`}
      />
      {!canShare ? (
        // A disabled control with no explanation reads as a broken one.
        <p className="text-xs text-muted">
          Publishing a view and pinning a default change what everyone else sees when they open{' '}
          {labelPlural}, so both need the layout permission. Your filter still saves privately.
        </p>
      ) : null}
    </div>
  );
}

/** The API's per-field message for `name`, else its top-level one. */
function nameError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiClientError)) return fallback;
  return err.fields?.['name']?.[0] ?? err.message;
}

/* ── Save Filter ─────────────────────────────────────────────────────────── */

export interface SaveViewPopupProps {
  slug: string;
  /** module.labelPlural — for the default-view wording, never a module name. */
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

/**
 * "Save Filter" — naming the applied filter so it becomes a `SavedView`.
 *
 * A view stores the filter, the columns and the sort. It never stores a
 * RESULT: applying one still runs through the repository, which ANDs the tree
 * under the reader's own scope filter. That is why a view an admin publishes
 * is safe to share — it shows each reader their own rows, and can only ever
 * narrow what they could already see.
 */
export function SaveViewPopup({
  slug,
  labelPlural,
  filters,
  columns,
  sort,
  canShare,
  onSaved,
  onClose,
}: SaveViewPopupProps) {
  const [name, setName] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

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
      setError(nameError(err, 'Could not save this filter.'));
      setSaving(false);
    }
  }

  return (
    <Popup
      open
      width={511}
      // The file's own string. It is a screen label, not config: a saved view
      // is an app concept, not an Admin-created field.
      title="Save Filter"
      trackPrefix={`${slug}.view.save`}
      onClose={onClose}
      footer={
        <PopupFooter
          trackPrefix={`${slug}.view.save`}
          cancel={{ label: 'Cancel', onClick: onClose }}
          // Measured "Save" on `bg #00667a` with a white label — the `next`
          // slot's default tone.
          next={{ label: 'Save', onClick: () => void save(), disabled: trimmed === '' || saving }}
        />
      }
    >
      <NameField
        id="saved-view-name"
        label="Filter Name"
        value={name}
        onChange={setName}
        track={`${slug}.view.save.name`}
        error={error}
      />
      <ShareToggles
        slug={slug}
        labelPlural={labelPlural}
        canShare={canShare}
        isShared={isShared}
        isDefault={isDefault}
        onShared={setIsShared}
        onDefault={setIsDefault}
      />
    </Popup>
  );
}

/* ── Edit Name of Save Filter ────────────────────────────────────────────── */

export interface RenameViewPopupProps {
  slug: string;
  view: { id: string; name: string };
  onRenamed: (view: SavedViewDto) => void;
  onClose: () => void;
}

/**
 * "Edit Name of Save Filter" — 511x252, structurally identical to Save Filter
 * minus the publish toggles.
 *
 * A rename sends ONLY the name. `viewUpdateSchema` is a partial for exactly
 * this reason ("a rename must not have to resend the whole tree"): resending
 * the spec would let a stale copy of the filter in this component overwrite a
 * tree edited in another tab, and would put a filter change through a dialog
 * whose title says it changes a name.
 */
export function RenameViewPopup({ slug, view, onRenamed, onClose }: RenameViewPopupProps) {
  const [name, setName] = useState(view.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  // Nothing to send: the API would accept it, write an identical row and the
  // list would flicker for no reason.
  const unchanged = trimmed === view.name.trim();

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { view: updated } = await api<{ view: SavedViewDto }>(
        `/api/modules/${slug}/views/${view.id}`,
        { method: 'PATCH', body: JSON.stringify({ name }) },
      );
      onRenamed(updated);
    } catch (err) {
      setError(nameError(err, 'Could not rename this filter.'));
      setSaving(false);
    }
  }

  return (
    <Popup
      open
      width={511}
      title="Edit Name of Save Filter"
      trackPrefix={`${slug}.view.rename`}
      onClose={onClose}
      footer={
        <PopupFooter
          trackPrefix={`${slug}.view.rename`}
          cancel={{ label: 'Cancel', onClick: onClose }}
          next={{
            label: 'Save',
            onClick: () => void save(),
            disabled: trimmed === '' || unchanged || saving,
          }}
        />
      }
    >
      <NameField
        id="saved-view-rename"
        label="Filter Name"
        value={name}
        onChange={setName}
        track={`${slug}.view.rename.name`}
        error={error}
      />
    </Popup>
  );
}

/* ── Delete Saved Filter ─────────────────────────────────────────────────── */

export interface DeleteViewPopupProps {
  slug: string;
  view: { id: string; name: string; isShared: boolean; isDefault: boolean };
  onDeleted: (viewId: string) => void;
  onClose: () => void;
}

/**
 * "Delete Saved Filter" — 511x203. Content is a single measured line:
 * "Are you sure you want to delete this filter?", Regular 14px `#111827`.
 *
 * This delete is HARD, and that is not a violation of invariant 4. A saved
 * view is a kept QUERY, not a record: nothing is stored in it, no audit row
 * points at it, and there is no timeline to keep readable. `lib/config/views.ts`
 * says the same at the other end.
 *
 * The name is echoed under the file's line because the rail can hold nine of
 * these and "this filter" alone does not say which one the kebab was on.
 */
export function DeleteViewPopup({ slug, view, onDeleted, onClose }: DeleteViewPopupProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await api<{ id: string }>(`/api/modules/${slug}/views/${view.id}`, { method: 'DELETE' });
      onDeleted(view.id);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Could not delete this filter.',
      );
      setDeleting(false);
    }
  }

  return (
    <Popup
      open
      width={511}
      title="Delete Saved Filter"
      trackPrefix={`${slug}.view.delete`}
      onClose={onClose}
      footer={
        <PopupFooter
          trackPrefix={`${slug}.view.delete`}
          cancel={{ label: 'Cancel', onClick: onClose }}
          // Measured `bg #ef4444` with a white label — `destructive`.
          next={{
            label: 'Delete',
            onClick: () => void remove(),
            tone: 'destructive',
            disabled: deleting,
          }}
        />
      }
    >
      <div>
        <p className="text-sm text-heading">Are you sure you want to delete this filter?</p>
        {/* Which one. truncate: a view name is user-authored and unbounded,
            and a wrapped name would push the footer past the measured frame. */}
        <p className="mt-1 truncate text-xs text-body" title={view.name}>
          {view.name}
        </p>
        {view.isShared || view.isDefault ? (
          // Deleting a published view or a role default changes other people's
          // screens, which is why the API puts it behind the layout gate. Say
          // so BEFORE the button is pressed rather than after it 403s.
          <p className="mt-2 text-xs text-muted">
            {view.isDefault
              ? 'This is the default view — everyone opening this module lands on it.'
              : 'This view is shared, so it disappears for everyone who uses it.'}
          </p>
        ) : null}
        <FieldError>{error}</FieldError>
      </div>
    </Popup>
  );
}
