import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { referenceOptionsFor } from '@/lib/records/reference-options';
import { PermissionEngine } from '@crm/core';
import { operatorsFor, type FieldType, type SavedViewDto, type SortSpec } from '@crm/shared';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { ConfigError } from '@/lib/config/service';
import { listViews } from '@/lib/config/views';
import { listRecords, storageFor } from '@/lib/records/list';
import type { DataTableColumn } from '@/components/ui';
import { DEMO_AVATAR_ROW_KEY } from '@/components/demo-avatar';
import { PageTitle } from '@/components/shell/page-title';
import { ListActions } from './_components/list-actions';
import { FilterToggle } from './_components/filter-toggle';
import { ListScreen } from './_components/list-screen';
import { NO_VIEW, parseListQuery, type ListQueryLimits } from './_components/list-query';
import { SearchBox } from './_components/search-box';
import type { FilterField } from './_components/filter-panel';
import type { PickerOption } from './_components/filter-condition-row';

/**
 * THE module list screen. One page serves /leads, /deals and every module an
 * Admin invents later — there is deliberately no per-module page, component or
 * column list anywhere in this app.
 *
 * Everything on screen is read from config at request time: the title from
 * `ModuleDefinition`, the columns from `FieldDefinition` or the applied
 * `SavedView`, the chips from `Status`, the filter rows from the field types'
 * operator registry, the rows from whichever table the storage resolver
 * decides this module lives in. The designed Leads screen is simply what this
 * renders when the Leads module's config drives it.
 */

/**
 * Columns the list opens with when no saved view supplies its own — the first
 * N fields in the order the Admin arranged them in the field builder.
 */
const MAX_COLUMNS = 12;

const PAGE_SIZES = [25, 50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;
const LIMITS: ListQueryLimits = { sizes: PAGE_SIZES, defaultSize: DEFAULT_PAGE_SIZE };

/** The physical column a status field points at — the same name on the core
 *  tables and on the generic records table. Keyed on the COLUMN rather than a
 *  field key, a label or a module slug, exactly as `cell.tsx` keys the chip. */
const STATUS_COLUMN = 'statusId';

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

/** A live field of this module, as this page needs it. */
interface PageField {
  key: string;
  label: string;
  type: FieldType;
  systemColumn: string | null;
  options: { value: string; label: string }[];
}

/**
 * Which saved view is in effect, and what to say when the named one cannot be.
 *
 * An ABSENT `?view=` means "whatever the module's default view is" — that is
 * what makes `isDefault` mean anything — so escaping the default needs the
 * explicit `?view=none`.
 *
 * A named view that has since been deleted, or one whose stored spec no longer
 * parses, does NOT fall through in silence. The list would then show every
 * record while the URL still claimed to be filtered, and a screen showing more
 * rows than it says is the failure this slice exists to prevent. It says so in
 * a banner instead — the scope filter is unaffected either way, so this is a
 * correctness problem rather than a leak.
 *
 * A view id belonging to someone else's private view resolves as "no longer
 * available" rather than "forbidden", for the same reason the API answers 404
 * for both: a "you may not see that view" message confirms that it exists.
 */
function resolveView(
  views: SavedViewDto[],
  requested: string | null,
): { view: SavedViewDto | null; problem: string | null } {
  if (requested === NO_VIEW) return { view: null, problem: null };

  if (requested === null) {
    // Nobody asked for this one, so a broken default is not worth a banner —
    // it is already listed as unavailable in the picker and the rail.
    return { view: views.find((v) => v.isDefault && v.isValid) ?? null, problem: null };
  }

  const found = views.find((v) => v.id === requested);
  if (!found) {
    // Deliberately says what did NOT happen rather than what is on screen: an
    // ad-hoc filter may be in effect at the same time, and "showing all" would
    // then be a second wrong statement fixing the first.
    return { view: null, problem: 'That saved view is no longer available, so it was not applied.' };
  }
  if (!found.isValid) {
    return {
      view: null,
      problem:
        `“${found.name}” references a field that no longer exists, so it was not applied.`,
    };
  }
  return { view: found, problem: null };
}

/**
 * The view's column set, resolved against the fields this actor may see.
 *
 * A column naming a field that has since been deleted — or one hidden from
 * this reader by the permission matrix — is dropped rather than rendered as an
 * empty column. Dropping a COLUMN is safe in a way dropping a FILTER CONDITION
 * never is: it shows less, not more.
 */
function viewColumns(view: SavedViewDto | null, byKey: Map<string, PageField>): PageField[] {
  if (view === null || view.columns.length === 0) return [];
  return [...view.columns]
    .sort((a, b) => a.order - b.order)
    .map((c) => byKey.get(c.fieldKey))
    .filter((f): f is PageField => f !== undefined);
}

export default async function ModulePage({
  params,
  searchParams,
}: {
  params: Promise<{ moduleSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ moduleSlug }, rawQuery] = await Promise.all([params, searchParams]);

  // The shell layout redirects too, but a page that reads permissions cannot
  // depend on a layout having run — layouts and pages render independently.
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  // Fail closed BEFORE the module is resolved. `/api/modules/<slug>/fields`
  // already refuses a module this actor has no view scope on (lib/config/
  // access.ts) because configuration describes the data — but this page was
  // reading the same FieldDefinition, Status and SavedView rows and rendering
  // them as column headers, status chips and filter labels. The scope filter
  // correctly returned zero ROWS, which made the leak easy to miss: the
  // records were hidden while every field label and status name was not, and
  // hiding a field in the UI is not a security control.
  //
  // notFound() rather than a 403 for the same reason the API asserts before
  // resolving: to a caller with no access, an unknown module and a forbidden
  // one must be indistinguishable.
  if (!canReadModuleConfig(principal, moduleSlug)) notFound();

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    // hasOwner comes along for the bulk reassign action: a module whose rows
    // are not owned has nothing to reassign, and the storage shape below has
    // the other half of that answer. `recordTitleField` names the field that
    // IS the record's identity, which is the column the file draws a picture
    // beside — see the column map below.
    select: {
      id: true, slug: true, label: true, labelPlural: true, isCore: true, hasOwner: true,
      recordTitleField: true,
    },
  });
  if (!mod) notFound();

  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const query = parseListQuery(rawQuery, LIMITS);

  const [fieldRows, statusRows, views, relatedModules] = await Promise.all([
    // Soft-deleted config stays in the table forever (invariant 4) and must
    // never come back as a column.
    prisma.fieldDefinition.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: {
        key: true, label: true, type: true, systemColumn: true,
        // Options come along so a picklist cell can show its LABEL rather
        // than the value it stores, and so the filter rail can offer them as
        // choices. Retired options are included: an older record still points
        // at one and would otherwise lose its label — and filtering FOR the
        // retired ones is exactly how those records get found again.
        options: { select: { value: true, label: true }, orderBy: { displayOrder: 'asc' } },
      },
    }),
    prisma.status.findMany({
      where: { moduleId: mod.id, isDeleted: false },
      orderBy: { displayOrder: 'asc' },
      select: { id: true, name: true, tag: true, color: true },
    }),
    // Through the views library, not a raw query: which views an actor may see
    // (their own, published ones, the seeded ones, their role's) is a
    // permission decision and belongs in exactly one place. Counts are NOT
    // requested — each is its own aggregate, and the rail fetches them lazily
    // when its Saved Filters group is opened rather than putting N queries in
    // front of every pagination click.
    listViews(principal, mod.slug),
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
  // hiding it in the UI is not a security control. It is also why a hidden
  // field cannot be filtered on: repeated narrowing on a field you may not see
  // still reads it.
  const hidden = engine.hiddenFields(mod.slug);
  const fields: PageField[] = fieldRows.filter((f) => !hidden.has(f.key));
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  const { view: appliedView, problem: viewProblem } = resolveView(views, query.view);
  const fromView = viewColumns(appliedView, fieldByKey);
  const columnFields = fromView.length > 0 ? fromView : fields.slice(0, MAX_COLUMNS);

  // The URL's sort overrides the view's; with neither, the repository's own
  // default ordering stands.
  const sort: SortSpec[] | null =
    query.sort !== null ? [query.sort] : (appliedView?.sort ?? null);

  let rows: { id: string }[] = [];
  let total = 0;
  let serverError: string | null = viewProblem;

  // `?f=1` says an ad-hoc filter is in effect and its tree is in the fragment,
  // which never reaches a server. Querying anyway would render rows that do
  // not match the filter the user is looking at, so the query is skipped and
  // the client owns it — see _components/list-query.ts.
  if (!query.filtered) {
    try {
      // Only the COLUMNS are projected: a module with 40 fields would otherwise
      // select 40 columns and ship 40 values per row to draw 12 of them.
      // `allFields` is separate because a filter or sort on the thirteenth
      // field is perfectly legitimate and still has to resolve.
      const result = await listRecords({
        module: { slug: mod.slug, isCore: mod.isCore },
        fields: columnFields.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
        allFields: fields.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
        engine,
        // Binds `isMe`. A query without it is refused rather than widened.
        actor: principal.actor,
        ...(appliedView?.filters ? { filters: appliedView.filters } : {}),
        ...(sort ? { sort } : {}),
        ...(query.search === null ? {} : { search: query.search }),
        page: query.page,
        pageSize: query.size,
      });
      rows = result.rows;
      total = result.total;
    } catch (err) {
      // A view naming a deleted field, or a hand-edited `?sort=` naming one:
      // the repository throws rather than dropping the condition, and this
      // page says so and shows NOTHING. Falling back to the unfiltered list
      // would show more records than the filter on screen claims to allow,
      // which is precisely what the throw exists to prevent. Anything that is
      // not a ConfigError is a real fault and still propagates.
      if (!(err instanceof ConfigError)) throw err;
      serverError = err.message;
    }
  }

  /**
   * Whether a record here CAN be reassigned at all — a storage property, not a
   * slug. `hasOwner` is the module's declaration and `ownerColumn` is whether
   * the table it lives in physically carries one; the record service refuses
   * the move unless both hold, so the screen asks the same question rather
   * than drawing a button that always answers 422.
   */
  const storageShape = storageFor(
    { id: mod.id, slug: mod.slug, isCore: mod.isCore },
    fields.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
  ).shape;
  const hasOwner = mod.hasOwner && storageShape.ownerColumn !== null;

  /**
   * The review queue's badge (spec §6.6): PENDING duplicate flags for this
   * module. Counted only when the button could exist at all — the storage
   * shape says whether flags can point at this table, and resolving a pair is
   * an edit-level power, both asserted again by the duplicates service. Zero
   * means "draw no button", so the gated-out cases and the empty queue are
   * deliberately the same number.
   */
  const duplicateCount =
    storageShape.canFlagDuplicates && engine.can('edit', mod.slug)
      ? await prisma.duplicateFlag.count({ where: { moduleSlug: mod.slug, status: 'PENDING' } })
      : 0;

  /**
   * Every user id the rows on THIS page mention, resolved to a name in one
   * query — the same display lookup the record detail screen does, and for the
   * same reason: an Owner column reading `9f3c…` is a column nobody can act
   * on. Only id and fullName are read; this is not a read of the Profile
   * module and grants no access to it.
   *
   * Keyed on the field TYPE, never on a column name, so every USER_LOOKUP
   * column an Admin adds resolves without this page being touched.
   */
  const userKeys = columnFields.filter((f) => f.type === 'USER_LOOKUP').map((f) => f.key);
  const userIds = new Set<string>();
  for (const row of rows) {
    for (const key of userKeys) {
      const value = (row as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '') userIds.add(value);
    }
  }
  const userNames: [string, string][] =
    userIds.size === 0
      ? []
      : (
          await prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, fullName: true },
          })
        ).map((u) => [u.id, u.fullName]);

  const columns: DataTableColumn[] = columnFields.map((f, i) => ({
    key: f.key,
    label: f.label,
    width: COLUMN_WIDTH[f.type],
    // The first column is pinned so the row stays identifiable while the
    // overflow columns scroll out from under it.
    ...(i === 0 ? { pinned: 'left' as const } : {}),
    /**
     * The 24x24 `Display Picture` beside the record's title.
     *
     * Measured on the `CRM _ Leads` frame: only the FIRST cell of a row draws
     * it — that cell is `Table / Base /  List` 200x45 holding "Arlene McCoy",
     * the Lead Name — and every other column's instance of the node is
     * `visible: false`. So it is a property of ONE column, which is why
     * `DataTableColumn.avatarKey` is per-column rather than "column 0 gets a
     * picture".
     *
     * Keyed off `ModuleDefinition.recordTitleField`, never off position: the
     * picture belongs to the field that IS the record's identity, and a saved
     * view is free to put that field third or leave it out entirely. Left out,
     * no column claims the avatar and none is drawn — which is correct, since
     * there is then no name for the face to sit beside.
     *
     * `DEMO_AVATAR_ROW_KEY` is filled in by `RecordTable`, not by the
     * repository. See components/demo-avatar.ts.
     */
    ...(f.key === mod.recordTitleField ? { avatarKey: DEMO_AVATAR_ROW_KEY } : {}),
  }));

  const statusOptions: PickerOption[] = statusRows.map((s) => ({ value: s.id, label: s.name }));

  // A field is filterable when its TYPE declares operators — the field type
  // registry decides, so a future type with none drops out here without this
  // screen being touched.
  // Role / department columns point at config tables, exactly as the status
  // column does — without this the Users screen shows ids where names belong.
  const refOptions = await referenceOptionsFor(fields);

  const filterFields: FilterField[] = fields
    .filter((f) => operatorsFor(f.type).length > 0)
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      // The status field is a pointer into the `Status` table, not a picklist:
      // its choices are the module's statuses, which is why it looks optionless
      // when read from FieldOption rows.
      options:
        refOptions.get(f.key) ??
        (f.systemColumn === STATUS_COLUMN ? statusOptions : f.options),
      usesUsers: f.type === 'USER_LOOKUP',
    }));

  const canConfigureFields =
    principal.actor.isAdmin || principal.permissions.specials.has('MANAGE_FIELDS_LAYOUTS');

  // gap-3, not gap-6: measured, the band ends at y=140 (84 + 56) and the panels
  // start at y=152 — a 12px gutter, not 24.
  return (
    <div className="flex flex-col gap-3">
      {/* The title is NOT drawn here. Measured: on every designed frame it is
          a text node at @286,21, inside the top bar's 0…68 band — so the shell
          draws it and this page only names it. See
          components/shell/page-title.tsx. */}
      <PageTitle title={mod.labelPlural} />
      {/* THE TOOLBAR BAND — measured `Rectangle 5` @272,84: 1152x56, white,
          1px #e5e7eb, radius 8. It is a band, not a bare row: the actions sit
          INSIDE it, right-aligned and ending at x=1412 (Frame 482686 @1012 is
          400 wide), with the rail's Filter toggle at its left edge @284.
          Rendering the buttons in their own row above the panels — which is
          what this did until now — was the visible mismatch the client
          called out. */}
      <div className="flex h-14 items-center justify-between rounded-md border border-border bg-surface px-3">
        <FilterToggle slug={mod.slug} />
        <ListActions
          slug={mod.slug}
          label={mod.label}
          labelPlural={mod.labelPlural}
          // The record form has to know which field IS the status and which IS
          // the owner — the status picker is fed from the `Status` table and
          // both are filled server-side on create — and `FieldDto` does not
          // serialise the column, so it travels from here. Keyed by field key,
          // never by label: both sides read the physical column.
          systemColumns={Object.fromEntries(fields.map((f) => [f.key, f.systemColumn]))}
          canCreate={engine.can('create', mod.slug)}
          canImportExport={engine.hasSpecial('IMPORT_EXPORT')}
          // The import wizard's last stage asks who owns the imported rows.
          // Whether that question exists at all is a storage property, not a
          // slug — the same answer the bulk reassign action reads.
          hasOwner={hasOwner}
        />
      </div>

      <ListScreen
        // Measured @284,190: the search box sits INSIDE the filter rail, under
        // its heading — not in a row of its own between the toolbar band and
        // the panels, which is where it used to be.
        search={<SearchBox slug={mod.slug} query={query} limits={LIMITS} />}
        slug={mod.slug}
        label={mod.label}
        labelPlural={mod.labelPlural}
        filterFields={filterFields}
        relatedModules={relatedModules}
        views={views.map((v) => ({
          id: v.id,
          name: v.name,
          isShared: v.isShared,
          isDefault: v.isDefault,
          isOwn: v.isOwn,
          isValid: v.isValid,
        }))}
        appliedView={
          appliedView === null
            ? null
            : {
                id: appliedView.id,
                filters: appliedView.filters ?? null,
                sort: appliedView.sort ?? null,
              }
        }
        columns={columns}
        // Only the columns' own fields cross to the client: the other 20 a
        // module may have would be payload nothing on screen reads.
        cellFields={columnFields.map((f) => ({
          key: f.key,
          type: f.type,
          systemColumn: f.systemColumn,
          // A picklist cell shows its option LABEL, not the value stored
          // underneath it — including reference-backed ones (role, department).
          options: refOptions.get(f.key) ?? f.options,
        }))}
        statuses={statusRows}
        rows={rows}
        total={total}
        query={query}
        limits={LIMITS}
        pageSizes={PAGE_SIZES}
        // Publishing a view or pinning a default changes what everyone else
        // sees, so the API gates both on the layout permission. The overlay
        // mirrors the gate rather than offering a switch whose save would 403.
        canShareViews={canConfigureFields}
        fieldBuilderHref={canConfigureFields ? `/settings/modules/${mod.slug}/fields` : null}
        emptyMessage={`Nothing here yet — ${mod.labelPlural} you create or import appear in this list.`}
        serverError={serverError}
        hasOwner={hasOwner}
        userNames={userNames}
        duplicateCount={duplicateCount}
      />
    </div>
  );
}
