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
import type { ModulePermission, PermissionSet } from '@crm/core';

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
  };
}
