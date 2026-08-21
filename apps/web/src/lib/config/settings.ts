/**
 * Platform settings — read and write.
 *
 * These rows are the POINTERS that keep the assignment engine free of names:
 * which Role is the ARK senior pool, which Group is the default pool, who a
 * converted deal hands over to. See packages/shared/src/settings.ts for why
 * pointers rather than names, and packages/db/prisma/schema.prisma for why a
 * key/value table does not breach invariant 3.
 *
 * Two rules shape this file:
 *
 *   - A READ never throws. Every setting resolves, and an absent or corrupt
 *     row resolves to its default rather than an exception, because these
 *     values are read on the path that assigns an owner to a new lead.
 *     Invariant 1 says that lead still gets an owner; a settings read that
 *     threw would leave it with none.
 *   - A WRITE proves its pointer. A key naming a role that was deleted last
 *     month passes every type check and then silently routes every ARK lead
 *     to the Admin — the failure looks like "assignment is broken" and
 *     nothing in the timeline says why. So the row is verified live, on write,
 *     while there is still a human to show the error to.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTING_VALUE_SCHEMAS,
  type AssignmentSettings,
  type SettingKey,
  type SettingValues,
  type SettingsPatch,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { applyConfigChange, ConfigError, type Tx } from '@/lib/config/service';

/**
 * Settings writes log as MODULE with the setting KEY as configId.
 *
 * CONFIG_TYPES is a fixed union and inventing a member would break every
 * reader of the log, so this borrows the same slot role writes borrow — there,
 * configId is a role id; here it is a setting key. Both are stable
 * identifiers, which is all the log viewer requires of a configId.
 */
const SETTING_CONFIG_TYPE = 'MODULE' as const;

// ── permission gate ───────────────────────────────────────────────────────

/**
 * Platform settings are ADMIN-ONLY, and deliberately not delegable.
 *
 * `assertConfigPermission` maps a config type to a special, but no member of
 * the fixed SPECIAL_PERMISSIONS union means "platform administrator" — every
 * one of them is a module-scoped or task-scoped grant. Nominating the senior
 * pool decides where every ARK lead in the business lands, which is broader
 * than any of them: a field manager must not be able to re-aim lead routing,
 * and neither must a user administrator. Spec §5.5 puts destructive platform
 * powers with the Admin, delegated later through the matrix — when that
 * delegation exists it will be a new special, added here, not a looser check.
 *
 * Fail-closed, same as `assertConfigPermission`: no Admin flag, no write.
 */
export function canManagePlatformSettings(principal: Principal): boolean {
  return principal.actor.isAdmin;
}

function assertPlatformAdmin(principal: Principal): void {
  if (!canManagePlatformSettings(principal)) {
    throw new ConfigError('Platform settings are administrator-only', 403, 'FORBIDDEN');
  }
}

// ── reads ─────────────────────────────────────────────────────────────────

/**
 * Turn a stored JSON value into a typed setting.
 *
 * A row that fails its own schema resolves to the default and is LOGGED, not
 * thrown: the only ways to get one are a hand-edited row or a shipped shape
 * change, and in both cases the right behaviour is for assignment to fall to
 * the next tier — group, then pool, then Admin — rather than for lead
 * creation to start failing.
 */
function resolve<K extends SettingKey>(key: K, raw: unknown): SettingValues[K] {
  if (raw === undefined) return SETTING_DEFAULTS[key];

  const parsed = SETTING_VALUE_SCHEMAS[key].safeParse(raw);
  if (parsed.success) return parsed.data;

  console.error(`[settings] "${key}" holds a value that no longer matches its schema; using the default`);
  return SETTING_DEFAULTS[key];
}

/** One setting. No principal: this is the server-internal read used by the
 *  assignment path, where the actor may be the ARK webhook rather than a user.
 *  The HTTP surface is gated in `getSettings`. */
export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
  const row = await prisma.platformSetting.findUnique({
    where: { key },
    select: { value: true },
  });
  return resolve(key, row?.value);
}

/**
 * The two pointers the assignment engine needs, in ONE query — this runs on
 * every lead create and every ARK webhook, so it must not be two round trips
 * to a cross-region pooler.
 */
export async function getAssignmentSettings(): Promise<AssignmentSettings> {
  const keys = ['assignment.seniorRoleId', 'assignment.defaultPoolGroupId'] as const;
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [...keys] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  return {
    seniorRoleId: resolve('assignment.seniorRoleId', byKey.get('assignment.seniorRoleId')),
    defaultPoolGroupId: resolve(
      'assignment.defaultPoolGroupId',
      byKey.get('assignment.defaultPoolGroupId'),
    ),
  };
}

/**
 * Every setting, resolved — the settings screen's payload. Written as an
 * explicit literal rather than a loop so that adding a key to SETTING_KEYS
 * fails to compile here until it is resolved, instead of quietly coming back
 * missing.
 */
export async function getSettings(principal: Principal): Promise<SettingValues> {
  assertPlatformAdmin(principal);

  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [...SETTING_KEYS] } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  return {
    'assignment.seniorRoleId': resolve('assignment.seniorRoleId', byKey.get('assignment.seniorRoleId')),
    'assignment.defaultPoolGroupId': resolve(
      'assignment.defaultPoolGroupId',
      byKey.get('assignment.defaultPoolGroupId'),
    ),
    'deals.handoverRule': resolve('deals.handoverRule', byKey.get('deals.handoverRule')),
  };
}

// ── pointer validation ────────────────────────────────────────────────────

/**
 * Prove the nominated row exists and is live, or refuse the write.
 *
 * 422 rather than 404: the request is well-formed and the ROUTE exists — what
 * failed is a business rule about the value. The message names the setting so
 * the settings screen can put the error on the right control.
 */
async function requireLiveRole(tx: Tx, roleId: string, key: SettingKey): Promise<void> {
  const role = await tx.role.findFirst({ where: { id: roleId, isDeleted: false }, select: { id: true } });
  if (!role) {
    throw new ConfigError(`"${key}" names a role that no longer exists`, 422, 'VALIDATION');
  }
}

async function requireLiveGroup(tx: Tx, groupId: string, key: SettingKey): Promise<void> {
  const group = await tx.group.findFirst({ where: { id: groupId, isDeleted: false }, select: { id: true } });
  if (!group) {
    throw new ConfigError(`"${key}" names a group that no longer exists`, 422, 'VALIDATION');
  }
}

/** Active, not merely present: a deactivated user still has rows, but handing
 *  them new deals is the same dead end as a deleted role (spec §5.5). */
async function requireActiveUser(tx: Tx, userId: string, key: SettingKey): Promise<void> {
  const user = await tx.user.findFirst({ where: { id: userId, isActive: true }, select: { id: true } });
  if (!user) {
    throw new ConfigError(`"${key}" names a user who is not active`, 422, 'VALIDATION');
  }
}

type PointerCheck<K extends SettingKey> = (tx: Tx, value: SettingValues[K]) => Promise<void>;

/**
 * One check per key, so `setSetting` never switches on the key it was handed.
 * Null always passes — clearing a pointer is a legitimate write, and the
 * engines degrade to the next tier when it is unset.
 */
const POINTER_CHECKS: { [K in SettingKey]: PointerCheck<K> } = {
  'assignment.seniorRoleId': async (tx, value) => {
    if (value !== null) await requireLiveRole(tx, value, 'assignment.seniorRoleId');
  },
  'assignment.defaultPoolGroupId': async (tx, value) => {
    if (value !== null) await requireLiveGroup(tx, value, 'assignment.defaultPoolGroupId');
  },
  'deals.handoverRule': async (tx, value) => {
    if (value === null) return;
    const key: SettingKey = 'deals.handoverRule';
    // Branching on the rule's own discriminator, never on a module or a name:
    // `type` says which table the id belongs to, and any row in that table may
    // be nominated.
    switch (value.type) {
      case 'user':
        return requireActiveUser(tx, value.id, key);
      case 'role':
        return requireLiveRole(tx, value.id, key);
      case 'pool':
        return requireLiveGroup(tx, value.id, key);
    }
  },
};

// ── writes ────────────────────────────────────────────────────────────────

/** What lands in ConfigChangeLog.before / .after. */
interface SettingSnapshot {
  key: SettingKey;
  value: unknown;
}

/**
 * Write one setting.
 *
 * Routed through `applyConfigChange` so a settings change is diffed into
 * ConfigChangeLog and shows up in the change viewer beside every other admin
 * write, with its own AuditLog row in the same transaction. (The viewer
 * withholds snapshots from anyone who cannot resolve the change's module;
 * a setting key resolves to no module, so non-admins see that the change
 * happened and not what it said — which is the correct answer for a surface
 * only the Admin may read.)
 *
 * Reverting one is refused by revert.ts, which has no table for MODULE. That
 * is deliberate: an undo here must re-run this function so the pointer is
 * re-proved against today's rows, never write a stale id back behind the
 * check.
 */
export async function setSetting<K extends SettingKey>(
  principal: Principal,
  key: K,
  value: SettingValues[K],
): Promise<SettingValues[K]> {
  assertPlatformAdmin(principal);

  // Re-validate the shape even though the route already parsed it: this
  // function is the only writer, so every guarantee about what reaches the
  // table has to hold HERE rather than at whichever call site got there.
  const parsed: SettingValues[K] = SETTING_VALUE_SCHEMAS[key].parse(value);

  // Prisma reads a bare `null` on a Json column as "leave it alone", and the
  // column is non-nullable, so a cleared pointer must be written as an
  // explicit JSON null.
  const stored = parsed === null ? Prisma.JsonNull : (parsed as Prisma.InputJsonValue);

  const { result } = await applyConfigChange<SettingValues[K]>({
    principal,
    configType: SETTING_CONFIG_TYPE,
    action: 'UPDATE',
    // The gate that matters is `assertPlatformAdmin` above; the funnel asserts
    // again and cannot be handed an admin-only special, so it is pointed at
    // the closest one rather than at MANAGE_FIELDS_LAYOUTS, which the MODULE
    // config type would otherwise imply.
    special: 'MANAGE_USERS_ROLES',
    before: async (tx) => {
      const row = await tx.platformSetting.findUnique({ where: { key }, select: { value: true } });
      return row === null ? null : ({ key, value: row.value } satisfies SettingSnapshot);
    },
    mutate: async (tx) => {
      // Inside the transaction, so the row is proved live against the same
      // snapshot the write commits against.
      await POINTER_CHECKS[key](tx, parsed);

      await tx.platformSetting.upsert({
        where: { key },
        create: { key, value: stored },
        update: { value: stored },
      });
      return { result: parsed, configId: key };
    },
    after: async () => ({ key, value: parsed }) satisfies SettingSnapshot,
  });

  return result;
}

/**
 * Apply a partial patch — the settings screen's save.
 *
 * One `setSetting` call per key, so each setting gets its own
 * ConfigChangeLog row: a combined entry would be ambiguous to diff and could
 * not be reasoned about per pointer. Iterating SETTING_KEYS rather than
 * Object.keys(patch) keeps the order deterministic and ignores anything the
 * schema did not declare.
 */
export async function setSettings(principal: Principal, patch: SettingsPatch): Promise<SettingValues> {
  assertPlatformAdmin(principal);

  for (const key of SETTING_KEYS) {
    await PATCH_APPLIERS[key](principal, patch);
  }

  return getSettings(principal);
}

/**
 * One applier per key, for the same reason POINTER_CHECKS exists: reading
 * `patch[key]` with an ITERATED key loses the correlation between the key and
 * its value type, and TypeScript will not accept the result without a cast —
 * a cast in exactly the place a wrong-shaped value would reach the table.
 * Naming each key as a literal keeps the correlation, and the mapped type
 * makes a newly added SETTING_KEY fail to compile until it is handled.
 */
const PATCH_APPLIERS: {
  [K in SettingKey]: (principal: Principal, patch: SettingsPatch) => Promise<void>;
} = {
  'assignment.seniorRoleId': (principal, patch) =>
    applyIfPresent(principal, 'assignment.seniorRoleId', patch['assignment.seniorRoleId']),
  'assignment.defaultPoolGroupId': (principal, patch) =>
    applyIfPresent(principal, 'assignment.defaultPoolGroupId', patch['assignment.defaultPoolGroupId']),
  'deals.handoverRule': (principal, patch) =>
    applyIfPresent(principal, 'deals.handoverRule', patch['deals.handoverRule']),
};

async function applyIfPresent<K extends SettingKey>(
  principal: Principal,
  key: K,
  value: SettingValues[K] | undefined,
): Promise<void> {
  // `undefined` means "not in the patch"; `null` is a real value that clears
  // the pointer, so the two must not be collapsed.
  if (value === undefined) return;
  await setSetting(principal, key, value);
}
