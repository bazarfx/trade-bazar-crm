'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { BulkAssignResult, ColumnSpec, FilterNode, SavedViewDto, SortSpec } from '@crm/shared';
import { api } from '@/lib/client-api';
import {
  Button,
  Panel,
  PanelBody,
  type DataTableColumn,
  type DataTableSelection,
} from '@/components/ui';
import { BulkReassignOverlay } from './bulk-reassign-overlay';
import type { CellField, StatusOption } from './cell';
import { nameMap, useDirectory } from './directory';
import { FilterPanel, type FilterField, type RailView, type RelatedModule } from './filter-panel';
import { draftsFrom } from './filter-model';
import { useSpecials } from './specials';
import {
  buildListHref,
  encodeFilterHash,
  readFilterHash,
  type ListQuery,
  type ListQueryLimits,
} from './list-query';
import { ListToolbar } from './list-toolbar';
import { Pagination } from './pagination';
import { RecordTable, type TableRow } from './record-table';
import { ReviewQueueOverlay } from './review-queue-overlay';
import { SaveViewOverlay } from './save-view-overlay';

/**
 * The list body: the rail, the toolbar, the table and the pager, and the one
 * place that knows which query is currently in effect.
 *
 * WHO FETCHES WHAT, and why it is split:
 *
 *   No ad-hoc filter → the SERVER rendered the rows, from the URL alone. That
 *     is the linkable, cacheable, works-on-first-paint path, and it covers the
 *     saved views: a view id is safe in a query string, so `?view=<id>` is a
 *     fully server-rendered filtered list.
 *   An ad-hoc filter → the CLIENT owns the rows, because the tree cannot go in
 *     the URL (it is record data — see list-query.ts) and therefore cannot
 *     reach the server component. It POSTs the tree to `records/query`.
 *
 * The `f=1` flag in the query string is what keeps those two from overlapping:
 * the server sees it, renders NO rows, and this component fills them in. The
 * alternative — server renders unfiltered, client replaces a moment later —
 * would put records on screen that do not match the filter beside them, which
 * is the one thing this whole slice exists to prevent.
 */
export interface ListScreenProps {
  slug: string;
  /** module.label — SINGULAR, for naming one row ("Select lead"). */
  label: string;
  labelPlural: string;
  filterFields: FilterField[];
  relatedModules: RelatedModule[];
  views: RailView[];
  /** the saved view in effect, already resolved server-side */
  appliedView: { id: string; filters: FilterNode | null; sort: SortSpec[] | null } | null;
  columns: DataTableColumn[];
  cellFields: CellField[];
  statuses: StatusOption[];
  /** the server's rows. Empty and unused while the client owns the query. */
  rows: TableRow[];
  total: number;
  query: ListQuery;
  limits: ListQueryLimits;
  pageSizes: readonly number[];
  canShareViews: boolean;
  emptyMessage: string;
  /**
   * Where to go to give this module some columns, or null when this actor
   * cannot configure fields. A module with no fields has nothing to draw, and
   * an empty table with no way out is a dead end.
   */
  fieldBuilderHref: string | null;
  /** a view or sort key the server could not apply, said in the user's words */
  serverError: string | null;
  /**
   * Records in this module carry an owner, so they can be reassigned.
   *
   * A property of the module's STORAGE, resolved server-side — a module whose
   * table has no owner column has nothing to reassign, and offering the action
   * there would produce a button that always answers 422.
   */
  hasOwner: boolean;
  /**
   * id → name for every user the SERVER's rows mention, resolved in one query
   * on the page. Sent as pairs rather than a Map because this crosses the RSC
   * boundary, and as data rather than a second fetch so the owner column never
   * paints a UUID and then swaps it for a name.
   */
  userNames: [string, string][];
  /**
   * PENDING duplicate flags for this module (spec §6.6), counted server-side.
   * The page sends 0 when this module's storage cannot carry flags or this
   * actor may not resolve them, so 0 is also "no button".
   */
  duplicateCount: number;
}

interface AppliedFilter {
  node: FilterNode;
  /** the encoded fragment — a stable primitive to key effects and state off */
  key: string;
}

export function ListScreen({
  slug,
  label,
  labelPlural,
  filterFields,
  relatedModules,
  views,
  appliedView,
  columns,
  cellFields,
  statuses,
  rows,
  total,
  query,
  limits,
  pageSizes,
  canShareViews,
  emptyMessage,
  fieldBuilderHref,
  serverError,
  hasOwner,
  userNames,
  duplicateCount,
}: ListScreenProps) {
  const router = useRouter();

  const [filter, setFilter] = useState<AppliedFilter | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [result, setResult] = useState<{ records: TableRow[]; total: number } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusToken, setFocusToken] = useState(0);

  /** Ticked row ids. Page-scoped — see the effect that clears it. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * The review queue count, held locally so each resolved pair pulls the
   * toolbar number down immediately — the server prop only refreshes on
   * navigation, and a button still reading (3) after the third resolution
   * would claim work that no longer exists.
   */
  const [pendingDuplicates, setPendingDuplicates] = useState(duplicateCount);
  useEffect(() => {
    setPendingDuplicates(duplicateCount);
  }, [duplicateCount]);
  const [reviewing, setReviewing] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  /**
   * Bumped after a bulk move, to re-run the client's own query.
   * `router.refresh()` re-renders the server component and therefore fixes the
   * server-owned path, but the filtered path's rows come from a POST this
   * component owns and nothing else can make it ask again.
   */
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Read the applied filter out of the URL — the query flag says whether there
   * is one, the fragment says what it is.
   *
   * Reads `window.location` rather than props on purpose: it runs from history
   * events, where the URL has already changed and the React props have not.
   */
  const syncFromUrl = useCallback(() => {
    if (new URLSearchParams(window.location.search).get('f') !== '1') {
      setFilter(null);
      setFilterError(null);
      return;
    }
    try {
      const node = readFilterHash(window.location.hash);
      if (node === null) {
        // The link says it is filtered and carries no filter — usually a URL
        // copied without its fragment. Showing the unfiltered list would show
        // MORE records than the filter it claims to have, so it shows none and
        // says why.
        setFilter(null);
        setFilterError(
          'This link says it is filtered but carries no filter. Clear the filter to see the full list.',
        );
        return;
      }
      setFilter({ node, key: encodeFilterHash(node) });
      setFilterError(null);
    } catch (err) {
      setFilter(null);
      setFilterError(err instanceof Error ? err.message : 'The filter could not be read.');
    }
  }, []);

  // Mount covers a pasted link; the two events cover the back button. A
  // pushState from our own handlers fires neither, which is why every handler
  // below sets the state itself rather than waiting to be told.
  useEffect(() => {
    syncFromUrl();
    window.addEventListener('hashchange', syncFromUrl);
    window.addEventListener('popstate', syncFromUrl);
    return () => {
      window.removeEventListener('hashchange', syncFromUrl);
      window.removeEventListener('popstate', syncFromUrl);
    };
  }, [syncFromUrl]);

  const sortParam = query.sort === null ? null : `${query.sort.fieldKey}:${query.sort.direction}`;

  useEffect(() => {
    if (filter === null) {
      setResult(null);
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    setFetchError(null);

    // POST, not GET: the tree is nested and its values are record data. The
    // route file says the rest.
    api<{ records: TableRow[]; total: number }>(`/api/modules/${slug}/records/query`, {
      method: 'POST',
      body: JSON.stringify({
        filters: filter.node,
        ...(query.sort === null ? {} : { sort: [query.sort] }),
        ...(query.search === null ? {} : { search: query.search }),
        page: query.page,
        pageSize: query.size,
      }),
    })
      .then((res) => {
        if (cancelled) return;
        setResult({ records: res.records, total: res.total });
        setFetching(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // An unknown field key, a type mismatch or an operator a field does not
        // support all arrive here as a 400 naming the problem. It is shown, not
        // swallowed: the compiler throws precisely so a bad condition cannot be
        // dropped, and catching it into an unfiltered list would undo that.
        setFetchError(err instanceof Error ? err.message : 'This filter could not be applied.');
        setResult(null);
        setFetching(false);
      });

    return () => {
      cancelled = true;
    };
    // sortParam stands in for query.sort: an object identity would refetch on
    // every render, and these five primitives are the whole query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, slug, sortParam, query.search, query.page, query.size, reloadToken]);

  /** True while the URL says a filter is in effect, whoever has the rows. */
  const clientOwned = query.filtered || filter !== null || filterError !== null;
  const busy = clientOwned && filterError === null && (fetching || result === null);

  const visibleRows = clientOwned ? (result?.records ?? []) : rows;
  const visibleTotal = clientOwned ? (result?.total ?? 0) : total;

  // ── who may reassign, and to whom ───────────────────────────────────────

  // UX only. Both permissions are asserted again in the record service, and
  // the scope filter runs in the repository whatever this set says.
  const specials = useSpecials();
  const canBulkReassign =
    hasOwner && specials.has('REASSIGN_LEADS') && specials.has('BULK_OPERATIONS');

  const serverNames = useMemo(() => new Map(userNames), [userNames]);
  const hasUserColumn = useMemo(
    // Asked of the TYPE, so every user column resolves — not just the owner.
    () => cellFields.some((f) => f.type === 'USER_LOOKUP'),
    [cellFields],
  );
  /**
   * The directory is fetched only while the CLIENT owns the rows. On the
   * server-rendered path every id on screen already has a name from the page,
   * and a fetch would buy nothing; on the filtered path the rows came from a
   * POST the server never rendered, so their ids are not in that map.
   */
  const directory = useDirectory(hasUserColumn && clientOwned);
  const names = useMemo(() => {
    if (directory.users.length === 0) return serverNames;
    const merged = new Map(serverNames);
    for (const [id, name] of nameMap(directory.users)) merged.set(id, name);
    return merged;
  }, [serverNames, directory.users]);

  /**
   * The selection is scoped to what is on screen, and dropped whenever that
   * changes. Carrying ticks across a page turn would let "12 selected" mean
   * eleven rows nobody can see plus one they can — a bulk action nobody could
   * review before running it.
   */
  const querySignature = [
    query.view ?? '',
    query.page,
    query.size,
    query.search ?? '',
    sortParam ?? '',
    filter?.key ?? '',
  ].join('|');
  useEffect(() => {
    setSelected(new Set());
  }, [querySignature]);

  const toggleRow = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  function toggleAllRows(checked: boolean) {
    setSelected(checked ? new Set(visibleRows.map((row) => row.id)) : new Set());
  }

  const selection: DataTableSelection | null = canBulkReassign
    ? {
        selected,
        onToggle: toggleRow,
        onToggleAll: toggleAllRows,
        // Composed from ModuleDefinition, so a screen reader says "Select
        // invoice" the day an Admin adds that module.
        label: `Select this ${label.toLowerCase()}`,
      }
    : null;

  const selectedIds = useMemo(() => [...selected], [selected]);

  function onReassigned(res: BulkAssignResult) {
    setSelected(new Set());
    setBulkNotice(
      res.skipped === 0
        ? `${res.updated} ${res.updated === 1 ? 'record' : 'records'} reassigned.`
        : `${res.updated} reassigned, ${res.skipped} left unchanged — outside your view scope, ` +
            'already owned by that user, or no longer in this module.',
    );
    // Both paths, because only one of them owns the rows and this component
    // does not branch on which.
    router.refresh();
    setReloadToken((n) => n + 1);
  }

  /**
   * What the rail shows. An ad-hoc filter wins over the applied view's, which
   * is what makes editing a view's conditions feel like editing them: the rail
   * opens pre-loaded from the view, and Apply supersedes it without touching
   * the stored view.
   */
  const railTree = filter?.node ?? (clientOwned ? null : (appliedView?.filters ?? null));
  const rail = useMemo(() => draftsFrom(railTree), [railTree]);

  /**
   * What the rail cannot faithfully re-emit.
   *
   * Both cases below mean the same thing: pressing Apply would produce a
   * DIFFERENT, broader filter than the one currently in effect — an AND with
   * conditions missing matches more rows, not fewer. Neither is allowed to
   * happen quietly, so the rail says it before the user presses anything.
   */
  const railWarnings = useMemo(() => {
    const out: string[] = [];
    if (!rail.exact) {
      out.push(
        'This filter nests conditions the rail cannot draw. They are listed below as one row ' +
          'each — applying replaces the original with an AND of these rows, which matches more.',
      );
    }
    const known = new Set(filterFields.map((f) => f.key));
    const missing = rail.drafts.filter((d) => !known.has(d.fieldKey)).length;
    if (missing > 0) {
      out.push(
        `${missing} condition${missing === 1 ? '' : 's'} filter on a field that is not in this ` +
          'list — deleted, or hidden from your role. Applying from the rail leaves it out, ' +
          'which widens the result; clear the filter instead if that is not what you want.',
      );
    }
    return out;
  }, [rail, filterFields]);

  /**
   * The sort actually in effect: the URL's override, else the applied view's
   * first key. A view may store up to MAX_SORT_KEYS and the server honours all
   * of them — the toolbar only ever edits the first, which is the one the
   * design's two-row menu can express.
   */
  const activeSort: SortSpec | null = query.sort ?? appliedView?.sort?.[0] ?? null;
  // The menu needs something to act on before anything is sorted; the first
  // column is the title column, which is what a user means by "sort this list".
  const sortKey = activeSort?.fieldKey ?? columns[0]?.key ?? null;
  const sortLabel = columns.find((c) => c.key === sortKey)?.label ?? sortKey;

  const href = useCallback(
    (patch: Partial<ListQuery>) => buildListHref(slug, query, patch, limits),
    [slug, query, limits],
  );

  /**
   * The fragment to carry across a navigation that keeps the filter.
   *
   * Taken from STATE rather than `window.location.hash` on purpose: this is
   * read while rendering hrefs, and the server has no `window`. Reading the
   * real location would make the server render `?page=2` and the first client
   * render `?page=2#f=…`, which is a hydration mismatch on every pager link.
   * State is null on both sides of that first render and fills in from the URL
   * a tick later, which is a normal update rather than a mismatch.
   */
  const hash = filter?.key ?? '';

  /** A navigation that KEEPS the ad-hoc filter — page, sort, size. */
  const go = useCallback(
    (patch: Partial<ListQuery>) => {
      router.push(`${href(patch)}${hash}`, { scroll: false });
    },
    [router, href, hash],
  );

  function applyFilter(tree: FilterNode | null) {
    if (tree === null) {
      clearFilter();
      return;
    }
    const next = encodeFilterHash(tree);
    // Set first, navigate second: a hash-only pushState fires no event, so the
    // handler is the only thing that can tell this component what it just did.
    setFilter({ node: tree, key: next });
    setFilterError(null);
    router.push(`${href({ filtered: true, page: 1 })}${next}`, { scroll: false });
  }

  function clearFilter() {
    setFilter(null);
    setFilterError(null);
    // No fragment appended: dropping it IS the clear.
    router.push(href({ filtered: false, page: 1 }), { scroll: false });
  }

  function applyView(viewId: string) {
    setFilter(null);
    setFilterError(null);
    // The view brings its own sort, so a leftover column sort is dropped —
    // keeping it would silently ignore half of what the view stores.
    router.push(
      href({ view: viewId, filtered: false, sort: null, page: 1 }),
      { scroll: false },
    );
  }

  function sortBy(fieldKey: string) {
    // Same column again flips the direction; a new column starts ascending.
    const direction: SortSpec['direction'] =
      activeSort?.fieldKey === fieldKey && activeSort.direction === 'asc' ? 'desc' : 'asc';
    go({ sort: { fieldKey, direction }, page: 1 });
  }

  function onSaved(view: SavedViewDto) {
    setSaving(false);
    setFilter(null);
    setFilterError(null);
    router.push(href({ view: view.id, filtered: false, sort: null, page: 1 }), { scroll: false });
    // The rail and the picker are server-rendered from `SavedView`; without
    // this the new view is applied but absent from both lists.
    router.refresh();
  }

  /** The column set as a view stores it, for Save Filter. */
  const columnSpecs: ColumnSpec[] = columns.map((column, order) => ({
    fieldKey: column.key,
    order,
    ...(column.width === undefined ? {} : { width: column.width }),
    ...(column.pinned === undefined ? {} : { pinned: column.pinned }),
  }));

  const problem = serverError ?? filterError ?? fetchError;

  return (
    <>
      {/* Both panels are the same fixed height in the design (856 at 1024) and
          each scrolls its own content — the page itself never grows. Expressed
          against the viewport rather than as 856px so it holds on a taller
          screen; the filter rail has 33 fields on Leads today and would
          otherwise push the page past the fold. */}
      <div className="flex h-[calc(100vh-11.5rem)] items-stretch gap-6">
        <FilterPanel
          slug={slug}
          labelPlural={labelPlural}
          fields={filterFields}
          relatedModules={relatedModules}
          views={views}
          appliedViewId={appliedView?.id ?? null}
          initialDrafts={rail.drafts}
          warnings={railWarnings}
          isFiltered={clientOwned || (appliedView?.filters ?? null) !== null}
          onApply={applyFilter}
          onClear={clearFilter}
          onSaveOpen={() => setSaving(true)}
          onApplyView={applyView}
          focusToken={focusToken}
          // Remount when the APPLIED filter changes underneath the rail — a
          // view being chosen, a link being opened, the back button. The rail
          // holds a draft, and a draft has to be re-seeded, not merged.
          key={filter?.key ?? appliedView?.id ?? 'none'}
        />

        {/* min-w-0: without it this flex child refuses to shrink below the
            table's intrinsic width and the whole page scrolls sideways
            instead of the table doing it. */}
        <Panel className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ListToolbar
            slug={slug}
            labelPlural={labelPlural}
            views={views}
            appliedViewId={appliedView?.id ?? null}
            onSelectView={applyView}
            sortLabel={sortLabel}
            sortDirection={activeSort?.direction ?? 'asc'}
            onSort={(direction) => {
              if (sortKey === null) return;
              go({ sort: { fieldKey: sortKey, direction }, page: 1 });
            }}
            filterCount={rail.drafts.length}
            onFocusFilters={() => setFocusToken((n) => n + 1)}
            pageSize={query.size}
            pageSizes={pageSizes}
            onChangePageSize={(size) => go({ size, page: 1 })}
            duplicateCount={pendingDuplicates}
            onOpenReview={() => setReviewing(true)}
          />

          {problem !== null ? (
            <p role="alert" className="border-b border-border bg-error/10 px-3 py-2 text-xs text-error">
              {problem}
            </p>
          ) : null}

          {/* The bulk bar. Present only while something is ticked — a
              permanent empty bar would take a row's worth of height off every
              list for an action nobody is performing. */}
          {selection !== null && selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-3 py-2">
              <span className="text-xs font-medium text-heading">
                {selected.size} selected on this page
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setReassigning(true)}
                  data-track={`${slug}.list.bulk.reassign.open`}
                >
                  Reassign
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                  data-track={`${slug}.list.bulk.clear.click`}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : null}

          {bulkNotice !== null ? (
            <div
              role="status"
              className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs text-heading"
            >
              <span>{bulkNotice}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBulkNotice(null)}
                data-track={`${slug}.list.bulk.notice.dismiss`}
              >
                Dismiss
              </Button>
            </div>
          ) : null}

          {columns.length === 0 ? (
            <PanelBody>
              <p className="text-sm text-body">
                {labelPlural} has no fields yet, so this list has no columns to show.
              </p>
              {fieldBuilderHref !== null ? (
                <Link
                  href={fieldBuilderHref}
                  data-track={`${slug}.list.fields.open`}
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                >
                  Add fields in the field builder →
                </Link>
              ) : null}
            </PanelBody>
          ) : (
            <>
          <RecordTable
            slug={slug}
            columns={columns}
            fields={cellFields}
            statuses={statuses}
            rows={visibleRows}
            loading={busy}
            {...(activeSort === null
              ? {}
              : { sort: { key: activeSort.fieldKey, direction: activeSort.direction } })}
            onSortColumn={sortBy}
            userNames={names}
            {...(selection === null ? {} : { selection })}
            emptyMessage={
              problem !== null
                ? // Nothing is shown while a filter cannot be applied, and
                  // "no records match" would be a claim about the data rather
                  // than about the filter that failed.
                  'Nothing is shown while this filter cannot be applied.'
                : clientOwned || query.search !== null || appliedView?.filters
                  ? 'No records match this filter.'
                  : emptyMessage
            }
          />

          <Pagination
            slug={slug}
            page={query.page}
            pageCount={Math.ceil(visibleTotal / query.size)}
            hrefFor={(page) => `${href({ page })}${hash}`}
          />
            </>
          )}
        </Panel>
      </div>

      {reassigning && selectedIds.length > 0 ? (
        <BulkReassignOverlay
          slug={slug}
          labelPlural={labelPlural}
          recordIds={selectedIds}
          onDone={onReassigned}
          onClose={() => setReassigning(false)}
        />
      ) : null}

      {reviewing ? (
        <ReviewQueueOverlay
          slug={slug}
          label={label}
          labelPlural={labelPlural}
          statuses={statuses}
          onResolved={() => setPendingDuplicates((n) => Math.max(0, n - 1))}
          onClose={() => {
            setReviewing(false);
            // A resolution may have changed what the list shows — a merged
            // pair's keeper was often just edited in another tab — and the
            // server-owned path re-reads only on refresh.
            router.refresh();
          }}
        />
      ) : null}

      {saving ? (
        <SaveViewOverlay
          slug={slug}
          labelPlural={labelPlural}
          filters={filter?.node ?? appliedView?.filters ?? null}
          columns={columnSpecs}
          sort={activeSort === null ? null : [activeSort]}
          canShare={canShareViews}
          onSaved={onSaved}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </>
  );
}
