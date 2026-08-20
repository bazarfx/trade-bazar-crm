import { redirect } from 'next/navigation';
import { getPrincipal } from '@/lib/auth/session';
import { RolesManager } from './_components/roles-manager';

/**
 * Roles, the permission matrix and view scopes (spec §5.1, §11).
 *
 * This gate is UX only — it decides which door a person sees, never what they
 * may do. The real enforcement is `assertRoleAdmin` inside `lib/config/roles`
 * and `scopeFilter` in the repository layer, neither of which a route or a
 * page can forget. Rendering the screen to someone without the permission
 * would only produce a page whose every request comes back 403.
 */
export default async function RolesSettingsPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  const { actor, permissions } = principal;
  // Keyed on the capability, never on a role name — the Admin role is
  // identified by `isLocked` (from which `isAdmin` is derived) and every other
  // role reaches this screen by holding the special, whatever it is called.
  if (!(actor.isAdmin || permissions.specials.has('MANAGE_USERS_ROLES'))) redirect('/');

  return (
    // The shell's <main> owns the canvas gutter; a second page-level one put
    // every settings screen on a different grid from the module list.
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">Roles &amp; permissions</h1>
        <p className="mt-1 text-sm text-body">
          A view scope, create/edit/delete flags and field rules per module, plus the special
          permissions granted alongside them. Every enabled module appears in every role — a
          module created tomorrow starts closed, in all of them.
        </p>
      </div>
      <RolesManager />
    </div>
  );
}
