import { NextResponse } from 'next/server';
import { getSession, clearSession } from '@/lib/auth/session';
import { audit, requestMeta } from '@/lib/audit';

export async function POST(req: Request) {
  const session = await getSession();

  if (session) {
    const meta = requestMeta(req);
    await audit.log({
      entityType: 'User',
      entityId: session.userId,
      action: 'USER_LOGOUT',
      actorType: 'USER',
      actorId: session.userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  // Always clear, even without a valid session — a stale cookie should not survive.
  await clearSession();
  return NextResponse.json({ ok: true });
}
