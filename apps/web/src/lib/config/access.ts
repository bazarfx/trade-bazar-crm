/**
 * The read gate for every config surface.
 *
 * Writes are gated by `assertConfigPermission`; reads were gated by nothing
 * but authentication, which let a role with `viewScope: NONE` on a module —
 * a role that cannot read one of its records — enumerate every field, every
 * picklist option and every status that module has. Configuration describes
 * the data, so it fails closed the same way the data does.
 *
 * Deliberately NOT `PermissionEngine.can('view', slug)`: an admin configuring
 * a module whose records they never read is legitimate, so a config special
 * is an accepted route in on its own.
 */
import 'server-only';
import type { ConfigType, SpecialPermission } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { assertConfigPermission, ConfigError } from '@/lib/config/service';

const CONFIG_SPECIALS = [
  'MANAGE_FIELDS_LAYOUTS',
  'MANAGE_STATUSES',
] as const satisfies readonly SpecialPermission[];

/** True when the actor may see how `moduleSlug` is configured. Reads only the
 *  Principal, so it costs no query and can be applied per row. */
export function canReadModuleConfig(principal: Principal, moduleSlug: string): boolean {
  if (principal.actor.isAdmin) return true;
  if (CONFIG_SPECIALS.some((special) => principal.permissions.specials.has(special))) return true;
  const module = principal.permissions.modules.get(moduleSlug);
  // No permission row is the same answer as an explicit NONE: see nothing.
  return module !== undefined && module.viewScope !== 'NONE';
}

/**
 * Assert before resolving the module, not after: to a caller with no access,
 * an unknown slug and a forbidden one must be indistinguishable.
 */
export function assertModuleReadAccess(principal: Principal, moduleSlug: string): void {
  if (!canReadModuleConfig(principal, moduleSlug)) {
    throw new ConfigError('You do not have access to this module', 403, 'FORBIDDEN');
  }
}

/**
 * Boolean form of `assertConfigPermission`, for call sites that filter rather
 * than reject. The configType -> special mapping is a security decision that
 * must have exactly one home, so this asks the assertion instead of restating
 * it; anything other than its 403 is a real fault and still propagates.
 */
export function hasConfigPermission(principal: Principal, configType: ConfigType): boolean {
  try {
    assertConfigPermission(principal, configType);
    return true;
  } catch (err) {
    if (err instanceof ConfigError && err.status === 403) return false;
    throw err;
  }
}
