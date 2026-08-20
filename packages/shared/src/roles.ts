import { z } from 'zod';
import { SPECIAL_PERMISSIONS, VIEW_SCOPES } from './permissions.js';

/**
 * Role and permission-matrix contracts.
 *
 * Defined ONCE here (constraint: validation lives in packages/shared) and
 * consumed by the roles routes, the role config service and the matrix editor.
 * Nothing in this file names a module, a role or a scope value that an Admin
 * could rename — the matrix is generated from ModuleDefinition rows at runtime
 * and validated against them server-side.
 */

// ── the role itself ───────────────────────────────────────────────────────
/** 60 chars matches Status.name; a role name is a label, never an identifier —
 *  behaviour keys off `isLocked` and the granted permissions, never the name. */
export const roleCreateSchema = z.object({
  name: z.string().trim().min(1, 'Role name is required').max(60),
});
export type RoleCreateInput = z.infer<typeof roleCreateSchema>;

/**
 * `.strict()` so a client cannot smuggle `isLocked` past the parser: isAdmin is
 * DERIVED from that column (see lib/auth/actor.ts), so making it writable from
 * any route would make administrator a self-service upgrade.
 */
export const roleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;

// ── the matrix ────────────────────────────────────────────────────────────
/**
 * One row of the permission grid: what this role may do inside one module.
 *
 * `hiddenFieldIds`/`readonlyFieldIds` carry FieldDefinition **ids**, and that
 * is what lands in `RolePermission.fieldRules` as `{ hidden, readonly }`.
 * PermissionEngine, however, strips by field **key** on serialisation — so
 * `loadPrincipal()` resolves ids -> keys once per request when it builds the
 * PermissionSet. Ids are stored because a key is only unique within a module
 * and a label change must never orphan a rule; the id is stable forever.
 *
 * `viewScope: 'NONE'` is the fail-closed answer, not "unset": a role with no
 * row at all and a role with a NONE row are the same thing to the engine.
 */
export const modulePermissionSchema = z.object({
  moduleId: z.string().uuid(),
  viewScope: z.enum(VIEW_SCOPES),
  canCreate: z.boolean(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  hiddenFieldIds: z.array(z.string().uuid()).max(500).default([]),
  readonlyFieldIds: z.array(z.string().uuid()).max(500).default([]),
});
export type ModulePermissionInput = z.infer<typeof modulePermissionSchema>;

/** The whole grid in one payload — the editor saves it as one gesture, so it
 *  logs as one ConfigChangeLog entry with one before/after diff. */
export const permissionMatrixSchema = z.object({
  modules: z.array(modulePermissionSchema).max(200),
  specials: z.array(z.enum(SPECIAL_PERMISSIONS)).max(SPECIAL_PERMISSIONS.length),
});
export type PermissionMatrixInput = z.infer<typeof permissionMatrixSchema>;

// ── delete ────────────────────────────────────────────────────────────────
/** Deleting a role that people hold requires somewhere to put them: User.roleId
 *  is NOT NULL and a soft-deleted role locks its holders out at login. */
export const roleDeleteSchema = z.object({
  reassignToRoleId: z.string().uuid().optional(),
});
export type RoleDeleteInput = z.infer<typeof roleDeleteSchema>;
