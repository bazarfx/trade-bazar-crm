import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import { Panel } from '@/components/ui';

/**
 * The settings landing: every enabled module with a door into its three
 * builders, plus the doors that are not per-module — roles and permissions
 * today, more later.
 *
 * The gates here are UX only. The real enforcement is `assertConfigPermission`
 * inside the config service and `assertRoleAdmin` in `lib/config/roles`,
 * neither of which a route can forget; these decide which doors are drawn.
 */
export default async function SettingsPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions } = principal;
  const canConfigureModules =
    actor.isAdmin ||
    permissions.specials.has('MANAGE_FIELDS_LAYOUTS') ||
    permissions.specials.has('MANAGE_STATUSES');
  const canManageRoles = actor.isAdmin || permissions.specials.has('MANAGE_USERS_ROLES');
  // Lead routing is Admin-only and deliberately not delegable: nominating the
  // senior pool decides where every ARK lead in the business lands, which is
  // broader than any module-scoped special in the matrix. The same condition
  // `canManagePlatformSettings` enforces server-side.
  const canManageRouting = actor.isAdmin;
  // Webhook sources — campaign intake and the ARK pipeline — share one door.
  const canManageWebhooks = actor.isAdmin || permissions.specials.has('MANAGE_CAMPAIGNS');
  if (!(canConfigureModules || canManageRoles || canManageWebhooks)) redirect('/');

  // Skipped entirely for someone who only administers roles — a query whose
  // result they are not allowed to see is a query worth not running.
  const modules = canConfigureModules
    ? await prisma.moduleDefinition.findMany({
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
      })
    : [];

  return (
    // No page-level max width or padding: the shell's <main> already sets the
    // canvas gutter, and a second one here made every settings screen sit on a
    // different grid from the module list.
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">Settings</h1>
        <p className="mt-1 text-sm text-body">
          Fields, statuses and layouts per module, and who may reach them.
        </p>
      </div>

      {canManageRoles && (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-6 px-6 py-5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-heading">Roles &amp; permissions</p>
              <p className="mt-1 text-sm text-body">
                View scopes, per-module create/edit/delete, field rules and the special
                permissions — for every role, across every enabled module.
              </p>
            </div>
            <Link
              href="/settings/roles"
              data-track="settings.landing.roles.open"
              className="shrink-0 text-sm text-primary hover:underline"
            >
              Open roles →
            </Link>
          </div>
        </Panel>
      )}

      {canManageRouting && (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-6 px-6 py-5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-heading">Assignment</p>
              <p className="mt-1 text-sm text-body">
                Which role is the senior pool and which group catches everything else. Leave
                either unset and those leads route to the Admin — still owned, but by one person.
              </p>
            </div>
            <Link
              href="/settings/assignment"
              data-track="settings.landing.assignment.open"
              className="shrink-0 text-sm text-primary hover:underline"
            >
              Open assignment →
            </Link>
          </div>
        </Panel>
      )}

      {canManageWebhooks && (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-6 px-6 py-5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-heading">Campaign intake</p>
              <p className="mt-1 text-sm text-body">
                The webhook URLs campaign platforms post leads into, each with its own payload
                mapping and event log. Every payload is stored raw and replayable.
              </p>
            </div>
            <Link
              href="/settings/intake"
              data-track="settings.landing.intake.open"
              className="shrink-0 text-sm text-primary hover:underline"
            >
              Open intake →
            </Link>
          </div>
        </Panel>
      )}

      {canManageWebhooks && (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-6 px-6 py-5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-heading">ARK Terminal</p>
              <p className="mt-1 text-sm text-body">
                The account-event webhook — the only way a lead converts. Sources, the payload
                mapping onto the pipeline&apos;s concepts, and every event with the outcome it
                produced.
              </p>
            </div>
            <Link
              href="/settings/ark"
              data-track="settings.landing.ark.open"
              className="shrink-0 text-sm text-primary hover:underline"
            >
              Open ARK →
            </Link>
          </div>
        </Panel>
      )}

      {canConfigureModules && (
        <div>
          <h2 className="mb-3 text-sm font-medium text-heading">Modules</h2>
          {/* Not <DataTable>: that primitive takes render callbacks, which
              cannot cross the server-component boundary this page renders on.
              The row metrics below are its metrics, so the two screens still
              match. */}
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
      )}
    </div>
  );
}
