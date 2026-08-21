import { z } from 'zod';

/**
 * Platform settings — the pointers that let PLATFORM behaviour be aimed at
 * ADMIN-CREATED data without a code change.
 *
 * The problem this file exists to solve: the spec routes unmatched ARK leads
 * to "the Seniors of that language" and everything else to a "default pool".
 * But roles and groups are rows the Admin creates, renames and deletes at
 * will. Matching the string 'Senior' — or 'Default Pool' — would break the
 * first time somebody renames one, which is the exact class of defect the
 * prime directive exists to prevent. It is the same rule that makes status
 * logic read `tag` and never `name`.
 *
 * So the Admin NOMINATES the row instead: 'assignment.seniorRoleId' holds a
 * Role id, 'assignment.defaultPoolGroupId' holds a Group id. Nothing in
 * application code may name either. Rename the role to "Desk Leads" and
 * routing follows it, with no migration and no deploy.
 *
 * Storage is one key/value row per setting (`PlatformSetting`), so adding a
 * setting adds a KEY here — never a column, never a migration.
 */

// ── keys ──────────────────────────────────────────────────────────────────

/**
 * Every platform setting, namespaced `area.name`. The key is the identity of
 * the setting: it is the primary key of `PlatformSetting` AND the `configId`
 * its ConfigChangeLog entries carry, so a key is IMMUTABLE once shipped.
 * Renaming one orphans both the stored value and its whole change history.
 */
export const SETTING_KEYS = [
  /** Role id whose holders are the ARK senior pool (spec §6.7, §7). Null =
   *  not nominated yet, so ARK routing falls straight to the default pool. */
  'assignment.seniorRoleId',
  /** Group id whose members catch every lead no group and no senior claimed
   *  (spec §6.7). Null = not nominated, so the fallback is the Admin. */
  'assignment.defaultPoolGroupId',
  /** Who owns a deal the moment it is created from a converted lead (spec
   *  §7.1). Null = not configured, so the deal goes to the Admin — a deal is
   *  never unowned either. `type` says which table `id` points at. */
  'deals.handoverRule',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

// ── value shapes ──────────────────────────────────────────────────────────

/** Which table a deal handover rule points at. Not a role NAME — 'role' here
 *  means "the id is a Role id", and any role may be nominated. */
export const DEAL_HANDOVER_TARGETS = ['user', 'role', 'pool'] as const;
export type DealHandoverTarget = (typeof DEAL_HANDOVER_TARGETS)[number];

export interface DealHandoverRule {
  type: DealHandoverTarget;
  /** id of the User, Role or Group named by `type` */
  id: string;
}

/**
 * The resolved type of every setting. EVERY value is nullable: an unset
 * pointer is a legitimate state (the client has not nominated a row yet) and
 * the engines must degrade to the next tier rather than fail — invariant 1
 * says the lead still gets an owner.
 */
export interface SettingValues {
  'assignment.seniorRoleId': string | null;
  'assignment.defaultPoolGroupId': string | null;
  'deals.handoverRule': DealHandoverRule | null;
}

export type SettingValue<K extends SettingKey> = SettingValues[K];

/** What an unwritten setting resolves to. Explicit rather than implicit so a
 *  future non-nullable setting has an obvious place to declare its default. */
export const SETTING_DEFAULTS: SettingValues = {
  'assignment.seniorRoleId': null,
  'assignment.defaultPoolGroupId': null,
  'deals.handoverRule': null,
};

// ── validation ────────────────────────────────────────────────────────────

/**
 * A nominated row, or nothing. `.uuid()` because every id in this schema is
 * one — it costs nothing and stops a label being posted where an id belongs.
 * It proves only the SHAPE; that the row still exists and is not soft-deleted
 * is proved server-side on write, where the tables are reachable.
 */
const nominatedIdSchema = z.string().uuid('Expected an id').nullable();

export const dealHandoverSchema = z
  .object({
    type: z.enum(DEAL_HANDOVER_TARGETS),
    id: z.string().uuid('Expected an id'),
  })
  .strict()
  .nullable();

/**
 * The assignment settings as the engine consumes them — short names, because
 * this is a domain object rather than a wire payload. `getAssignmentSettings`
 * returns exactly this.
 */
export const assignmentSettingsSchema = z
  .object({
    seniorRoleId: nominatedIdSchema,
    defaultPoolGroupId: nominatedIdSchema,
  })
  .strict();

export type AssignmentSettings = z.infer<typeof assignmentSettingsSchema>;

/**
 * One validator per key, so a write path can validate a setting it was handed
 * generically without ever switching on the key. Annotated with the mapped
 * type (not `satisfies`) deliberately: indexing a mapped type with a generic
 * `K extends SettingKey` resolves to `ZodType<SettingValues[K]>`, which is
 * what lets `setSetting<K>` stay type-safe with no cast.
 */
export const SETTING_VALUE_SCHEMAS: { [K in SettingKey]: z.ZodType<SettingValues[K]> } = {
  'assignment.seniorRoleId': nominatedIdSchema,
  'assignment.defaultPoolGroupId': nominatedIdSchema,
  'deals.handoverRule': dealHandoverSchema,
};

/**
 * The PUT payload: a PARTIAL write keyed by setting key. Partial because the
 * settings screen saves the control the Admin touched, and a full-document PUT
 * would let a stale tab silently revert a setting somebody else just changed.
 *
 * `.strict()` so an unknown or misspelled key is a 400 rather than a write
 * that appears to succeed and changes nothing. An empty patch is allowed and
 * is a no-op — a save with nothing dirty must not be an error.
 */
export const settingsPatchSchema = z
  .object({
    'assignment.seniorRoleId': nominatedIdSchema.optional(),
    'assignment.defaultPoolGroupId': nominatedIdSchema.optional(),
    'deals.handoverRule': dealHandoverSchema.optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Narrow an arbitrary string to a key. Used where keys arrive as data — a
 *  query string, a ConfigChangeLog row — and must not be trusted. */
export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}
