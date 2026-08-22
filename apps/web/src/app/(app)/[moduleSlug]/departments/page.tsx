import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { PermissionEngine } from '@crm/core';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { storageFor } from '@/lib/records/list';
import { PageTitle } from '@/components/shell/page-title';
import { ProfileTabs } from '../_components/profile-tabs';
import { DepartmentsManager } from '../_components/departments/departments-manager';

/**
 * The physical column a department field points at on the user table. Keyed
 * on the COLUMN rather than a field key or a label, exactly as the list page
 * keys the status chip on `statusId`: the Admin may relabel the field, and a
 * label is never a contract.
 */
const DEPARTMENT_COLUMN = 'departmentId';

/**
 * The Departments sub-module of the Profile module (spec §5.2), at
 * `/[moduleSlug]/departments`. A thin adapter, like the groups page beside
 * it — see that file for the storage check and the capability gate, which
 * are the same here for the same reasons.
 */
export default async function DepartmentsPage({
  params,
}: {
  params: Promise<{ moduleSlug: string }>;
}) {
  const { moduleSlug } = await params;

  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (!canReadModuleConfig(principal, moduleSlug)) notFound();

  const mod = await prisma.moduleDefinition.findFirst({
    where: { slug: moduleSlug, isEnabled: true },
    select: { id: true, slug: true, labelPlural: true, isCore: true },
  });
  if (!mod) notFound();

  const fieldRows = await prisma.fieldDefinition.findMany({
    where: { moduleId: mod.id, isDeleted: false },
    select: { key: true, type: true, systemColumn: true },
  });

  // A storage property, never a slug — only the user table has departments.
  const storage = storageFor(
    { id: mod.id, slug: mod.slug, isCore: mod.isCore },
    fieldRows.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
  );
  if (storage.delegateName !== 'user') notFound();

  const { actor, permissions } = principal;
  const canManageGroups = actor.isAdmin || permissions.specials.has('MANAGE_DEPARTMENTS_GROUPS');
  if (!canManageGroups) notFound();
  const canManageRoles = actor.isAdmin || permissions.specials.has('MANAGE_USERS_ROLES');

  /**
   * Whether the list's filter rail can filter by department FOR THIS READER:
   * the module has a live field on the department column and the permission
   * matrix does not hide it. A link carrying a filter on a hidden field would
   * land on a list that refuses the filter and shows nothing — correctly, but
   * unhelpfully — so the count then links to the plain list instead.
   */
  const engine = new PermissionEngine(actor, permissions);
  const hidden = engine.hiddenFields(mod.slug);
  const departmentRow = fieldRows.find(
    (f) => f.systemColumn === DEPARTMENT_COLUMN && !hidden.has(f.key),
  );
  const departmentField = departmentRow ? { key: departmentRow.key, type: departmentRow.type } : null;

  return (
    <>
      <PageTitle title={`Departments — ${mod.labelPlural}`} />
      <DepartmentsManager
        slug={mod.slug}
        labelPlural={mod.labelPlural}
        departmentField={departmentField}
        tabs={
          <ProfileTabs
            slug={mod.slug}
            labelPlural={mod.labelPlural}
            active="departments"
            canManageGroups={canManageGroups}
            canManageRoles={canManageRoles}
          />
        }
      />
    </>
  );
}
