/**
 * Small read-side lookups behind the shell: the nav's module catalogue and
 * the layout editor's role picker. Kept out of the route files so the routes
 * stay thin adapters — the permission decision for roles lives HERE.
 */
import 'server-only';
import { prisma } from '@crm/db';
import type { Principal } from '@/lib/auth/actor';
import { ConfigError } from '@/lib/config/service';

/** Enabled modules in nav order. Any authenticated user — this IS the nav. */
export async function listModules() {
  return prisma.moduleDefinition.findMany({
    where: { isEnabled: true },
    orderBy: { navOrder: 'asc' },
    select: { slug: true, label: true, labelPlural: true, icon: true, navOrder: true },
  });
}

/**
 * Non-deleted roles. MANAGE_FIELDS_LAYOUTS is accepted alongside
 * MANAGE_USERS_ROLES because the layout editor's role picker needs the list
 * without granting user administration.
 */
export async function listRoles(principal: Principal) {
  const allowed =
    principal.actor.isAdmin ||
    principal.permissions.specials.has('MANAGE_USERS_ROLES') ||
    principal.permissions.specials.has('MANAGE_FIELDS_LAYOUTS');
  if (!allowed) {
    throw new ConfigError('Requires the "MANAGE_USERS_ROLES" permission', 403, 'FORBIDDEN');
  }

  return prisma.role.findMany({
    where: { isDeleted: false },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, isLocked: true },
  });
}
