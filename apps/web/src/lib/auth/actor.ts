/**
 * Shim. `Principal` and `loadPrincipal` now live in `@crm/records` — see that
 * package's `principal.ts` for why: the import worker has no cookie and no
 * request, but it must still run as the user who uploaded the file, and a
 * Principal is the only way to say who that is.
 *
 * The re-export keeps every existing `@/lib/auth/actor` import working, and
 * `server-only` stays HERE: the builder is runtime-agnostic, but anything
 * reaching it through this path is inside the Next bundle and must never cross
 * into a client component.
 */
import 'server-only';

export { loadPrincipal } from '@crm/records';
export type { Principal } from '@crm/records';
