/**
 * Shim. The record engine now lives in `@crm/records`, so the
 * worker can run it too — see that package's index for why.
 *
 * The re-export keeps every existing `@/lib/...` import working unchanged,
 * and `server-only` stays HERE: the engine itself is runtime-agnostic, but
 * anything reaching it through this path is inside the Next bundle and must
 * still never cross into a client component.
 */
import 'server-only';

export * from '@crm/records';
