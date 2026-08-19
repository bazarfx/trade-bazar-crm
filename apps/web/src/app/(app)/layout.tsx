import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { SignOutButton } from '@/components/sign-out-button';
import { TrackListener } from '@/components/track-listener';
import { OverlayProvider } from '@/components/overlay/overlay-context';

/**
 * The signed-in shell. Navigation is not a hardcoded list of modules — it is
 * whatever `ModuleDefinition` says is enabled, in `navOrder`. An Admin adding
 * a module tomorrow appears here without a deploy, which is the whole point.
 *
 * This is a server component, so nav config is read straight from Prisma —
 * self-fetching our own API would double every request for no isolation gain.
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

  // Settings is gated on capability flags, never on a role name.
  const canConfigure =
    actor.isAdmin ||
    permissions.specials.has('MANAGE_FIELDS_LAYOUTS') ||
    permissions.specials.has('MANAGE_STATUSES');

  return (
    <OverlayProvider>
      <TrackListener />
      <div className="min-h-screen bg-background">
        <aside className="fixed inset-y-0 left-0 z-10 flex w-60 flex-col border-r border-border bg-surface">
          <div className="border-b border-border px-4 py-4">
            <span className="text-sm font-semibold text-heading">Trade Bazar CRM</span>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-3">
            {modules.map((m) => (
              <Link
                key={m.slug}
                href={`/${m.slug}`}
                data-track={`${m.slug}.nav.item.open`}
                className="flex items-center gap-3 rounded px-3 py-2 text-sm text-body hover:bg-background hover:text-heading"
              >
                {/* Icon names come from config; the icon set lands with the
                    design-system slice. Until then: an initial, same slot. */}
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-background text-xs font-semibold text-heading"
                >
                  {m.labelPlural.charAt(0)}
                </span>
                <span className="truncate">{m.labelPlural}</span>
              </Link>
            ))}
          </nav>

          {canConfigure && (
            <div className="border-t border-border px-2 py-3">
              <Link
                href="/settings/modules"
                data-track="settings.nav.item.open"
                className="flex items-center gap-3 rounded px-3 py-2 text-sm text-body hover:bg-background hover:text-heading"
              >
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-background text-xs font-semibold text-heading"
                >
                  S
                </span>
                Settings
              </Link>
            </div>
          )}
        </aside>

        <div className="ml-60 flex min-h-screen flex-col">
          <header className="flex items-center justify-between border-b border-border bg-surface px-8 py-3">
            <p className="text-sm text-body">
              <span className="font-medium text-heading">{user.fullName}</span> · {user.roleName}
            </p>
            <SignOutButton />
          </header>
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </OverlayProvider>
  );
}
