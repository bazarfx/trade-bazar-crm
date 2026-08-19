import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';

/**
 * Settings landing: every enabled module with a door into its three builders.
 * This gate is UX only — the real enforcement is `assertConfigPermission`
 * inside the config service, which a route cannot forget.
 */
export default async function ModulesSettingsPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions } = principal;
  const allowed =
    actor.isAdmin ||
    permissions.specials.has('MANAGE_FIELDS_LAYOUTS') ||
    permissions.specials.has('MANAGE_STATUSES');
  if (!allowed) redirect('/');

  const modules = await prisma.moduleDefinition.findMany({
    where: { isEnabled: true },
    orderBy: { navOrder: 'asc' },
    select: {
      slug: true,
      label: true,
      labelPlural: true,
      _count: {
        select: {
          // Soft-deleted config stays in the table; it must not inflate counts.
          fields: { where: { isDeleted: false } },
          statuses: { where: { isDeleted: false } },
        },
      },
    },
  });

  return (
    <div className="mx-auto max-w-[1440px] px-8 py-10">
      <h1 className="text-xl font-semibold text-heading">Module settings</h1>
      <p className="mt-1 text-sm text-body">
        Fields, statuses and layouts for every enabled module.
      </p>

      <section className="mt-6 rounded border border-border bg-surface">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-body">
              <th className="px-6 py-3 font-medium">Module</th>
              <th className="px-6 py-3 font-medium">Slug</th>
              <th className="px-6 py-3 font-medium">Fields</th>
              <th className="px-6 py-3 font-medium">Statuses</th>
              <th className="px-6 py-3 font-medium">Configure</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.slug} className="border-b border-border last:border-0">
                <td className="px-6 py-3 text-heading">{m.labelPlural}</td>
                <td className="px-6 py-3">{m.slug}</td>
                <td className="px-6 py-3">{m._count.fields}</td>
                <td className="px-6 py-3">{m._count.statuses}</td>
                <td className="px-6 py-3">
                  <span className="flex gap-4">
                    {/* One name per builder: a shared name would make the
                        interaction log unable to say which one was opened. */}
                    <Link
                      href={`/settings/modules/${m.slug}/fields`}
                      data-track={`${m.slug}.settings.fields.open`}
                      className="text-primary hover:underline"
                    >
                      Fields
                    </Link>
                    <Link
                      href={`/settings/modules/${m.slug}/statuses`}
                      data-track={`${m.slug}.settings.statuses.open`}
                      className="text-primary hover:underline"
                    >
                      Statuses
                    </Link>
                    <Link
                      href={`/settings/modules/${m.slug}/layout`}
                      data-track={`${m.slug}.settings.layout.open`}
                      className="text-primary hover:underline"
                    >
                      Layout
                    </Link>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
