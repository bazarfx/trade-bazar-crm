import { NextResponse } from 'next/server';
import { rotateSession, clearSession } from '@/lib/auth/session';

/**
 * Exchange the refresh cookie for a new token pair. The presented token is
 * revoked as part of the exchange, so a replayed refresh token fails.
 */
export async function POST() {
  const rotated = await rotateSession();

  if (!rotated) {
    await clearSession();
    return NextResponse.json({ error: 'Session expired' }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
