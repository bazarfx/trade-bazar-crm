import bcrypt from 'bcryptjs';

/** Cost 12 — matches the seed. Changing this needs a rehash-on-login path. */
const ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, ROUNDS);

export const verifyPassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);
