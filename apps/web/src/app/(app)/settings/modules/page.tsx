import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { Panel } from '@/components/ui';

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
    // No page-level max width or padding: the shell's <main> already sets the
    // canvas gutter, and a second one here made every settings screen sit on a
    // different grid from the module list.
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">Module settings</h1>
        <p className="mt-1 text-sm text-body">
          Fields, statuses and layouts for every enabled module.
        </p>
      </div>

      {/* Not <DataTable>: that primitive takes render callbacks, which cannot
          cross the server-component boundary this page renders on. The row
          metrics below are its metrics, so the two screens still match. */}
      <Panel className="overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {['Module', 'Slug', 'Fields', 'Statuses', 'Configure'].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="h-11 border-b border-border bg-background px-6 text-xs font-medium text-body"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.slug} className="h-12 border-b border-border last:border-0">
                <td className="px-6 text-heading">{m.labelPlural}</td>
                <td className="px-6 text-body">{m.slug}</td>
                <td className="px-6 text-body">{m._count.fields}</td>
                <td className="px-6 text-body">{m._count.statuses}</td>
                <td className="px-6">
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
      </Panel>
    </div>
  );
}
