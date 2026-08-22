/**
 * Which modules a conversion is BETWEEN — resolved from the tables, never
 * from a slug.
 *
 * The conversion service needs two modules: the one a conversion PRODUCES
 * (it carries a Closed By column, a deposit ledger and a parent link) and
 * the one it CONSUMES (the module the first one's timeline inherits from).
 * Spec §7 calls them Deals and Leads; this file never does. It asks the
 * storage shapes — `closedByColumn`, `ledger`, `inheritsTimelineFrom` — and
 * whichever modules' tables answer are the ones. Rename either module, the
 * answer is unchanged; create a module called "Deals 2" in the generic
 * table, it is never mistaken for the target because the generic table has
 * none of those columns.
 *
 * Both contexts are built by `moduleContext`, so the read gate and the
 * module's live field list come from the same place every other record
 * operation uses.
 */
import type { Principal } from '../principal.js';
import { ConfigError } from '../config/service.js';
import { coreModuleStorages, type LedgerShape } from '../records/list.js';
import { moduleContext, type ModuleContext } from '../records/service.js';

/** The product of a conversion, with the two shape facts its writers need. */
export interface ConversionTarget {
  target: ModuleContext;
  ledger: LedgerShape;
  /** the column pointing at the originating record, and that record's audit entityType */
  link: { column: string; entityType: string };
}

export interface ConversionModules extends ConversionTarget {
  /** the module a conversion consumes — the one `target` inherits its timeline from */
  source: ModuleContext;
}

/**
 * Broken config, not user error: a product with no conversion target has no
 * conversion path, and a payload that arrived for one must fail loudly so
 * the event stays FAILED and replayable rather than silently IGNORED.
 */
function misconfigured(what: string): ConfigError {
  return new ConfigError(`Conversion is not configured: ${what}`, 500, 'GUARDRAIL');
}

/**
 * The module whose table declares the full conversion-target shape.
 *
 * Exactly one may: two tables each claiming a ledger and a Closed By would
 * make "which one does a webhook convert into" unanswerable, so that is
 * refused as loudly as none.
 */
export async function resolveConversionTarget(principal: Principal): Promise<ConversionTarget> {
  const candidates = (await coreModuleStorages()).filter(
    (m) => m.shape.closedByColumn !== null && m.shape.ledger !== null && m.shape.inheritsTimelineFrom !== null,
  );
  const only = candidates[0];
  if (!only || candidates.length !== 1) {
    throw misconfigured(
      candidates.length === 0
        ? 'no module carries a Closed By column and a deposit ledger'
        : 'more than one module carries a Closed By column and a deposit ledger',
    );
  }

  const target = await moduleContext(principal, only.ref.slug);
  const { ledger, inheritsTimelineFrom } = target.storage.shape;
  // Both proved non-null by the filter above; narrowed again here so the
  // return type carries the proof instead of a `!`.
  if (!ledger || !inheritsTimelineFrom) throw misconfigured('the target shape lost its ledger');
  return { target, ledger, link: inheritsTimelineFrom };
}

/**
 * Target AND source. The source is found through the target's own
 * declaration — `inheritsTimelineFrom.entityType` names the parent table's
 * audit discriminator, and the module whose shape writes that entityType is
 * the one a conversion consumes.
 */
export async function resolveConversionModules(principal: Principal): Promise<ConversionModules> {
  const resolved = await resolveConversionTarget(principal);

  const parent = (await coreModuleStorages()).find(
    (m) => m.shape.entityType === resolved.link.entityType,
  );
  if (!parent) {
    throw misconfigured(`no module writes "${resolved.link.entityType}" rows for the target to inherit from`);
  }

  const source = await moduleContext(principal, parent.ref.slug);
  if (source.storage.shape.accountNumberColumn === null) {
    throw misconfigured('the source module has no account-number column for the webhook to fill');
  }
  if (source.storage.shape.statusColumn === null || source.storage.shape.ownerColumn === null) {
    throw misconfigured('the source module has no status or owner column');
  }

  return { ...resolved, source };
}
