import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { canReadModuleConfig } from '@/lib/config/access';
import { TrackListener } from '@/components/track-listener';
import { OverlayProvider } from '@/components/overlay/overlay-context';
import { Sidebar, type ShellModule, type ShellSettingsPage } from '@/components/shell/sidebar';
import { TopBar } from '@/components/shell/topbar';

/**
 * The signed-in shell: sidebar left, top bar over the content column, page
 * below — the geometry of the `CRM _ Leads` frame. The user profile lives in
 * the TOP BAR (right-aligned), the sidebar carries the logo slot and the nav.
 *
 * Navigation is not a hardcoded list of modules — it is whatever
 * `ModuleDefinition` says is enabled, in `navOrder`, rendered as the CRM
 * dropdown's sub-links. An Admin adding a module tomorrow appears here
 * without a deploy, which is the whole point.
 *
 * This is a server component, so nav config is read straight from Prisma —
 * self-fetching our own API would double every request for no isolation gain.
 * It resolves the lists and hands them to a client `Sidebar`, which needs
 * `usePathname` for the current-item test and `localStorage` for collapse.
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

  // Only modules this actor may actually open. The same gate the module page
  // and the config API use, so the nav cannot advertise a door that answers
  // 404 — and a module's very existence and label stay inside the permission
  // boundary rather than being enumerable by anyone signed in.
  const navModules: ShellModule[] = modules
    .filter((m) => canReadModuleConfig(principal, m.slug))
    .map((m) => ({ slug: m.slug, label: m.labelPlural, icon: m.icon }));

  // Settings is gated on capability flags, never on a role name. Every
  // special that has a door behind /settings belongs in this list — the
  // landing page draws only the doors the holder may use, so someone who
  // administers roles but configures no module still needs the nav item.
  const canConfigure =
    actor.isAdmin ||
    permissions.specials.has('MANAGE_FIELDS_LAYOUTS') ||
    permissions.specials.has('MANAGE_STATUSES') ||
    permissions.specials.has('MANAGE_USERS_ROLES');

  // Settings pages are the shell's own areas, not modules — they never sort
  // against `navOrder` and their icons only surface in the collapsed rail,
  // where a label-less row still needs a distinguishable glyph.
  const settingsPages: ShellSettingsPage[] = canConfigure
    ? [
        { key: 'modules', href: '/settings/modules', label: 'Modules & fields', icon: 'module' },
        { key: 'roles', href: '/settings/roles', label: 'Roles & permissions', icon: 'user-cog' },
        { key: 'assignment', href: '/settings/assignment', label: 'Assignment', icon: 'users' },
      ]
    : [];

  return (
    <OverlayProvider>
      <TrackListener />
      <div className="flex min-h-screen bg-background">
        <Sidebar modules={navModules} settingsPages={settingsPages} />
        {/* min-w-0 so a wide table scrolls inside the content column rather
            than stretching the flex row and pushing the sidebar off screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar user={{ fullName: user.fullName, roleName: user.roleName }} />
          <main className="min-w-0 flex-1 p-6">{children}</main>
        </div>
      </div>
    </OverlayProvider>
  );
}
