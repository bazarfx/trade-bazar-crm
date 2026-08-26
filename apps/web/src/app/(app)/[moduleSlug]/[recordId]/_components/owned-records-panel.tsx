'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FieldType, FilterCondition } from '@crm/shared';
import { Button, cn, DataTable, Panel, PanelBody, PanelHeader, type DataTableColumn } from '@/components/ui';
import { DEMO_AVATAR_ROW_KEY, demoAvatarFor } from '@/components/demo-avatar';
import { api } from '@/lib/client-api';
import {
  renderFieldCell,
  type StatusOption,
} from '@/app/(app)/[moduleSlug]/_components/cell';
import { nameMap, useDirectory } from '@/app/(app)/[moduleSlug]/_components/directory';
import type { DetailField } from './value';

/**
 * The records this person actually owns — the second half of "the leads
 * assigned … everything must be visible at once".
 *
 * The tiles above answer HOW MANY. This answers WHICH, without leaving the
 * page: one segmented control per module the person owns records in, and the
 * ordinary record table underneath it.
 *
 * NOTHING HERE NAMES A MODULE. The tabs are whatever the storage shapes say
 * carries an owner, the columns are `FieldDefinition` rows, the chip comes
 * from `Status.tag`, and the row click builds its href from the slug it was
 * handed. A module an Admin creates tomorrow with an owner column arrives as
 * another tab with no code change.
 *
 * WHY THE FILTER-TREE ENDPOINT and not `GET …/records?owner=…`: there is no
 * such query parameter and there must not be, because "records owned by X" is
 * an ordinary filter condition and the filter compiler is the one place that
 * turns a condition into Prisma parameters. Posting the tree also keeps the
 * person's id out of the URL, the access log and the Referer header — the
 * same privacy rule the list screen's POST exists for.
 *
 * SCOPE IS NOT THIS FILE'S JOB and cannot be. The repository ANDs the reader's
 * scope filter under whatever tree arrives here, so a rep who may only see
 * their own leads gets an empty table on a colleague's page rather than a
 * window into a pipeline they cannot read.
 */

/** Rows per page. The panel is a summary on someone else's page, not the list
 *  screen — 10 keeps the table shorter than the tiles above it. */
const PAGE_SIZE = 10;

/**
 * Width of the pinned title column. The other columns take `DataTable`'s own
 * default, which is deliberate: this table draws at most six columns inside a
 * full-width panel, so there is no overflow to budget for and no reason to
 * carry a second copy of the list screen's type→width table — a copy that
 * would drift the first time one of them was tuned.
 */
const TITLE_COLUMN_WIDTH = 220;

/** A record as it comes back from the query route: field keys, opaque values. */
interface OwnedRow extends Record<string, unknown> {
  id: string;
}

interface QueryResponse {
  records: OwnedRow[];
  total: number;
}

/**
 * One module this person can own records in, resolved on the SERVER.
 *
 * `ownerFieldKey` is the reason this is a prop rather than something the panel
 * fetches: it is the field whose `systemColumn` is the storage shape's
 * `ownerColumn`, and `systemColumn` is server-side config that no API route
 * exposes. Guessing it — "the USER_LOOKUP field", say — would pick a deal's
 * Closed By as often as its Owner.
 */
export interface OwnedModuleTable {
  slug: string;
  label: string;
  labelPlural: string;
  /** what this reader can see; decides which tab opens first */
  total: number;
  ownerFieldKey: string;
  /** carried so the posted condition states the type the server will re-check */
  ownerFieldType: FieldType;
  /** the field that IS the record's title, or null when it is hidden here */
  titleFieldKey: string | null;
  /** first few visible fields by displayOrder, title first */
  columns: DetailField[];
  statuses: StatusOption[];
}

export interface OwnedRecordsPanelProps {
  /** the PERSON module's slug — only ever used to build `data-track` names */
  slug: string;
  /** the person's record id: the value every owner condition below matches */
  personId: string;
  modules: OwnedModuleTable[];
  className?: string;
}

export function OwnedRecordsPanel({ slug, personId, modules, className }: OwnedRecordsPanelProps) {
  const router = useRouter();

  /**
   * Open on the module carrying the most of this person's work — that is the
   * one the question was about. Ties break on the order the page sent, which
   * is the Admin's own nav order.
   */
  const busiest = useMemo(() => {
    let best: OwnedModuleTable | undefined;
    for (const m of modules) if (!best || m.total > best.total) best = m;
    return best?.slug ?? null;
  }, [modules]);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(busiest);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<OwnedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A different person (or a re-count) means a different busiest module and a
  // page-1 reset. Without this, navigating between two people would keep the
  // previous tab and page number over the new person's records.
  useEffect(() => {
    setSelectedSlug(busiest);
    setPage(1);
  }, [busiest, personId]);

  const selected = modules.find((m) => m.slug === selectedSlug) ?? null;

  useEffect(() => {
    if (!selected) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    // "Owned by this person" as an ordinary filter condition. The field type
    // travels with it because the schema asks for it; the server re-checks it
    // against the live FieldDefinition and refuses a mismatch, so this is a
    // hint, never a claim it will act on.
    const condition: FilterCondition = {
      fieldKey: selected.ownerFieldKey,
      fieldType: selected.ownerFieldType,
      operator: 'eq',
      value: personId,
    };

    let cancelled = false;
    setLoading(true);
    setError(null);
    api<QueryResponse>(`/api/modules/${selected.slug}/records/query`, {
      method: 'POST',
      body: JSON.stringify({ filters: condition, page, pageSize: PAGE_SIZE }),
    })
      .then((res) => {
        if (cancelled) return;
        setRows(res.records);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : 'These records could not be loaded.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, personId, page]);

  const columns: DataTableColumn[] = useMemo(() => {
    if (!selected) return [];
    return selected.columns.map((field) => ({
      key: field.key,
      label: field.label,
      // The title column is pinned so the row stays identifiable while any
      // overflow columns scroll out from under it — the same rule the list
      // screen follows, keyed on `recordTitleField` rather than on position.
      ...(field.key === selected.titleFieldKey
        ? { pinned: 'left' as const, width: TITLE_COLUMN_WIDTH, avatarKey: DEMO_AVATAR_ROW_KEY }
        : {}),
      // Neither control is wired on this panel: sorting and filtering belong
      // to the module's own list screen, and a header that looks clickable and
      // is not is worse than one that does not.
      sortable: false,
      filterable: false,
    }));
  }, [selected]);

  // Maps, not `.find()` per cell — see `RecordTable`, which does the same for
  // the same reason.
  const fieldByKey = useMemo(
    () => new Map((selected?.columns ?? []).map((f) => [f.key, f])),
    [selected],
  );
  const statusById = useMemo(
    () => new Map((selected?.statuses ?? []).map((s) => [s.id, s])),
    [selected],
  );

  /**
   * Names for the USER_LOOKUP columns — a deal's Closed By, and every such
   * column an Admin adds.
   *
   * These rows come from a POST the server never rendered, so unlike the
   * panels beside this one there is no page-built name map that could already
   * contain their ids; the list screen fetches the directory on exactly that
   * `clientOwned` path for exactly this reason. Without it the cell renderer
   * falls back to printing the raw id, which is a column nobody can act on.
   *
   * Asked of the field TYPE, never of a column name, and gated so a module
   * with no user column never pays for the request. A role that may not
   * enumerate users gets an empty map and the id fallback, which is the
   * honest answer rather than a gap.
   */
  const hasUserColumn = useMemo(
    () => (selected?.columns ?? []).some((f) => f.type === 'USER_LOOKUP'),
    [selected],
  );
  const directory = useDirectory(hasUserColumn);
  const userNames = useMemo(() => nameMap(directory.users), [directory.users]);

  /** The 24x24 Display Picture beside the title. Demo imagery derived from the
   *  record id and never stored — see components/demo-avatar.ts. */
  const rowsWithAvatars = useMemo(
    () => rows.map((row) => ({ ...row, [DEMO_AVATAR_ROW_KEY]: demoAvatarFor(row.id) })),
    [rows],
  );

  // Nothing in this workspace records an owner this reader can see. Drawing an
  // empty table with no tabs would say the person owns nothing, which is a
  // different and possibly untrue statement.
  if (modules.length === 0) return null;

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const firstOnPage = total === 0 ? 0 : (current - 1) * PAGE_SIZE + 1;
  const lastOnPage = Math.min(current * PAGE_SIZE, total);

  return (
    <Panel className={cn('shrink-0', className)}>
      <PanelHeader
        // With one module there is no control to name it, so the title does.
        title={
          modules.length === 1 && selected ? `${selected.labelPlural} assigned` : 'Assigned records'
        }
        actions={
          modules.length > 1 ? (
            // A segmented control, not a dropdown: the whole point of this
            // page is that everything is visible at once, and the counts are
            // part of the answer rather than something behind a menu.
            //
            // Toggle buttons rather than `role="tablist"`: real tabs owe a
            // reader `aria-controls` and a `role="tabpanel"`, and claiming the
            // pattern without wiring it is worse for a screen reader than the
            // pressed-button pattern this actually is.
            <div role="group" aria-label="Module" className="flex flex-wrap gap-1">
              {modules.map((module) => {
                const active = module.slug === selectedSlug;
                return (
                  <button
                    key={module.slug}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setSelectedSlug(module.slug);
                      setPage(1);
                    }}
                    data-track={`${slug}.person.workload.module.select`}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ' +
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
                        'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                      active
                        ? 'bg-primary text-surface'
                        : 'bg-subtle text-heading hover:bg-background',
                    )}
                  >
                    <span className="truncate" title={module.labelPlural}>
                      {module.labelPlural}
                    </span>
                    <span className="tabular-nums opacity-70">{module.total}</span>
                  </button>
                );
              })}
            </div>
          ) : null
        }
      />

      {error !== null ? (
        <PanelBody>
          <p role="alert" className="rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
            {error}
          </p>
        </PanelBody>
      ) : selected === null ? null : (
        <>
          <DataTable<OwnedRow>
            columns={columns}
            rows={rowsWithAvatars}
            rowKey={(row) => row.id}
            renderCell={(column, row) =>
              renderFieldCell({
                field: fieldByKey.get(column.key),
                value: row[column.key],
                statusById,
                userNames,
              })
            }
            // A real navigation to the record's own URL, so it can be opened in
            // a new tab and returned to with Back. The slug is the only thing
            // this component knows about the module it is drawing.
            onRowClick={(row) => router.push(`/${selected.slug}/${row.id}`)}
            trackPrefix={`${slug}.person.owned`}
            emptyMessage={`No ${selected.labelPlural.toLowerCase()} assigned to this person.`}
            loading={loading}
          />

          {/* Prev/next rather than the list screen's `Pagination`: that one is
              a server component built from `<Link>`s, because a list's page
              number belongs in the URL. This table's page does not — it is one
              panel of somebody else's record page, and putting its offset in
              the address bar would make the Back button walk through table
              pages instead of leaving the person. */}
          <nav
            aria-label="Assigned records pagination"
            className="flex items-center justify-between gap-3 border-t border-border px-6 py-3"
          >
            <p className="text-xs text-body">
              {total === 0
                ? 'Nothing to show'
                : `${firstOnPage}–${lastOnPage} of ${total} ${total === 1 ? selected.label.toLowerCase() : selected.labelPlural.toLowerCase()}`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={current <= 1 || loading}
                onClick={() => setPage((n) => Math.max(1, n - 1))}
                data-track={`${slug}.person.owned.page.prev`}
              >
                Previous
              </Button>
              <span className="text-xs tabular-nums text-muted">
                {current} / {pageCount}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={current >= pageCount || loading}
                onClick={() => setPage((n) => n + 1)}
                data-track={`${slug}.person.owned.page.next`}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </Panel>
  );
}
