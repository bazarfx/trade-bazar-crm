import { redirect } from 'next/navigation';
import { getPrincipal } from '@/lib/auth/session';
import { SignOutButton } from '@/components/sign-out-button';

/**
 * Placeholder landing for the signed-in shell. The real Leads list arrives in
 * the record-engine slice; for now this proves the session resolves into a
 * full principal — actor, role, scopes and specials — on every request.
 */
export default async function LeadsPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { user, actor, permissions } = principal;
  const modules = [...permissions.modules.values()].sort((a, b) =>
    a.moduleSlug.localeCompare(b.moduleSlug),
  );

  return (
    <main className="mx-auto max-w-[1440px] px-8 py-10">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-heading">Leads</h1>
          <p className="mt-1 text-sm text-body">
            Signed in as {user.fullName} · {user.roleName}
            {user.departmentName ? ` · ${user.departmentName}` : ''}
          </p>
        </div>
        <SignOutButton />
      </header>

      <section className="rounded border border-border bg-surface p-6">
        <h2 className="mb-4 text-sm font-semibold text-heading">Resolved permissions</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-body">
              <th className="pb-2 font-medium">Module</th>
              <th className="pb-2 font-medium">View scope</th>
              <th className="pb-2 font-medium">Create</th>
              <th className="pb-2 font-medium">Edit</th>
              <th className="pb-2 font-medium">Delete</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.moduleSlug} className="border-b border-border last:border-0">
                <td className="py-2 text-heading">{m.moduleSlug}</td>
                <td className="py-2">{m.viewScope}</td>
                <td className="py-2">{m.canCreate ? 'Yes' : 'No'}</td>
                <td className="py-2">{m.canEdit ? 'Yes' : 'No'}</td>
                <td className="py-2">{m.canDelete ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-6 text-xs text-body">
          {permissions.specials.size} special permission
          {permissions.specials.size === 1 ? '' : 's'} · {actor.groupIds.length} group
          {actor.groupIds.length === 1 ? '' : 's'}
          {actor.isAdmin ? ' · Admin' : ''}
        </p>
      </section>
    </main>
  );
}
