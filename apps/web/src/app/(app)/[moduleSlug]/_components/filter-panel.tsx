'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FieldType, FilterNode, SystemFilterDto, SystemFilterId } from '@crm/shared';
import { api } from '@/lib/client-api';
import type { UserListItem } from '@/lib/config/users';
import { FieldError, Panel, Select } from '@/components/ui';
import { ChevronDownIcon } from './icons';
import { SAVE_FILTER_EVENT, type SaveFilterEventDetail } from './filter-toggle';
import { CONDITION_INDENT, ConditionRow, type PickerOption } from './filter-condition-row';
import { draftError, newDraft, treeFrom, type DraftCondition } from './filter-model';
import type { SystemSelection } from './list-query';

/**
 * The left filter rail — the design's groups, and the only place an ad-hoc
 * filter is built.
 *
 * Nothing in it is written by hand. The field rows are this module's
 * `FieldDefinition` rows narrowed to the types that declare operators, the
 * operators come from the registry, the related-module list is whichever
 * modules point at this one, and the saved filters are `SavedView` rows. The
 * designed Leads rail is what this renders when the Leads module drives it.
 *
 * ── Measured, 26 Aug 2026, off `CRM _ Leads_Filter By leads` and the four
 * frames that draw the saved-filter states. Frame-relative coordinates; the
 * rail's own `Rectangle 3` is @272,152 — 230×856, `bg #ffffff`,
 * `border #e5e7eb`, `r:12`.
 *
 * | Node | Measured |
 * |---|---|
 * | `Filter by Leads` | @284,164 — Inter Medium 14px `#111827` (12px inset) |
 * | `Rectangle 4` search | @284,190 — 206×36 (10px under the title) |
 * | group heading | 16 tall, `flex-row gap:10` — chevron 16 + label Medium 12px `#111827` |
 * | group list | indented 10 from the heading, `flex-col gap:4` |
 * | a row | 151×16, `flex-row gap:8` — 16×16 box `r:4` + label **Regular 10px** `#6b7280` |
 * | a TICKED box | `bg #00667a`, `border #00667a`, `r:4`, white `charm:tick` 12 |
 * | heading → list | 10 · list → next heading | 12 · search → first heading | 12 |
 * | `Rectangle 8` footer | @273,951 — 228×56, `bg #f6f8fa`, `r:0,0,11,11` |
 * | `Frame 482691` | @285,963 — 204×32, `flex-row gap:8`, two 98×32 buttons |
 * | ↳ Clear | `border #00667a 1px`, no fill, label `#00667a` Regular 10px |
 * | ↳ Apply Filter | `bg #00667a`, label `#ffffff` Regular 10px |
 *
 * ⚠️ Two corrections to docs/DESIGN-SPEC.md, both measured off the frames:
 *
 *  - **Saved Filters is the FIRST group, above the title and the search box**,
 *    not "a fourth rail group". `Frame 482701` is @284,164 in all four saved
 *    frames and pushes `Filter by Leads` down to 244 and the search to 270. It
 *    is absent entirely in the two frames drawn before anything is saved,
 *    which is why it renders only when there are views.
 *  - **`Age in [N] Days` is not a System Defined Filter.** It is drawn at
 *    @318,506 — directly under the TICKED `Account Open Date` row inside
 *    *Filter By fields* — so it is that field's condition row, not a computed
 *    filter of its own. `filter-condition-row.tsx` carries its geometry.
 *  - **`Rectangle 8` is conditional, and Save Filter is not in it.** The
 *    footer strip is drawn in `CRM _ Leads_Filter By leads` and its two
 *    `_Drop Down` variants — the three frames with a field row ticked — and in
 *    none of the frames that draw the rail at rest. Save Filter is a TOOLBAR
 *    BAND button (`Frame 482700` @416,93); it lives in `filter-toggle.tsx` now
 *    and reaches this component through a window event.
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
  /**
   * The list search box, rendered directly under the heading.
   *
   * Measured @284,190 in the frame — INSIDE this rail, not in a row above the
   * panels. It arrives as a slot rather than an import so the rail stays
   * ignorant of the query string: the page owns that wiring already.
   */
  search?: ReactNode;
  fields: FilterField[];
  relatedModules: RelatedModule[];
  views: RailView[];
  appliedViewId: string | null;
  /** the conditions the applied filter (link or saved view) resolved to */
  initialDrafts: DraftCondition[];
  /**
   * The System Defined Filters the applied filter carries, from the fragment.
   * Seeded rather than merged: the rail is remounted whenever the applied
   * filter changes underneath it (see the `key` the list gives it), so this is
   * read once per applied filter, exactly like `initialDrafts`.
   */
  initialSystem: SystemSelection[];
  /**
   * What the rail cannot faithfully represent about the applied filter, if
   * anything. Shown above the rows rather than hidden, because every one of
   * these means "re-applying from here changes the filter" — and every one of
   * them changes it in the widening direction.
   */
  warnings: string[];
  /** an ad-hoc filter is in effect right now */
  isFiltered: boolean;
  /**
   * Both halves of the ad-hoc filter, together. They are ANDed by the server,
   * so they are emitted in one call: handing them over separately would let a
   * caller apply one and forget the other, and half of an AND matches more
   * rows than the whole of it.
   */
  onApply: (tree: FilterNode | null, system: SystemSelection[]) => void;
  onClear: () => void;
  /**
   * Opens the Save Filter pop-up. The BUTTON that asks for it is in the
   * toolbar band now (`filter-toggle.tsx`), not in this rail's footer — the
   * band is a server component, so it reaches this callback through a window
   * event rather than a prop. The pop-up itself is unchanged.
   */
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
 * ── System Defined Filters ────────────────────────────────────────────────
 *
 * The file draws NINE rows here, at 20px pitch under a heading at @310,238:
 * Activities @318,264, Cadences @284, Campaigns @304, Latest Email Status
 * @324, Locked @344, Record Action @364, Related Record Action @384, Touched
 * Records @404, Untouched Records @424 — then `Filter By fields` at @310,452.
 * (The .fig spells the second one `Canences`; that is its typo, not a label,
 * so the row reads `Cadences`.)
 *
 * These are ENGINE concepts, not `FieldDefinition` rows, so unlike every other
 * group on this rail they cannot be derived from the module's fields. What
 * this component must NOT do is decide which of them work: whether a module
 * can answer `Touched Records` is a fact about the audit log and the storage
 * shape, and it is published by `GET /api/modules/:slug/system-filters` as one
 * `SystemFilterDto` per row — label, availability, the reason it is
 * unavailable, and the choices when it needs a value.
 *
 * The map below is therefore the DRAWING and nothing else — the file's label
 * against each id, so the group holds its geometry before the server has
 * answered and if the server never answers at all. Every row it produces is
 * `available: false`. Availability only ever arrives over the wire; there is
 * no branch anywhere in this file that says which module or which row can be
 * filtered on.
 *
 * `Record<SystemFilterId, …>` is what keeps it honest: the shared vocabulary
 * has to be covered exactly, so a tenth id, a renamed one or a stray one is a
 * compile error here rather than a row that quietly stops being drawn. The tie
 * is a TYPE, deliberately — a client component that imported the id array as a
 * VALUE would take the whole list screen down with it if that import ever
 * failed to resolve, and this table is the fallback, i.e. the one part that
 * has to survive things going wrong.
 */
const SYSTEM_LABELS: Record<SystemFilterId, string> = {
  activities: 'Activities',
  // The .fig spells this `Canences`. That is its typo, not a label.
  cadences: 'Cadences',
  campaigns: 'Campaigns',
  latestEmailStatus: 'Latest Email Status',
  locked: 'Locked',
  recordAction: 'Record Action',
  relatedRecordAction: 'Related Record Action',
  touched: 'Touched Records',
  untouched: 'Untouched Records',
};

/**
 * The ids in the file's order — the map's own key order, which for string keys
 * is insertion order. Cast because `Object.keys` is typed `string[]` and
 * cannot see that this object's keys ARE the union; the annotation above is
 * what makes that true, and it is checked.
 */
const SYSTEM_ID_ORDER = Object.keys(SYSTEM_LABELS) as SystemFilterId[];

const SYSTEM_LOADING = 'Checking whether this module can answer this filter…';

const SYSTEM_UNAVAILABLE =
  'This module’s system filters could not be loaded, so none of them can be applied right now.';

/**
 * The related-module rows are drawn; the join behind them is not written.
 *
 * Stated as the mechanical obstacle rather than as a plan. `AuditLog` rows are
 * addressed by `(entityType, entityId)`, so testing "did anything happen to a
 * record LINKED to this one" means joining the link and the log inside one
 * compiled tree — a shape the filter compiler has no node for. That is the
 * whole of it; naming a slice it arrives with would be promising a date this
 * file has no way to keep.
 */
const RELATED_NOTE =
  'Filtering across a related module needs the link and the audit log queryable in one tree. ' +
  'The modules that point at this one are listed, but audit rows are addressed by ' +
  'entity type and id, so a condition that reaches across a link needs a join the filter ' +
  'compiler has no shape for.';

/**
 * A rail row: 16 tall, a 16×16 box, an 8px gap and a 10px label.
 *
 * `leading-4` pins the row to the measured 16 — a bare `text-[10px]` inherits
 * the page's line-height and grows the 20px pitch the file draws.
 *
 * Split from its colour so an unavailable system row can take `text-muted`
 * without stacking two text-colour utilities on one element. Two competing
 * utilities resolve by STYLESHEET order, not attribute order (the trap
 * `filter-condition-row.tsx` documents at length), so the way to win is to
 * never emit the losing one.
 */
const ROW_BASE = 'flex items-center gap-2 text-[10px] leading-4';
const ROW = `${ROW_BASE} text-body`;

/** The 16×16 `r:4` box, ticked in `#00667a` with a white glyph. */
const BOX = 'h-4 w-4 shrink-0 rounded accent-primary';

/**
 * The value picker a system row reveals — the measured condition-control
 * chrome: 18 tall, `pad 4`, `r:4`, white on a `#e5e7eb` hairline, 10px `--body`
 * text (`filter-condition-row.tsx` carries the measurement and the reason the
 * colour is written the long way — `.text-heading` on the shared input
 * primitive is emitted after `.text-body`, so only a bracketed value wins).
 */
const SYSTEM_CONTROL =
  'h-[18px] min-w-0 bg-surface px-[4px] text-[10px] leading-none text-[color:var(--body)]';

/** Clear / Apply Filter: 98×32, radius 4, 10px label. Same recipe as the sort
 *  pop-over's Cancel / Apply pair, which the file draws identically. */
const FOOTER_ACTION =
  'inline-flex h-8 flex-1 items-center justify-center rounded text-[10px] transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function FilterPanel({
  search,
  slug,
  labelPlural,
  fields,
  relatedModules,
  views,
  appliedViewId,
  initialDrafts,
  initialSystem,
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
  /**
   * The ticked System Defined Filters, id → its picked value ('' when the row
   * needs none, or needs one and nothing is chosen yet).
   *
   * A record rather than a list so ticking is O(1) and an id can appear only
   * once — the same reason `drafts` is keyed by field key.
   */
  const [system, setSystem] = useState<Partial<Record<SystemFilterId, string>>>(() =>
    Object.fromEntries(initialSystem.map((s) => [s.id, s.value ?? ''])),
  );
  // Errors appear on Apply, not on the first keystroke of a half-typed value.
  const [showErrors, setShowErrors] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const fieldsGroupRef = useRef<HTMLDivElement>(null);

  const systemRows = useSystemFilters(slug);

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

  /**
   * The ticked system rows, in the order the server published them — the same
   * rule `active` follows for fields, so a filter built twice is the same
   * filter.
   *
   * The second loop is the important one. The fragment can only ever carry an
   * id from the shared vocabulary — `readSystemHash` parses it with the
   * route's own schema — but the row LIST comes from a per-module endpoint,
   * and a module that published eight rows would leave the ninth ticked and
   * undrawn. It is CARRIED anyway, never dropped: dropping it would silently
   * turn an AND of two conditions into an AND of one, which matches more rows.
   * It travels to the server, which answers an id it cannot honour with a 400
   * that names it.
   */
  const activeSystem = useMemo<SystemSelection[]>(() => {
    const out: SystemSelection[] = [];
    const drawn = new Set<string>();
    for (const row of systemRows) {
      drawn.add(row.id);
      const value = system[row.id];
      if (value === undefined) continue;
      out.push(value === '' ? { id: row.id } : { id: row.id, value });
    }
    // Walked over the drawn order rather than over the state's own keys, so
    // every id in it is typed and nothing needs casting back into the union.
    for (const id of SYSTEM_ID_ORDER) {
      if (drawn.has(id)) continue;
      const value = system[id];
      if (value === undefined) continue;
      out.push(value === '' ? { id } : { id, value });
    }
    return out;
  }, [systemRows, system]);

  /** Ticked ids this rail has no row for — carried, and said out loud. */
  const strayCount = useMemo(
    () =>
      SYSTEM_ID_ORDER.filter(
        (id) => system[id] !== undefined && !systemRows.some((row) => row.id === id),
      ).length,
    [system, systemRows],
  );

  /**
   * A ticked row that needs a value and has none.
   *
   * Blocked rather than sent without one, for the reason every incomplete
   * condition on this rail is blocked: what the server would do with a
   * value-less filter is its business, and guessing here is how a filter comes
   * to mean something other than what the rail displays.
   */
  const systemErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of systemRows) {
      if (row.options === null) continue;
      const value = system[row.id];
      if (value === undefined) continue;
      if (value === '') out[row.id] = `Choose a value for ${row.label}.`;
    }
    return out;
  }, [systemRows, system]);

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

  /**
   * Save Filter now lives in the TOOLBAR BAND (`Frame 482700` @416,93), which
   * `page.tsx` renders as a server component — so it cannot be handed
   * `onSaveOpen` directly. It raises a window event instead and the rail, which
   * already holds that callback, opens the pop-up. Same pop-up, same
   * validation, same permissions; only the button moved.
   */
  // Through a ref, not a dependency: the caller builds `onSaveOpen` inline, so
  // depending on it would tear the listener down and rebuild it on every
  // render of the list.
  const saveOpenRef = useRef(onSaveOpen);
  useEffect(() => {
    saveOpenRef.current = onSaveOpen;
  });

  useEffect(() => {
    function onSaveFilter(event: Event) {
      const detail = (event as CustomEvent<SaveFilterEventDetail>).detail;
      // Two rails on one page must never answer each other's button.
      if (detail?.slug !== slug) return;
      saveOpenRef.current();
    }
    window.addEventListener(SAVE_FILTER_EVENT, onSaveFilter);
    return () => window.removeEventListener(SAVE_FILTER_EVENT, onSaveFilter);
  }, [slug]);

  function toggleField(field: FilterField, on: boolean) {
    setDrafts((prev) => {
      const next = { ...prev };
      if (on) next[field.key] = newDraft(field.key, field.type);
      else delete next[field.key];
      return next;
    });
  }

  function toggleSystem(row: SystemFilterDto, on: boolean) {
    // One direction only. Unticking an unavailable row is how a reader clears
    // a condition a link brought in that this module cannot answer; TICKING
    // one is never allowed, and this is the rule rather than the `disabled`
    // attribute, which is a rendering detail.
    if (on && !row.available) return;
    setSystem((prev) => {
      const next = { ...prev };
      if (on) next[row.id] = '';
      else delete next[row.id];
      return next;
    });
  }

  function apply() {
    setShowErrors(true);
    // An incomplete row is not dropped: dropping a condition widens the result
    // set, which is the one thing a filter must never do quietly.
    if (Object.keys(errors).length > 0 || Object.keys(systemErrors).length > 0) return;
    onApply(treeFrom(active), activeSystem);
  }

  function clear() {
    setDrafts({});
    setSystem({});
    setShowErrors(false);
    onClear();
  }

  const isOpen = (id: string) => collapsed[id] !== true;
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: prev[id] !== true }));

  const groups: { id: string; label: string; count?: number; body: ReactNode }[] = [
    {
      id: 'system',
      label: 'System Defined Filters',
      // No chip at rest — the file draws none on this heading. It appears only
      // to report how many of these rows the current filter is using.
      ...(activeSystem.length === 0 ? {} : { count: activeSystem.length }),
      body: (
        <>
          {/* The file's nine rows, its order, its labels, and the same
              16/16/8/10 anatomy as a field row — so the two groups sit on one
              20px pitch. What differs is only what the SERVER says: an
              unavailable row is disabled and carries its reason. */}
          <ul className="flex flex-col gap-1">
            {systemRows.map((row) => {
              const value = system[row.id];
              const ticked = value !== undefined;
              const error = showErrors ? (systemErrors[row.id] ?? null) : null;
              const errorId = error === null ? undefined : `filter-system-${row.id}-error`;
              return (
                <li key={row.id} data-system-id={row.id}>
                  <label
                    className={
                      row.available
                        ? `${ROW} cursor-pointer`
                        : `${ROW_BASE} text-muted ${ticked ? 'cursor-pointer' : 'cursor-not-allowed'}`
                    }
                    // The reason IS the tooltip on an unavailable row: the row
                    // is drawn because the file draws it, and a row that cannot
                    // be ticked owes the reader an explanation on the spot.
                    title={row.available ? row.label : (row.reason ?? row.label)}
                  >
                    <input
                      type="checkbox"
                      checked={ticked}
                      // Disabled in the ADDING direction only. A link can carry
                      // a row this module cannot answer — the fragment is
                      // checked against the vocabulary, not against this
                      // module's capabilities — and the server refuses it with
                      // a 400. Leaving that tick disabled would leave the
                      // reader looking at the condition that broke their list
                      // with no way to take it off; removing a condition is
                      // always safe, because it can only narrow what is asked.
                      disabled={!row.available && !ticked}
                      onChange={(e) => toggleSystem(row, e.target.checked)}
                      aria-describedby={errorId}
                      className={`${BOX} disabled:cursor-not-allowed`}
                      data-track={`${slug}.filter.system.toggle`}
                    />
                    <span className="truncate">{row.label}</span>
                  </label>

                  {/* A row that needs a value reveals its picker underneath,
                      on the ticked field row's own 24px indent — the same
                      reveal, kept to the one control this needs. */}
                  {ticked && row.options !== null ? (
                    <div className={`mt-2 ${CONDITION_INDENT} flex flex-col gap-1`}>
                      <Select
                        value={value}
                        aria-label={row.label}
                        aria-invalid={error !== null || undefined}
                        aria-describedby={errorId}
                        onChange={(e) =>
                          setSystem((prev) => ({ ...prev, [row.id]: e.target.value }))
                        }
                        className={`${SYSTEM_CONTROL} w-full`}
                        data-track={`${slug}.filter.system.value`}
                      >
                        <option value="">Select…</option>
                        {row.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                      <FieldError id={errorId}>{error}</FieldError>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {strayCount > 0 ? (
            <Note className="mt-2">
              {strayCount === 1
                ? 'One system filter in this link is not one this module offers. It is kept and sent as it is — dropping it would widen the result — and the server answers for it.'
                : `${strayCount} system filters in this link are not ones this module offers. They are kept and sent as they are — dropping them would widen the result — and the server answers for them.`}
            </Note>
          ) : null}
        </>
      ),
    },
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
                // A flat surface with a warning-coloured edge: slash opacity
                // (`bg-[var(--globalcolors-orange-10)]`) cannot work here — the tokens are CSS
                // variables holding hex, and Tailwind's alpha rewrite silently
                // produces nothing.
                className="mb-2 rounded border border-warning bg-surface px-2 py-1 text-[10px] leading-4 text-heading"
              >
                {warning}
              </p>
            ))}
            <ul className="flex flex-col gap-1">
              {fields.map((field) => {
                const draft = drafts[field.key];
                return (
                  <li key={field.key} data-field-key={field.key}>
                    <label className={`${ROW} cursor-pointer`} title={field.label}>
                      <input
                        type="checkbox"
                        checked={draft !== undefined}
                        onChange={(e) => toggleField(field, e.target.checked)}
                        className={BOX}
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
            {/* The file draws these as checkbox rows identical to the field
                ones. They stay LABELS until the join is queryable in one tree:
                a tickable row that compiles to nothing is the lie the system
                group's disabled rows exist to avoid — the difference is that a
                system row can name the module-specific reason it is off, and
                these all share the one reason the note below states. `pl-6`
                keeps them on the label column the file puts them in, so the
                geometry survives. */}
            <ul className="flex flex-col gap-1">
              {relatedModules.map((m) => (
                <li key={m.slug} className={`${ROW} pl-6`} title={m.labelPlural}>
                  {/* The label as `ModuleDefinition` holds it, with nothing
                      appended. The file's "(Connected Records)" is not a rule
                      it applies: `Accounts`, `Archives`, `Products`,
                      `Solutions` and `Quotes` carry the suffix while `Emails`,
                      `Deals`, `Notes`, `Meetings`, `Tasks` and `Connected To`
                      do not — it is Zoho's own labelling, i.e. CONTENT, and
                      content is the one thing never copied out of the mock.

                      No `opacity-70` either: the file paints these rows the
                      same full-strength #6b7280 as every other rail row. What
                      marks them inert is that they carry no checkbox and the
                      note below says why. */}
                  <span className="truncate">{m.labelPlural}</span>
                </li>
              ))}
            </ul>
            <Note className="mt-2">{RELATED_NOTE}</Note>
          </>
        ),
    },
  ];

  return (
    // shrink-0 so a wide table can never squeeze the rail below its 230px.
    <Panel className="flex w-filters shrink-0 flex-col overflow-hidden" id={`filter-rail-${slug}`}>
      {/* 12px padding, not the panel default of 24: the file insets the rail's
          content to 284 of a rail at 272, and at 206px wide a field label has
          to truncate as it is.

          Everything above the footer is ONE scroll port, which is what the
          file draws — a single column of Saved Filters, title, search and the
          three groups. The footer sits outside it so Apply stays reachable on
          a module with 33 filterable fields. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* Saved Filters and the title are 10 apart, not the 12 the file uses
            between GROUPS: measured on `…_Saved filter Edit`, the last saved
            row (`Frame 482702` @284,214, 20 tall) bottoms out at 234 and
            `Filter by Leads` starts at 244. So the pair is nested in its own
            column and the outer `gap-3` never applies between them. */}
        <div className="flex flex-col gap-2.5">
          {/* Measured FIRST in the rail, above the title: `Frame 482701`
              @284,164 with `Filter by Leads` pushed to 244. Drawn only once
              something is saved — the two pre-save frames have no such
              group. */}
          {views.length > 0 ? (
            <Group
              id="saved"
              slug={slug}
              label="Saved Filters"
              count={views.length}
              open={isOpen('saved')}
              onToggle={() => toggleGroup('saved')}
            >
              <SavedFilters
                slug={slug}
                views={views}
                appliedViewId={appliedViewId}
                onApplyView={onApplyView}
                onRenameView={onRenameView}
                onDeleteView={onDeleteView}
              />
            </Group>
          ) : null}

          <div>
            <h2
              // `leading-4` is the measured line box: the text node is
              // @284,164 and 16 TALL, while `text-sm` carries a 20px line
              // height — four pixels that would push the search box to 30
              // below the title instead of the file's 26.
              className="truncate text-sm font-medium leading-4 text-heading"
              title={`Filter by ${labelPlural}`}
            >
              Filter by {labelPlural}
            </h2>

            {/* @284,190 — 26px below the heading's top edge in the frame, which
                is this 10px gap under a 16px line. */}
            {search ? <div className="mt-2.5">{search}</div> : null}
          </div>
        </div>

        {groups.map((group) => (
          <Group
            key={group.id}
            id={group.id}
            slug={slug}
            label={group.label}
            {...(group.count === undefined ? {} : { count: group.count })}
            open={isOpen(group.id)}
            onToggle={() => toggleGroup(group.id)}
          >
            {group.body}
          </Group>
        ))}
      </div>

      {/* `Rectangle 8` — 228×56 on `#f6f8fa`, 12px inset, the rail's own radius
          less its 1px border on the bottom corners. It holds the two 98×32
          buttons and nothing else, which is what makes 12+32+12 come to the
          measured 56; Save Filter used to be stacked above them and inflated
          it to 96 (see `filter-toggle.tsx` — it is a band button).

          Drawn only when it has something to do. The file agrees: `Rectangle 8`
          appears in `CRM _ Leads_Filter By leads` and its two `_Drop Down`
          variants — the three frames with a field row ticked — and in none of
          the frames that draw the rail at rest, where the rows run to the
          panel's bottom edge. The predicate is exactly the one Clear is
          disabled by, so nothing reachable is hidden: with no draft, no ticked
          system row and no live filter, Clear is a no-op and Apply emits the
          null tree with an empty system list, which is the same no-op. A
          ticked system row counts — it is a condition like any other, and the
          strip is how it gets applied. */}
      {active.length > 0 || activeSystem.length > 0 || isFiltered ? (
        <div className="shrink-0 rounded-b-[11px] border-t border-border bg-background p-3">
          {/* `Frame 482691` — 204×32, two 98×32 buttons 8 apart. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              // Unreachable while the strip renders on the same predicate, and
              // kept deliberately: the disabled state is the truth about the
              // button, not about whether its container happens to be drawn.
              disabled={active.length === 0 && activeSystem.length === 0 && !isFiltered}
              onClick={clear}
              data-track={`${slug}.filter.clear.click`}
              className={`${FOOTER_ACTION} border border-primary text-primary hover:bg-surface`}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={apply}
              data-track={`${slug}.filter.apply.click`}
              className={`${FOOTER_ACTION} bg-primary text-surface hover:bg-primary-strong`}
            >
              Apply Filter
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * One collapsible rail group.
 *
 * Heading measured at 16 tall, `flex-row gap:10` — a 16px chevron then a
 * Medium 12px `#111827` label, with an optional count chip after it. The list
 * hangs 10 below the heading and is indented 10 from it (`Frame 482694` @294
 * against `Frame 2` @284).
 */
function Group({
  id,
  slug,
  label,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  slug: string;
  label: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const regionId = `filter-${slug}-${id}`;
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={onToggle}
        data-track={`${slug}.list.filter.group.toggle`}
        className="flex w-full items-center gap-2.5 rounded text-left text-xs font-medium leading-4 text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ChevronDownIcon
          // One chevron rotated, so open and closed can never drift into two
          // differently-shaped glyphs.
          className={`h-4 w-4 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
        />
        <span className="truncate" title={label}>
          {label}
        </span>
        {count === undefined ? null : <CountChip>{count}</CountChip>}
      </button>

      {open ? (
        <div id={regionId} className="mt-2.5 pl-2.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The count chip beside `Saved Filters` and beside each saved view.
 *
 * `Frame 482702` / `Frame 482703` — 16×16, `bg #f6f8fa`, `r:2`, `pad 2`, with
 * the number in 8px. Two departures: 8px is below the type scale so it renders
 * at the rail's own 10px, and the box grows with the number rather than
 * staying 16 wide — a live match count runs to four digits and the file only
 * ever drew `(0)` and `(9)`. The 0.2px hairline it carries is sub-pixel and
 * would not render, so it is left off rather than thickened to 1px.
 */
function CountChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[2px] bg-background px-0.5 text-[10px] leading-4 tabular-nums text-body">
      {children}
    </span>
  );
}

function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`text-[10px] leading-4 text-body ${className ?? ''}`}>{children}</p>;
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
 * Measured on `…_Saved filter Edit` as `Group 3` @388,236 — 98x32 with `r:4`,
 * hanging 4px below a kebab at @470,216 and flush with its right edge. Two
 * 98x16 `Drop Down` rows, the resting one `bg #ffffff` with `#6b7280` text and
 * the hovered one `bg #f6f8fa` with `#111827`. Those two fills and the two
 * text colours are used verbatim below (`surface`/`background`,
 * `body`/`heading`).
 *
 * The 16px rows and 6px text are NOT: 6px is below every step the type scale
 * defines. So this follows the Sort pop-over's measured 28px row and 10px
 * text, which is the nearest real step.
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

  const ROW_ITEM =
    'flex h-7 w-full items-center px-3 text-left text-[10px] leading-4 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary';

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${viewName}`}
      // right-0: the kebab is flush right of a 230px rail, so the menu hangs
      // from that edge or it leaves the panel. overflow-hidden gives the rows
      // the container's corners, which is how the file draws them. mt-1 is the
      // measured 4px between the kebab's box and the menu's top edge.
      className="absolute right-0 top-full z-40 mt-1 w-[98px] overflow-hidden rounded border border-border bg-surface"
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        data-track={`${slug}.view.rename.open`}
        className={`${ROW_ITEM} text-body hover:bg-background hover:text-heading`}
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
        className={`${ROW_ITEM} text-body hover:bg-background hover:text-heading`}
      >
        Delete
      </button>
    </div>
  );
}

/**
 * The saved-view list, with live match counts.
 *
 * Row anatomy measured on `Frame 482655` / `Frame 482702`: 206×20, `pad 2`,
 * `flex-row gap:8`, `r:4` and `bg #f6f8fa` on the active one, a Regular 10px
 * `#6b7280` name, a count chip, and the kebab flush right. Pitch 24, i.e. the
 * same 4px list gap every other rail group uses.
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
                  which no browser renders and no screen reader can announce.
                  h-5 + p-0.5 is the file's 20-tall row with its 2px pad. */}
              <div
                className={
                  'flex h-5 items-center gap-2 rounded p-0.5 ' +
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
                    'flex min-w-0 flex-1 items-center gap-2 text-left text-[10px] leading-4 ' +
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
                    'disabled:cursor-not-allowed disabled:opacity-60 ' +
                    (view.id === appliedViewId ? 'font-medium text-heading' : 'text-body')
                  }
                >
                  {/* No `flex-1` on the name: measured, `Frame 482705` is
                      200x16 with `gap:97` between TWO clusters — `Frame 482704`
                      (87x16 = the 63-wide name, 8, then the 16x16 chip) and the
                      kebab flush right at x=470. The free space belongs BETWEEN
                      those clusters, so the chip hugs the name; a name that
                      stretched would push the chip against the kebab instead.
                      `min-w-0` still lets a long name truncate. */}
                  <span className="min-w-0 truncate">{view.name}</span>
                  {view.isShared ? (
                    <span className="shrink-0 text-overline uppercase text-muted">Shared</span>
                  ) : null}
                  {count !== undefined ? <CountChip>{count}</CountChip> : null}
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
                      'flex shrink-0 items-center rounded text-body hover:text-heading ' +
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
        <p className="mt-1 text-[10px] leading-4 text-muted">
          Match counts are unavailable right now.
        </p>
      ) : null}
    </>
  );
}

/**
 * The answer, per module, for as long as the page lives.
 *
 * The rail is REMOUNTED every time the applied filter changes (the list keys
 * it on the fragment), so without this every Apply would re-ask the same
 * question — and while that request was in flight the rows would fall back to
 * unavailable, flickering the tick the user just applied into a disabled box.
 * A page load is the natural expiry: this is module config, and a config change
 * arrives with a navigation.
 */
const systemFilterCache = new Map<string, SystemFilterDto[]>();

/**
 * What this module can answer, asked once per mount.
 *
 * Same lifecycle as the user lookup below — a client fetch after the list has
 * painted, because the rows are a label on the rail and a label must not delay
 * the data.
 *
 * Until it answers, and if it never answers, the rail falls back to the file's
 * nine rows with every one of them UNAVAILABLE. That is the honest shape of
 * not knowing: the group holds the geometry the file draws, and nothing in it
 * can be ticked, because nothing here is entitled to decide that a filter
 * works. `available: true` only ever arrives over the wire.
 */
function useSystemFilters(slug: string): SystemFilterDto[] {
  const [rows, setRows] = useState<SystemFilterDto[] | null>(
    () => systemFilterCache.get(slug) ?? null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cached = systemFilterCache.get(slug);
    if (cached !== undefined) {
      setRows(cached);
      return;
    }
    let cancelled = false;
    api<{ filters: SystemFilterDto[] }>(`/api/modules/${slug}/system-filters`)
      .then((res) => {
        // A 200 that is not the shape we asked for is a failure, not a filter
        // list: rendering `undefined.map` would take the whole rail down.
        if (!Array.isArray(res.filters)) {
          if (!cancelled) setFailed(true);
          return;
        }
        // Cached before the cancel check, and on successes only: the answer is
        // good whether or not this mount is still around to show it, and a
        // transient failure must not be remembered for the rest of the page's
        // life.
        systemFilterCache.set(slug, res.filters);
        if (!cancelled) setRows(res.filters);
      })
      // A 404 is the read gate refusing this actor, and any other status is
      // the route being unreachable. Both mean the same thing to a reader —
      // these rows cannot be applied — so both say so on the rows themselves
      // rather than replacing them with an error the file does not draw.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return useMemo(() => {
    if (rows !== null) return rows;
    return SYSTEM_ID_ORDER.map((id) => ({
      id,
      label: SYSTEM_LABELS[id],
      available: false,
      reason: failed ? SYSTEM_UNAVAILABLE : SYSTEM_LOADING,
      options: null,
    }));
  }, [rows, failed]);
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
