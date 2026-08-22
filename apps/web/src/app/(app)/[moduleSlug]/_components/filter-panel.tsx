'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FieldType, FilterNode } from '@crm/shared';
import { api } from '@/lib/client-api';
import type { UserListItem } from '@/lib/config/users';
import { Button, Panel } from '@/components/ui';
import { ChevronDownIcon } from './icons';
import { ConditionRow, type PickerOption } from './filter-condition-row';
import { draftError, newDraft, treeFrom, type DraftCondition } from './filter-model';

/**
 * The left filter rail — the design's four groups, and the only place an
 * ad-hoc filter is built.
 *
 * Nothing in it is written by hand. The field rows are this module's
 * `FieldDefinition` rows narrowed to the types that declare operators, the
 * operators come from the registry, the related-module list is whichever
 * modules point at this one, and the saved filters are `SavedView` rows. The
 * designed Leads rail is what this renders when the Leads module drives it.
 *
 * SECURITY NOTE, since this is the screen that builds the tree: nothing here
 * can widen a result set. The tree it emits is ANDed underneath the reader's
 * own scope filter in the repository (`combine(scopedWhere, userWhereFor)`),
 * so the worst a bad filter can do is show the user fewer of their own rows.
 * What it must never do is show MORE rows than it says — which is why an
 * incomplete condition blocks the Apply instead of being quietly dropped.
 */

export interface FilterField {
  key: string;
  label: string;
  type: FieldType;
  /**
   * The choices for a picker, resolved server-side: a picklist's own options,
   * or the module's statuses when this field IS the status pointer. Keyed off
   * the physical column there, never off a field name.
   */
  options: PickerOption[];
  /** a user field's picker is the user list, which is fetched, not seeded */
  usesUsers: boolean;
}

export interface RelatedModule {
  slug: string;
  labelPlural: string;
}

export interface RailView {
  id: string;
  name: string;
  isShared: boolean;
  isDefault: boolean;
  isOwn: boolean;
  /** false when the stored spec no longer parses — listed, but not applicable */
  isValid: boolean;
}

export interface FilterPanelProps {
  slug: string;
  /** module.labelPlural — the panel title is "Filter by {these}". */
  labelPlural: string;
  fields: FilterField[];
  relatedModules: RelatedModule[];
  views: RailView[];
  appliedViewId: string | null;
  /** the conditions the applied filter (link or saved view) resolved to */
  initialDrafts: DraftCondition[];
  /**
   * What the rail cannot faithfully represent about the applied filter, if
   * anything. Shown above the rows rather than hidden, because every one of
   * these means "re-applying from here changes the filter" — and every one of
   * them changes it in the widening direction.
   */
  warnings: string[];
  /** an ad-hoc filter is in effect right now */
  isFiltered: boolean;
  onApply: (tree: FilterNode | null) => void;
  onClear: () => void;
  onSaveOpen: () => void;
  onApplyView: (viewId: string) => void;
  /**
   * The two actions the file's own row menu offers — measured on
   * `…_Saved filter Edit`, where a saved-filter row carries a
   * `ph:dots-three-vertical-bold` 16x16 that opens a 98x32 `Drop Down` of
   * exactly "Rename" and "Delete". The rail RAISES them; the pop-ups that
   * perform them live with the screen that owns the view list.
   */
  onRenameView: (view: RailView) => void;
  onDeleteView: (view: RailView) => void;
  /** bumped by the toolbar's Filter button to bring the rail into focus */
  focusToken: number;
  /**
   * The field the rail should open on, when the focus came from a column
   * header's `oui:filter` funnel rather than the toolbar's Filter button.
   * Absent, the group as a whole takes focus, which is the toolbar's meaning.
   */
  focusFieldKey?: string;
}

/**
 * The system group stays inert, and says so.
 *
 * `Activities`, `Cadences`, `Touched/Untouched Records`, `Age in N Days` and
 * the rest are ENGINE concepts, not `FieldDefinition` rows: they need the
 * activity log and the campaign link, neither of which exists yet. A live
 * checkbox here would compile to a condition that matches nothing, and a
 * filter that silently matches nothing is worse than an absent one — the user
 * concludes they have no records, not that the feature is missing.
 */
const SYSTEM_NOTE =
  'Untouched records, locked records, activities and age-in-days are computed by the ' +
  'filter engine from the activity log, not from this module’s fields. They arrive with ' +
  'the activity and campaign slices.';

const RELATED_NOTE =
  'Filtering across a related module needs the link to be queryable in one tree. ' +
  'The modules that point at this one are listed; the join arrives with the related-records slice.';

export function FilterPanel({
  slug,
  labelPlural,
  fields,
  relatedModules,
  views,
  appliedViewId,
  initialDrafts,
  warnings,
  isFiltered,
  onApply,
  onClear,
  onSaveOpen,
  onApplyView,
  onRenameView,
  onDeleteView,
  focusToken,
  focusFieldKey,
}: FilterPanelProps) {
  // Keyed by field key: the rail is a list of fields, so one row per field is
  // the only arrangement it can draw. A second condition on the same field is
  // an advanced-filter concept and `draftsFrom` reports it rather than losing it.
  const [drafts, setDrafts] = useState<Record<string, DraftCondition>>(() =>
    Object.fromEntries(initialDrafts.map((d) => [d.fieldKey, d])),
  );
  // Errors appear on Apply, not on the first keystroke of a half-typed value.
  const [showErrors, setShowErrors] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const fieldsGroupRef = useRef<HTMLDivElement>(null);

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const active = useMemo(
    // Rail order, not insertion order, so the tree a user builds twice is the
    // same tree — and so a saved view's name matches what it reloads as.
    () => fields.map((f) => drafts[f.key]).filter((d): d is DraftCondition => d !== undefined),
    [fields, drafts],
  );

  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const draft of active) {
      const message = draftError(draft);
      if (message !== null) out[draft.fieldKey] = message;
    }
    return out;
  }, [active]);

  // The user list is a second round trip and only when a user field is
  // actually being filtered on — a module with no USER_LOOKUP field, or a rail
  // nobody has opened one on, must not pay for it.
  const needsUsers = active.some((d) => fieldByKey.get(d.fieldKey)?.usesUsers === true);
  const users = useUserOptions(needsUsers);

  // The toolbar's Filter button brings the rail into view rather than opening
  // a second filter surface — the rail IS the filter UI, and the design keeps
  // it on screen. Token rather than a callback ref so the parent needs to know
  // nothing about the rail's internals.
  /**
   * The row a funnel asked for, waiting to be focused.
   *
   * Two effects, not one, and that split is the whole point: ticking the field
   * CREATES its condition row, and the row does not exist until React has
   * committed that state. Focusing in the same effect (or a frame later) races
   * the commit and lands on the group's first input, or on nothing at all —
   * which is exactly what it did. So the first effect records the intent and
   * the second one acts on it once the row is actually in the DOM.
   */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  useEffect(() => {
    if (focusToken === 0) return;
    setCollapsed((prev) => ({ ...prev, fields: false }));
    // A funnel names its field, so TICK that row — an untouched field has no
    // value control to land in.
    if (focusFieldKey !== undefined) {
      const field = fieldByKey.get(focusFieldKey);
      if (field !== undefined) {
        setDrafts((prev) =>
          prev[field.key] !== undefined
            ? prev
            : { ...prev, [field.key]: newDraft(field.key, field.type) },
        );
      }
    }
    setPendingFocus(focusFieldKey ?? '');
    // `fieldByKey` is stable per field list and deliberately not a dependency:
    // re-running this on an unrelated re-render would yank focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  useEffect(() => {
    if (pendingFocus === null) return;
    const group = fieldsGroupRef.current;
    if (!group) return;
    // '' is the toolbar's meaning: the group as a whole, no particular field.
    const scope =
      pendingFocus === ''
        ? group
        : group.querySelector<HTMLElement>(`[data-field-key="${CSS.escape(pendingFocus)}"]`);
    // The row has not rendered yet — stay pending and try again on the commit
    // that brings it in, rather than giving up and focusing the wrong thing.
    if (scope === null) return;
    scope.scrollIntoView({ block: 'nearest' });
    // Skip the field's own toggle checkbox and land on the VALUE control —
    // focusing the toggle would put Space on "untick the thing you just asked
    // to filter by".
    const controls = [...scope.querySelectorAll<HTMLElement>('input, select')];
    const value = controls.find((el) => el.getAttribute('type') !== 'checkbox');
    (value ?? controls[0])?.focus();
    setPendingFocus(null);
  }, [pendingFocus, drafts]);

  function toggleField(field: FilterField, on: boolean) {
    setDrafts((prev) => {
      const next = { ...prev };
      if (on) next[field.key] = newDraft(field.key, field.type);
      else delete next[field.key];
      return next;
    });
  }

  function apply() {
    setShowErrors(true);
    // An incomplete row is not dropped: dropping a condition widens the result
    // set, which is the one thing a filter must never do quietly.
    if (Object.keys(errors).length > 0) return;
    onApply(treeFrom(active));
  }

  function clear() {
    setDrafts({});
    setShowErrors(false);
    onClear();
  }

  const groups: { id: string; label: string; body: ReactNode }[] = [
    { id: 'system', label: 'System Defined Filters', body: <Note>{SYSTEM_NOTE}</Note> },
    {
      id: 'fields',
      label: 'Filter By fields',
      body:
        fields.length === 0 ? (
          <Note>This module has no filterable fields yet.</Note>
        ) : (
          <div ref={fieldsGroupRef}>
            {warnings.map((warning) => (
              <p
                key={warning}
                className="mb-2 rounded bg-warning/10 px-2 py-1 text-xs text-heading"
              >
                {warning}
              </p>
            ))}
            <ul className="flex flex-col gap-1">
              {fields.map((field) => {
                const draft = drafts[field.key];
                return (
                  <li key={field.key} data-field-key={field.key}>
                    <label
                      className="flex cursor-pointer items-center gap-2 text-xs text-body"
                      title={field.label}
                    >
                      <input
                        type="checkbox"
                        checked={draft !== undefined}
                        onChange={(e) => toggleField(field, e.target.checked)}
                        className="h-4 w-4 shrink-0 rounded accent-primary"
                        data-track={`${slug}.filter.field.toggle`}
                      />
                      <span className="truncate">{field.label}</span>
                    </label>

                    {draft !== undefined ? (
                      <ConditionRow
                        slug={slug}
                        field={field}
                        draft={draft}
                        onChange={(next) => setDrafts((prev) => ({ ...prev, [field.key]: next }))}
                        options={field.usesUsers ? users.options : field.options}
                        optionsNote={field.usesUsers ? users.note : null}
                        error={showErrors ? (errors[field.key] ?? null) : null}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ),
    },
    {
      id: 'related',
      label: 'Filter By Related Modules',
      body:
        relatedModules.length === 0 ? (
          <Note>No other module links to this one yet.</Note>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {relatedModules.map((m) => (
                <li key={m.slug} className="truncate text-xs text-body opacity-70" title={m.labelPlural}>
                  {m.labelPlural} (Connected Records)
                </li>
              ))}
            </ul>
            <Note>{RELATED_NOTE}</Note>
          </>
        ),
    },
    {
      // The design's fourth group. (N) is the number of saved filters; the
      // per-view number beside each name is its live match count.
      id: 'saved',
      label: `Saved Filters (${views.length})`,
      body: (
        <SavedFilters
          slug={slug}
          views={views}
          appliedViewId={appliedViewId}
          onApplyView={onApplyView}
          onRenameView={onRenameView}
          onDeleteView={onDeleteView}
        />
      ),
    },
  ];

  return (
    // shrink-0 so a wide table can never squeeze the rail below its 230px.
    <Panel className="flex w-filters shrink-0 flex-col overflow-hidden" id={`filter-rail-${slug}`}>
      {/* 12px padding, not the panel default of 24: at 230px wide the standard
          padding would leave 182px for a field label, and these truncate. */}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <h2 className="truncate text-sm font-medium text-heading" title={`Filter by ${labelPlural}`}>
          Filter by {labelPlural}
        </h2>

        {/* min-h-0 + overflow-y-auto: the rail scrolls, the page does not. */}
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => {
            const isOpen = collapsed[group.id] !== true;
            const regionId = `filter-${slug}-${group.id}`;
            return (
              <section key={group.id}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={regionId}
                  onClick={() =>
                    setCollapsed((prev) => ({ ...prev, [group.id]: prev[group.id] !== true }))
                  }
                  data-track={`${slug}.list.filter.group.toggle`}
                  className="flex w-full items-center gap-2 rounded text-left text-xs font-medium text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <ChevronDownIcon
                    // One chevron rotated, so open and closed can never drift
                    // into two differently-shaped glyphs.
                    className={`h-4 w-4 shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                  />
                  <span className="truncate" title={group.label}>
                    {group.label}
                  </span>
                </button>

                {isOpen ? (
                  <div id={regionId} className="mt-2 pl-2">
                    {group.body}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>

        {/* The footer the file draws. It sits outside the scroll port so Apply
            is reachable on a module with 33 filterable fields. */}
        <div className="mt-3 flex shrink-0 flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              disabled={active.length === 0 && !isFiltered}
              onClick={clear}
              data-track={`${slug}.filter.clear.click`}
            >
              Clear
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              onClick={apply}
              data-track={`${slug}.filter.apply.click`}
            >
              Apply Filter
            </Button>
          </div>

          {/* Save Filter appears once a filter is applied, exactly as the file
              shows it — there is nothing to name before then. */}
          {isFiltered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onSaveOpen}
              data-track={`${slug}.view.save.open`}
            >
              Save Filter
            </Button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-body">{children}</p>;
}

/**
 * `ph:dots-three-vertical-bold`, measured 16x16 on the saved-filter row.
 *
 * Traced here rather than added to `./icons.tsx` on purpose: this is the only
 * screen that draws it, and that file is shared with the import wizard, which
 * another slice is editing concurrently. It moves into `icons.tsx` the moment
 * a second caller wants it.
 */
function KebabIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      {/* Bold, per the icon's own name — filled dots rather than strokes. */}
      <g fill="currentColor">
        <circle cx="12" cy="5" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="12" cy="19" r="2" />
      </g>
    </svg>
  );
}

/**
 * The row menu the kebab opens: "Rename" then "Delete", in that order.
 *
 * Measured on `…_Saved filter Edit` as `Group 3` @388,236 — 98x32, two 98x16
 * `Drop Down` rows, the resting one `bg #ffffff` with `#6b7280` text and the
 * hovered one `bg #f6f8fa` with `#111827`. Those two fills and the two text
 * colours are used verbatim below (`surface`/`background`, `body`/`heading`).
 *
 * The 16px rows and 6px text are NOT: the whole dropdown is drawn at a reduced
 * scale in that frame — 6px is below every step the type scale defines and
 * below the 10px the same file uses for the Sort menu's rows. So this follows
 * the Sort menu's measured 28px row and 10px text (`text-overline`), which is
 * the nearest real step and the precedent `sort-menu.tsx` already documents.
 */
function ViewRowMenu({
  slug,
  viewName,
  onRename,
  onDelete,
  onClose,
}: {
  slug: string;
  viewName: string;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // pointerdown, not click: a click that lands on another control should
    // close this and still reach that control, which a click-phase close on
    // the document would swallow. Same handling as `SortMenu`.
    function onPointerDown(e: PointerEvent) {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  const ROW =
    'flex h-7 w-full items-center px-3 text-left text-overline ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary';

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${viewName}`}
      // right-0: the kebab is flush right of a 230px rail, so the menu hangs
      // from that edge or it leaves the panel. overflow-hidden gives the rows
      // the container's corners, which is how the file draws them.
      className="absolute right-0 top-full z-40 mt-1 w-[98px] overflow-hidden rounded border border-border bg-surface"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        data-track={`${slug}.view.rename.open`}
        className={`${ROW} text-body hover:bg-background hover:text-heading`}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        data-track={`${slug}.view.delete.open`}
        // The file paints this row's label `#111827` (it is drawn hovered).
        // It stays a neutral row rather than turning red: the destructive
        // colour belongs on the confirmation's Delete button, which is where
        // the file puts `#ef4444`.
        className={`${ROW} text-body hover:bg-background hover:text-heading`}
      >
        Delete
      </button>
    </div>
  );
}

/**
 * The saved-view list, with live match counts.
 *
 * The counts are fetched FROM THE CLIENT, after the list has already painted,
 * and only while this group is expanded. Each one is its own aggregate over
 * the matched set (`listViews({ withCounts })` caps itself at 20), so asking
 * for them in the page's own server render would put N queries in front of the
 * rows — the numbers are a label on the rail, and a label must not delay the
 * data. They survive client-side navigation, so paging through the list does
 * not re-run them.
 *
 * A view whose count cannot be computed — one referencing a field an Admin has
 * since deleted — shows no number rather than a wrong one.
 */
function SavedFilters({
  slug,
  views,
  appliedViewId,
  onApplyView,
  onRenameView,
  onDeleteView,
}: {
  slug: string;
  views: RailView[];
  appliedViewId: string | null;
  onApplyView: (viewId: string) => void;
  onRenameView: (view: RailView) => void;
  onDeleteView: (view: RailView) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsFailed, setCountsFailed] = useState(false);
  /** id of the view whose row menu is open — at most one at a time. */
  const [menuFor, setMenuFor] = useState<string | null>(null);

  useEffect(() => {
    if (views.length === 0) return;
    let cancelled = false;
    api<{ views: { id: string; matchCount?: number }[] }>(`/api/modules/${slug}/views?counts=1`)
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const v of res.views) if (v.matchCount !== undefined) next[v.id] = v.matchCount;
        setCounts(next);
      })
      // A missing count is a missing label, never a broken rail: the views are
      // already listed and still applicable without it.
      .catch(() => {
        if (!cancelled) setCountsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, views.length]);

  if (views.length === 0) {
    return <Note>No saved filters yet. Apply a filter and save it to keep it here.</Note>;
  }

  return (
    <>
      <ul className="flex flex-col gap-1">
        {views.map((view) => {
          const count = counts?.[view.id];
          /**
           * The row menu, measured on `…_Saved filter Edit`: the saved-filter
           * row there (`Frame 482702`, 206x20, `bg #f6f8fa`) ends in a
           * `ph:dots-three-vertical-bold` 16x16 at x=470 of 284..490 — flush
           * right — and it opens a 98x32 `Drop Down` of two rows, "Rename"
           * then "Delete".
           *
           * Drawn only for a view this actor OWNS. `SavedViewDto.isOwn` is the
           * same fact `lib/config/views.ts` gates the write on ("Only the
           * owner of a view can delete it"), so a menu on someone else's view
           * would be two items that always 403. Publishing and role defaults
           * need the layout permission on top of that — the API asserts it and
           * the delete pop-up warns about it, rather than this rail
           * re-deriving a permission rule.
           *
           * Deliberately NOT gated on `isValid`. A view whose stored spec no
           * longer parses cannot be APPLIED, and the kebab is then the only
           * way to rename or remove it — which is exactly what `SavedViewDto`
           * says such a view is listed for. Disabling the menu alongside the
           * row would leave a broken view on the rail with no way to clear it.
           */
          const canManage = view.isOwn;
          const menuOpen = menuFor === view.id;
          return (
            <li key={view.id} className="relative">
              {/* The row is a flex of TWO buttons, not one: a kebab nested
                  inside the apply button would be a button inside a button,
                  which no browser renders and no screen reader can announce. */}
              <div
                className={
                  'flex items-center gap-1 rounded px-1 ' +
                  (view.id === appliedViewId ? 'bg-background' : 'hover:bg-background')
                }
              >
                <button
                  type="button"
                  disabled={!view.isValid}
                  aria-current={view.id === appliedViewId ? 'true' : undefined}
                  title={
                    view.isValid
                      ? `${view.name}${view.isShared ? ' — shared' : ''}${view.isDefault ? ' — default' : ''}`
                      : `${view.name} — this view references a field that no longer exists, so it cannot be applied.`
                  }
                  onClick={() => onApplyView(view.id)}
                  data-track={`${slug}.view.select`}
                  className={
                    'flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-xs ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
                    'disabled:cursor-not-allowed disabled:opacity-60 ' +
                    (view.id === appliedViewId ? 'font-medium text-heading' : 'text-body')
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{view.name}</span>
                  {view.isShared ? (
                    <span className="shrink-0 text-overline uppercase text-muted">Shared</span>
                  ) : null}
                  {count !== undefined ? (
                    <span className="shrink-0 tabular-nums text-muted">{count}</span>
                  ) : null}
                </button>

                {canManage ? (
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    // Icon-only, and there is one per row: the view's own name
                    // is the only thing that tells two of them apart.
                    aria-label={`Actions for ${view.name}`}
                    onClick={() => setMenuFor(menuOpen ? null : view.id)}
                    data-track={`${slug}.view.actions.open`}
                    className={
                      'flex shrink-0 items-center rounded p-0.5 text-body hover:text-heading ' +
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
                    }
                  >
                    <KebabIcon />
                  </button>
                ) : null}
              </div>

              {menuOpen ? (
                <ViewRowMenu
                  slug={slug}
                  viewName={view.name}
                  onRename={() => {
                    setMenuFor(null);
                    onRenameView(view);
                  }}
                  onDelete={() => {
                    setMenuFor(null);
                    onDeleteView(view);
                  }}
                  onClose={() => setMenuFor(null)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {countsFailed ? (
        <p className="mt-1 text-xs text-muted">Match counts are unavailable right now.</p>
      ) : null}
    </>
  );
}

/** The owner picker's options, fetched at most once per mount and only when a
 *  user field is actually being filtered on. */
function useUserOptions(enabled: boolean): { options: PickerOption[]; note: string | null } {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!enabled || loaded.current) return;
    loaded.current = true;
    let cancelled = false;
    // 200 is the route's own cap. A role that cannot enumerate users can still
    // filter — "is me", "is empty" and a typed id all still work — so a failure
    // here is a note, not an error.
    api<{ users: UserListItem[] }>('/api/users?take=200')
      .then((res) => {
        if (cancelled) return;
        setOptions(
          res.users.map((u) => ({ value: u.id, label: u.fullName ?? u.email ?? u.id })),
        );
      })
      .catch(() => {
        if (!cancelled) setNote('The user list is not available to your role — “is me” still works.');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { options, note };
}
