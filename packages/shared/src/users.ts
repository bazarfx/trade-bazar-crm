import { z } from 'zod';
import { passwordSchema } from './auth.js';
import type { StatusTagValue } from './config.js';

/**
 * The Profile module's user-administration contracts.
 *
 * Defined ONCE here so the admin UI, the route handler and any future importer
 * or CLI agree on what a valid user is. Nothing in this file names a role, a
 * department or a group — those are rows the Admin creates, and they travel as
 * ids.
 *
 * These shapes describe the SYSTEM columns of a user (spec §5.4). The Admin's
 * own fields on the Profile module live in `User.custom`, governed by
 * FieldDefinition at runtime, and are validated by the field engine — adding
 * one must never touch this file.
 */

const languageSchema = z.string().trim().min(1).max(60);

const userBaseSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
  // The login identity. Lowercased here so `A@x.com` and `a@x.com` cannot
  // become two accounts past the unique index.
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(200),
  phone: z.string().trim().max(30).nullish(),
  roleId: z.string().uuid('Choose a role'),
  departmentId: z.string().uuid().nullish(),
  /** Membership is many; groups are the backbone of assignment (spec §5.3). */
  groupIds: z.array(z.string().uuid()).max(100).default([]),
  /** Free strings, not an enum: the language list is Admin-editable seed data. */
  languages: z.array(languageSchema).max(50).default([]),
  isActive: z.boolean().default(true),
});

/**
 * Create. The password is set BY THE ADMIN at launch (spec §5.5) and is the
 * only place a password is accepted — `userUpdateSchema` is `.strict()`, so a
 * client that posts one to the update route is rejected rather than silently
 * ignored. Password resets are their own flow with their own audit entry.
 */
export const userCreateSchema = userBaseSchema.extend({ password: passwordSchema }).strict();
export type UserCreateInput = z.infer<typeof userCreateSchema>;

/** Update. Every field optional; `password` and `isLocked`-style keys rejected. */
export const userUpdateSchema = userBaseSchema.partial().strict();
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

/** Activate / deactivate. Its own route because deactivation is a guardrail
 *  (last-admin protection) and a session revocation, not a field edit. */
export const userSetActiveSchema = z.object({ isActive: z.boolean() }).strict();
export type UserSetActiveInput = z.infer<typeof userSetActiveSchema>;

/**
 * Status tags meaning "this record needs nobody" — a deactivated user's rows
 * carrying one of these are not counted for the reassignment prompt (spec
 * §5.5, §13). Tags, never names: the Admin renames statuses at will.
 */
export const HANDOVER_CLOSED_TAGS = [
  'CONVERTED',
  'LOST',
  'INVALID',
] as const satisfies readonly StatusTagValue[];
