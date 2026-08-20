import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { TrackListener } from '@/components/track-listener';
import { OverlayProvider } from '@/components/overlay/overlay-context';
import { Sidebar, type ShellNavGroup } from '@/components/shell/sidebar';

/**
 * The signed-in shell. Navigation is not a hardcoded list of modules — it is
 * whatever `ModuleDefinition` says is enabled, in `navOrder`. An Admin adding
 * a module tomorrow appears here without a deploy, which is the whole point.
 *
 * This is a server component, so nav config is read straight from Prisma —
 * self-fetching our own API would double every request for no isolation gain.
 * It resolves the groups and hands them to a client `Sidebar`, which needs
 * `usePathname` for the current-item test and `localStorage` for the collapse.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions, user } = principal;

  const modules = await prisma.moduleDefinition.findMany({
    where: { isEnabled: true },
    orderBy: { navOrder: 'asc' },
    select: { slug: true, label: true, labelPlural: true, icon: true, navOrder: true },
  });

  // Settings is gated on capability flags, never on a role name. Every
  // special that has a door behind /settings belongs in this list — the
  // landing page draws only the doors the holder may use, so someone who
  // administers roles but configures no module still needs the nav item.
  const canConfigure =
    actor.isAdmin ||
    permissions.specials.has('MANAGE_FIELDS_LAYOUTS') ||
    permissions.specials.has('MANAGE_STATUSES') ||
    permissions.specials.has('MANAGE_USERS_ROLES');

  const groups: ShellNavGroup[] = [
    {
      id: 'main',
      heading: 'Main',
      // Only modules this actor may actually open. The same gate the module
      // page and the config API use, so the nav cannot advertise a door that
      // answers 404 — and a module's very existence and label stay inside the
      // permission boundary rather than being enumerable by anyone signed in.
      items: modules
        .filter((m) => canReadModuleConfig(principal, m.slug))
        .map((m) => ({
          trackKey: m.slug,
          href: `/${m.slug}`,
          match: `/${m.slug}`,
          label: m.labelPlural,
          icon: m.icon,
        })),
    },
  ];

  if (canConfigure) {
    // Settings is not a module — it is the shell's own area — so it is a group
    // of one rather than a row smuggled into the module list, where it would
    // sort against `navOrder` values it has no business competing with.
    groups.push({
      id: 'settings',
      heading: 'Settings',
      items: [
        {
          trackKey: 'settings',
          href: '/settings/modules',
          // Every builder lives under /settings/*, so the whole subtree is
          // "current" — not just the landing page.
          match: '/settings',
          label: 'Settings',
          icon: 'settings',
        },
      ],
    });
  }

  return (
    <OverlayProvider>
      <TrackListener />
      <div className="flex min-h-screen bg-background">
        <Sidebar groups={groups} user={{ fullName: user.fullName, roleName: user.roleName }} />
        {/* min-w-0 so a wide table scrolls inside the main column rather than
            stretching the flex row and pushing the sidebar off screen. */}
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </OverlayProvider>
  );
}
