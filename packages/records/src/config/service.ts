/**
 * THE single config write path.
 *
 * Every admin configuration mutation — field, section, status, picklist
 * option, layout — funnels through `applyConfigChange`. Nothing else in the
 * codebase may write these tables. That single funnel is what makes three
 * spec guarantees structural rather than remembered:
 *
 *   - the required SpecialPermission is asserted HERE, so a route handler
 *     that forgets the check still cannot mutate config;
 *   - before/after snapshots are captured HERE, so every change lands in
 *     ConfigChangeLog with a diff and undo support (spec §13);
 *   - the mutation and its log rows commit in ONE transaction, so they can
 *     never diverge.
 */
import { prisma, Prisma } from '@crm/db';
import type { ApiError, ConfigAction, ConfigType, SpecialPermission } from '@crm/shared';
import type { Principal } from '../principal.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: ApiError['code'],
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Which special unlocks which config type. */
const REQUIRED_SPECIAL: Record<ConfigType, SpecialPermission> = {
  FIELD: 'MANAGE_FIELDS_LAYOUTS',
  SECTION: 'MANAGE_FIELDS_LAYOUTS',
  LAYOUT: 'MANAGE_FIELDS_LAYOUTS',
  PICKLIST_OPTION: 'MANAGE_FIELDS_LAYOUTS',
  STATUS: 'MANAGE_STATUSES',
  MODULE: 'MANAGE_FIELDS_LAYOUTS',
  // Webhook sources exist to feed campaign leads, so the matrix delegates them
  // with the campaigns special rather than with the field/layout one.
  WEBHOOK_SOURCE: 'MANAGE_CAMPAIGNS',
};

/**
 * `special` overrides the configType -> special mapping for the rare write
 * whose config type does not imply its permission. CONFIG_TYPES is a fixed
 * union, so a role's permission matrix logs as MODULE — but it is a user
 * administration write, not a field/layout one. Defaulting it to
 * MANAGE_FIELDS_LAYOUTS would both lock a delegated user administrator out of
 * their own screen and hand permission editing to anyone who can move a field.
 */
export function assertConfigPermission(
  principal: Principal,
  configType: ConfigType,
  special: SpecialPermission = REQUIRED_SPECIAL[configType],
): void {
  const allowed = principal.actor.isAdmin || principal.permissions.specials.has(special);
  if (!allowed) {
    throw new ConfigError(`Requires the "${special}" permission`, 403, 'FORBIDDEN');
  }
}

export type Tx = Prisma.TransactionClient;

export interface ConfigChangeSpec<T> {
  principal: Principal;
  configType: ConfigType;
  action: ConfigAction;
  /** Override the configType -> special mapping. See assertConfigPermission.
   *  The assertion still happens HERE, so the route cannot forget it. */
  special?: SpecialPermission;
  /**
   * Interactive-transaction budget. Prisma's defaults (5s timeout, 2s maxWait)
   * are sized for a single-row write; a status reassignment touches every
   * record carrying that status and needs far longer against a pooled,
   * cross-region connection. Raise it for those, leave it alone otherwise.
   */
  timeout?: number;
  maxWait?: number;
  /** Load the current state. Return null for CREATE. Runs inside the tx. */
  before: (tx: Tx) => Promise<unknown>;
  /** The mutation itself. Returns the domain result AND the id of the object
   *  (known only after a CREATE). Runs inside the tx. */
  mutate: (tx: Tx) => Promise<{ result: T; configId: string }>;
  /** Load the post-state. Runs inside the tx, after mutate. */
  after: (tx: Tx, configId: string) => Promise<unknown>;
}

export interface ConfigChangeResult<T> {
  result: T;
  changeId: string;
}

export async function applyConfigChange<T>(spec: ConfigChangeSpec<T>): Promise<ConfigChangeResult<T>> {
  // Config is written by PEOPLE. `ConfigChangeLog.actorId` is a NOT-NULL
  // foreign key to `users` precisely so every config change is attributable
  // to someone — a system principal (`systemPrincipal()`) has no row there,
  // and letting it through would fail at insert with an error nobody can act
  // on. Refusing here keeps the invariant loud: pipelines write RECORDS, only
  // humans write CONFIG.
  if (spec.principal.system) {
    throw new ConfigError('System pipelines cannot change configuration', 403, 'FORBIDDEN');
  }
  assertConfigPermission(spec.principal, spec.configType, spec.special);

  return prisma.$transaction(
    async (tx) => {
      const before = await spec.before(tx);
      const { result, configId } = await spec.mutate(tx);
      const after = await spec.after(tx, configId);

      const change = await tx.configChangeLog.create({
        data: {
          actorId: spec.principal.actor.userId,
          configType: spec.configType,
          configId,
          action: spec.action,
          before: before === null ? Prisma.DbNull : (before as Prisma.InputJsonValue),
          after: after === null ? Prisma.DbNull : (after as Prisma.InputJsonValue),
        },
        select: { id: true },
      });

      // Layer A sees config changes too — the admin log viewer reads AuditLog.
      await tx.auditLog.create({
        data: {
          entityType: `config:${spec.configType}`,
          entityId: configId,
          action: 'CONFIG_CHANGED',
          actorType: 'USER',
          actorId: spec.principal.actor.userId,
          changes: { action: { from: null, to: spec.action } } as Prisma.InputJsonObject,
        },
      });

      return { result, changeId: change.id };
    },
    { timeout: spec.timeout ?? 15_000, maxWait: spec.maxWait ?? 5_000 },
  );
}

/**
 * Undo lives in ./revert.ts — it must call the per-type services (so a revert
 * runs the same guardrails as the forward path), and those import this file.
 */

/** Resolve a module by slug or throw a uniform 404. */
export async function requireModule(slug: string) {
  const module = await prisma.moduleDefinition.findUnique({ where: { slug } });
  if (!module || !module.isEnabled) throw new ConfigError(`Unknown module "${slug}"`, 404, 'NOT_FOUND');
  return module;
}
