import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { canManagePlatformSettings } from '@/lib/config/settings';
import { AssignmentSettingsForm, type GroupOption } from './_components/assignment-settings-form';

/**
 * Lead routing (spec §6.7, §7): which role is the senior pool, which group is
 * the default pool.
 *
 * The gate is `canManagePlatformSettings` rather than a re-derived
 * `actor.isAdmin`, so the door drawn here and the door enforced in
 * `lib/config/settings` open on exactly the same condition. Even so it is UX
 * only: `assertPlatformAdmin` runs again inside every read and write, and
 * rendering this page to anybody else would only produce two pickers whose
 * every request comes back 403.
 *
 * Not delegable through a special on purpose. Nominating the senior pool
 * decides where every ARK lead in the business lands, which is broader than
 * any module-scoped grant in the matrix — see the note in lib/config/settings.
 */
export default async function AssignmentSettingsPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');
  if (!canManagePlatformSettings(principal)) redirect('/');

  /**
   * Groups come straight from Prisma because there is no groups API yet, and
   * inventing a route another slice owns would leave two of them to reconcile
   * later. Read here rather than in the client for the same reason the shell
   * reads its nav here: this is a server component, and self-fetching our own
   * API would double the request for no isolation gain.
   *
   * The member count is filtered to ACTIVE users because that is the count the
   * engine actually rounds over — a pool of six people, four of them
   * deactivated, routes like a pool of two, and a picker showing "6" would
   * hide the reason leads stopped arriving.
   */
  const groups = await prisma.group.findMany({
    // Soft delete, always: a deleted group keeps its rows and its history but
    // must never be nominable, and the write path refuses it anyway.
    where: { isDeleted: false },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      language: true,
      _count: { select: { members: { where: { user: { isActive: true } } } } },
    },
  });

  const options: GroupOption[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
    language: group.language,
    activeMembers: group._count.members,
  }));

  return (
    // The shell's <main> owns the canvas gutter; a second page-level one put
    // every settings screen on a different grid from the module list.
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">Assignment</h1>
        <p className="mt-1 text-sm text-body">
          Where a new lead lands, and who catches the ones nobody else can. Nothing here is
          matched by name — a role or a group renamed tomorrow keeps its place in the routing.
        </p>
      </div>
      <AssignmentSettingsForm groups={options} />
    </div>
  );
}
