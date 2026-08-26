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
 * A), never ConfigChangeLog.
 *
 * Deactivation carries a fourth duty, added with the assignment engine: it
 * HANDS OVER the user's open records in the same transaction that switches
 * them off, and refuses with a 409 when it has nowhere to put them. Nothing is
 * ever unassigned (invariant 1), and nothing is ever left owned by somebody
 * who can no longer log in.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { PermissionEngine, StorageResolver, type FieldMeta } from '@crm/core';
import {
  buildRecordSchema,
  FIELD_TYPE_SPECS,
  HANDOVER_CLOSED_TAGS,
  normalisePhone,
  type FieldDef,
  type FieldType,
  type FieldValidation,
  type UserCreateInput,
  type UserUpdateInput,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { ASSIGNMENT_REASON_KEY, type AssignmentReason } from '@/lib/assignment';
import { audit } from '@/lib/audit';
import { hashPassword } from '@/lib/auth/passwords';
import { revokeAllSessions } from '@/lib/auth/session';
import { ConfigError, requireModule, type Tx } from '@/lib/config/service';
import { listRecords } from '@/lib/records/list';
import { plain, serialiseRecord, type RecordRow } from '@/lib/records/serialise';

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

/**
 * The reason a handover stamps on every record it moves.
 *
 * Typed against the assignment engine's vocabulary so the timeline speaks ONE
 * language about why a record changed hands, whoever moved it — the round
 * robin, a floor manager, or this.
 */
const HANDOVER_REASON: AssignmentReason = 'deactivation_handover';

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

/**
 * Deactivation answers with what it moved (spec §5.5).
 *
 * `ownedOpenRecords` is what is LEFT, which after a successful deactivation is
 * always zero — the call cannot succeed while the user still owns open work.
 * The number behind the reassignment PROMPT travels on the 409 instead, which
 * is the only moment a caller can act on it.
 */
export interface SetUserActiveResult {
  user: UserListItem;
  ownedOpenRecords: number;
  /** how many records the handover moved to the chosen user */
  reassigned: number;
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
 * The mirror of `requireAssignableRole`: a LOCKED role is the Admin role, so
 * ADMINISTERING an account that holds one — editing it, deactivating it,
 * resetting its password — is holding the keys to every permission in the
 * product. MANAGE_USERS_ROLES is delegable, and without this check a delegate
 * could reset the Admin's password and simply sign in as them, which is the
 * same escalation `requireAssignableRole` closes on the way up. `isLocked` is
 * the flag `isAdmin` derives from everywhere else — never a role name.
 */
function assertMayAdministerTarget(principal: Principal, targetRoleIsLocked: boolean): void {
  if (targetRoleIsLocked && !principal.actor.isAdmin) {
    throw new ConfigError('Only an Admin can administer an Admin account', 403, 'FORBIDDEN');
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
 * A reporting manager must be an ACTIVE account, and setting one must keep the
 * reporting graph a tree: the chain is read UPWARD, so any cycle — self, a
 * two-step swap, or a longer ring — would never terminate for whatever walks
 * it next. The walk follows the proposed manager's own chain; finding the user
 * being edited on it means the assignment would close a ring. A visited set
 * bounds the walk against rings already present in the data.
 */
async function assertReportingManager(managerId: string, selfId: string | null): Promise<void> {
  const refuse = (message: string): never => {
    throw new ConfigError(message, 400, 'VALIDATION', {
      fields: { reportingManagerId: [message] },
    });
  };

  if (selfId !== null && managerId === selfId) refuse('A user cannot report to themself');

  const manager = await prisma.user.findFirst({
    where: { id: managerId },
    select: { id: true, isActive: true, reportingManagerId: true },
  });
  if (!manager) refuse('Unknown reporting manager');
  if (!manager!.isActive) refuse('The chosen manager is deactivated');

  if (selfId !== null) {
    const visited = new Set<string>([managerId]);
    let cursor = manager!.reportingManagerId;
    while (cursor !== null) {
      if (cursor === selfId) refuse('That would make the reporting chain a loop');
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const next = await prisma.user.findUnique({
        where: { id: cursor },
        select: { reportingManagerId: true },
      });
      cursor = next?.reportingManagerId ?? null;
    }
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

// ── Admin-created fields (`User.custom`) ──────────────────────────────────

/**
 * The group-membership SHELL field's key. The field renders the membership UI
 * but stores nothing — membership lives in GroupMember rows and travels as
 * `groupIds`. The same name-gate `toListItem` reads (`'groups' in row`); if
 * that gate ever retires, this exclusion retires with it.
 */
const GROUP_SHELL_KEY = 'groups';

/** A live custom field, as validation wants it. */
interface CustomFieldRow {
  key: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
  validation: unknown;
  defaultValue: unknown;
  options: { value: string }[];
}

/**
 * The Profile module's WRITABLE custom fields — the Admin-created fields the
 * account path may store into `User.custom` (`systemColumn` null; a system
 * column is the fixed contract `userCreateSchema` already validates).
 *
 * Four exclusions, each because the account path cannot honour the type's
 * contract, so accepting a value would store something nothing can resolve:
 *  - derived types (FORMULA, AUTONUMBER): computed server-side, never
 *    submitted — the record engine drops them from its write contract too;
 *  - FILE / IMAGE: values are AttachmentRefs, and this path has no upload
 *    flow to mint one;
 *  - RECORD_LINK: no resolvable target here — a bare uuid checked against
 *    nothing could point at any row in any module;
 *  - the `groups` shell (see GROUP_SHELL_KEY above).
 */
async function writableCustomFields(moduleId: string): Promise<CustomFieldRow[]> {
  const rows = await prisma.fieldDefinition.findMany({
    // Soft-deleted fields keep their stored values (invariant 4) but are no
    // longer part of the contract. Retired picklist options likewise: the
    // historical value keeps rendering, a new write may not choose it.
    where: { moduleId, systemColumn: null, isDeleted: false },
    orderBy: { displayOrder: 'asc' },
    select: {
      key: true,
      label: true,
      type: true,
      isRequired: true,
      validation: true,
      defaultValue: true,
      options: { where: { isDeleted: false }, select: { value: true } },
    },
  });
  return rows.filter(
    (f) =>
      !FIELD_TYPE_SPECS[f.type].isDerived &&
      f.type !== 'FILE' &&
      f.type !== 'IMAGE' &&
      f.type !== 'RECORD_LINK' &&
      f.key !== GROUP_SHELL_KEY,
  );
}

/**
 * Validate a submitted `custom` bag against the module's live custom fields.
 *
 * The ONE validation path for Admin-created values on an account, generated
 * from FieldDefinition exactly like the record engine's: phones normalised to
 * the matching key BEFORE the E.164 check, configured defaults filled on
 * create for keys the payload did not mention, and `.partial()` semantics on
 * update — only sent keys validate, so an absent required field is not a
 * failure there, but a present one faces the same rules as on create.
 *
 * An unknown key THROWS, never dropped — the same rule as the filter
 * compiler: silently narrowing what a payload said it wrote is how a form
 * "saves" a value that never lands.
 *
 * Returns only the keys that were actually sent (plus create defaults), each
 * reduced by `plain()` so the blob and the audit trail hold JSON — a `Date`
 * stored raw would come back a string anyway, and the diff would log a change
 * that never happened on every later save.
 */
function validateCustom(
  submitted: Record<string, unknown>,
  fields: CustomFieldRow[],
  mode: 'create' | 'update',
): Record<string, unknown> {
  const known = new Set(fields.map((f) => f.key));
  const unknown = Object.keys(submitted).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new ConfigError('Unknown custom field', 400, 'VALIDATION', {
      fields: Object.fromEntries(
        unknown.map((key) => [key, [`Unknown field "${key}" on the users module`]]),
      ),
    });
  }

  const values: Record<string, unknown> = { ...submitted };
  for (const f of fields) {
    if (f.type === 'PHONE') {
      const raw = values[f.key];
      if (typeof raw === 'string' && raw.trim() !== '') values[f.key] = normalisePhone(raw);
    }
    if (mode === 'create' && f.defaultValue !== null && f.defaultValue !== undefined) {
      if (values[f.key] === undefined) values[f.key] = f.defaultValue;
    }
  }

  const defs: FieldDef[] = fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    isRequired: f.isRequired,
    validation: (f.validation ?? null) as FieldValidation | null,
    options: f.options,
  }));
  const schema = buildRecordSchema(defs);
  // A ZodError from here leaves as guarded()'s uniform 400 VALIDATION with
  // per-field messages, keyed by field key — same shape as the unknown-key
  // refusal above.
  const parsed = (
    mode === 'create' ? schema.parse(values) : schema.partial().parse(values)
  ) as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (values[f.key] === undefined) continue; // never sent, no default
    out[f.key] = plain(parsed[f.key] ?? null);
  }
  return out;
}

/** `User.custom` as a plain object — the column is Json, so the type system
 *  only knows "some JSON". Anything else (a hand-written scalar) reads empty. */
function customBlob(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    // The same 'groups' shell key as GROUP_SHELL_KEY — the two retire together.
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
 *
 * The custom blob is spread PER KEY, never as one value: `audit.diff` compares
 * top-level keys, so this is what makes an `employee_code` edit read as its
 * own line on the timeline rather than as "custom changed". Spread FIRST so a
 * custom field whose key collides with a snapshot key (an Admin could mint
 * `groupIds`) can never mask the account's own value.
 */
function snapshot(user: UserRow, groupIds: string[]): Record<string, unknown> {
  return {
    ...customBlob(user.custom),
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    roleId: user.roleId,
    departmentId: user.departmentId,
    reportingManagerId: user.reportingManagerId,
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

/**
 * One account, in the shape the ADMIN's edit form needs: the system columns as
 * ids (roleId, not a role name) plus the group membership, which lives in
 * GroupMember rather than on the row and so is invisible to the record read.
 *
 * Gated on MANAGE_USERS_ROLES rather than the view scope on purpose: this is
 * the write-side read — it exists to fill a form that only a manage-users
 * holder may submit, and it exposes exactly the columns that form can write.
 * The password hash is not selected and has no business here.
 */
export interface UserAccount {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  roleId: string;
  departmentId: string | null;
  reportingManagerId: string | null;
  languages: string[];
  isActive: boolean;
  groupIds: string[];
  /**
   * Admin-created field values, the raw `User.custom` blob keyed by field key
   * — what the form's dynamic fields edit and the PATCH's `custom` bag writes
   * back. Raw because this read is already gated: MANAGE_USERS_ROLES plus the
   * locked-role check above cover everything the account form touches.
   */
  custom: Record<string, unknown>;
}

/** The field keys the account form reads and writes — the seeded system
 *  fields of the Profile module, whose keys equal their columns. */
const ACCOUNT_CONTRACT_KEYS = [
  'fullName',
  'email',
  'phone',
  'roleId',
  'departmentId',
  'reportingManagerId',
  'languages',
  'isActive',
  'groups',
] as const;

export async function getUserAccount(principal: Principal, userId: string): Promise<UserAccount> {
  assertManageUsers(principal);

  // Hidden fields never leave the server — CLAUDE.md makes that a security
  // rule, and this endpoint returns raw columns rather than going through the
  // serialiser. Nulling the hidden ones instead would arm a different trap:
  // the form resubmits every key, so a null it was handed becomes a clear it
  // never meant. A role whose matrix hides part of the account contract is
  // refused outright — the config is contradictory, and fail-closed is the
  // only honest answer.
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const hidden = engine.hiddenFields(USERS_MODULE_SLUG);
  if (ACCOUNT_CONTRACT_KEYS.some((key) => hidden.has(key))) {
    throw new ConfigError(
      'Your role hides fields this form edits, so accounts cannot be opened for editing',
      403,
      'FORBIDDEN',
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
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
      role: { select: { isLocked: true } },
      // LIVE memberships only. A soft-deleted group keeps its member rows so a
      // restore brings the team back (invariant 4), but the form can only offer
      // live groups — handing it a dead id would put an uncheckable value in
      // every save payload, and `assertGroupsExist` would then refuse every
      // edit of this account for a checkbox nobody can see.
      groups: { where: { group: { isDeleted: false } }, select: { groupId: true } },
    },
  });
  if (!user) throw new ConfigError('Unknown user', 404, 'NOT_FOUND');
  // The read is part of administering the account: the same locked-role rule
  // as the writes, or a delegate could still pull the Admin's login identity.
  assertMayAdministerTarget(principal, user.role.isLocked);

  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    roleId: user.roleId,
    departmentId: user.departmentId,
    reportingManagerId: user.reportingManagerId,
    languages: user.languages,
    isActive: user.isActive,
    groupIds: user.groups.map((g) => g.groupId).sort(),
    custom: customBlob(user.custom),
  };
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
  if (input.reportingManagerId) await assertReportingManager(input.reportingManagerId, null);
  await assertGroupsExist(input.groupIds);
  await assertEmailAvailable(input.email, null);

  // The Admin's own fields, validated by the field engine — the account
  // schema carries the bag opaquely because it cannot know fields that did
  // not exist until an Admin created them.
  const custom =
    input.custom !== undefined
      ? validateCustom(input.custom, await writableCustomFields(module.id), 'create')
      : null;

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
          reportingManagerId: input.reportingManagerId ?? null,
          languages: input.languages,
          isActive: input.isActive,
          ...(custom ? { custom: custom as Prisma.InputJsonObject } : {}),
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
    select: {
      ...USER_SELECT,
      role: { select: { isLocked: true } },
      // Live memberships only, mirroring the replacement below — otherwise the
      // audit diff would claim a soft-deleted group's membership was removed
      // when its row in fact survives for the restore.
      groups: { where: { group: { isDeleted: false } }, select: { groupId: true } },
    },
  });
  if (!existing) throw new ConfigError('Unknown user', 404, 'NOT_FOUND');
  assertMayAdministerTarget(principal, existing.role.isLocked);

  const movingRole = input.roleId !== undefined && input.roleId !== existing.roleId;
  if (movingRole && input.roleId) await requireAssignableRole(principal, input.roleId);
  if (input.departmentId) await assertDepartmentExists(input.departmentId);
  if (input.reportingManagerId) await assertReportingManager(input.reportingManagerId, userId);
  if (input.groupIds) await assertGroupsExist(input.groupIds);
  if (input.email !== undefined && input.email !== existing.email) {
    await assertEmailAvailable(input.email, userId);
  }

  // The custom bag is a PATCH within the PATCH: only sent keys were validated,
  // `null` clears a key, everything else merges over the stored blob. Written
  // only when the merge actually changed something, so a form that resubmits
  // what it read neither rewrites the row nor invents a timeline entry.
  const beforeCustom = customBlob(existing.custom);
  let afterCustom = beforeCustom;
  if (input.custom !== undefined) {
    const patch = validateCustom(input.custom, await writableCustomFields(module.id), 'update');
    const merged = { ...beforeCustom };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    // Key order survives a spread-plus-overwrite, so an unchanged merge
    // stringifies identically to what was read.
    if (JSON.stringify(merged) !== JSON.stringify(beforeCustom)) afterCustom = merged;
  }
  const customChanged = afterCustom !== beforeCustom;

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

      // Deactivating here carries the third consequence too: nothing may be
      // left owned by a deactivated user (spec §5.5, invariant 1). A field
      // edit is not a handover — it has nowhere to name a target — so this
      // path refuses and sends the caller to the operation that can move the
      // work, rather than quietly stranding it.
      if (deactivating) {
        const ownedOpenRecords = await countOwnedOpenRecords(tx, userId);
        if (ownedOpenRecords > 0) {
          throw new ConfigError(
            `This user still owns ${ownedOpenRecords} open record(s); deactivate them from the account controls and choose who takes them over`,
            409,
            'CONFLICT',
            { ownedOpenRecords },
          );
        }
      }

      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
          ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
          ...(input.departmentId !== undefined ? { departmentId: input.departmentId ?? null } : {}),
          ...(input.reportingManagerId !== undefined
            ? { reportingManagerId: input.reportingManagerId ?? null }
            : {}),
          ...(input.languages !== undefined ? { languages: input.languages } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(customChanged ? { custom: afterCustom as Prisma.InputJsonObject } : {}),
        },
        select: USER_SELECT,
      });

      if (input.groupIds) {
        // Replaced wholesale rather than diffed: GroupMember carries nothing
        // but the pair, so there is no state to preserve, and one delete plus
        // one insert inside the transaction cannot leave a half-applied set.
        // LIVE memberships only: a soft-deleted group retains its member rows
        // so a restore brings the team back (invariant 4), and the form was
        // never shown those — an account edit must not quietly erase them.
        await tx.groupMember.deleteMany({ where: { userId, group: { isDeleted: false } } });
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
 * Activate or deactivate an account, and hand over what the user was working.
 *
 * Its own operation because deactivation is not a field edit: it trips the
 * last-admin guardrail, it kills every live session, and it MOVES WORK. Spec
 * §5.5 has the system prompting for a reassignment target; the prompt is the
 * 409 this raises when the user still owns open records and no target was
 * given, and `reassignToUserId` is the answer coming back.
 *
 * The handover and the deactivation are one transaction, in that order. There
 * is no ordering in which an inactive user owns live work, and no partial
 * outcome where some of it moved: nothing is ever unassigned (invariant 1),
 * and nothing is ever owned by somebody who cannot log in.
 */
export async function setUserActive(
  principal: Principal,
  userId: string,
  isActive: boolean,
  reassignToUserId?: string | null,
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
  assertMayAdministerTarget(principal, existing.role.isLocked);

  // An activation has nothing to hand over, so a target sent with one is
  // ignored rather than acted on — moving records is not what was asked for.
  const handoverTo = isActive ? null : (reassignToUserId ?? null);
  if (handoverTo !== null) {
    // Proved before the transaction opens: the caller's mistake costs one
    // query, not a rolled-back handover.
    if (handoverTo === userId) {
      throw new ConfigError(
        'Choose somebody other than the user being deactivated',
        422,
        'VALIDATION',
        { fields: { reassignToUserId: ['Choose a different user'] } },
      );
    }
    const target = await prisma.user.findFirst({
      where: { id: handoverTo, isActive: true },
      select: { id: true },
    });
    if (!target) {
      throw new ConfigError('The chosen user is not active', 422, 'VALIDATION', {
        fields: { reassignToUserId: ['The chosen user is not active'] },
      });
    }
  }

  const { user: updated, reassigned } = await prisma.$transaction(
    async (tx) => {
      if (!isActive && existing.role.isLocked) await assertAnotherAdminRemains(tx, userId);

      // BEFORE the flip, in the same transaction. Refuses with a 409 when
      // there is work to move and nowhere to move it.
      const moved = isActive ? 0 : await handOverOpenRecords(tx, principal, userId, handoverTo);

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
      return { user, reassigned: moved };
    },
    // Only the handover needs a larger budget: at the design target a floor
    // rep can own thousands of open leads, and Prisma's 5s default is sized
    // for a single-row write. A deactivation with nothing to move stays on
    // the defaults.
    handoverTo === null ? {} : { timeout: 120_000, maxWait: 10_000 },
  );

  // Deactivation must take effect now, not when an access token happens to
  // expire. `loadPrincipal` already refuses an inactive user, so this closes
  // the refresh path behind it.
  if (!isActive) await revokeAllSessions(userId);

  return {
    user: await present(engine, module, fields, updated),
    // Zero by construction on the way out: a deactivation that left anything
    // behind would have been refused above.
    ownedOpenRecords: 0,
    reassigned,
  };
}

// ── password reset (spec §5.5) ────────────────────────────────────────────

/**
 * Reset an account's password to a value the Admin chose or generated.
 *
 * Three consequences, in order:
 *  - the hash is replaced (bcrypt runs OUTSIDE the transaction, same as
 *    create — see the note there);
 *  - a PASSWORD_RESET entry lands in the append-only log WITH NO DIFF: that a
 *    reset happened, by whom and when, is the timeline's business — the value
 *    never is (CLAUDE.md forbids logging credentials, and this log can never
 *    be amended);
 *  - every live session dies, because a reset usually means "this account may
 *    be in the wrong hands" and the old credential must stop working NOW, not
 *    when a token expires.
 *
 * The plaintext is returned to the caller ONCE, for the Admin to hand to the
 * user. It is never stored and cannot be read back later — there is nothing to
 * read back.
 */
export async function resetUserPassword(
  principal: Principal,
  userId: string,
  password: string,
): Promise<{ user: UserListItem; password: string }> {
  assertManageUsers(principal);

  const module = await requireModule(USERS_MODULE_SLUG);
  const engine = new PermissionEngine(principal.actor, principal.permissions);
  const fields = await userFields(module.id);

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: { select: { isLocked: true } } },
  });
  if (!existing) throw new ConfigError('Unknown user', 404, 'NOT_FOUND');
  // Resetting a password IS taking the account over — a delegate must never
  // be able to do that to an Admin.
  assertMayAdministerTarget(principal, existing.role.isLocked);

  const passwordHash = await hashPassword(password);

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      // The stamp is what makes "signed out everywhere" true NOW rather than
      // when the access token expires: the session layer refuses any token
      // minted before it. Revoking refresh rows alone closes only the renewal
      // path, not the live 15-minute window.
      data: { passwordHash, credentialsChangedAt: new Date() },
      select: USER_SELECT,
    });
    await tx.auditLog.create({
      data: {
        entityType: USER_ENTITY_TYPE,
        entityId: userId,
        action: 'PASSWORD_RESET',
        actorType: 'USER',
        actorId: principal.actor.userId,
      },
    });
    return user;
  });

  await revokeAllSessions(userId);

  return { user: await present(engine, module, fields, updated), password };
}

// ── handover (spec §5.5) ──────────────────────────────────────────────────

/**
 * The statuses that mean "this record needs nobody".
 *
 * Read as TAGS, never as names — the Admin renames statuses at will, and a
 * rename must not change who gets handed over. `Record.statusId` has no
 * relation in the schema, so the same set also travels as ids for that table.
 */
async function closedStatuses(db: Tx): Promise<{
  tags: (typeof HANDOVER_CLOSED_TAGS)[number][];
  ids: string[];
}> {
  const tags = [...HANDOVER_CLOSED_TAGS];
  const rows = await db.status.findMany({ where: { tag: { in: tags } }, select: { id: true } });
  return { tags, ids: rows.map((s) => s.id) };
}

type ClosedStatuses = Awaited<ReturnType<typeof closedStatuses>>;

/**
 * Every table that physically carries an `ownerId`, as one uniform list.
 *
 * A STORAGE fact from schema.prisma (Lead.ownerId, Deal.ownerId,
 * Record.ownerId), not a module list: every Admin-created module lands in
 * `record` and is counted, moved and logged here without this function being
 * touched. `entityType` is the Prisma MODEL name the timeline reader resolves,
 * never a module slug — slugs are Admin-editable data.
 *
 * Closures per delegate keep each query typed against its own model while the
 * caller iterates one list. `ids` is paged and `reassign` is id-scoped rather
 * than `{ ownerId }`-scoped: that pairing is what lets the handover move a
 * page and write exactly that page's timeline entries, so invariant 2 holds
 * wherever the loop stops.
 *
 * Only OPEN records are in scope. A converted or lost record keeps the owner
 * who worked it — that is the historical credit performance reports count
 * (spec §7.1 makes the same choice with `Deal.closedById`), and moving it
 * would rewrite who closed what.
 */
function ownedOpenReferences(db: Tx, userId: string, closed: ClosedStatuses) {
  return [
    {
      entityType: 'Lead',
      count: () =>
        db.lead.count({
          where: { ownerId: userId, isDeleted: false, status: { tag: { notIn: closed.tags } } },
        }),
      ids: (take: number) =>
        db.lead.findMany({
          where: { ownerId: userId, isDeleted: false, status: { tag: { notIn: closed.tags } } },
          select: { id: true },
          take,
        }),
      reassign: (to: string, ids: string[]) =>
        db.lead.updateMany({ where: { id: { in: ids } }, data: { ownerId: to } }),
    },
    {
      entityType: 'Deal',
      count: () =>
        db.deal.count({
          where: { ownerId: userId, isDeleted: false, status: { tag: { notIn: closed.tags } } },
        }),
      ids: (take: number) =>
        db.deal.findMany({
          where: { ownerId: userId, isDeleted: false, status: { tag: { notIn: closed.tags } } },
          select: { id: true },
          take,
        }),
      // `Deal.closedById` is deliberately untouched: the deal owner changes,
      // the permanent credit for the conversion does not (spec §7.1).
      reassign: (to: string, ids: string[]) =>
        db.deal.updateMany({ where: { id: { in: ids } }, data: { ownerId: to } }),
    },
    {
      entityType: 'Record',
      count: () =>
        db.record.count({
          where: {
            ownerId: userId,
            isDeleted: false,
            // A record with no status at all is still open.
            OR: [{ statusId: null }, { statusId: { notIn: closed.ids } }],
          },
        }),
      ids: (take: number) =>
        db.record.findMany({
          where: {
            ownerId: userId,
            isDeleted: false,
            OR: [{ statusId: null }, { statusId: { notIn: closed.ids } }],
          },
          select: { id: true },
          take,
        }),
      reassign: (to: string, ids: string[]) =>
        db.record.updateMany({ where: { id: { in: ids } }, data: { ownerId: to } }),
    },
  ];
}

/** Page size of the handover drain loop: ids are read, moved and given their
 *  timeline entry (invariant 2) one page at a time, so neither the id list nor
 *  a createMany payload is ever unbounded. */
const HANDOVER_BATCH = 1000;

/**
 * Ceiling on how many records one interactive deactivation may move.
 *
 * The move must finish inside the transaction that deactivates the user —
 * a half-moved handover would leave an inactive user owning live work, which
 * is exactly what invariant 1 forbids — and past this many rows it will not,
 * on a pooled cross-region connection. Refusing beats rolling back minutes of
 * work the Admin already believes succeeded.
 */
export const HANDOVER_LIMIT = 100_000;

/**
 * How many live records this user still owns — the number behind the
 * reassignment prompt (spec §5.5, §13).
 */
async function countOwnedOpenRecords(db: Tx, userId: string): Promise<number> {
  const closed = await closedStatuses(db);
  const counts = await Promise.all(ownedOpenReferences(db, userId, closed).map((ref) => ref.count()));
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Move every open record off a user who is being deactivated.
 *
 * Runs INSIDE the deactivation's own transaction, before the `isActive` flip,
 * so there is no window — not one millisecond, not one failed request — in
 * which an inactive user owns live work. If no target was given and there is
 * anything to move, the whole deactivation is refused with a 409 carrying the
 * count, which is the prompt spec §5.5 describes.
 *
 * Every moved record gets its own REASSIGNED entry (invariant 2): a rep
 * opening a lead tomorrow has to see that it arrived, from whom, and why.
 */
async function handOverOpenRecords(
  tx: Tx,
  principal: Principal,
  fromUserId: string,
  toUserId: string | null,
): Promise<number> {
  if (toUserId === null) {
    const ownedOpenRecords = await countOwnedOpenRecords(tx, fromUserId);
    // Nothing to hand over: the deactivation proceeds without a target, which
    // is the common case for an account that never worked a lead.
    if (ownedOpenRecords === 0) return 0;
    throw new ConfigError(
      `This user still owns ${ownedOpenRecords} open record(s); choose who should take them over`,
      409,
      'CONFLICT',
      { ownedOpenRecords },
    );
  }

  const closed = await closedStatuses(tx);
  let moved = 0;
  for (const ref of ownedOpenReferences(tx, fromUserId, closed)) {
    // Drain loop: read one page of ids still owned by this user, move exactly
    // those ids, write exactly their timeline entries, repeat. No cursor is
    // needed — every pass removes its own rows from the `{ ownerId }`
    // predicate. Re-read inside the tx rather than reusing a pre-check count,
    // so a record created underneath the handover moves too.
    for (;;) {
      const rows = await ref.ids(HANDOVER_BATCH);
      if (rows.length === 0) break;

      moved += rows.length;
      if (moved > HANDOVER_LIMIT) {
        throw new ConfigError(
          `This user owns more than ${HANDOVER_LIMIT} open records, more than one request can move; contact support to hand them over in the background`,
          422,
          'GUARDRAIL',
          { limit: HANDOVER_LIMIT },
        );
      }

      const ids = rows.map(({ id }) => id);
      await ref.reassign(toUserId, ids);

      const entries: Prisma.AuditLogCreateManyInput[] = ids.map((id) => ({
        entityType: ref.entityType,
        entityId: id,
        action: 'REASSIGNED',
        actorType: 'USER',
        actorId: principal.actor.userId,
        changes: {
          // The physical column, not a module's owner FIELD key: one handover
          // spans every owner-bearing table at once, and resolving three
          // modules' field configs inside a transaction that may be moving
          // thousands of rows would cost more than it explains. The seeded
          // Leads and Deals field is keyed `ownerId` anyway, so the timeline
          // reads the same either way.
          ownerId: { from: fromUserId, to: toUserId },
          // WHY, so the timeline explains a move nobody on the floor asked for.
          [ASSIGNMENT_REASON_KEY]: { from: null, to: HANDOVER_REASON },
        } as unknown as Prisma.InputJsonObject,
      }));
      await tx.auditLog.createMany({ data: entries });
    }
  }

  return moved;
}
