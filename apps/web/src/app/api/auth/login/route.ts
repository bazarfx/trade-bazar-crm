import { NextResponse } from 'next/server';
import { prisma } from '@crm/db';
import { loginSchema } from '@crm/shared';
import { verifyPassword } from '@/lib/auth/passwords';
import { issueSession } from '@/lib/auth/session';
import { audit, requestMeta } from '@/lib/audit';
import { rateLimit, resetRateLimit } from '@/lib/rate-limit';

/**
 * Accounts are created by an Admin — there is no self-service signup, so this
 * is the only way into the product.
 *
 * The response never distinguishes "no such account" from "wrong password"
 * and never from "deactivated": all three return the same message, and a
 * bcrypt comparison runs even when the account does not exist so the timing
 * does not answer the question either.
 */

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO3nRhO3CFT.wTx7Nn1Bnd6ZcQD/x1Ub2';

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  const meta = requestMeta(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid credentials', fields: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;
  const limitKey = `login:${meta.ipAddress ?? 'unknown'}:${email}`;
  const limit = rateLimit(limitKey, MAX_ATTEMPTS, WINDOW_MS);

  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, isActive: true, fullName: true, email: true },
  });

  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !ok || !user.isActive) {
    return NextResponse.json({ error: 'Email or password is incorrect' }, { status: 401 });
  }

  resetRateLimit(limitKey);
  await issueSession(user.id);

  await audit.log({
    entityType: 'User',
    entityId: user.id,
    action: 'USER_LOGIN',
    actorType: 'USER',
    actorId: user.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ user: { id: user.id, fullName: user.fullName, email: user.email } });
}
