/**
 * The System Defined Filters group on the list rail — availability, and the
 * where-clause each answerable row compiles to.
 *
 * THE RULE THIS FILE EXISTS TO KEEP. The Figma draws nine rows. Six of them
 * are questions this product cannot currently answer, and there are exactly
 * two honest things to do with such a row: draw it disabled with the real
 * reason, or answer it. Drawing it enabled and returning everything is the
 * third option, and it is the one that gets a floor manager to work a list
 * they believe is filtered. So `available` is COMPUTED — per module, from that
 * module's storage shape and from the capability table below — and a query
 * naming an unavailable row is a 400 that names it, never a silently ignored
 * condition. That is the same rule as an unknown field key in the filter
 * compiler, for the same reason: a dropped condition widens a result set, and
 * a widened result set can cross a permission scope.
 *
 * WHAT ANSWERS EACH ROW.
 *
 *   touched / untouched  the append-only audit log. Every record mutation
 *                        writes it (`records/service.ts`), so "has anything
 *                        happened to this record since it was created" is an
 *                        EXISTS test over `AuditLog` rows for the record whose
 *                        action is not one a record is BORN with — see
 *                        `OPENING_ACTIONS`, which is where the difference
 *                        between a useful filter and a dead one lives.
 *   recordAction         the action of the record's MOST RECENT audit row.
 *   campaigns            the storage shape's `campaignColumn`.
 *
 * WHY THE OTHER SIX CANNOT BE ANSWERED — each for a concrete, checkable
 * reason, not "a future slice". See `CAPABILITIES`.
 *
 * WHERE THE AUDIT ROWS ARE ADDRESSED FROM. `AuditLog` has NO relation to
 * `Lead`, `Deal` or `Record` — it addresses rows by `(entityType, entityId)`,
 * where `entityType` is the PRISMA MODEL NAME the storage shape declares and
 * never a module slug (a slug is Admin-editable; renaming one would orphan
 * every timeline entry). Prisma cannot express an EXISTS against an unrelated
 * model inside a `where`, so these filters resolve to an ID SET and compose as
 * `{ id: { in } }` / `{ id: { notIn } }`. That set is bounded on purpose —
 * see `AUDIT_ID_CAP`.
 */
// `AuditAction` is both: the generated runtime object (the vocabulary, read
// below instead of hand-keeping a list) and the union type of its values.
import { AuditAction, prisma, type AuditAction as AuditActionType } from '@crm/db';
import {
  SYSTEM_FILTER_IDS,
  type SystemFilterDto,
  type SystemFilterId,
  type SystemFilterOption,
  type SystemFilterSelection,
} from '@crm/shared';
import { canReadModuleConfig } from '../config/access.js';
import { ConfigError, requireModule } from '../config/service.js';
import type { Principal } from '../principal.js';
import { storageFor, type Row, type StorageShape } from './list.js';

/**
 * Everything a system filter is allowed to know about the module it is being
 * asked on. A SHAPE and a config flag — never a slug, never a field key.
 */
export interface SystemFilterContext {
  shape: StorageShape;
  /**
   * Whether this module keeps a timeline at all. A module with `hasTimeline`
   * false gets an empty timeline from `getTimeline`, and a filter derived from
   * history it declines to show would both contradict that and disclose it.
   */
  hasTimeline: boolean;
}

// ── the capability table ──────────────────────────────────────────────────

/**
 * An engine surface a system filter answers FROM.
 *
 * Present means "something in this product writes it and something can read
 * it back per record". `null` means the surface does not exist — ONE flag, in
 * ONE place, so a future writer flips a single value here rather than hunting
 * for a hardcoded `available: false`. Flipping a flag without also supplying
 * the row's `where` builder fails LOUDLY (see `unanswerable`), which is the
 * behaviour we want: a filter that compiles to nothing is worse than one that
 * refuses.
 */
interface Capability {
  /** what to call it when explaining the refusal */
  readonly name: string;
}

type CapabilityKey =
  | 'activitySource'
  | 'cadenceEngine'
  | 'emailDelivery'
  | 'recordLock'
  | 'relatedRecordAudit';

const CAPABILITIES: Record<CapabilityKey, Capability | null> = {
  /**
   * Layer B. `ActivityLog` is a real table in `schema.prisma`, and NOTHING IN
   * THIS REPOSITORY WRITES IT — a search for `activityLog.create` /
   * `.createMany` across `apps/` and `packages/` finds zero writers. So the
   * table is empty by construction and a filter over it matches nothing on
   * every record, forever. That is a lie dressed as a filter, not a slice
   * waiting its turn.
   */
  activitySource: null,
  /**
   * A cadence is a Zoho feature: a scheduled multi-step outreach sequence. No
   * cadence exists in this schema or in the spec — there is no sequence, no
   * step, no enrolment and no scheduler to read one off.
   */
  cadenceEngine: null,
  /**
   * There is no email system in this product. No send path, no delivery
   * receipt, no bounce handling — so no record has a latest email status.
   */
  emailDelivery: null,
  /**
   * There is no record-level lock. The only `isLocked` column in the schema is
   * on `Role`, and it is the guardrail that stops the Admin role being edited
   * away; it says nothing about any record.
   */
  recordLock: null,
  /**
   * "Has anything happened on a RELATED record" needs an action test across
   * another module's rows. The link exists, but audit rows are addressed by
   * `(entityType, entityId)` with no relation to the record tables, so this
   * needs a join the compiler has no shape for — genuinely more work than the
   * three answerable rows, and stated as such rather than as "coming soon".
   */
  relatedRecordAudit: null,
};

// ── audit vocabulary ──────────────────────────────────────────────────────

/**
 * The entries a record is BORN with. "Touched" means anything but these.
 *
 * `RECORD_CREATED` is the obvious one. `ASSIGNED` is the one that matters:
 * invariant 1 says nothing is ever unassigned, so `createRecord` writes an
 * owner entry in the SAME transaction as the creation — every record in this
 * product is born created AND owned. Counting that as a touch would make
 * "Untouched Records" return nothing on Leads, forever, which is a filter that
 * looks like it works and never narrows.
 *
 * Excluding `ASSIGNED` hides no real activity: it is written at creation and
 * NOWHERE ELSE. A later owner change writes `REASSIGNED` (`reassignRecord`) or
 * `OWNERSHIP_TRANSFERRED` (`conversion/transfer.ts`), both of which count as a
 * touch. Verified by grep over every `action:` written in the repository, and
 * cheap to re-verify — which is why the claim is written down rather than
 * assumed.
 *
 * The timestamps cannot answer this instead: Prisma evaluates `@default(now())`
 * per write rather than per transaction, so the birth entries do not share a
 * timestamp and "anything later than the creation row" counts every record.
 */
const OPENING_ACTIONS: readonly AuditActionType[] = ['RECORD_CREATED', 'ASSIGNED'];

/**
 * Actions that can never be a RECORD's most recent action, because they are
 * not written against a record at all.
 *
 * `CONFIG_CHANGED` is written with `entityType: "config:<configType>"`
 * (`config/service.ts`), a namespace no table's `entityType` can equal — so no
 * record's timeline can ever end on one. Everything else in the enum is
 * written against a table's own `entityType`, including `USER_LOGIN`,
 * `USER_LOGOUT` and `PASSWORD_RESET`, which land on `User` rows and so are
 * legitimately the last thing that happened to a person's record.
 */
const NEVER_ON_A_RECORD: ReadonlySet<string> = new Set<string>(['CONFIG_CHANGED']);

/**
 * Plain words per action.
 *
 * The timeline's own copy (`timeline-panel.tsx`) is a CLIENT component under
 * `apps/web/app/`, which a package may not import — and its sentences are
 * verb phrases for a feed ("created this record"), not labels for a picker.
 * So the vocabulary is stated once, here, and travels to the rail inside the
 * DTO: the rail renders `option.label` and owns no copy of this map.
 */
const ACTION_LABELS: Record<string, string> = {
  RECORD_CREATED: 'Created',
  RECORD_UPDATED: 'Updated',
  RECORD_DELETED: 'Deleted',
  RECORD_RESTORED: 'Restored',
  FIELD_CHANGED: 'Field changed',
  STATUS_CHANGED: 'Status changed',
  ASSIGNED: 'Owner set',
  REASSIGNED: 'Owner changed',
  OWNERSHIP_TRANSFERRED: 'Ownership transferred',
  DEPOSIT_RECEIVED: 'Deposit received',
  CONVERTED: 'Converted',
  NOTE_ADDED: 'Note added',
  CALL_LOGGED: 'Call logged',
  IMPORTED: 'Imported',
  WEBHOOK_RECEIVED: 'Webhook received',
  DUPLICATE_FLAGGED: 'Flagged as duplicate',
  DUPLICATE_RESOLVED: 'Duplicate resolved',
  USER_LOGIN: 'Signed in',
  USER_LOGOUT: 'Signed out',
  PASSWORD_RESET: 'Password reset',
};

/** `SOMETHING_HAPPENED` -> `Something happened`, for an action added later. */
function humanise(action: string): string {
  const words = action.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The choices for "Record Action", read from the ENUM Prisma generated from
 * the schema rather than from a hand-kept list — the same reasoning as
 * `columnIsNullableOn` in `records/list.ts`: this is the database's answer, so
 * a migration that adds an action cannot leave a stale list behind.
 */
function recordActionOptions(): SystemFilterOption[] {
  return Object.values(AuditAction)
    .filter((action) => !NEVER_ON_A_RECORD.has(action))
    .map((action) => ({ value: action, label: ACTION_LABELS[action] ?? humanise(action) }));
}

const RECORD_ACTIONS: ReadonlySet<string> = new Set(recordActionOptions().map((o) => o.value));

// ── the id-set resolution, and its ceiling ────────────────────────────────

/**
 * How many record ids a system filter may put into one `IN (...)`.
 *
 * `AuditLog` has no relation to the record tables, so these filters cannot be
 * a subquery — they are an id list travelling as Prisma parameters. Postgres
 * caps a statement at 65,535 bind parameters, and long before that a 10,000-id
 * list is ~370 KB of query text per request, parsed and planned on a pooled
 * connection every time somebody pages the list. Ten thousand is the point
 * where "this is a filter" turns into "this is a table scan with extra steps".
 *
 * EXCEEDING IT THROWS. It does not truncate, and it does not fall back to the
 * unfiltered list: a truncated id set is a page of results that is confidently
 * wrong, and the person reading it has no way to tell. The refusal names the
 * real fix — a denormalised column on the record table, maintained on write —
 * which is a migration, not a patch to this file.
 */
export const AUDIT_ID_CAP = 10_000;

const capExceeded = (what: string): ConfigError =>
  new ConfigError(
    `Too many records match "${what}" to filter this way (over ${AUDIT_ID_CAP.toLocaleString()}). ` +
      `This filter resolves through the audit log, which has no join to the record table, so it can only ` +
      `carry a bounded list of ids — and adding another filter cannot help, because that list is built ` +
      `before any of them apply. Answering it at this size needs the fact kept on the record itself.`,
    422,
    'VALIDATION',
  );

/**
 * Every record of this `entityType` that has been touched since it was
 * created — the SMALL side of the pair, and the one both `touched` and
 * `untouched` are derived from.
 *
 * `groupBy` and not `distinct`: `groupBy` is a real SQL `GROUP BY`, so `take`
 * limits GROUPS. Prisma's `distinct` has historically been applied after the
 * rows come back, which would make `take` limit ROWS and hand back fewer
 * distinct ids than exist — a silently short list, which is exactly the wrong
 * failure. Taking `CAP + 1` is how the ceiling is detected rather than guessed.
 *
 * NOTE for Admin-created modules: every one of them stores in the generic
 * `records` table and therefore shares the `Record` entityType, so this set
 * spans all of them. That is CORRECT — the module discriminator is ANDed in by
 * `scopedWhere`, so ids from a sibling module match nothing — but it does make
 * the cap arrive sooner on a busy generic table, which is the honest cost of
 * one shared table and is why the refusal above is explicit.
 */
async function touchedIds(entityType: string): Promise<string[]> {
  const groups = await prisma.auditLog.groupBy({
    by: ['entityId'],
    where: { entityType, action: { notIn: [...OPENING_ACTIONS] } },
    orderBy: { entityId: 'asc' },
    take: AUDIT_ID_CAP + 1,
  });
  if (groups.length > AUDIT_ID_CAP) throw capExceeded('touched records');
  return groups.map((g) => g.entityId);
}

/**
 * Every record of this `entityType` whose MOST RECENT audit row carries
 * `action`.
 *
 * Two bounded aggregates, because "the row with the greatest createdAt per
 * group" is not something a Prisma `where` can express:
 *
 *   1. per record, the last time `action` happened — the candidates, capped;
 *   2. per candidate, the last time anything ELSE happened.
 *
 * A candidate qualifies when (2) is absent or not later than (1). The second
 * query is bounded by the first, so the pair cannot outgrow the cap.
 *
 * TIES: `AuditLog` orders only by `createdAt`, and two rows written in the
 * same instant are genuinely ambiguous. `action` wins the tie — stated here
 * because a silent coin-flip is the kind of thing that gets rediscovered as a
 * bug three years later.
 */
async function latestActionIds(entityType: string, action: AuditActionType): Promise<string[]> {
  const candidates = await prisma.auditLog.groupBy({
    by: ['entityId'],
    where: { entityType, action },
    _max: { createdAt: true },
    orderBy: { entityId: 'asc' },
    take: AUDIT_ID_CAP + 1,
  });
  if (candidates.length > AUDIT_ID_CAP) throw capExceeded('that action');
  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.entityId);
  const others = await prisma.auditLog.groupBy({
    by: ['entityId'],
    where: { entityType, entityId: { in: ids }, action: { not: action } },
    _max: { createdAt: true },
    orderBy: { entityId: 'asc' },
  });

  const lastOther = new Map<string, number>();
  for (const row of others) {
    const at = row._max.createdAt;
    if (at) lastOther.set(row.entityId, at.getTime());
  }

  return candidates
    .filter((c) => {
      const at = c._max.createdAt;
      if (!at) return false;
      const other = lastOther.get(c.entityId);
      return other === undefined || other <= at.getTime();
    })
    .map((c) => c.entityId);
}

// ── the spec table: one row per filter, reason stated as data ─────────────

/** Matches every row. Only ever the answer to "nothing narrows this". */
const MATCH_ALL: Row = {};

/** Matches no row, on every delegate. */
const MATCH_NONE: Row = { id: { in: [] as string[] } };

/**
 * One resolution pass. `touched` and `untouched` in the same query would
 * otherwise issue the same aggregate twice.
 */
interface Answering {
  ctx: SystemFilterContext;
  touched(): Promise<string[]>;
}

interface SystemFilterSpec {
  /** the Figma file's label, verbatim */
  label: string;
  /** does the row carry a value? `options` lists the choices when it does */
  takesValue: boolean;
  /** the reason this module cannot answer it, or null when it can */
  blockedBy(ctx: SystemFilterContext): string | null;
  options(ctx: SystemFilterContext): SystemFilterOption[] | null;
  /** only ever called after `blockedBy` returned null */
  where(run: Answering, value: string | null): Promise<Row>;
}

/** The `where` of a row nothing can answer. Unreachable while its capability
 *  is null — and loud if a capability is flipped on without a builder. */
const unanswerable =
  (id: SystemFilterId) =>
  (): Promise<Row> => {
    throw new ConfigError(
      `System filter "${id}" has no implementation. Its capability was enabled without one.`,
      500,
      'VALIDATION',
    );
  };

/** A blocker that reports a missing engine surface, or null when it is there. */
const needs =
  (key: CapabilityKey, reason: string) =>
  (): string | null =>
    CAPABILITIES[key] === null ? reason : null;

/** The audit-backed rows all need the module to keep a timeline. */
function needsTimeline(ctx: SystemFilterContext): string | null {
  return ctx.hasTimeline
    ? null
    : 'This module keeps no timeline, so there is no record history to test.';
}

const NO_OPTIONS = (): null => null;

/**
 * THE table. One row per id: its label, what it needs, why it cannot be
 * answered when it cannot, and how it narrows the query when it can.
 */
const SYSTEM_FILTER_SPECS: Record<SystemFilterId, SystemFilterSpec> = {
  activities: {
    label: 'Activities',
    takesValue: false,
    blockedBy: needs(
      'activitySource',
      'Nothing in this product writes the activity log yet, so every record would match nothing.',
    ),
    options: NO_OPTIONS,
    where: unanswerable('activities'),
  },
  cadences: {
    label: 'Cadences',
    takesValue: false,
    blockedBy: needs(
      'cadenceEngine',
      'There are no cadences in this CRM — no sequence, no steps and nothing to be enrolled in.',
    ),
    options: NO_OPTIONS,
    where: unanswerable('cadences'),
  },
  campaigns: {
    label: 'Campaigns',
    takesValue: false,
    blockedBy: (ctx) =>
      ctx.shape.campaignColumn === null
        ? 'Records in this module carry no campaign link, so there is nothing to attribute.'
        : null,
    options: NO_OPTIONS,
    // A presence test: "came in on a campaign". The rail draws no picker for
    // this row (`options` is null), so it takes no value — picking WHICH
    // campaign is an ordinary field filter on the campaign column and belongs
    // in the Filter By fields group, not here.
    where: async (run) => {
      const column = run.ctx.shape.campaignColumn;
      // Unreachable: `blockedBy` refused this module already. Belt and braces,
      // because the alternative to a throw here is a `{}` that matches all.
      if (!column) throw unanswerable('campaigns')();
      return { [column]: { not: null } };
    },
  },
  latestEmailStatus: {
    label: 'Latest Email Status',
    takesValue: false,
    blockedBy: needs(
      'emailDelivery',
      'This CRM sends no email, so no record has an email status to be latest.',
    ),
    options: NO_OPTIONS,
    where: unanswerable('latestEmailStatus'),
  },
  locked: {
    label: 'Locked',
    takesValue: false,
    blockedBy: needs(
      'recordLock',
      'Records cannot be locked in this CRM — the only lock in the system guards the Admin role, not a record.',
    ),
    options: NO_OPTIONS,
    where: unanswerable('locked'),
  },
  recordAction: {
    label: 'Record Action',
    takesValue: true,
    blockedBy: needsTimeline,
    options: () => recordActionOptions(),
    where: async (run, value) => {
      if (value === null || !RECORD_ACTIONS.has(value)) {
        throw new ConfigError(
          `System filter "recordAction" needs one of its listed actions; "${value ?? ''}" is not one.`,
          400,
          'VALIDATION',
        );
      }
      const ids = await latestActionIds(run.ctx.shape.entityType, value as AuditActionType);
      return ids.length === 0 ? MATCH_NONE : { id: { in: ids } };
    },
  },
  relatedRecordAction: {
    label: 'Related Record Action',
    takesValue: false,
    blockedBy: needs(
      'relatedRecordAudit',
      'Audit rows are addressed by entity type and id with no join to the record tables, so an action on a RELATED record cannot be tested yet.',
    ),
    options: NO_OPTIONS,
    where: unanswerable('relatedRecordAction'),
  },
  touched: {
    label: 'Touched Records',
    takesValue: false,
    blockedBy: needsTimeline,
    options: NO_OPTIONS,
    where: async (run) => {
      const ids = await run.touched();
      return ids.length === 0 ? MATCH_NONE : { id: { in: ids } };
    },
  },
  untouched: {
    label: 'Untouched Records',
    takesValue: false,
    blockedBy: needsTimeline,
    options: NO_OPTIONS,
    where: async (run) => {
      const ids = await run.touched();
      // Nothing has been touched, so everything is untouched. `MATCH_ALL` is
      // the ANSWER here, not a dropped condition — and it is still ANDed
      // under the actor's scope by `combine`, so it widens nothing. Stated
      // rather than left to Prisma's handling of `notIn: []`.
      return ids.length === 0 ? MATCH_ALL : { id: { notIn: ids } };
    },
  },
};

// ── the two public entry points ───────────────────────────────────────────

/**
 * The nine rows for one module, in the file's order, each with a straight
 * answer about whether this module can serve it.
 */
export function resolveSystemFilters(ctx: SystemFilterContext): SystemFilterDto[] {
  return SYSTEM_FILTER_IDS.map((id) => {
    const spec = SYSTEM_FILTER_SPECS[id];
    const reason = spec.blockedBy(ctx);
    return {
      id,
      label: spec.label,
      available: reason === null,
      reason,
      // An unavailable row has no choices to offer: the picker would be a
      // control on a dead filter.
      options: reason === null ? spec.options(ctx) : null,
    };
  });
}

/**
 * The rail's system group for a module named by slug.
 *
 * Read-gated like every other config read of a module, and a refusal is a 404
 * rather than a 403: to an actor with no access, an unknown module and a
 * forbidden one must be indistinguishable — the same answer `requireModule`
 * gives for a slug that does not exist.
 */
export async function listSystemFilters(
  principal: Principal,
  moduleSlug: string,
): Promise<SystemFilterDto[]> {
  if (!canReadModuleConfig(principal, moduleSlug)) {
    throw new ConfigError(`Unknown module "${moduleSlug}"`, 404, 'NOT_FOUND');
  }
  const module = await requireModule(moduleSlug);
  // No fields needed: every question here is asked of the SHAPE.
  const storage = storageFor({ id: module.id, slug: module.slug, isCore: module.isCore }, []);
  return resolveSystemFilters({ shape: storage.shape, hasTimeline: module.hasTimeline });
}

/**
 * Compile the selected rows into where-fragments, ONE PER SELECTION.
 *
 * They come back as an array and not as a merged object on purpose: two rows
 * can narrow the same key — `touched` and `untouched` both narrow `id` — and a
 * flat merge would drop one of them, turning a contradiction into a result
 * set. The caller ANDs them (see `userWhereFor` in `records/list.ts`), so
 * every selection survives and each can only ever narrow.
 *
 * Anything it cannot answer THROWS, naming the id:
 *   - a row this module cannot serve — never ignored, because a filter the
 *     user believes is applied is worse than an error;
 *   - a value on a row that takes none, or a missing/unknown value on the one
 *     that does.
 */
export async function systemFilterWhere(
  ctx: SystemFilterContext,
  selections: readonly SystemFilterSelection[] | null | undefined,
): Promise<Row[]> {
  if (!selections || selections.length === 0) return [];

  let touchedOnce: Promise<string[]> | null = null;
  const run: Answering = {
    ctx,
    touched: () => (touchedOnce ??= touchedIds(ctx.shape.entityType)),
  };

  const parts: Row[] = [];
  for (const selection of selections) {
    const spec = SYSTEM_FILTER_SPECS[selection.id];
    // An id outside the vocabulary never reaches here — `recordQuerySchema`
    // parses it against SYSTEM_FILTER_IDS — but a caller inside the engine
    // could still hand one over, and a missing spec must not read as "no
    // condition".
    if (!spec) {
      throw new ConfigError(`Unknown system filter "${selection.id}"`, 400, 'VALIDATION');
    }

    const reason = spec.blockedBy(ctx);
    if (reason !== null) {
      throw new ConfigError(
        `System filter "${selection.id}" is not available on this module. ${reason}`,
        400,
        'VALIDATION',
      );
    }

    if (!spec.takesValue && selection.value !== undefined) {
      throw new ConfigError(
        `System filter "${selection.id}" takes no value.`,
        400,
        'VALIDATION',
      );
    }
    if (spec.takesValue && selection.value === undefined) {
      throw new ConfigError(
        `System filter "${selection.id}" needs a value.`,
        400,
        'VALIDATION',
      );
    }

    parts.push(await spec.where(run, selection.value ?? null));
  }
  return parts;
}
