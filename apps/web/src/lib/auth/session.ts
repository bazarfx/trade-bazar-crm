/**
 * Session cookies and refresh-token rotation.
 *
 * Both cookies are httpOnly — no token is ever readable from JavaScript. The
 * refresh cookie is scoped to `/api/auth` so it is not sent with every page
 * and API request, only when it is actually needed.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { prisma } from '@crm/db';
import { isProduction, env } from '../env';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  durationMs,
} from './jwt';
import { loadPrincipal, type Principal } from './actor';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './constants';

export { ACCESS_COOKIE, REFRESH_COOKIE };

const baseCookie = {
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
} as const;

/** Mint a fresh token pair, record the refresh token, set both cookies. */
export async function issueSession(userId: string): Promise<void> {
  const [accessToken, refresh] = await Promise.all([
    signAccessToken(userId),
    signRefreshToken(userId),
  ]);

  const expiresAt = new Date(Date.now() + durationMs(env.JWT_REFRESH_TTL));

  await prisma.refreshToken.create({
    data: { userId, tokenHash: await hashToken(refresh.token), expiresAt },
  });

  const jar = await cookies();
  jar.set(ACCESS_COOKIE, accessToken, {
    ...baseCookie,
    path: '/',
    maxAge: Math.floor(durationMs(env.JWT_ACCESS_TTL) / 1000),
  });
  jar.set(REFRESH_COOKIE, refresh.token, {
    ...baseCookie,
    path: '/api/auth',
    maxAge: Math.floor(durationMs(env.JWT_REFRESH_TTL) / 1000),
  });
}

/** The user id on the current request, or null. Signature check only. */
export async function getSession(): Promise<{ userId: string } | null> {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  return claims ? { userId: claims.sub } : null;
}

/** Session plus the database-resolved actor and permissions. */
export async function getPrincipal(): Promise<Principal | null> {
  const session = await getSession();
  return session ? loadPrincipal(session.userId) : null;
}

/**
 * Rotate. The presented token is revoked and a new pair issued.
 * Returns false when the token is unknown, already revoked or expired — the
 * caller should clear cookies and send the user back to the login screen.
 */
export async function rotateSession(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(REFRESH_COOKIE)?.value;
  if (!token) return false;

  const claims = await verifyRefreshToken(token);
  if (!claims) return false;

  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: await hashToken(token) },
  });
  if (!row || row.revokedAt || row.expiresAt < new Date() || row.userId !== claims.sub) {
    return false;
  }

  // A deactivated user cannot refresh their way back in.
  const principal = await loadPrincipal(claims.sub);
  if (!principal) return false;

  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });

  await issueSession(claims.sub);
  return true;
}

/** Revoke the presented refresh token and clear both cookies. */
export async function clearSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(REFRESH_COOKIE)?.value;

  if (token) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: await hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  jar.delete({ name: ACCESS_COOKIE, path: '/' });
  jar.delete({ name: REFRESH_COOKIE, path: '/api/auth' });
}

/** Revoke every live session for a user — password reset, deactivation. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
