import { notFound, redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { storageFor } from '@/lib/records/list';
import { PageTitle } from '@/components/shell/page-title';
import { ProfileTabs } from '../_components/profile-tabs';
import { GroupsManager } from '../_components/groups/groups-manager';

/**
 * The Groups sub-module of the Profile module (spec §5.3), at
 * `/[moduleSlug]/groups` — INSIDE the users module, where the client asked for
 * it and where the spec puts it.
 *
 * A thin adapter like the list and import pages beside it: resolve the
 * module, ask the storage resolver whether its rows are user accounts, gate
 * on the capability, hand the manager the one config-derived value it needs
 * (the languages people here actually speak). It knows nothing about "users"
 * — see the storage check below.
 */
export default async function GroupsPage({
  params,
}: {
  params: Promise<{ moduleSlug: string }>;
}) {
  const { moduleSlug } = await params;

  // The shell layout redirects too, but a page that reads permissions cannot
  // depend on a layout having run — layouts and pages render independently.
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  // Fail closed BEFORE the module is resolved, and 404 rather than 403: to an
  // actor with no access an unknown module and a forbidden one must be
  // indistinguishable. Same gate, same reasoning, as the list page.
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

  /**
   * Whether this module's rows ARE user accounts — a storage property, never
   * a slug. The resolver names the table the module lives in; only the user
   * table has groups and departments hanging off it. A module renamed from
   * "Users" to "Staff" keeps this screen; an Admin-created module called
   * "Users" that lives in the generic table does not get it. The same way the
   * record screen decides a deposits ledger exists: it asks the shape.
   */
  const storage = storageFor(
    { id: mod.id, slug: mod.slug, isCore: mod.isCore },
    fieldRows.map((f) => ({ key: f.key, type: f.type, systemColumn: f.systemColumn })),
  );
  if (storage.delegateName !== 'user') notFound();

  // Keyed on the CAPABILITY, never on a role name. Without it the route is
  // 404 rather than a disabled screen: the tab is hidden, so anyone arriving
  // here typed the URL, and every write behind it would answer 403 anyway —
  // the groups lib asserts the same special again.
  const { actor, permissions } = principal;
  const canManageGroups = actor.isAdmin || permissions.specials.has('MANAGE_DEPARTMENTS_GROUPS');
  if (!canManageGroups) notFound();
  const canManageRoles = actor.isAdmin || permissions.specials.has('MANAGE_USERS_ROLES');

  /**
   * The language picker's choices: whatever the people in this system speak.
   * `User.languages` is seed data the Admin edits, not an enum — so the list
   * is READ, never declared, and "add Tamil" is a user edit, not a deploy.
   * Only the column is selected; this is not a read of the Profile module
   * and grants no access to it.
   */
  const spoken = await prisma.user.findMany({ select: { languages: true } });
  const languages = [...new Set(spoken.flatMap((u) => u.languages))]
    .filter((l) => l.trim() !== '')
    .sort((a, b) => a.localeCompare(b));

  return (
    <>
      {/* Drawn by the shell in the top bar — see components/shell/page-title.tsx. */}
      <PageTitle title={`Groups — ${mod.labelPlural}`} />
      <GroupsManager
        slug={mod.slug}
        languages={languages}
        tabs={
          <ProfileTabs
            slug={mod.slug}
            labelPlural={mod.labelPlural}
            active="groups"
            canManageGroups={canManageGroups}
            canManageRoles={canManageRoles}
          />
        }
      />
    </>
  );
}
