/**
 * Shim. The System Defined Filters group — availability per module and the
 * where-fragment each answerable row compiles to — lives in `@crm/records`
 * beside the rest of the record engine, so the worker can reach it too (an
 * export job filtering "untouched records" would otherwise need a second copy
 * of the audit-log resolution, which is how two answers to one question get
 * born). See that package's index for the full reasoning.
 *
 * The re-export keeps `@/lib/...` imports working, and `server-only` stays
 * HERE: the engine is runtime-agnostic, but anything reaching it through this
 * path is inside the Next bundle and must never cross into a client component.
 */
import 'server-only';

export * from '@crm/records';
