/**
 * Departments — the Profile module's view-scope boundary (spec §5.2).
 *
 * A department is CONFIG: a DEPARTMENT view scope on any module is read
 * against `User.departmentId`, so renaming or retiring one changes what a
 * whole role can see. Every write travels through `applyConfigChange`
 * (configType DEPARTMENT) — MANAGE_DEPARTMENTS_GROUPS is asserted there, the
 * before/after snapshot lands in ConfigChangeLog with undo support, and the
 * mutation commits with its log in one transaction.
 *
 * Retiring a department never detaches its people. `departmentId` stays set
 * on every user so a restore brings the boundary straight back, and until
 * then a retired department still renders by name off the soft-deleted row —
 * a person whose department "disappeared" is how scope bugs get reported.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type { DepartmentCreateInput, DepartmentDto, DepartmentUpdateInput } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { applyConfigChange, assertConfigPermission, ConfigError, type Tx } from '@/lib/config/service';

const DEPARTMENT_CONFIG_TYPE = 'DEPARTMENT' as const;

const DEPARTMENT_SELECT = { id: true, name: true, isDeleted: true } as const;
type DepartmentRow = Prisma.DepartmentGetPayload<{ select: typeof DEPARTMENT_SELECT }>;

export interface SoftDeleteDepartmentOptions {
  /** The Admin has seen the user count and still wants the department retired. */
  confirmed?: boolean;
}

// ── reads ─────────────────────────────────────────────────────────────────

export interface ListDepartmentsOptions {
  includeDeleted?: boolean;
}

/**
 * Every live department, with the number of people in it. Not gated on the
 * special: the user form's Department dropdown needs this list. The retired
 * rows are a management view and need the special, as on every other path.
 */
export async function listDepartments(
  principal: Principal,
  opts: ListDepartmentsOptions = {},
): Promise<DepartmentDto[]> {
  if (opts.includeDeleted) assertConfigPermission(principal, DEPARTMENT_CONFIG_TYPE);

  const rows = await prisma.department.findMany({
    where: opts.includeDeleted ? {} : { isDeleted: false },
    orderBy: { name: 'asc' },
    select: { ...DEPARTMENT_SELECT, _count: { select: { users: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    userCount: row._count.users,
    isDeleted: row.isDeleted,
  }));
}

// ── writes ────────────────────────────────────────────────────────────────

export async function createDepartment(
  principal: Principal,
  input: DepartmentCreateInput,
): Promise<DepartmentDto> {
  assertConfigPermission(principal, DEPARTMENT_CONFIG_TYPE);
  await assertNameFree(input.name, null);

  const { result } = await conflictAware(input.name, () =>
    applyConfigChange<DepartmentRow>({
      principal,
      configType: DEPARTMENT_CONFIG_TYPE,
      action: 'CREATE',
      before: async () => null,
      mutate: async (tx) => {
        const created = await tx.department.create({
          data: { name: input.name },
          select: DEPARTMENT_SELECT,
        });
        return { result: created, configId: created.id };
      },
      after: (tx, configId) => snapshot(tx, configId),
    }),
  );

  return toDto(result);
}

export async function updateDepartment(
  principal: Principal,
  departmentId: string,
  input: DepartmentUpdateInput,
): Promise<DepartmentDto> {
  assertConfigPermission(principal, DEPARTMENT_CONFIG_TYPE);
  const department = await requireLiveDepartment(departmentId);

  // Nothing to change is not a change: an empty diff would sit in the undo
  // stack blocking the revert of the entry underneath it (see revert.ts).
  if (input.name === undefined || input.name === department.name) return toDto(department);
  await assertNameFree(input.name, departmentId);

  const { result } = await conflictAware(input.name, () =>
    applyConfigChange<DepartmentRow>({
      principal,
      configType: DEPARTMENT_CONFIG_TYPE,
      action: 'UPDATE',
      before: (tx) => snapshot(tx, departmentId),
      mutate: async (tx) => {
        const updated = await tx.department.update({
          where: { id: departmentId },
          data: { name: input.name },
          select: DEPARTMENT_SELECT,
        });
        return { result: updated, configId: departmentId };
      },
      after: (tx) => snapshot(tx, departmentId),
    }),
  );

  return toDto(result);
}

/**
 * Retire a department. Soft, always (invariant 4), and its people stay
 * attached — see the header. A department that still has users asks for
 * confirmation (409, carrying the count) because every DEPARTMENT-scoped
 * role reading against it is about to lose that boundary's meaning.
 */
export async function softDeleteDepartment(
  principal: Principal,
  departmentId: string,
  opts: SoftDeleteDepartmentOptions = {},
): Promise<void> {
  assertConfigPermission(principal, DEPARTMENT_CONFIG_TYPE);
  const department = await requireLiveDepartment(departmentId);

  const userCount = await prisma.user.count({ where: { departmentId } });
  if (userCount > 0 && !opts.confirmed) {
    throw new ConfigError(
      `"${department.name}" still has ${userCount} user(s) — confirm to retire it anyway`,
      409,
      'CONFLICT',
      { userCount },
    );
  }

  await applyConfigChange<null>({
    principal,
    configType: DEPARTMENT_CONFIG_TYPE,
    action: 'DELETE',
    before: (tx) => snapshot(tx, departmentId),
    mutate: async (tx) => {
      await tx.department.update({ where: { id: departmentId }, data: { isDeleted: true } });
      return { result: null, configId: departmentId };
    },
    after: (tx) => snapshot(tx, departmentId),
  });
}

/** Restoring only ever ADDS capability, so there is no guard; the name stayed
 *  reserved while retired, so it cannot collide on the unique index. */
export async function restoreDepartment(
  principal: Principal,
  departmentId: string,
): Promise<DepartmentDto> {
  assertConfigPermission(principal, DEPARTMENT_CONFIG_TYPE);
  const department = await requireDepartment(departmentId);
  // Already live: nothing happened, so nothing is logged.
  if (!department.isDeleted) return toDto(department);

  const { result } = await applyConfigChange<DepartmentRow>({
    principal,
    configType: DEPARTMENT_CONFIG_TYPE,
    action: 'RESTORE',
    before: (tx) => snapshot(tx, departmentId),
    mutate: async (tx) => {
      const restored = await tx.department.update({
        where: { id: departmentId },
        data: { isDeleted: false },
        select: DEPARTMENT_SELECT,
      });
      return { result: restored, configId: departmentId };
    },
    after: (tx) => snapshot(tx, departmentId),
  });

  return toDto(result);
}

// ── helpers ───────────────────────────────────────────────────────────────

async function toDto(department: DepartmentRow): Promise<DepartmentDto> {
  const userCount = await prisma.user.count({ where: { departmentId: department.id } });
  return { ...department, userCount };
}

/** What goes into ConfigChangeLog.before/after — the row itself, which is
 *  exactly what the generic undo path writes back. */
async function snapshot(tx: Tx, departmentId: string): Promise<DepartmentRow> {
  const department = await tx.department.findUnique({
    where: { id: departmentId },
    select: DEPARTMENT_SELECT,
  });
  if (!department) throw new ConfigError('Department not found', 404, 'NOT_FOUND');
  return department;
}

async function requireDepartment(departmentId: string): Promise<DepartmentRow> {
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: DEPARTMENT_SELECT,
  });
  if (!department) throw new ConfigError('Department not found', 404, 'NOT_FOUND');
  return department;
}

/** A retired department is gone as far as every other write path is
 *  concerned: it cannot be renamed or retired twice. */
async function requireLiveDepartment(departmentId: string): Promise<DepartmentRow> {
  const department = await requireDepartment(departmentId);
  if (department.isDeleted) throw new ConfigError('Department not found', 404, 'NOT_FOUND');
  return department;
}

/**
 * `Department.name` is unique across soft-deleted rows too, so a name held by
 * a retired department is genuinely taken — answer 409 with that reason
 * rather than letting the insert surface as a 500.
 */
async function assertNameFree(name: string, exceptDepartmentId: string | null): Promise<void> {
  const clash = await prisma.department.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptDepartmentId ? { id: { not: exceptDepartmentId } } : {}),
    },
    select: { isDeleted: true },
  });
  if (!clash) return;

  throw new ConfigError(
    clash.isDeleted
      ? `A retired department still holds the name "${name}" — restore it or choose another`
      : `A department named "${name}" already exists`,
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
      throw new ConfigError(`A department named "${name}" already exists`, 409, 'CONFLICT');
    }
    throw err;
  }
}
