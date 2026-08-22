/**
 * Campaign analytics (spec §9): leads in, converted, conversion rate, total
 * deposited, and cost per conversion when a spend has been entered.
 *
 * Written for "a module that other records link to", never for a module
 * called Campaigns. The question it asks is structural: does the module a
 * conversion CONSUMES (the one deals inherit their timeline from) carry a
 * record-link field pointing at THIS module? If so, every record of this
 * module is something leads are attributed to, and the numbers below are
 * meaningful for it. If not, the answer is null — an ordinary "no analytics
 * here" the route serves as 200 — and the detail screen draws no panel. Rename Campaigns to "Sources" tomorrow and nothing here
 * notices.
 *
 * Every number is a SCOPED read. `countRecords` runs the same scope + filter
 * combination as the list screen, so an agent who can see only their own
 * leads gets the campaign's numbers for THEIR leads — the same answer the list
 * would give them. The deposit total goes through `scopedWhere` for the same
 * reason, and is withheld entirely when the matrix hides the total field from
 * this role: an aggregate is a read of that field.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import type { FilterNode } from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { ConfigError } from '@/lib/config/service';
import { countRecords, scopedWhere } from '@/lib/records/list';
import {
  getRecord,
  moduleContext,
  resolveConversionModules,
  type FieldRow,
} from '@/lib/records/service';

export interface CampaignAnalyticsDto {
  /** records of the conversion SOURCE module (leads) attributed to this record */
  leadsIn: number;
  /** of those, how many sit in a status tagged CONVERTED */
  converted: number;
  /** converted / leadsIn, or null when there are no leads to divide by */
  conversionRate: number | null;
  /**
   * Sum of the derived total across conversion-TARGET records (deals)
   * attributed to this record — exact digits. Null when the target module
   * has no link back to this one, or when this role may not see the total.
   */
  totalDeposited: string | null;
  /** the spend entered on this record, when a money field holds one */
  spend: string | null;
  /** spend / converted — null until both exist */
  costPerConversion: string | null;
  /** the Admin's own labels, for the panel's copy */
  labels: {
    /** plural label of the source module — "Leads" */
    source: string;
    /** plural label of the target module — "Deals" */
    target: string;
    /** label of the field spend was read from, or null when there is none */
    spendField: string | null;
  };
}

/**
 * The slice of a delegate used for the deposit aggregate. Structural because
 * the delegate is chosen by name from the storage shape.
 */
interface Aggregator {
  aggregate(args: {
    where: Record<string, unknown>;
    _sum: Record<string, true>;
  }): Promise<{ _sum: Record<string, unknown> }>;
}

function linkTo(fields: FieldRow[], moduleId: string): FieldRow | undefined {
  return fields.find((f) => f.type === 'RECORD_LINK' && f.relatedModuleId === moduleId);
}

function money(value: unknown): string {
  return new Prisma.Decimal(value === null || value === undefined ? 0 : String(value)).toFixed(2);
}

export async function campaignAnalytics(
  principal: Principal,
  moduleSlug: string,
  recordId: string,
): Promise<CampaignAnalyticsDto | null> {
  // Scope first: the record itself, through the same read the page uses.
  const record = await getRecord(principal, moduleSlug, recordId);
  const ctx = await moduleContext(principal, moduleSlug);

  // Which modules a conversion is between, resolved from the storage shapes.
  // An actor who may not read either module gets that module's own answer
  // (404), which is the honest "no analytics for you" here too.
  const { source, target, ledger } = await resolveConversionModules(principal);

  const sourceLink = linkTo(source.fields, ctx.module.id);
  if (!sourceLink) {
    // Null, not 404: "this module has no analytics" is an ordinary answer the
    // detail screen probes for on EVERY record, and a 404 would print a
    // resource error in the browser console on every open. 404 stays reserved
    // for "this record does not exist / is outside your scope" (getRecord
    // above throws it), which really is an error.
    return null;
  }

  const attributed: FilterNode = {
    fieldKey: sourceLink.key,
    fieldType: sourceLink.type,
    operator: 'eq',
    value: recordId,
  };

  // "Converted" is the CONVERTED tag, never a status name (CLAUDE.md). Read
  // live statuses only: a retired status still sits on old records, but the
  // Admin retired it, and a count that kept honouring it would disagree with
  // every list filter.
  const statusField = source.fields.find((f) => f.systemColumn === source.storage.shape.statusColumn);
  const convertedStatuses = statusField
    ? await prisma.status.findMany({
        where: { moduleId: source.module.id, tag: 'CONVERTED', isDeleted: false },
        select: { id: true },
      })
    : [];

  const countIn = (filters: FilterNode) =>
    countRecords({
      module: source.module,
      fields: source.metas,
      engine: source.engine,
      actor: principal.actor,
      filters,
    });

  const [leadsIn, converted] = await Promise.all([
    countIn(attributed),
    statusField && convertedStatuses.length > 0
      ? countIn({
          op: 'AND',
          children: [
            attributed,
            {
              fieldKey: statusField.key,
              fieldType: statusField.type,
              operator: 'in',
              value: convertedStatuses.map((s) => s.id),
            },
          ],
        })
      : Promise.resolve(0),
  ]);

  // The deposit total: one aggregate over the target rows attributed to this
  // record, under the target module's scope filter. Withheld when the total
  // field is hidden from this role — the matrix governs aggregates too.
  const targetLink = linkTo(target.fields, ctx.module.id);
  const totalField = target.fields.find((f) => f.systemColumn === ledger.totalColumn);
  const totalHidden = totalField === undefined || target.engine.hiddenFields(target.module.slug).has(totalField.key);
  let totalDeposited: string | null = null;
  if (targetLink?.systemColumn && !totalHidden) {
    const delegate = (prisma as unknown as Record<string, Aggregator | undefined>)[target.storage.delegateName];
    if (delegate) {
      const agg = await delegate.aggregate({
        where: {
          ...scopedWhere(target.storage, target.engine, target.module.slug),
          [targetLink.systemColumn]: recordId,
        },
        _sum: { [ledger.totalColumn]: true },
      });
      totalDeposited = money(agg._sum[ledger.totalColumn]);
    }
  }

  // Spend: "cost per conversion if spend is entered" (spec §9). Which field
  // holds spend is the Admin's to name — it is read as THE money-typed field
  // on this module when exactly one exists. Two would make the question
  // ambiguous, so two is honestly "no spend" rather than a guess, and the
  // label is returned so the panel can say where the number came from.
  const moneyFields = ctx.fields.filter((f) => f.type === 'CURRENCY');
  const spendField = moneyFields.length === 1 ? moneyFields[0] : undefined;
  const rawSpend = spendField ? record[spendField.key] : null;
  const spend =
    rawSpend === null || rawSpend === undefined || rawSpend === '' ? null : money(rawSpend);

  const costPerConversion =
    spend !== null && converted > 0
      ? new Prisma.Decimal(spend).dividedBy(converted).toFixed(2)
      : null;

  const [sourceLabel, targetLabel] = await Promise.all([
    prisma.moduleDefinition.findUnique({ where: { id: source.module.id }, select: { labelPlural: true } }),
    prisma.moduleDefinition.findUnique({ where: { id: target.module.id }, select: { labelPlural: true } }),
  ]);

  return {
    leadsIn,
    converted,
    conversionRate: leadsIn > 0 ? converted / leadsIn : null,
    totalDeposited,
    spend,
    costPerConversion,
    labels: {
      source: sourceLabel?.labelPlural ?? source.module.slug,
      target: targetLabel?.labelPlural ?? target.module.slug,
      spendField: spendField?.label ?? null,
    },
  };
}
