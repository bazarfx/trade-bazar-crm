import { z } from 'zod';

/**
 * Credential shapes. Defined once here so the login form, the route handler
 * and any future CLI or worker task all agree on what a valid credential is.
 */

/**
 * The login identifier is an email OR a bare username. A username is the
 * local part of the account's email — typing `admin` signs in as
 * `admin@<LOGIN_DEFAULT_DOMAIN>`. The server does the expansion, so nothing
 * invalid is ever stored in `User.email` and the unique index stays honest.
 */
const USERNAME = /^[a-z0-9._-]{1,64}$/;

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Enter your email or username')
    .refine(
      (v) => USERNAME.test(v) || z.string().email().safeParse(v).success,
      'Enter a valid email address or username',
    ),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Password policy for Admin-set and self-set passwords alike.
 * Deliberately length-first: length beats character-class theatre.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password must be at most 200 characters')
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v), 'Include an upper and a lower case letter')
  .refine((v) => /\d/.test(v), 'Include a number');

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
