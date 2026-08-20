/**
 * Roles and the permission matrix (spec §5.1).
 *
 * The matrix is GENERATED, never authored: one row per enabled
 * ModuleDefinition, so a module the client invents in 2027 appears in every
 * role editor the moment it exists. Nothing here names a module.
 *
 * Three rules shape this file:
 *
 *   - The seeded Admin role is LOCKED. `isAdmin` is derived from that column
 *     (lib/auth/actor.ts), so nothing in this file — and nothing in any route
 *     reaching it — may set, clear or route around `isLocked`. A locked role
 *     is readable and never writable.
 *   - Absence is NONE. A module with no RolePermission row grants nothing,
 *     which is exactly what PermissionEngine.scopeFilter answers, so the
 *     editor renders the same fail-closed default the engine enforces.
 *   - Every write travels through `applyConfigChange`: the permission is
 *     asserted there, the before/after matrix lands in ConfigChangeLog, and
 *     the AuditLog entry commits in the same transaction.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type {
  PermissionMatrixInput,
  RoleCreateInput,
  RoleDeleteInput,
  RoleUpdateInput,
  SpecialPermission,
  ViewScope,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { applyConfigChange, ConfigError, type Tx } from '@/lib/config/service';

/**
 * Role writes are logged as MODULE because CONFIG_TYPES is a fixed union and
 * inventing a member would break every reader of the log. `configId` is the
 * ROLE id for these entries — the same shape a REORDER uses, where configId is
 * the module id rather than a row id.
 */
const ROLE_CONFIG_TYPE = 'MODULE' as const;

/** The one permission that unlocks every function in this file. */
const ROLE_SPECIAL: SpecialPermission = 'MANAGE_USERS_ROLES';

/** Page size for the reassignment drain loop — never an unbounded id list and
 *  never an unbounded createMany payload. */
const REASSIGN_BATCH = 1000;

/** Ceiling on one interactive reassignment. Staff counts live in the hundreds;
 *  this only exists to bound the loop if rows keep arriving underneath it. */
const REASSIGN_LIMIT = 50_000;

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface RoleDto {
  id: string;
  name: string;
  isLocked: boolean;
  isDeleted: boolean;
}

export interface RoleSummary extends RoleDto {
  userCount: number;
  /** modules this role can actually see — a row parked at NONE grants nothing. */
  moduleCount: number;
  specialCount: number;
}

/** One cell-row of the grid, carrying the labels the editor renders. */
export interface RoleMatrixModule {
  moduleId: string;
  slug: string;
  label: string;
  labelPlural: string;
  navOrder: number;
  viewScope: ViewScope;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  hiddenFieldIds: string[];
  readonlyFieldIds: string[];
}

export interface RoleMatrix {
  role: RoleDto;
  modules: RoleMatrixModule[];
  specials: SpecialPermission[];
}

/**
 * What goes into ConfigChangeLog.before/after. Deliberately the same shape as
 * `PermissionMatrixInput` plus the role identity: an undo is then a replay —
 * `saveMatrix(principal, roleId, snapshot)` — which runs every guardrail the
 * forward path runs instead of writing rows behind them.
 */
interface RoleMatrixSnapshot {
  role: RoleDto;
  modules: Omit<RoleMatrixModule, 'slug' | 'label' | 'labelPlural' | 'navOrder'>[];
  specials: SpecialPermission[];
}

const ROLE_SELECT = { id: true, name: true, isLocked: true, isDeleted: true } as const;

// ── permission gate ───────────────────────────────────────────────────────

/**
 * `assertConfigPermission` maps CONFIG TYPES to specials; a role is not a
 * config type, so the decision lives here — once, for every function below.
 */
export function canManageRoles(principal: Principal): boolean {
  return principal.actor.isAdmin || principal.permissions.specials.has(ROLE_SPECIAL);
}

function assertRoleAdmin(principal: Principal): void {
  if (!canManageRoles(principal)) {
    throw new ConfigError(`Requires the "${ROLE_SPECIAL}" permission`, 403, 'FORBIDDEN');
  }
}

/**
 * The Admin role ships with everything on and is the only locked role. It must
 * stay visible in the roles screen and stay unwritable everywhere else —
 * weakening it is how an installation locks itself out permanently, and
 * invariant 5 (Admin holds the keys first) has no recovery path if it happens.
 */
function assertUnlocked(role: RoleDto, verb: string): void {
  if (role.isLocked) {
    throw new ConfigError(`The Admin role cannot be ${verb}`, 422, 'GUARDRAIL');
  }
}

// ── reads ─────────────────────────────────────────────────────────────────

export async function listRoles(principal: Principal): Promise<RoleSummary[]> {
  assertRoleAdmin(principal);

  const roles = await prisma.role.findMany({
    where: { isDeleted: false },
    // Admin pins to the top: it is the role every other role is compared to.
    orderBy: [{ isLocked: 'desc' }, { name: 'asc' }],
    select: {
      ...ROLE_SELECT,
      _count: {
        select: {
          users: true,
          specials: true,
          // Counting rows would overstate reach — the editor writes a row for
          // every module in the grid, most of them parked at NONE.
          permissions: { where: { viewScope: { not: 'NONE' } } },
        },
      },
    },
  });

  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    isLocked: role.isLocked,
    isDeleted: role.isDeleted,
    userCount: role._count.users,
    moduleCount: role._count.permissions,
    specialCount: role._count.specials,
  }));
}

/**
 * The full grid for one role. EVERY enabled module appears, with or without a
 * stored row, so the editor never has to invent a default — and so a module
 * created after this role was last saved shows up already fail-closed.
 */
export async function getRoleMatrix(principal: Principal, roleId: string): Promise<RoleMatrix> {
  assertRoleAdmin(principal);
  await requireLiveRole(roleId);
  return readMatrix(prisma, roleId);
}

// ── role writes ───────────────────────────────────────────────────────────

/** New roles start with NOTHING granted. Fail closed: an Admin adds reach
 *  deliberately, never by forgetting to take it away. */
export async function createRole(principal: Principal, input: RoleCreateInput): Promise<RoleDto> {
  assertRoleAdmin(principal);
  await assertNameFree(input.name, null);

  const { result } = await conflictAware(input.name, () =>
    applyConfigChange<RoleDto>({
      principal,
      configType: ROLE_CONFIG_TYPE,
      special: ROLE_SPECIAL,
      action: 'CREATE',
      before: async () => null,
      mutate: async (tx) => {
        // isLocked is never in the payload and never set here: exactly one
        // locked role exists and the seed owns it.
        const created = await tx.role.create({ data: { name: input.name }, select: ROLE_SELECT });
        return { result: created, configId: created.id };
      },
      after: (tx, configId) => snapshot(tx, configId),
    }),
  );

  return result;
}

export async function updateRole(
  principal: Principal,
  roleId: string,
  input: RoleUpdateInput,
): Promise<RoleDto> {
  assertRoleAdmin(principal);
  const role = await requireLiveRole(roleId);
  assertUnlocked(role, 'edited');

  // Nothing to change is not a change: an empty diff would sit in the undo
  // stack blocking the revert of the entry underneath it (see revert.ts).
  if (input.name === undefined || input.name === role.name) return role;
  await assertNameFree(input.name, roleId);

  const { result } = await conflictAware(input.name, () =>
    applyConfigChange<RoleDto>({
      principal,
      configType: ROLE_CONFIG_TYPE,
      special: ROLE_SPECIAL,
      action: 'UPDATE',
      before: (tx) => snapshot(tx, roleId),
      mutate: async (tx) => {
        const updated = await tx.role.update({
          where: { id: roleId },
          data: { name: input.name },
          select: ROLE_SELECT,
        });
        return { result: updated, configId: roleId };
      },
      after: (tx) => snapshot(tx, roleId),
    }),
  );

  return result;
}

/**
 * Soft delete, always (invariant 4). Historical AuditLog diffs name this role
 * id and must keep resolving, and a restore has to be possible without
 * recreating permissions from memory.
 *
 * Last-admin protection needs no code here: the Admin role is locked, so it
 * can never be deleted and the people holding it can never be moved off it by
 * this path.
 */
export async function deleteRole(
  principal: Principal,
  roleId: string,
  input: RoleDeleteInput,
): Promise<void> {
  assertRoleAdmin(principal);
  const role = await requireLiveRole(roleId);
  assertUnlocked(role, 'deleted');

  const userCount = await prisma.user.count({ where: { roleId } });
  const reassignToRoleId = input.reassignToRoleId ?? null;

  if (userCount > 0 && !reassignToRoleId) {
    // 409 with the count so the UI can name the number before it asks the
    // Admin to pick somewhere to put them.
    throw new ConfigError(
      `${userCount} user(s) hold this role — choose a role to move them to first`,
      409,
      'CONFLICT',
      { userCount },
    );
  }
  if (userCount > REASSIGN_LIMIT) {
    throw new ConfigError(
      `This role is held by ${userCount} user(s), more than the ${REASSIGN_LIMIT} one request can move`,
      422,
      'GUARDRAIL',
      { userCount, limit: REASSIGN_LIMIT },
    );
  }
  // Validated whenever it is supplied, not only when the pre-check saw
  // holders: `userCount` is a snapshot, and a user assigned between here and
  // the transaction would otherwise be moved into an unvetted role.
  if (reassignToRoleId) await assertReassignTarget(principal, roleId, reassignToRoleId);

  await applyConfigChange<null>({
    principal,
    configType: ROLE_CONFIG_TYPE,
    special: ROLE_SPECIAL,
    action: 'DELETE',
    before: (tx) => snapshot(tx, roleId),
    mutate: async (tx) => {
      if (reassignToRoleId) await reassignHolders(tx, principal, roleId, reassignToRoleId);

      await tx.role.update({ where: { id: roleId }, data: { isDeleted: true } });
      return { result: null, configId: roleId };
    },
    after: (tx) => snapshot(tx, roleId),
  });
}

// ── the matrix write ──────────────────────────────────────────────────────

/**
 * Save the whole grid as ONE change.
 *
 * Only the modules named in the payload are written; rows for modules the
 * payload does not mention are left exactly as they are. The editor always
 * sends the full grid, and the before/after snapshots always carry the full
 * grid, so an undo restores every module regardless of what the forward
 * payload happened to name.
 */
export async function saveMatrix(
  principal: Principal,
  roleId: string,
  input: PermissionMatrixInput,
): Promise<void> {
  assertRoleAdmin(principal);
  const role = await requireLiveRole(roleId);
  assertUnlocked(role, 'edited');

  await assertModulesAreEnabled(input);
  await assertFieldRulesBelong(input);

  await applyConfigChange<null>({
    principal,
    configType: ROLE_CONFIG_TYPE,
    special: ROLE_SPECIAL,
    action: 'UPDATE',
    before: (tx) => snapshot(tx, roleId),
    mutate: async (tx) => {
      for (const row of input.modules) {
        // DbNull rather than `{}` when nothing is restricted: actor.ts reads
        // this column on every request, and an empty object costs a parse for
        // an answer it already has.
        const fieldRules =
          row.hiddenFieldIds.length > 0 || row.readonlyFieldIds.length > 0
            ? { hidden: row.hiddenFieldIds, readonly: row.readonlyFieldIds }
            : Prisma.DbNull;

        const grant = {
          viewScope: row.viewScope,
          canCreate: row.canCreate,
          canEdit: row.canEdit,
          canDelete: row.canDelete,
          fieldRules,
        };

        await tx.rolePermission.upsert({
          where: { roleId_moduleId: { roleId, moduleId: row.moduleId } },
          create: { roleId, moduleId: row.moduleId, ...grant },
          update: grant,
        });
      }

      // Specials are a set, so they are replaced rather than merged: an
      // unchecked box must REMOVE the grant, and a merge would silently keep
      // it. Delete-then-create in this order so a re-sent grant survives.
      await tx.roleSpecialPermission.deleteMany({
        where: {
          roleId,
          // `notIn: []` is ambiguous across drivers — say "delete them all"
          // explicitly when the payload grants nothing.
          ...(input.specials.length > 0 ? { permission: { notIn: input.specials } } : {}),
        },
      });
      await tx.roleSpecialPermission.createMany({
        data: input.specials.map((permission) => ({ roleId, permission })),
        skipDuplicates: true,
      });

      return { result: null, configId: roleId };
    },
    after: (tx) => snapshot(tx, roleId),
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

/** A deleted role is gone as far as every write path is concerned: it cannot
 *  be renamed, re-granted or deleted twice. */
async function requireLiveRole(roleId: string): Promise<RoleDto> {
  const role = await prisma.role.findUnique({ where: { id: roleId }, select: ROLE_SELECT });
  if (!role || role.isDeleted) throw new ConfigError('Role not found', 404, 'NOT_FOUND');
  return role;
}

/**
 * `Role.name` is unique across soft-deleted rows too, so a name held by a
 * deleted role is genuinely taken — answer 409 with that reason rather than
 * letting the insert surface as a 500.
 */
async function assertNameFree(name: string, exceptRoleId: string | null): Promise<void> {
  const clash = await prisma.role.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptRoleId ? { id: { not: exceptRoleId } } : {}),
    },
    select: { isDeleted: true },
  });
  if (!clash) return;

  throw new ConfigError(
    clash.isDeleted
      ? `A deleted role still holds the name "${name}" — choose another`
      : `A role named "${name}" already exists`,
    409,
    'CONFLICT',
  );
}

/** The pre-check above races with a concurrent create; the unique index is the
 *  real arbiter, so translate its violation into the same 409. */
async function conflictAware<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConfigError(`A role named "${name}" already exists`, 409, 'CONFLICT');
    }
    throw err;
  }
}

/**
 * Where the deleted role's people go.
 *
 * The locked check is the important one: without it, a MANAGE_USERS_ROLES
 * holder could delete their own role and reassign themselves into Admin,
 * turning a delegated permission into full administration in one request.
 * Only an existing Admin may move anyone into the Admin role.
 */
async function assertReassignTarget(
  principal: Principal,
  roleId: string,
  targetId: string,
): Promise<void> {
  if (targetId === roleId) {
    throw new ConfigError('Choose a different role to move these users to', 422, 'VALIDATION');
  }

  const target = await prisma.role.findUnique({ where: { id: targetId }, select: ROLE_SELECT });
  if (!target || target.isDeleted) {
    throw new ConfigError('Reassignment target must be a live role', 422, 'VALIDATION');
  }
  if (target.isLocked && !principal.actor.isAdmin) {
    throw new ConfigError('Only an Admin can move users into the Admin role', 403, 'FORBIDDEN');
  }
}

/**
 * Move every holder, one page at a time, writing that page's timeline entries
 * before the next page is read. Invariant 2: a role change is a change to that
 * person's record, so it shows on their history — one entry per user, never
 * one insert per user.
 *
 * No cursor is needed: each pass removes its own rows from the `{ roleId }`
 * predicate. Ids are re-read inside the transaction so a user created between
 * the pre-check and here moves too.
 */
async function reassignHolders(
  tx: Tx,
  principal: Principal,
  roleId: string,
  targetId: string,
): Promise<void> {
  let moved = 0;

  for (;;) {
    const holders = await tx.user.findMany({
      where: { roleId },
      select: { id: true },
      take: REASSIGN_BATCH,
    });
    if (holders.length === 0) break;

    moved += holders.length;
    if (moved > REASSIGN_LIMIT) {
      throw new ConfigError(
        `More than ${REASSIGN_LIMIT} users hold this role; move them in the background first`,
        422,
        'GUARDRAIL',
        { limit: REASSIGN_LIMIT },
      );
    }

    const ids = holders.map(({ id }) => id);
    await tx.user.updateMany({ where: { id: { in: ids } }, data: { roleId: targetId } });

    const entries: Prisma.AuditLogCreateManyInput[] = ids.map((id) => ({
      entityType: 'User',
      entityId: id,
      action: 'CONFIG_CHANGED',
      actorType: 'USER',
      actorId: principal.actor.userId,
      changes: { roleId: { from: roleId, to: targetId } } as Prisma.InputJsonObject,
    }));
    await tx.auditLog.createMany({ data: entries });
  }
}

/** An unknown or disabled module id is refused, never dropped: silently
 *  ignoring a row would report a save the Admin never got. */
async function assertModulesAreEnabled(input: PermissionMatrixInput): Promise<void> {
  const seen = new Set<string>();
  for (const row of input.modules) {
    if (seen.has(row.moduleId)) {
      throw new ConfigError('The same module appears twice in this matrix', 422, 'VALIDATION');
    }
    seen.add(row.moduleId);
  }
  if (seen.size === 0) return;

  const enabled = await prisma.moduleDefinition.findMany({
    where: { id: { in: [...seen] }, isEnabled: true },
    select: { id: true },
  });
  if (enabled.length !== seen.size) {
    throw new ConfigError(
      'This matrix names a module that does not exist or is disabled',
      422,
      'VALIDATION',
    );
  }
}

/**
 * A field rule must name a field OF THE MODULE it is listed under. A rule
 * pointing at another module's field is dead weight that `loadPrincipal` would
 * resolve into a key belonging to a different module — and a key collision
 * across modules would hide the wrong column.
 */
async function assertFieldRulesBelong(input: PermissionMatrixInput): Promise<void> {
  const byModule = new Map<string, Set<string>>();
  for (const row of input.modules) {
    const ids = [...row.hiddenFieldIds, ...row.readonlyFieldIds];
    if (ids.length > 0) byModule.set(row.moduleId, new Set(ids));
  }
  if (byModule.size === 0) return;

  const all = [...byModule.values()].flatMap((ids) => [...ids]);
  const fields = await prisma.fieldDefinition.findMany({
    where: { id: { in: all } },
    select: { id: true, moduleId: true },
  });
  const moduleByField = new Map(fields.map((f) => [f.id, f.moduleId]));

  for (const [moduleId, ids] of byModule) {
    for (const id of ids) {
      if (moduleByField.get(id) !== moduleId) {
        throw new ConfigError(
          'A field rule names a field that does not belong to its module',
          422,
          'VALIDATION',
        );
      }
    }
  }
}

/** `{ hidden: [fieldId], readonly: [fieldId] }` as stored on RolePermission —
 *  the same reader actor.ts uses, kept tolerant of a hand-edited column. */
function parseFieldRules(raw: unknown): { hidden: string[]; readonly: string[] } {
  if (!raw || typeof raw !== 'object') return { hidden: [], readonly: [] };
  const rules = raw as { hidden?: unknown; readonly?: unknown };
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return { hidden: strings(rules.hidden), readonly: strings(rules.readonly) };
}

/**
 * The merge that both the editor and the change log read: every enabled
 * module, joined to its stored row if it has one. Takes a `Tx` so it can run
 * inside the change transaction and see the same world the mutation wrote.
 */
async function readMatrix(db: Tx, roleId: string): Promise<RoleMatrix> {
  const role = await db.role.findUnique({ where: { id: roleId }, select: ROLE_SELECT });
  if (!role) throw new ConfigError('Role not found', 404, 'NOT_FOUND');

  const [modules, rows, specials] = await Promise.all([
    db.moduleDefinition.findMany({
      where: { isEnabled: true },
      orderBy: { navOrder: 'asc' },
      select: { id: true, slug: true, label: true, labelPlural: true, navOrder: true },
    }),
    db.rolePermission.findMany({ where: { roleId } }),
    db.roleSpecialPermission.findMany({ where: { roleId }, orderBy: { permission: 'asc' } }),
  ]);

  const rowByModule = new Map(rows.map((row) => [row.moduleId, row]));

  return {
    role,
    modules: modules.map((module) => {
      const row = rowByModule.get(module.id);
      const rules = parseFieldRules(row?.fieldRules);
      return {
        moduleId: module.id,
        slug: module.slug,
        label: module.label,
        labelPlural: module.labelPlural,
        navOrder: module.navOrder,
        // No row is NONE, not "unset" — the same answer scopeFilter gives.
        viewScope: (row?.viewScope ?? 'NONE') as ViewScope,
        canCreate: row?.canCreate ?? false,
        canEdit: row?.canEdit ?? false,
        canDelete: row?.canDelete ?? false,
        hiddenFieldIds: rules.hidden,
        readonlyFieldIds: rules.readonly,
      };
    }),
    specials: specials.map((s) => s.permission as SpecialPermission),
  };
}

/** ConfigChangeLog before/after: the matrix minus the display labels, which
 *  are Admin-editable data and would make two identical grids diff. */
async function snapshot(db: Tx, roleId: string): Promise<RoleMatrixSnapshot> {
  const matrix = await readMatrix(db, roleId);
  return {
    role: matrix.role,
    modules: matrix.modules.map((m) => ({
      moduleId: m.moduleId,
      viewScope: m.viewScope,
      canCreate: m.canCreate,
      canEdit: m.canEdit,
      canDelete: m.canDelete,
      hiddenFieldIds: m.hiddenFieldIds,
      readonlyFieldIds: m.readonlyFieldIds,
    })),
    specials: matrix.specials,
  };
}
