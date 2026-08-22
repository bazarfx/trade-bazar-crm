/**
 * Groups — the Profile module's team sub-module (spec §5.3).
 *
 * A group is CONFIG, not business data: its name, its language and its member
 * list decide where every campaign lead in the business lands, and the Admin
 * edits all three without a deploy. So every write here travels through
 * `applyConfigChange` (configType GROUP) — the MANAGE_DEPARTMENTS_GROUPS
 * special is asserted there, the before/after snapshot lands in
 * ConfigChangeLog with undo support, and the mutation commits with its log in
 * one transaction.
 *
 * Three rules shape this file:
 *
 *   - A group is never hard-deleted and neither is its membership (invariant
 *     4). `Lead.groupId` and a decade of AuditLog diffs name group ids, and a
 *     restore has to bring the team back exactly as it was.
 *   - Membership writes also land on each PERSON's timeline. A group change
 *     is logged against the group; the question "when did Priya join the
 *     Hindi team?" is asked on Priya's record, so one AuditLog row per
 *     affected user is written in the same transaction.
 *   - Nothing here names a group, a language or a setting value. The default
 *     pool is whichever group `assignment.defaultPoolGroupId` points at.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type {
  GroupCreateInput,
  GroupDto,
  GroupMemberDto,
  GroupUpdateInput,
  GroupWriteResult,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import {
  applyConfigChange,
  assertConfigPermission,
  ConfigError,
  getSetting,
  type Tx,
} from '@/lib/config/service';

const GROUP_CONFIG_TYPE = 'GROUP' as const;

/**
 * AuditLog entityType for the per-person rows. The Prisma MODEL name, never a
 * module slug: slugs are Admin-editable and the timeline must stay readable
 * after a rename. Matches what `lib/config/users.ts` writes, so a person's
 * timeline is one stream.
 */
const USER_ENTITY_TYPE = 'User';

const GROUP_SELECT = { id: true, name: true, language: true, isDeleted: true } as const;
type GroupRow = Prisma.GroupGetPayload<{ select: typeof GROUP_SELECT }>;

const MEMBER_SELECT = {
  userId: true,
  user: {
    select: {
      fullName: true,
      email: true,
      isActive: true,
      role: { select: { name: true } },
    },
  },
} as const;
type MemberRow = Prisma.GroupMemberGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * What goes into ConfigChangeLog.before/after. Carries the member id list
 * alongside the scalars so a membership change has a readable diff and an
 * undo can replay the list (see revert.ts); the scalars write back through
 * the generic path, `memberIds` through `replaceGroupMembers` below.
 */
interface GroupSnapshot extends GroupRow {
  memberIds: string[];
}

export interface SoftDeleteGroupOptions {
  /** The Admin has seen the member count and still wants the group retired. */
  confirmed?: boolean;
}

// ── reads ─────────────────────────────────────────────────────────────────

export interface ListGroupsOptions {
  includeDeleted?: boolean;
}

/**
 * Every live group, with counts.
 *
 * Deliberately NOT gated on the config special: the user form's Groups
 * multi-select needs this list, and anyone who may edit a user may choose a
 * team for them. What IS gated is the retired rows — `includeDeleted` is a
 * management view, and a retired group is admin-only on every other path.
 */
export async function listGroups(
  principal: Principal,
  opts: ListGroupsOptions = {},
): Promise<GroupDto[]> {
  if (opts.includeDeleted) assertConfigPermission(principal, GROUP_CONFIG_TYPE);

  const [groups, activeCounts, defaultPoolGroupId] = await Promise.all([
    prisma.group.findMany({
      where: opts.includeDeleted ? {} : { isDeleted: false },
      orderBy: { name: 'asc' },
      select: { ...GROUP_SELECT, _count: { select: { members: true } } },
    }),
    // One aggregate for every group rather than a count per row: the list is
    // read on every open of the Profile screen and on every user form.
    prisma.groupMember.groupBy({
      by: ['groupId'],
      where: { user: { isActive: true } },
      _count: { _all: true },
    }),
    getSetting('assignment.defaultPoolGroupId'),
  ]);

  const activeByGroup = new Map(activeCounts.map((row) => [row.groupId, row._count._all]));

  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    language: group.language,
    memberCount: group._count.members,
    activeMemberCount: activeByGroup.get(group.id) ?? 0,
    isDefaultPool: group.id === defaultPoolGroupId,
    isDeleted: group.isDeleted,
  }));
}

/**
 * The team roster. Gated on the special rather than on the `users` view
 * scope: this is the management surface for a team, and it lists every
 * member's email regardless of whether the caller could see that person in
 * the users list.
 */
export async function listMembers(principal: Principal, groupId: string): Promise<GroupMemberDto[]> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  await requireGroup(prisma, groupId);
  return readMembers(prisma, groupId);
}

// ── group writes ──────────────────────────────────────────────────────────

export async function createGroup(principal: Principal, input: GroupCreateInput): Promise<GroupWriteResult> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  await assertNameFree(input.name, null);

  const { result } = await conflictAware(input.name, () =>
    applyConfigChange<GroupRow>({
      principal,
      configType: GROUP_CONFIG_TYPE,
      action: 'CREATE',
      before: async () => null,
      mutate: async (tx) => {
        const created = await tx.group.create({
          data: { name: input.name, language: input.language },
          select: GROUP_SELECT,
        });
        return { result: created, configId: created.id };
      },
      after: (tx, configId) => snapshot(tx, configId),
    }),
  );

  return present(result);
}

/** Rename, or point the group at a different language. */
export async function updateGroup(
  principal: Principal,
  groupId: string,
  input: GroupUpdateInput,
): Promise<GroupWriteResult> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  const group = await requireLiveGroup(groupId);

  const name = input.name ?? group.name;
  const language = input.language === undefined ? group.language : input.language;

  // Nothing to change is not a change: an empty diff would sit in the undo
  // stack blocking the revert of the entry underneath it (see revert.ts).
  if (name === group.name && language === group.language) return present(group);
  if (name !== group.name) await assertNameFree(name, groupId);

  const { result } = await conflictAware(name, () =>
    applyConfigChange<GroupRow>({
      principal,
      configType: GROUP_CONFIG_TYPE,
      action: 'UPDATE',
      before: (tx) => snapshot(tx, groupId),
      mutate: async (tx) => {
        const updated = await tx.group.update({
          where: { id: groupId },
          data: { name, language },
          select: GROUP_SELECT,
        });
        return { result: updated, configId: groupId };
      },
      after: (tx) => snapshot(tx, groupId),
    }),
  );

  return present(result);
}

/**
 * Retire a group. Soft, always: `Lead.groupId` and the AuditLog name this id
 * forever, and the membership rows are KEPT so a restore brings the team back
 * intact — a retired group has no members as far as assignment is concerned
 * (every engine query filters `group.isDeleted`), which is all "deleted" has
 * to mean.
 *
 * Two guardrails, with different answers:
 *   - the nominated default pool cannot be retired at all (422). Every lead no
 *     group and no senior claims falls to it; retiring it would drop that
 *     whole tier to the Admin silently, and the right move is to nominate
 *     another pool first.
 *   - a group with ACTIVE members asks for confirmation (409, carrying the
 *     count), because those people stop receiving that language's leads the
 *     moment this commits.
 */
export async function softDeleteGroup(
  principal: Principal,
  groupId: string,
  opts: SoftDeleteGroupOptions = {},
): Promise<void> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  const group = await requireLiveGroup(groupId);
  await assertNotNominated(group);

  const memberCount = await prisma.groupMember.count({
    where: { groupId, user: { isActive: true } },
  });
  if (memberCount > 0 && !opts.confirmed) {
    throw new ConfigError(
      `"${group.name}" still has ${memberCount} active member(s) — confirm to retire it anyway`,
      409,
      'CONFLICT',
      { memberCount },
    );
  }

  await applyConfigChange<null>({
    principal,
    configType: GROUP_CONFIG_TYPE,
    action: 'DELETE',
    before: (tx) => snapshot(tx, groupId),
    mutate: async (tx) => {
      await tx.group.update({ where: { id: groupId }, data: { isDeleted: true } });
      return { result: null, configId: groupId };
    },
    after: (tx) => snapshot(tx, groupId),
  });
}

/**
 * Bring a retired group back, members and all. Restoring only ever ADDS
 * capability, so there is no guard — and `Group.name` stays reserved while
 * soft-deleted, so a restore can never collide on the unique index.
 */
export async function restoreGroup(principal: Principal, groupId: string): Promise<GroupWriteResult> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  const group = await requireGroup(prisma, groupId);
  // Already live: nothing happened, so nothing is logged.
  if (!group.isDeleted) return present(group);

  const { result } = await applyConfigChange<GroupRow>({
    principal,
    configType: GROUP_CONFIG_TYPE,
    action: 'RESTORE',
    before: (tx) => snapshot(tx, groupId),
    mutate: async (tx) => {
      const restored = await tx.group.update({
        where: { id: groupId },
        data: { isDeleted: false },
        select: GROUP_SELECT,
      });
      return { result: restored, configId: groupId };
    },
    after: (tx) => snapshot(tx, groupId),
  });

  return present(result);
}

// ── membership writes ─────────────────────────────────────────────────────

/**
 * Add people to a team. Idempotent: a user already in the group is skipped,
 * never a unique-violation 500, so a double-submitted form is harmless. When
 * nobody new is named at all nothing is written and nothing is logged.
 */
export async function addMembers(
  principal: Principal,
  groupId: string,
  userIds: string[],
): Promise<GroupMemberDto[]> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  await requireLiveGroup(groupId);
  await assertUsersExist(userIds);

  const current = await memberIdSet(prisma, groupId);
  if (userIds.every((id) => current.has(id))) return readMembers(prisma, groupId);

  return changeMembership(principal, groupId, { add: userIds });
}

/** Remove people from a team. Idempotent the same way: an id that is not a
 *  member is a no-op, not an error. */
export async function removeMembers(
  principal: Principal,
  groupId: string,
  userIds: string[],
): Promise<GroupMemberDto[]> {
  assertConfigPermission(principal, GROUP_CONFIG_TYPE);
  await requireLiveGroup(groupId);

  const current = await memberIdSet(prisma, groupId);
  if (!userIds.some((id) => current.has(id))) return readMembers(prisma, groupId);

  return changeMembership(principal, groupId, { remove: userIds });
}

/**
 * Make the roster exactly `userIds` — the undo path's entry point, used by
 * revert.ts to replay a snapshotted member list. Runs inside the caller's
 * transaction and writes the same per-person timeline rows the forward path
 * does, so a person's record reads "removed from Hindi" whether an Admin did
 * it or an undo did.
 */
export async function replaceGroupMembers(
  tx: Tx,
  principal: Principal,
  groupId: string,
  userIds: readonly string[],
): Promise<void> {
  const target = new Set(userIds);
  const current = await memberIdSet(tx, groupId);
  await syncMembers(tx, principal, groupId, {
    add: [...target].filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !target.has(id)),
  });
}

interface MembershipChange {
  add?: readonly string[];
  remove?: readonly string[];
}

/** One membership gesture as one config change, snapshots either side. */
async function changeMembership(
  principal: Principal,
  groupId: string,
  change: MembershipChange,
): Promise<GroupMemberDto[]> {
  const { result } = await applyConfigChange<GroupMemberDto[]>({
    principal,
    configType: GROUP_CONFIG_TYPE,
    action: 'UPDATE',
    before: (tx) => snapshot(tx, groupId),
    mutate: async (tx) => {
      await syncMembers(tx, principal, groupId, change);
      return { result: await readMembers(tx, groupId), configId: groupId };
    },
    after: (tx) => snapshot(tx, groupId),
  });
  return result;
}

/**
 * The one place GroupMember rows are written for a group, and the one place
 * the per-person audit rows come from.
 *
 * Each affected user gets ONE AuditLog row on their own record — `groups:
 * { from, to }` being their full group-id list either side — written through
 * `tx` so it can never outlive a rolled-back write. The group's own log entry
 * is the caller's ConfigChangeLog row; this is the view from the person.
 */
async function syncMembers(
  tx: Tx,
  principal: Principal,
  groupId: string,
  change: MembershipChange,
): Promise<void> {
  const current = await memberIdSet(tx, groupId);
  const added = [...new Set(change.add ?? [])].filter((id) => !current.has(id));
  const removed = [...new Set(change.remove ?? [])].filter((id) => current.has(id));
  if (added.length === 0 && removed.length === 0) return;

  const affected = [...added, ...removed];
  const rows = await tx.groupMember.findMany({
    where: { userId: { in: affected } },
    select: { userId: true, groupId: true },
  });
  const groupsBefore = new Map<string, string[]>();
  for (const row of rows) {
    groupsBefore.set(row.userId, [...(groupsBefore.get(row.userId) ?? []), row.groupId]);
  }

  if (added.length > 0) {
    await tx.groupMember.createMany({
      data: added.map((userId) => ({ groupId, userId })),
      // The pre-filter above and a concurrent add can still race; the unique
      // index is the arbiter, and a duplicate is a no-op here, not a 500.
      skipDuplicates: true,
    });
  }
  if (removed.length > 0) {
    await tx.groupMember.deleteMany({ where: { groupId, userId: { in: removed } } });
  }

  const sorted = (ids: Iterable<string>): string[] => [...ids].sort();
  await tx.auditLog.createMany({
    data: affected.map((userId) => {
      const before = groupsBefore.get(userId) ?? [];
      const after = added.includes(userId)
        ? [...before, groupId]
        : before.filter((id) => id !== groupId);
      return {
        entityType: USER_ENTITY_TYPE,
        entityId: userId,
        action: 'CONFIG_CHANGED' as const,
        actorType: 'USER' as const,
        actorId: principal.actor.userId,
        changes: { groups: { from: sorted(before), to: sorted(after) } } as Prisma.InputJsonObject,
      };
    }),
  });
}

// ── the language guardrail ────────────────────────────────────────────────

/**
 * WHY A WARNING AND NOT A BLOCK.
 *
 * The assignment engine resolves a lead's language to the FIRST live group
 * carrying it, ordered by name (`findGroupForLanguage` in the assignment
 * ports). Two live groups sharing a language are therefore ambiguous: one of
 * them receives every campaign lead for that language and the other silently
 * receives none. That is exactly the kind of failure that looks like
 * "assignment is broken" with nothing in the timeline saying why.
 *
 * But spec §5.3 says groups are freeform. A second group for a language is a
 * legitimate thing to want — a team being split, a regional sub-team, a
 * rename mid-flight — and refusing it would be the product deciding something
 * the Admin is entitled to decide. So the write goes through and the result
 * names the overlap and which group wins, for the screen to show.
 */
async function languageWarning(group: GroupRow): Promise<string | undefined> {
  if (!group.language) return undefined;

  const sharing = await prisma.group.findMany({
    where: { isDeleted: false, language: { equals: group.language, mode: 'insensitive' } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  if (sharing.length < 2) return undefined;

  const winner = sharing[0]!;
  const others = sharing.filter((g) => g.id !== group.id).map((g) => `"${g.name}"`);
  const routing =
    winner.id === group.id
      ? `Campaign leads in ${group.language} now route to "${group.name}" only.`
      : `Campaign leads in ${group.language} route to "${winner.name}" only.`;
  return `${others.join(', ')} also serve${others.length === 1 ? 's' : ''} ${group.language}. ${routing}`;
}

// ── helpers ───────────────────────────────────────────────────────────────

async function present(group: GroupRow): Promise<GroupWriteResult> {
  const [dto, warning] = await Promise.all([toDto(group), languageWarning(group)]);
  return warning ? { group: dto, warning } : { group: dto };
}

async function toDto(group: GroupRow): Promise<GroupDto> {
  const [memberCount, activeMemberCount, defaultPoolGroupId] = await Promise.all([
    prisma.groupMember.count({ where: { groupId: group.id } }),
    prisma.groupMember.count({ where: { groupId: group.id, user: { isActive: true } } }),
    getSetting('assignment.defaultPoolGroupId'),
  ]);
  return {
    ...group,
    memberCount,
    activeMemberCount,
    isDefaultPool: group.id === defaultPoolGroupId,
  };
}

async function snapshot(tx: Tx, groupId: string): Promise<GroupSnapshot> {
  const group = await tx.group.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!group) throw new ConfigError('Group not found', 404, 'NOT_FOUND');
  return { ...group, memberIds: [...(await memberIdSet(tx, groupId))].sort() };
}

async function memberIdSet(client: Tx | typeof prisma, groupId: string): Promise<Set<string>> {
  const rows = await client.groupMember.findMany({ where: { groupId }, select: { userId: true } });
  return new Set(rows.map((row) => row.userId));
}

async function readMembers(client: Tx | typeof prisma, groupId: string): Promise<GroupMemberDto[]> {
  const rows: MemberRow[] = await client.groupMember.findMany({
    where: { groupId },
    orderBy: { user: { fullName: 'asc' } },
    select: MEMBER_SELECT,
  });
  return rows.map((row) => ({
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    isActive: row.user.isActive,
    roleName: row.user.role.name,
  }));
}

/** Any group, live or retired — the restore path and the roster need both. */
async function requireGroup(client: Tx | typeof prisma, groupId: string): Promise<GroupRow> {
  const group = await client.group.findUnique({ where: { id: groupId }, select: GROUP_SELECT });
  if (!group) throw new ConfigError('Group not found', 404, 'NOT_FOUND');
  return group;
}

/** A retired group is gone as far as every other write path is concerned:
 *  it cannot be renamed, re-pointed, staffed or retired twice. */
async function requireLiveGroup(groupId: string): Promise<GroupRow> {
  const group = await requireGroup(prisma, groupId);
  if (group.isDeleted) throw new ConfigError('Group not found', 404, 'NOT_FOUND');
  return group;
}

/**
 * The platform settings that may point at a group. Retiring a nominated group
 * would drop a whole routing tier to the Admin with nothing in the timeline
 * saying why; the right move is to nominate another group first.
 */
async function assertNotNominated(group: GroupRow): Promise<void> {
  const [defaultPoolGroupId, handover] = await Promise.all([
    getSetting('assignment.defaultPoolGroupId'),
    getSetting('deals.handoverRule'),
  ]);
  if (defaultPoolGroupId === group.id) {
    throw new ConfigError(
      `"${group.name}" is the default assignment pool — nominate another group in Settings first`,
      422,
      'GUARDRAIL',
    );
  }
  if (handover?.type === 'pool' && handover.id === group.id) {
    throw new ConfigError(
      `"${group.name}" receives converted deals — change the deal handover rule in Settings first`,
      422,
      'GUARDRAIL',
    );
  }
}

async function assertUsersExist(userIds: string[]): Promise<void> {
  const wanted = [...new Set(userIds)];
  const found = await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true } });
  if (found.length === wanted.length) return;
  const known = new Set(found.map((u) => u.id));
  throw new ConfigError('One or more users no longer exist', 400, 'VALIDATION', {
    fields: { userIds: ['One or more users no longer exist'] },
    unknownIds: wanted.filter((id) => !known.has(id)),
  });
}

/**
 * `Group.name` is unique across soft-deleted rows too, so a name held by a
 * retired group is genuinely taken — answer 409 with that reason rather than
 * letting the insert surface as a 500. Case-insensitive on purpose: "Hindi"
 * and "hindi" are one team to everybody except a byte comparison.
 */
async function assertNameFree(name: string, exceptGroupId: string | null): Promise<void> {
  const clash = await prisma.group.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      ...(exceptGroupId ? { id: { not: exceptGroupId } } : {}),
    },
    select: { isDeleted: true },
  });
  if (!clash) return;

  throw new ConfigError(
    clash.isDeleted
      ? `A retired group still holds the name "${name}" — restore it or choose another`
      : `A group named "${name}" already exists`,
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
      throw new ConfigError(`A group named "${name}" already exists`, 409, 'CONFLICT');
    }
    throw err;
  }
}
