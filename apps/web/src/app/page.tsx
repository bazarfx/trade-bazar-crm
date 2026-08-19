import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { SignOutButton } from '@/components/sign-out-button';

/**
 * The landing route. There is no default module in this product: which module
 * comes first is config (`navOrder`), exactly as it is for the nav in the app
 * shell. A hardcoded slug here would 404 every signed-in user the moment an
 * Admin disables or renames that module — the prime directive in one line.
 */
export default async function Home() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const first = await prisma.moduleDefinition.findFirst({
    where: { isEnabled: true },
    orderBy: { navOrder: 'asc' },
    select: { slug: true },
  });
  if (first) redirect(`/${first.slug}`);

  // Nothing is enabled. Anyone who can configure modules is sent where they
  // can fix it; everyone else gets told, because /settings/modules bounces
  // them straight back here and the two would redirect at each other forever.
  const { actor, permissions } = principal;
  const canConfigure =
    actor.isAdmin ||
    permissions.specials.has('MANAGE_FIELDS_LAYOUTS') ||
    permissions.specials.has('MANAGE_STATUSES');
  if (canConfigure) redirect('/settings/modules');

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-8">
      <div className="max-w-md rounded border border-border bg-surface px-6 py-6 text-center">
        <h1 className="text-lg font-semibold text-heading">No modules are enabled</h1>
        <p className="mt-2 text-sm text-body">
          There is nothing for you to open yet. An administrator enables modules from module
          settings.
        </p>
        <div className="mt-6 flex justify-center">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
