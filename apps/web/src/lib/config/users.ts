/**
 * The Profile module's user administration (spec §5.4, §5.5).
 *
 * Three things make this file safe rather than careful:
 *
 *  - **Reads go through the scoped repository.** `listUsers` calls
 *    `listRecords`, so the `users` module obeys the same `scopeFilter` as every
 *    other module — a role scoped OWN sees itself, DEPARTMENT sees its
 *    department, and a role with no permission row on `users` sees nothing,
 *    without this file asserting anything.
 *  - **Nothing is hand-picked out of the row.** The password hash is absent
 *    because the projection is built from FieldDefinition and because
 *    `NEVER_SERIALISED` drops it again on the way out — not because a `select`
 *    here happens to omit it.
 *  - **Writes are guarded and logged.** Account administration is Admin-only
 *    at launch and delegated by MANAGE_USERS_ROLES; every write lands in the
 *    append-only AuditLog in the same transaction as the mutation.
 *
 * Users are business data, not configuration: they belong in AuditLog (layer
 * A), never ConfigChangeLog. Reassignment of a deactivated user's records is
 * deliberately NOT here — this service reports the count and the assignment
 * slice owns the move.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine, StorageResolver, type FieldMeta } from '@crm/core';
import {
  HANDOVER_CLOSED_TAGS,
  type UserCreateInput,
  type UserUpdateInput,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { audit } from '@/lib/audit';
import { hashPassword } from '@/lib/auth/passwords';
import { revokeAllSessions } from '@/lib/auth/session';
import { ConfigError, requireModule, type Tx } from '@/lib/config/service';
import { listRecords } from '@/lib/records/list';
import { serialiseRecord, type RecordRow } from '@/lib/records/serialise';

/**
 * The one slug this file names. A core module's slug IS its storage identity —
 * `StorageResolver` already resolves `users` to the `user` table that way — so
 * the fact lives in one constant here rather than being spelled out at each
 * call site. Nothing else about the module is assumed: its fields, its label
 * and its permissions are all read from config.
 */
const USERS_MODULE_SLUG = 'users';

/**
 * AuditLog entityType. The Prisma MODEL name, never a module slug: slugs are
 * Admin-editable and the timeline must stay readable after a rename.
 */
const USER_ENTITY_TYPE = 'User';

/** Ceiling on one page of users. A hand-edited `?take=100000` is a full scan. */
export const USERS_PAGE_MAX = 200;
const USERS_PAGE_DEFAULT = 100;

// ── outbound shape ────────────────────────────────────────────────────────

/**
 * What the users screen renders. Every field is nullable because every field
 * is hideable: a role whose matrix hides `email` on the Profile module gets
 * null here, since a hidden field never leaves the server.
 */
export interface UserListItem {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean | null;
  roleName: string | null;
  departmentName: string | null;
  groupNames: string[];
}

export interface UserListResult {
  users: UserListItem[];
  total: number;
}

/** Deactivation answers with the reassignment prompt's number (spec §5.5). */
export interface SetUserActiveResult {
  user: UserListItem;
  ownedOpenRecords: number;
}

/**
 * System columns this service reads. `passwordHash` is absent and must stay
 * absent — but that absence is the third lock, not the first: the projection
 * below is built from FieldDefinition, and `NEVER_SERIALISED` strips the key
 * whatever a config row says.
 */
const USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  roleId: true,
  departmentId: true,
  reportingManagerId: true,
  languages: true,
  isActive: true,
  custom: true,
} as const;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

// ── permission gates ──────────────────────────────────────────────────────

/**
 * Account creation, edits and deactivation start with Admin and are delegated
 * through MANAGE_USERS_ROLES (spec §5.5). Reads are NOT gated here — the view
 * scope on the `users` module governs those, in the repository.
 */
function assertManageUsers(principal: Principal): void {
  const allowed =
    principal.actor.isAdmin || principal.permissions.specials.has('MANAGE_USERS_ROLES');
  if (!allowed) {
    throw new ConfigError('Requires the "MANAGE_USERS_ROLES" permission', 403, 'FORBIDDEN');
  }
}

/**
 * Resolve a role the caller is allowed to hand out.
 *
 * A LOCKED role is the Admin role, and granting it hands over every permission
 * in the product. MANAGE_USERS_ROLES is delegable, so without this check a
 * delegate could mint an Admin account and walk straight past every view scope
 * they were given. `isLocked` is never read from a name — `isAdmin` is derived
 * from the same flag everywhere else.
 */
async function requireAssignableRole(principal: Principal, roleId: string): Promise<void> {
  const role = await prisma.role.findFirst({
    where: { id: roleId, isDeleted: false },
    select: { isLocked: true },
  });
  if (!role) {
    throw new ConfigError('Unknown role', 400, 'VALIDATION', { fields: { roleId: ['Unknown role'] } });
  }
  if (role.isLocked && !principal.actor.isAdmin) {
    throw new ConfigError('Only an Admin can grant the Admin role', 403, 'FORBIDDEN');
  }
}

/**
 * Last-admin protection (spec §13): the final ACTIVE user holding a locked
 * role cannot be deactivated or moved off it — there would be nobody left with
 * the rights to put them back.
 *
 * Runs inside the caller's transaction so two concurrent deactivations cannot
 * each see the other as the remaining Admin.
 */
async function assertAnotherAdminRemains(tx: Tx, userId: string): Promise<void> {
  const others = await tx.user.count({
    where: { id: { not: userId }, isActive: true, role: { isLocked: true } },
  });
  if (others === 0) {
    throw new ConfigError(
      'This is the last active Admin. Give another user the Admin role first.',
      422,
      'GUARDRAIL',
    );
  }
}

// ── referential checks ────────────────────────────────────────────────────

async function assertDepartmentExists(departmentId: string): Promise<void> {
  const department = await prisma.department.findFirst({
    where: { id: departmentId, isDeleted: false },
    select: { id: true },
  });
  if (!department) {
    throw new ConfigError('Unknown department', 400, 'VALIDATION', {
      fields: { departmentId: ['Unknown department'] },
    });
  }
}

async function assertGroupsExist(groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const found = await prisma.group.count({ where: { id: { in: groupIds }, isDeleted: false } });
  // Compared against the DEDUPED count: a payload repeating one id is not a
  // second group, and would otherwise fail a length check that is really about
  // whether every id resolves.
  if (found !== new Set(groupIds).size) {
    throw new ConfigError('One or more groups no longer exist', 400, 'VALIDATION', {
      fields: { groupIds: ['One or more groups no longer exist'] },
    });
  }
}

/**
 * Email is the login identity and is unique in the database. Checking first
 * turns a 500 into a field error; the P2002 catch on the write is what makes
 * it correct under a race.
 */
async function assertEmailAvailable(email: string, exceptUserId: string | null): Promise<void> {
  const clash = await prisma.user.findFirst({
    where: { email, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
    select: { id: true },
  });
  if (clash) {
    throw new ConfigError('That email address is already in use', 409, 'CONFLICT', {
      fields: { email: ['That email address is already in use'] },
    });
  }
}

/** Prisma's unique-violation code, raised when two creates race the check. */
function asEmailConflict(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConfigError('That email address is already in use', 409, 'CONFLICT', {
      fields: { email: ['That email address is already in use'] },
    });
  }
  throw err;
}

// ── presentation ──────────────────────────────────────────────────────────

/** The Profile module's live fields, as the storage layer wants them. */
async function userFields(moduleId: string): Promise<FieldMeta[]> {
  const rows = await prisma.fieldDefinition.findMany({
    // Soft-deleted config stays in the table forever (invariant 4) and must
    // never come back as a column.
    where: { moduleId, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: { key: true, type: true, systemColumn: true },
  });
  return rows.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn }));
}

interface UserRelations {
  roleName: string;
  departmentName: string | null;
  groupNames: string[];
}

/**
 * Resolve role, department and group LABELS for rows the repository already
 * allowed through. Scoped by `id in <those ids>`, so it cannot widen what the
 * scope filter decided — an empty id list queries nothing at all.
 */
async function relationsFor(ids: string[]): Promise<Map<string, UserRelations>> {
  if (ids.length === 0) return new Map();

  const rows = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      role: { select: { name: true } },
      department: { select: { name: true } },
      groups: { select: { group: { select: { name: true, isDeleted: true } } } },
    },
  });

  return new Map(
    rows.map((u) => [
      u.id,
      {
        roleName: u.role.name,
        departmentName: u.department?.name ?? null,
        groupNames: u.groups
          .filter((m) => !m.group.isDeleted)
          .map((m) => m.group.name)
          .sort((a, b) => a.localeCompare(b)),
      },
    ]),
  );
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Fold a serialised row and its resolved labels into the screen's shape.
 *
 * A label is gated on the presence of the id it came from: a role that may not
 * see `roleId` may not see the role's NAME either, or hiding the field would
 * be cosmetic — and hiding a field in the UI is not a security control.
 */
function toListItem(row: RecordRow, relations: UserRelations | undefined): UserListItem {
  return {
    id: row.id,
    fullName: text(row['fullName']),
    email: text(row['email']),
    phone: text(row['phone']),
    isActive: typeof row['isActive'] === 'boolean' ? row['isActive'] : null,
    roleName: 'roleId' in row ? (relations?.roleName ?? null) : null,
    departmentName: 'departmentId' in row ? (relations?.departmentName ?? null) : null,
    groupNames: 'groups' in row ? (relations?.groupNames ?? []) : [],
  };
}

/**
 * Present ONE user the caller just wrote. Goes through the same serialiser as
 * the list — the write path must not invent a second idea of what may leave
 * the server — and through the same storage resolver, so an Admin-created
 * field on the Profile module flattens out of `custom` exactly as it does on
 * the list screen.
 */
async function present(
  engine: PermissionEngine,
  module: { slug: string; isCore: boolean },
  fields: FieldMeta[],
  user: UserRow,
): Promise<UserListItem> {
  const resolver = new StorageResolver({ slug: module.slug, isCore: module.isCore, fields });
  const flat = resolver.flatten(user as unknown as Record<string, unknown>);
  // The id comes from the database row: an Admin may create a field keyed `id`
  // and `flatten` would have written its value over the record's identity.
  flat['id'] = user.id;

  const relations = await relationsFor([user.id]);
  return toListItem(serialiseRecord(engine, module.slug, flat, fields), relations.get(user.id));
}

// ── audit ─────────────────────────────────────────────────────────────────

/**
 * The state this service writes, as the timeline should read it. The password
 * is absent by construction: CLAUDE.md forbids logging one, AuditLog is
 * append-only, and a hash written into a diff could never be taken back out.
 */
function snapshot(user: UserRow, groupIds: string[]): Record<string, unknown> {
  return {
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    roleId: user.roleId,
    departmentId: user.departmentId,
    languages: user.languages,
    isActive: user.isActive,
    groupIds: [...groupIds].sort(),
  };
}

/**
 * Written through `tx`, not through the AuditLogger's own sink, so the entry
 * and the mutation commit together — a log that can diverge from the data is
 * not the timeline (invariant 2). The diff itself is the logger's, so every
 * layer-A entry in the product is shaped the same way.
 */
async function writeAudit(
  tx: Tx,
  principal: Principal,
  userId: string,
  action: 'RECORD_CREATED' | 'RECORD_UPDATED',
  changes: Record<string, { from: unknown; to: unknown }>,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: USER_ENTITY_TYPE,
      entityId: userId,
      action,
      actorType: 'USER',
      actorId: principal.actor.userId,
      changes: changes as unknown as Prisma.InputJsonObject,
    },
  });
}

// ── reads ─────────────────────────────────────────────────────────────────

export interface ListUsersOptions {
  take?: number;
  skip?: number;
}

/**
 * Users this actor may see.
 *
 * There is deliberately no permission assertion in this function: the `users`
 * module carries RolePermission rows like any other, and `listRecords` applies
 * `scopeFilter` in the repository. A caller with no row there gets an empty
 * page, because the engine's answer for "no permission" is a filter that
 * matches nothing — never an unfiltered query.
 */
export async function listUsers(
  principal: Principal,
  options: ListUsersOptions = {},
): Promise<UserListResult> {
  const module = await requireModule(USERS_MODULE_SLUG);
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const fields = await userFields(module.id);

  const take = Math.min(Math.max(options.take ?? USERS_PAGE_DEFAULT, 1), USERS_PAGE_MAX);
  const skip = Math.max(options.skip ?? 0, 0);

  const { rows, total } = await listRecords({
    module: { slug: module.slug, isCore: module.isCore },
    fields,
    engine,
    take,
    skip,
  });

  const relations = await relationsFor(rows.map((r) => r.id));
  return { users: rows.map((r) => toListItem(r, relations.get(r.id))), total };
}

// ── writes ────────────────────────────────────────────────────────────────

export async function createUser(
  principal: Principal,
  input: UserCreateInput,
): Promise<UserListItem> {
  assertManageUsers(principal);

  const module = await requireModule(USERS_MODULE_SLUG);
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const fields = await userFields(module.id);

  await requireAssignableRole(principal, input.roleId);
  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  await assertGroupsExist(input.groupIds);
  await assertEmailAvailable(input.email, null);

  // Hashing is deliberately OUTSIDE the transaction: bcrypt at cost 12 takes
  // hundreds of milliseconds, and holding a pooled cross-region connection
  // open for that is how a pool runs dry under a bulk import.
  const passwordHash = await hashPassword(input.password);
  const groupIds = [...new Set(input.groupIds)];

  const created = await prisma
    .$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: input.fullName,
          email: input.email,
          passwordHash,
          phone: input.phone ?? null,
          roleId: input.roleId,
          departmentId: input.departmentId ?? null,
          languages: input.languages,
          isActive: input.isActive,
        },
        select: USER_SELECT,
      });

      if (groupIds.length > 0) {
        await tx.groupMember.createMany({
          data: groupIds.map((groupId) => ({ userId: user.id, groupId })),
          skipDuplicates: true,
        });
      }

      await writeAudit(
        tx,
        principal,
        user.id,
        'RECORD_CREATED',
        audit.diff({}, snapshot(user, groupIds)),
      );
      return user;
    })
    .catch(asEmailConflict);

  return present(engine, module, fields, created);
}

export async function updateUser(
  principal: Principal,
  userId: string,
  input: UserUpdateInput,
): Promise<UserListItem> {
  assertManageUsers(principal);

  const module = await requireModule(USERS_MODULE_SLUG);
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const fields = await userFields(module.id);

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { ...USER_SELECT, role: { select: { isLocked: true } }, groups: { select: { groupId: true } } },
  });
  if (!existing) throw new ConfigError('Unknown user', 404, 'NOT_FOUND');

  const movingRole = input.roleId !== undefined && input.roleId !== existing.roleId;
  if (movingRole && input.roleId) await requireAssignableRole(principal, input.roleId);
  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.groupIds) await assertGroupsExist(input.groupIds);
  if (input.email !== undefined && input.email !== existing.email) {
    await assertEmailAvailable(input.email, userId);
  }

  // Deactivating through this route is the same act as the /active route, and
  // carries the same two consequences: the guardrail, and dead sessions.
  const deactivating = input.isActive === false && existing.isActive;
  const beforeGroupIds = existing.groups.map((g) => g.groupId);
  const afterGroupIds = input.groupIds ? [...new Set(input.groupIds)] : beforeGroupIds;

  const updated = await prisma
    .$transaction(async (tx) => {
      // Moving the last Admin off the locked role removes the last Admin —
      // the same guardrail as deactivating them (spec §13).
      if (existing.role.isLocked && (movingRole || deactivating)) {
        await assertAnotherAdminRemains(tx, userId);
      }

      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
          ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
          ...(input.departmentId !== undefined ? { departmentId: input.departmentId ?? null } : {}),
          ...(input.languages !== undefined ? { languages: input.languages } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        select: USER_SELECT,
      });

      if (input.groupIds) {
        // Replaced wholesale rather than diffed: GroupMember carries nothing
        // but the pair, so there is no state to preserve, and one delete plus
        // one insert inside the transaction cannot leave a half-applied set.
        await tx.groupMember.deleteMany({ where: { userId } });
        if (afterGroupIds.length > 0) {
          await tx.groupMember.createMany({
            data: afterGroupIds.map((groupId) => ({ userId, groupId })),
            skipDuplicates: true,
          });
        }
      }

      const changes = audit.diff(snapshot(existing, beforeGroupIds), snapshot(user, afterGroupIds));
      // A no-op edit writes no entry — the timeline is what happened, not what
      // was submitted.
      if (Object.keys(changes).length > 0) {
        await writeAudit(tx, principal, userId, 'RECORD_UPDATED', changes);
      }
      return user;
    })
    .catch(asEmailConflict);

  // After the commit: a session revoked for a transaction that then rolls back
  // would log a still-active user out for nothing.
  if (deactivating) await revokeAllSessions(userId);

  return present(engine, module, fields, updated);
}

/**
 * Activate or deactivate an account.
 *
 * Its own operation because deactivation is not a field edit: it trips the
 * last-admin guardrail, it kills every live session, and it owes the caller
 * the number of records left behind so the UI can prompt for a reassignment
 * target (spec §5.5). The reassignment itself belongs to the assignment slice.
 */
export async function setUserActive(
  principal: Principal,
  userId: string,
  isActive: boolean,
): Promise<SetUserActiveResult> {
  assertManageUsers(principal);

  const module = await requireModule(USERS_MODULE_SLUG);
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const fields = await userFields(module.id);

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true, role: { select: { isLocked: true } } },
  });
  if (!existing) throw new ConfigError('Unknown user', 404, 'NOT_FOUND');

  const updated = await prisma.$transaction(async (tx) => {
    if (!isActive && existing.role.isLocked) await assertAnotherAdminRemains(tx, userId);

    const user = await tx.user.update({
      where: { id: userId },
      data: { isActive },
      select: USER_SELECT,
    });

    if (existing.isActive !== isActive) {
      await writeAudit(tx, principal, userId, 'RECORD_UPDATED', {
        isActive: { from: existing.isActive, to: isActive },
      });
    }
    return user;
  });

  // Deactivation must take effect now, not when an access token happens to
  // expire. `loadPrincipal` already refuses an inactive user, so this closes
  // the refresh path behind it.
  if (!isActive) await revokeAllSessions(userId);

  return {
    user: await present(engine, module, fields, updated),
    // Only meaningful on the way out: an activation has nothing to hand over.
    ownedOpenRecords: isActive ? 0 : await countOwnedOpenRecords(userId),
  };
}

/**
 * How many live records this user still owns — the number behind the
 * reassignment prompt (spec §5.5, §13).
 *
 * The three tables here are the ones that PHYSICALLY carry an `ownerId`
 * (schema.prisma: Lead, Deal, Record). That is a storage fact, not a module
 * list: every Admin-created module lands in `record` and is counted without
 * this function being touched.
 *
 * "Open" reads the status TAG, never the name — a renamed status must not
 * change who gets handed over.
 */
async function countOwnedOpenRecords(userId: string): Promise<number> {
  const closedTags = [...HANDOVER_CLOSED_TAGS];

  // `Record.statusId` has no relation in the schema, so its tag filter has to
  // travel as ids; a record with no status at all is still open.
  const closedStatusIds = (
    await prisma.status.findMany({ where: { tag: { in: closedTags } }, select: { id: true } })
  ).map((s) => s.id);

  const [leads, deals, records] = await Promise.all([
    prisma.lead.count({
      where: { ownerId: userId, isDeleted: false, status: { tag: { notIn: closedTags } } },
    }),
    prisma.deal.count({
      where: { ownerId: userId, isDeleted: false, status: { tag: { notIn: closedTags } } },
    }),
    prisma.record.count({
      where: {
        ownerId: userId,
        isDeleted: false,
        OR: [{ statusId: null }, { statusId: { notIn: closedStatusIds } }],
      },
    }),
  ]);

  return leads + deals + records;
}
