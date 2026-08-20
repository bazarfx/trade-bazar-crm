/**
 * Saved views — the filter tree, the column set and the sort a user keeps.
 *
 * A view is two different things wearing one row, and the difference is the
 * whole permission model here:
 *
 *   PRIVATE  (`isShared: false`, no `roleId`) — the actor's own working state.
 *            Anyone who can read the module may keep as many as they like. It
 *            is not configuration; requiring MANAGE_FIELDS_LAYOUTS to save a
 *            personal filter would be absurd.
 *   PUBLISHED (`isShared: true`) or a ROLE DEFAULT (`roleId` / `isDefault`) —
 *            configuration. It changes what other people see when they open
 *            the module, so it is gated exactly like a layout is.
 *
 * The gate is `assertConfigPermission(principal, 'LAYOUT')`, which resolves to
 * MANAGE_FIELDS_LAYOUTS through the map in `lib/config/service.ts`. Asking the
 * assertion rather than restating the special keeps that mapping in one home,
 * the same way `hasConfigPermission` in `lib/config/access.ts` does.
 *
 * SECURITY, and the reason a shared view is safe at all: a view stores a
 * filter, never a result. Applying one still runs through `listRecords`, which
 * ANDs the tree under the reader's own scope filter. A view authored by an
 * admin and opened by a rep shows the rep their own rows — a saved view can
 * narrow what someone sees and can never widen it.
 *
 * TODO(ConfigChangeLog): publishing a view or pinning a role default IS an
 * admin config write (CLAUDE.md's log table), so it belongs in
 * `applyConfigChange` with a before/after snapshot and undo. It is not routed
 * there yet because `ConfigType` has no `VIEW` member and adding one touches
 * the revert surface. Private views must stay OUT of that path regardless —
 * `applyConfigChange` asserts a config permission on every write.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine, type FieldMeta } from '@crm/core';
import {
  buildViewSpecSchema,
  viewSpecSchema,
  type FilterNode,
  type SavedViewDto,
  type SortSpec,
  type ViewCreateInput,
  type ViewSpec,
  type ViewUpdateInput,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { assertModuleReadAccess } from '@/lib/config/access';
import { assertConfigPermission, ConfigError, requireModule } from '@/lib/config/service';
import { countRecords } from '@/lib/records/list';

/**
 * Ceiling on how many live counts one listing will issue.
 *
 * Each count is its own aggregate over the matched set (see `countRecords`), so
 * the design's "Saved Filters (9)" rail costs nine queries — fine. Ninety would
 * not be. Past the cap the extra views list without a number rather than making
 * the page wait: a missing count is visibly missing, a slow page is not.
 */
const MAX_COUNTED_VIEWS = 20;

const VIEW_SELECT = {
  id: true,
  name: true,
  ownerId: true,
  columns: true,
  filters: true,
  sort: true,
  isShared: true,
  isDefault: true,
  roleId: true,
} as const;

type ViewRow = {
  id: string;
  name: string;
  ownerId: string | null;
  columns: Prisma.JsonValue;
  filters: Prisma.JsonValue | null;
  sort: Prisma.JsonValue | null;
  isShared: boolean;
  isDefault: boolean;
  roleId: string | null;
};

// ── module context ────────────────────────────────────────────────────────

interface ViewContext {
  module: { id: string; slug: string; isCore: boolean };
  /**
   * The fields this actor may filter, sort or column on — hidden ones removed.
   * A view must not be SAVEABLE against a hidden field for the same reason it
   * must not be RUNNABLE against one: repeated narrowing on a field you cannot
   * see still reads it. `listRecords` strips them again; this is the earlier,
   * friendlier refusal.
   */
  fields: FieldMeta[];
  engine: PermissionEngine;
}

async function viewContext(principal: Principal, moduleSlug: string): Promise<ViewContext> {
  // Before the module is resolved: to an actor with no access, an unknown
  // module and a forbidden one must be indistinguishable.
  assertModuleReadAccess(principal, moduleSlug);
  const module = await requireModule(moduleSlug);

  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const hidden = engine.hiddenFields(moduleSlug);

  // Soft-deleted fields keep their values (invariant 4) but leave the contract:
  // a NEW view may not reference one. An OLD view that does still lists — see
  // `readSpec` — it simply cannot be applied or counted.
  const rows = await prisma.fieldDefinition.findMany({
    where: { moduleId: module.id, isDeleted: false },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    select: { key: true, type: true, systemColumn: true },
  });

  return {
    module: { id: module.id, slug: module.slug, isCore: module.isCore },
    fields: rows.filter((f) => !hidden.has(f.key)),
    engine,
  };
}

// ── stored spec <-> DTO ───────────────────────────────────────────────────

/**
 * Read the three JSON columns back as a `ViewSpec`.
 *
 * STRUCTURAL parse only, deliberately: the field-aware pass would reject a
 * view whose field an Admin has since deleted, and a view that cannot be
 * applied must still be listable so its owner can delete it. So an unparseable
 * spec returns null and the DTO says `isValid: false` — never a half-read spec
 * with some conditions dropped, which is the shape of a filter that silently
 * matches more than it says.
 */
function readSpec(row: ViewRow): ViewSpec | null {
  const parsed = viewSpecSchema.safeParse({
    columns: row.columns ?? [],
    ...(row.filters === null ? {} : { filters: row.filters }),
    ...(row.sort === null ? {} : { sort: row.sort }),
  });
  if (!parsed.success) return null;
  return {
    columns: parsed.data.columns,
    ...(parsed.data.filters ? { filters: parsed.data.filters } : {}),
    ...(parsed.data.sort ? { sort: parsed.data.sort } : {}),
  };
}

function toDto(row: ViewRow, actorId: string): SavedViewDto {
  const spec = readSpec(row);
  return {
    id: row.id,
    name: row.name,
    columns: spec?.columns ?? [],
    ...(spec?.filters ? { filters: spec.filters } : {}),
    ...(spec?.sort ? { sort: spec.sort } : {}),
    isShared: row.isShared,
    isDefault: row.isDefault,
    roleId: row.roleId,
    isOwn: row.ownerId === actorId,
    isValid: spec !== null,
  };
}

/** Prisma wants `DbNull` for "write SQL NULL", and `undefined` for "leave it". */
function jsonOrNull(value: unknown): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

// ── visibility ────────────────────────────────────────────────────────────

/**
 * Which views this actor may SEE: their own, anything published, the seeded
 * system views (`ownerId: null`), and whatever is pinned to their role.
 *
 * Note what is NOT here: another user's private view. `@@index([moduleId,
 * ownerId])` covers the common half of this.
 */
function visibleTo(principal: Principal, moduleId: string): Prisma.SavedViewWhereInput {
  return {
    moduleId,
    OR: [
      { ownerId: principal.actor.userId },
      { isShared: true },
      { ownerId: null },
      { roleId: principal.actor.roleId },
    ],
  };
}

/** True when the actor may CHANGE this view, as opposed to merely read it. */
function mayWrite(principal: Principal, row: { ownerId: string | null }): boolean {
  // Admin included so a published view whose author has left is not immortal.
  return principal.actor.isAdmin || row.ownerId === principal.actor.userId;
}

/** Does this payload touch anything that affects OTHER people's screens? */
function touchesSharedState(input: ViewCreateInput | ViewUpdateInput): boolean {
  return input.isShared === true || input.isDefault === true || Boolean(input.roleId);
}

// ── read ──────────────────────────────────────────────────────────────────

export interface ListViewsOptions {
  /** compute live match counts — one query per view. See MAX_COUNTED_VIEWS. */
  withCounts?: boolean;
}

export async function listViews(
  principal: Principal,
  moduleSlug: string,
  opts: ListViewsOptions = {},
): Promise<SavedViewDto[]> {
  const ctx = await viewContext(principal, moduleSlug);

  const rows = await prisma.savedView.findMany({
    where: visibleTo(principal, ctx.module.id),
    // The default first — it is the one the list opens with — then by name, so
    // the rail's order does not shuffle when someone edits a view.
    orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    select: VIEW_SELECT,
  });

  const dtos = rows.map((row) => toDto(row, principal.actor.userId));
  if (!opts.withCounts) return dtos;

  // Sequential, not Promise.all: N counts firing at once against a session-mode
  // pooler is N connections, and this runs on every open of the list screen.
  for (const dto of dtos.slice(0, MAX_COUNTED_VIEWS)) {
    const count = await countForSpec(ctx, principal, dto);
    if (count !== null) dto.matchCount = count;
  }
  return dtos;
}

/**
 * One count for one view, or null when the view cannot be counted.
 *
 * The expected null is a view referencing a field an Admin has since deleted,
 * or one hidden from THIS actor: `compileFilter` throws (correctly — a dropped
 * condition widens), and there is no honest number to show. Showing no count
 * is visibly nothing; showing the unfiltered total would be a wrong number
 * presented as a right one.
 *
 * The catch is deliberately wide — one unrunnable view must not blank the
 * whole rail, and this is a LABEL, not a result set. That is the whole reason
 * a broad catch is defensible here and nowhere else on the query side: the
 * same view applied to the LIST still raises its 400/500 loudly, because that
 * path returns records and a wrong record set is the leak. Anything unexpected
 * is logged rather than swallowed, so a real fault still reaches a human.
 */
async function countForSpec(
  ctx: ViewContext,
  principal: Principal,
  spec: { id?: string; filters?: FilterNode; sort?: SortSpec[]; isValid?: boolean },
): Promise<number | null> {
  if (spec.isValid === false) return null;
  try {
    return await countRecords({
      module: ctx.module,
      fields: ctx.fields,
      engine: ctx.engine,
      actor: principal.actor,
      ...(spec.filters ? { filters: spec.filters } : {}),
    });
  } catch (err) {
    // A ConfigError here is the expected stale-field case and is not news.
    if (!(err instanceof ConfigError)) {
      console.error('[views] match count failed', { view: spec.id, module: ctx.module.slug }, err);
    }
    return null;
  }
}

/**
 * The live match count the design shows beside a saved filter.
 *
 * ONE query, and it reads no columns — so this is safe to call per view, and
 * expensive to call per view on a large module. The caller owns that decision;
 * `listViews({ withCounts: true })` caps itself at MAX_COUNTED_VIEWS.
 */
export async function countMatches(
  principal: Principal,
  moduleSlug: string,
  view: { filters?: FilterNode | null; sort?: SortSpec[] | null },
): Promise<number> {
  const ctx = await viewContext(principal, moduleSlug);
  return countRecords({
    module: ctx.module,
    fields: ctx.fields,
    engine: ctx.engine,
    actor: principal.actor,
    ...(view.filters ? { filters: view.filters } : {}),
  });
}

/** One view by id, through the same visibility filter as the listing. */
export async function getView(
  principal: Principal,
  moduleSlug: string,
  viewId: string,
): Promise<SavedViewDto> {
  const ctx = await viewContext(principal, moduleSlug);
  const row = await prisma.savedView.findFirst({
    where: { id: viewId, ...visibleTo(principal, ctx.module.id) },
    select: VIEW_SELECT,
  });
  if (!row) throw new ConfigError('View not found', 404, 'NOT_FOUND');
  return toDto(row, principal.actor.userId);
}

// ── write ─────────────────────────────────────────────────────────────────

/**
 * Validate the spec against the module's LIVE fields.
 *
 * This is where "operators come from the registry" is enforced on the way in:
 * `buildViewSpecSchema` checks each condition's operator against
 * `FIELD_TYPE_SPECS[field.type].operators`. Rejecting at save time is worth
 * more than rejecting at run time — a saved view that always errors is a
 * booby trap, and a shared one is a booby trap for everybody.
 */
function validateSpec(ctx: ViewContext, spec: ViewSpec): ViewSpec {
  return buildViewSpecSchema(ctx.fields).parse(spec);
}

/** A role a view may be pinned to must exist and be live. */
async function assertRole(roleId: string): Promise<void> {
  const role = await prisma.role.findFirst({ where: { id: roleId, isDeleted: false } });
  if (!role) throw new ConfigError('Unknown role', 400, 'VALIDATION');
}

/**
 * Only one default per (module, role).
 *
 * Two rows both claiming the default makes which view a user opens depend on
 * row order, which is not a decision anyone made. Cleared inside the same
 * transaction as the write that sets it.
 */
function clearOtherDefaults(
  tx: Prisma.TransactionClient,
  moduleId: string,
  roleId: string | null,
  exceptId?: string,
) {
  return tx.savedView.updateMany({
    where: {
      moduleId,
      roleId,
      isDefault: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isDefault: false },
  });
}

export async function createView(
  principal: Principal,
  moduleSlug: string,
  input: ViewCreateInput,
): Promise<SavedViewDto> {
  const ctx = await viewContext(principal, moduleSlug);

  // Publishing or pinning is configuration; keeping a private view is not.
  if (touchesSharedState(input)) assertConfigPermission(principal, 'LAYOUT');

  const spec = validateSpec(ctx, {
    columns: input.columns,
    ...(input.filters ? { filters: input.filters } : {}),
    ...(input.sort ? { sort: input.sort } : {}),
  });

  const roleId = input.roleId ?? null;
  if (roleId) await assertRole(roleId);
  const isDefault = input.isDefault ?? false;

  const row = await prisma.$transaction(async (tx) => {
    if (isDefault) await clearOtherDefaults(tx, ctx.module.id, roleId);
    return tx.savedView.create({
      data: {
        moduleId: ctx.module.id,
        name: input.name,
        // Authorship is kept even on a published view: `ownerId: null` is
        // reserved for the seeded system views, so "shared" and "nobody's"
        // stay distinguishable and a published view still has someone to ask.
        ownerId: principal.actor.userId,
        columns: spec.columns as unknown as Prisma.InputJsonValue,
        filters: jsonOrNull(spec.filters),
        sort: jsonOrNull(spec.sort),
        isShared: input.isShared ?? false,
        isDefault,
        roleId,
      },
      select: VIEW_SELECT,
    });
  });

  return toDto(row, principal.actor.userId);
}

export async function updateView(
  principal: Principal,
  moduleSlug: string,
  viewId: string,
  input: ViewUpdateInput,
): Promise<SavedViewDto> {
  const ctx = await viewContext(principal, moduleSlug);

  const existing = await prisma.savedView.findFirst({
    where: { id: viewId, ...visibleTo(principal, ctx.module.id) },
    select: VIEW_SELECT,
  });
  // Not visible and not existing give the same answer: a 403 on a view you may
  // not see still confirms that it exists.
  if (!existing) throw new ConfigError('View not found', 404, 'NOT_FOUND');

  if (!mayWrite(principal, existing)) {
    throw new ConfigError('Only the owner of a view can change it', 403, 'FORBIDDEN');
  }
  // Gate on the RESULT, not just the delta: unsharing is as much a change to
  // other people's screens as sharing was.
  if (touchesSharedState(input) || existing.isShared || existing.isDefault || existing.roleId) {
    assertConfigPermission(principal, 'LAYOUT');
  }

  // The spec is validated as a WHOLE even on a partial update: a rename that
  // left an unvalidated tree behind would let a view outlive the field it
  // filters on without anyone noticing.
  const current = readSpec(existing);
  const merged: ViewSpec = {
    columns: input.columns ?? current?.columns ?? [],
    ...(input.filters !== undefined
      ? input.filters
        ? { filters: input.filters }
        : {}
      : current?.filters
        ? { filters: current.filters }
        : {}),
    ...(input.sort !== undefined
      ? input.sort
        ? { sort: input.sort }
        : {}
      : current?.sort
        ? { sort: current.sort }
        : {}),
  };
  const spec = validateSpec(ctx, merged);

  const roleId = input.roleId === undefined ? existing.roleId : (input.roleId ?? null);
  if (roleId && roleId !== existing.roleId) await assertRole(roleId);
  const isDefault = input.isDefault ?? existing.isDefault;

  const row = await prisma.$transaction(async (tx) => {
    if (isDefault) await clearOtherDefaults(tx, ctx.module.id, roleId, viewId);
    return tx.savedView.update({
      where: { id: viewId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        columns: spec.columns as unknown as Prisma.InputJsonValue,
        filters: jsonOrNull(spec.filters),
        sort: jsonOrNull(spec.sort),
        ...(input.isShared !== undefined ? { isShared: input.isShared } : {}),
        isDefault,
        roleId,
      },
      select: VIEW_SELECT,
    });
  });

  return toDto(row, principal.actor.userId);
}

/**
 * Hard delete, and that is the right call here.
 *
 * Invariant 4 is soft delete "always" — for fields, options, statuses, records
 * and modules, because their values live on in 40,000 rows and in a timeline
 * that must stay readable forever. A saved view owns no data: it is a query
 * someone kept. Deleting it destroys nothing that another row or an older
 * audit diff still points at, and `SavedView` carries no `isDeleted` column to
 * hide it in. Keeping tombstones would only make the rail's count wrong.
 *
 * Who may: the owner, or an Admin. Not "anyone who can see it" — a shared view
 * is visible to the whole company.
 */
export async function deleteView(
  principal: Principal,
  moduleSlug: string,
  viewId: string,
): Promise<{ id: string }> {
  const ctx = await viewContext(principal, moduleSlug);

  const existing = await prisma.savedView.findFirst({
    where: { id: viewId, ...visibleTo(principal, ctx.module.id) },
    select: { id: true, ownerId: true, isShared: true, isDefault: true, roleId: true },
  });
  if (!existing) throw new ConfigError('View not found', 404, 'NOT_FOUND');

  if (!mayWrite(principal, existing)) {
    throw new ConfigError('Only the owner of a view can delete it', 403, 'FORBIDDEN');
  }
  // Removing a published view or a role default changes other people's screens
  // exactly as publishing it did, so it passes the same gate.
  if (existing.isShared || existing.isDefault || existing.roleId) {
    assertConfigPermission(principal, 'LAYOUT');
  }

  await prisma.savedView.delete({ where: { id: viewId } });
  return { id: viewId };
}
