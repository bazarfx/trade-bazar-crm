import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import { operatorsFor, type FieldType } from '@crm/shared';
import { getPrincipal } from '@/lib/auth/session';
import { listRecords } from '@/lib/records/list';
import { Panel, PanelBody, type DataTableColumn } from '@/components/ui';
import { FilterPanel } from './_components/filter-panel';
import { ListActions } from './_components/list-actions';
import { ListToolbar } from './_components/list-toolbar';
import { Pagination } from './_components/pagination';
import { RecordTable } from './_components/record-table';
import { SearchBox } from './_components/search-box';

/**
 * THE module list screen. One page serves /leads, /deals and every module an
 * Admin invents later — there is deliberately no per-module page, component or
 * column list anywhere in this app.
 *
 * Everything on screen is read from config at request time: the title from
 * `ModuleDefinition`, the columns from `FieldDefinition`, the chips from
 * `Status`, the views from `SavedView`, the rows from whichever table the
 * storage resolver decides this module lives in. The designed Leads screen is
 * simply what this renders when the Leads module's config drives it.
 */

/**
 * Columns the list opens with. The saved-views slice replaces this with the
 * view's own column set; until then it is the first N fields in the order the
 * Admin arranged them in the field builder.
 */
const MAX_COLUMNS = 12;

const PAGE_SIZES = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Column width by field TYPE — never by field name. An Admin-created field has
 * to get a sensible width the moment it exists, with nobody having measured it.
 * The values are the ones the reference frame uses for the same shapes: 200 for
 * a name, 260 for an email, 160 for a phone, 120–144 for a picklist.
 *
 * Keyed on the whole `FieldType` union on purpose: adding a field type without
 * deciding its width becomes a compile error rather than a 160px surprise.
 */
const COLUMN_WIDTH: Record<FieldType, number> = {
  SINGLE_LINE: 200,
  MULTI_LINE: 240,
  EMAIL: 260,
  PHONE: 160,
  NUMBER: 120,
  DECIMAL: 120,
  CURRENCY: 140,
  PERCENT: 120,
  DROPDOWN: 144,
  MULTI_SELECT: 180,
  LANGUAGE_PICKER: 160,
  DATE: 140,
  DATE_TIME: 180,
  CHECKBOX: 100,
  TOGGLE: 100,
  URL: 200,
  FILE: 180,
  IMAGE: 180,
  USER_LOOKUP: 180,
  RECORD_LINK: 180,
  FORMULA: 160,
  AUTONUMBER: 140,
};

/** A positive integer from the query string, or null. Hand-edited URLs happen. */
function positiveInt(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default async function ModulePage({
  params,
  searchParams,
}: {
  params: Promise<{ moduleSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ moduleSlug }, query] = await Promise.all([params, searchParams]);

  // The shell layout redirects too, but a page that reads permissions cannot
  // depend on a layout having run — layouts and pages render independently.
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    select: { id: true, slug: true, label: true, labelPlural: true, isCore: true },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);

  const [fieldRows, statusRows, viewRows, relatedModules] = await Promise.all([
    // Soft-deleted config stays in the table forever (invariant 4) and must
    // never come back as a column.
    prisma.fieldDefinition.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: { key: true, label: true, type: true, systemColumn: true },
    }),
    prisma.status.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, name: true, tag: true, color: true },
    }),
    prisma.savedView.findMany({
      // ownerId null is a system view; isShared is one someone published.
      where: {
        moduleId: mod.id,
        OR: [{ ownerId: null }, { isShared: true }, { ownerId: principal.user.id }],
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    // "Related modules" is not a hardcoded list: it is whichever enabled
    // modules hold a relation field pointing at this one.
    prisma.moduleDefinition.findMany({
      where: { isEnabled: true, fields: { some: { relatedModuleId: mod.id, isDeleted: false } } },
      orderBy: { navOrder: 'asc' },
      select: { slug: true, labelPlural: true },
    }),
  ]);

  // Hidden fields are dropped HERE, before anything is queried or serialised —
  // a field hidden by the permission matrix never leaves the server, because
  // hiding it in the UI is not a security control.
  const hidden = engine.hiddenFields(mod.slug);
  const fields = fieldRows.filter((f) => !hidden.has(f.key));

  // Only a size the page-size control actually offers is honoured. `?size=5000`
  // in a hand-edited URL is a query that reads the whole module into memory.
  const requestedSize = positiveInt(query['size']);
  const pageSize =
    requestedSize !== null && (PAGE_SIZES as readonly number[]).includes(requestedSize)
      ? requestedSize
      : DEFAULT_PAGE_SIZE;
  const page = positiveInt(query['page']) ?? 1;

  const columnFields = fields.slice(0, MAX_COLUMNS);

  // Only the columns are read. A module with 40 fields would otherwise select
  // 40 columns and ship 40 values per row to draw 12 of them.
  const { rows, total } = await listRecords({
    module: { slug: mod.slug, isCore: mod.isCore },
    fields: columnFields.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
    engine,
    take: pageSize,
    skip: (page - 1) * pageSize,
  });

  const columns: DataTableColumn[] = columnFields.map((f, i) => ({
    key: f.key,
    label: f.label,
    width: COLUMN_WIDTH[f.type],
    // The first column is pinned so the row stays identifiable while the
    // overflow columns scroll out from under it.
    ...(i === 0 ? { pinned: 'left' as const } : {}),
  }));

  const canConfigureFields =
    principal.actor.isAdmin || principal.permissions.specials.has('MANAGE_FIELDS_LAYOUTS');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-medium text-heading">{mod.labelPlural}</h1>
        <ListActions
          slug={mod.slug}
          label={mod.label}
          canCreate={engine.can('create', mod.slug)}
          canImportExport={engine.hasSpecial('IMPORT_EXPORT')}
        />
      </div>

      <SearchBox slug={mod.slug} />

      {/* Both panels are the same fixed height in the design (856 at 1024) and
          each scrolls its own content — the page itself never grows. Expressed
          against the viewport rather than as 856px so it holds on a taller
          screen; the filter rail has 33 fields on Leads today and would
          otherwise push the page past the fold. */}
      <div className="flex h-[calc(100vh-11.5rem)] items-stretch gap-6">
        <FilterPanel
          slug={mod.slug}
          labelPlural={mod.labelPlural}
          // A field is filterable when its TYPE declares operators — the field
          // type registry decides, so a future type with none drops out here
          // without this screen being touched.
          fields={fields
            .filter((f) => operatorsFor(f.type).length > 0)
            .map((f) => ({ key: f.key, label: f.label }))}
          relatedModules={relatedModules}
        />

        {/* min-w-0: without it this flex child refuses to shrink below the
            table's intrinsic width and the whole page scrolls sideways
            instead of the table doing it. */}
        <Panel className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ListToolbar
            slug={mod.slug}
            labelPlural={mod.labelPlural}
            views={viewRows}
            pageSize={pageSize}
            pageSizes={PAGE_SIZES}
          />

          {columns.length === 0 ? (
            <PanelBody>
              <p className="text-sm text-body">
                {mod.labelPlural} has no fields yet, so this list has no columns to show.
              </p>
              {canConfigureFields ? (
                <Link
                  href={`/settings/modules/${mod.slug}/fields`}
                  data-track={`${mod.slug}.list.fields.open`}
                  className="mt-2 inline-block text-sm text-primary hover:underline"
                >
                  Add fields in the field builder →
                </Link>
              ) : null}
            </PanelBody>
          ) : (
            <RecordTable
              slug={mod.slug}
              label={mod.label}
              columns={columns}
              // Only the columns' own fields cross to the client: the other 20
              // a module may have would be payload nothing on screen reads.
              fields={columnFields.map((f) => ({
                key: f.key,
                type: f.type,
                systemColumn: f.systemColumn,
              }))}
              statuses={statusRows}
              rows={rows}
              emptyMessage={`Nothing here yet — ${mod.labelPlural} you create or import appear in this list.`}
            />
          )}

          <Pagination
            slug={mod.slug}
            page={page}
            pageCount={Math.ceil(total / pageSize)}
            pageSize={pageSize}
          />
        </Panel>
      </div>
    </div>
  );
}
