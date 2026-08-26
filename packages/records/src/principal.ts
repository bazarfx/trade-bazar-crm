/**
 * WHO is asking, as every engine in this package needs it — and the one
 * function that builds it.
 *
 * The SHAPE used to live in `apps/web/src/lib/auth/actor.ts` behind
 * `import 'server-only'`, and a type-only import of it was the single thread
 * tying the record engine to the Next bundle. The BUILDER followed it here for
 * a harder reason: the import worker has no request, no cookie and no session,
 * but it still has to run as the user who uploaded the file. An import that
 * ran as a superuser would write rows past the importer's own view scope and
 * hand them owners they may not choose — a side door around the permission
 * matrix, opened by a spreadsheet.
 *
 * Nothing in here touches a request. `loadPrincipal` takes a user id and reads
 * the database; `getPrincipal()` in `apps/web/src/lib/auth/session.ts` is the
 * Next-side caller that gets that id out of a cookie, and the worker passes
 * `ImportBatch.userId` instead.
 */
import { prisma } from '@crm/db';
import type { ActorContext, SpecialPermission, ViewScope } from '@crm/shared';
import type { ActorType, ModulePermission, PermissionSet } from '@crm/core';

/** The audit identities that are not a person. `USER` is excluded because a
 *  human principal is built by `loadPrincipal` from a real row, never forged. */
export type SystemActorType = Exclude<ActorType, 'USER'>;

export interface Principal {
  actor: ActorContext;
  permissions: PermissionSet;
  user: {
    id: string;
    fullName: string;
    email: string;
    roleName: string;
    departmentName: string | null;
    languages: string[];
  };
  /**
   * When this account's credentials last changed (a password reset). Access
   * tokens are stateless, so the web session layer compares this against the
   * token's `iat` and refuses anything minted before it — the only way
   * "signed out everywhere" can be true before the token expires. Null when
   * the credentials never changed; null on system principals, which hold no
   * credentials at all.
   */
  credentialsChangedAt: Date | null;
  /**
   * Set ONLY by `systemPrincipal()`. When present, every audit row the record
   * engine writes carries this actorType with a NULL actorId, and nothing is
   * stamped `createdBy` — there is no human in the loop and the log must not
   * invent one. Absent on every principal built from a session or a user id.
   */
  system?: SystemActorType;
}

/** `{ hidden: [fieldId], readonly: [fieldId] }` as stored on RolePermission. */
interface FieldRules {
  hidden?: string[];
  readonly?: string[];
}

function parseFieldRules(raw: unknown): FieldRules {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as FieldRules;
  return {
    hidden: Array.isArray(r.hidden) ? r.hidden : [],
    readonly: Array.isArray(r.readonly) ? r.readonly : [],
  };
}

/**
 * Returns null when the user is missing or deactivated. A deactivated user's
 * live sessions stop working on their next request.
 */
export async function loadPrincipal(userId: string): Promise<Principal | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      department: { select: { name: true } },
      groups: { select: { groupId: true } },
      role: {
        include: {
          permissions: { include: { module: { select: { slug: true, id: true } } } },
          specials: true,
        },
      },
    },
  });

  if (!user || !user.isActive || user.role.isDeleted) return null;

  // Field rules store FieldDefinition ids; the engine strips by field KEY on
  // serialisation. Resolve once here so nothing downstream has to know.
  const ruleFieldIds = new Set<string>();
  for (const p of user.role.permissions) {
    const rules = parseFieldRules(p.fieldRules);
    rules.hidden?.forEach((id) => ruleFieldIds.add(id));
    rules.readonly?.forEach((id) => ruleFieldIds.add(id));
  }

  const keyById = new Map<string, string>();
  if (ruleFieldIds.size > 0) {
    const fields = await prisma.fieldDefinition.findMany({
      where: { id: { in: [...ruleFieldIds] } },
      select: { id: true, key: true },
    });
    for (const f of fields) keyById.set(f.id, f.key);
  }

  const toKeys = (ids: string[] | undefined): string[] =>
    (ids ?? []).map((id) => keyById.get(id) ?? id);

  const modules = new Map<string, ModulePermission>();
  for (const p of user.role.permissions) {
    const rules = parseFieldRules(p.fieldRules);
    modules.set(p.module.slug, {
      moduleSlug: p.module.slug,
      viewScope: p.viewScope as ViewScope,
      canCreate: p.canCreate,
      canEdit: p.canEdit,
      canDelete: p.canDelete,
      hiddenFields: toKeys(rules.hidden),
      readonlyFields: toKeys(rules.readonly),
    });
  }

  const actor: ActorContext = {
    userId: user.id,
    roleId: user.roleId,
    departmentId: user.departmentId,
    groupIds: user.groups.map((g) => g.groupId),
    // The seeded Admin role is the only locked role and the roles UI never
    // exposes `isLocked` for editing. Keying off the flag rather than the name
    // keeps this honest under the "never read a label" rule.
    isAdmin: user.role.isLocked,
  };

  return {
    actor,
    permissions: {
      modules,
      specials: new Set(user.role.specials.map((s) => s.permission as SpecialPermission)),
    },
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      roleName: user.role.name,
      departmentName: user.department?.name ?? null,
      languages: user.languages,
    },
    credentialsChangedAt: user.credentialsChangedAt,
  };
}

/**
 * A Principal for a pipeline with NO human in the loop — campaign intake, the
 * ARK webhook. It exists so those pipelines can call `createRecord` and get
 * everything a create means here (generated-schema validation, the assignment
 * engine, the audit rows, the duplicate scan) instead of growing a second
 * write path around the engine.
 *
 * WHY ADMIN-EQUIVALENT SCOPE. A system pipeline acts for the PLATFORM, not
 * for a person: the duplicate scan must see every record, and the assignment
 * engine must be free to hand the result to anyone. `isAdmin: true` is the
 * engine's one "no restriction" answer and is honest here — an intake lead
 * that could not be created for permission reasons would be a lost lead,
 * which invariant 1 forbids.
 *
 * WHAT KEEPS IT HONEST. `system` is set, so the engine writes audit rows as
 * `actorType: <system>, actorId: null` — the timeline renders "System
 * (Campaign Intake)", never a fabricated person — and stamps no `createdBy`.
 * The empty `userId` can never match a row (`isMe`, OWN scope) and is never
 * written anywhere; `applyConfigChange` refuses a system principal outright,
 * so this identity cannot leak into config surfaces whose log carries a
 * NOT-NULL foreign key to a real user.
 */
export function systemPrincipal(system: SystemActorType): Principal {
  return {
    actor: {
      userId: '',
      roleId: '',
      departmentId: null,
      groupIds: [],
      isAdmin: true,
    },
    permissions: { modules: new Map(), specials: new Set() },
    user: {
      id: '',
      fullName: system,
      email: '',
      roleName: 'System',
      departmentName: null,
      languages: [],
    },
    credentialsChangedAt: null,
    system,
  };
}
