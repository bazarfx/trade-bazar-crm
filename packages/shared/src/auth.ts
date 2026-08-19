import { z } from 'zod';

/**
 * Credential shapes. Defined once here so the login form, the route handler
 * and any future CLI or worker task all agree on what a valid credential is.
 */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
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
