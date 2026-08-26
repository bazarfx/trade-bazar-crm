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

/**
 * The system columns' length caps, exported so the account form's own schema
 * (which speaks the form dialect — '' for "unset") derives from the same
 * numbers instead of restating them. Validation is defined once, here.
 */
export const USER_FIELD_LIMITS = { fullName: 120, email: 200, phone: 30 } as const;

const userBaseSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(USER_FIELD_LIMITS.fullName),
  // The login identity. Lowercased here so `A@x.com` and `a@x.com` cannot
  // become two accounts past the unique index.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Enter a valid email address')
    .max(USER_FIELD_LIMITS.email),
  phone: z.string().trim().max(USER_FIELD_LIMITS.phone).nullish(),
  roleId: z.string().uuid('Choose a role'),
  departmentId: z.string().uuid().nullish(),
  /** Membership is many; groups are the backbone of assignment (spec §5.3). */
  groupIds: z.array(z.string().uuid()).max(100).default([]),
  /** Free strings, not an enum: the language list is Admin-editable seed data. */
  languages: z.array(languageSchema).max(50).default([]),
  reportingManagerId: z.string().uuid().nullish(),
  isActive: z.boolean().default(true),
  /**
   * Admin-created fields on the Profile module. The account contract's system
   * columns above are FIXED — but the Profile module is still a dynamic
   * module, and the Admin's own fields live in `User.custom`, governed by
   * FieldDefinition at runtime. A form that renders those fields must be able
   * to save them, so this slot carries them through the `.strict()` gate as an
   * opaque bag: the KEYS inside are validated server-side by the field engine
   * (`buildRecordSchema` over the module's live custom fields, unknown keys
   * rejected), because this file cannot know fields that do not exist until an
   * Admin creates them. On update the bag is a PATCH: only sent keys are
   * validated, and `null` clears a key.
   */
  custom: z.record(z.string(), z.unknown()).optional(),
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

/**
 * Activate / deactivate. Its own route because deactivation is a guardrail
 * (last-admin protection), a session revocation and a HANDOVER — not a field
 * edit.
 *
 * `reassignToUserId` is the answer to the prompt spec §5.5 describes: the
 * server refuses to deactivate a user who still owns open records until it is
 * given somewhere to put them, so the two halves travel in one request and
 * commit in one transaction. Nothing is ever left owned by a deactivated user
 * (invariant 1), and there is no window in which it is.
 */
export const userSetActiveSchema = z
  .object({
    isActive: z.boolean(),
    reassignToUserId: z.string().uuid('Choose a user').nullish(),
  })
  .strict();
export type UserSetActiveInput = z.infer<typeof userSetActiveSchema>;

/**
 * Password reset (spec §5.5): Admin-driven, no "current password" — the whole
 * point is that the user cannot sign in. Its own schema and route because a
 * reset is not a field edit: it writes a PASSWORD_RESET audit entry with no
 * diff (a hash in the append-only log could never be taken back out) and it
 * revokes every live session. The plaintext exists only in this one request
 * and in the response's `password` echo, for the Admin to hand over — it is
 * never stored and never shown again.
 */
export const userSetPasswordSchema = z.object({ password: passwordSchema }).strict();
export type UserSetPasswordInput = z.infer<typeof userSetPasswordSchema>;

/**
 * The characters a generated password draws from. Ambiguous glyphs (0/O, 1/l/I)
 * are left out because these passwords get read to somebody over a phone or a
 * chat, and the symbol set avoids characters that shells and URLs mangle.
 */
const PASSWORD_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const PASSWORD_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const PASSWORD_DIGIT = '23456789';
const PASSWORD_SYMBOL = '!@#$%^&*-_+=';
const PASSWORD_LENGTH = 14;

/** An unbiased CSPRNG draw below `max`, via rejection sampling — a plain
 *  modulo would skew toward the low end of the character sets. */
function randomBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const value = buf[0] as number;
    if (value < limit) return value % max;
  }
}

/**
 * A password that satisfies `passwordSchema` by construction: one draw from
 * each character class, the rest from the union, shuffled with the same
 * CSPRNG. Shared here so the Admin's "Generate" button means the same strength
 * in every flow, in the browser and on the server alike (`globalThis.crypto`
 * is Web Crypto in both). Never persisted anywhere but as a bcrypt hash.
 */
export function generatePassword(): string {
  const union = PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGIT + PASSWORD_SYMBOL;
  const pick = (set: string) => set[randomBelow(set.length)] as string;
  const chars = [pick(PASSWORD_LOWER), pick(PASSWORD_UPPER), pick(PASSWORD_DIGIT), pick(PASSWORD_SYMBOL)];
  while (chars.length < PASSWORD_LENGTH) chars.push(pick(union));
  // Fisher–Yates on the CSPRNG — Math.random has no place in a credential.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    const a = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = a;
  }
  return chars.join('');
}

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
