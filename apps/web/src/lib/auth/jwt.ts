/**
 * Token minting and verification.
 *
 * Access tokens carry the user id and nothing else. Role, scope, groups and
 * department are resolved from the database on every request — a permission
 * revoked at 10:00 must not keep working until a 15-minute token expires.
 *
 * Refresh tokens are JWTs whose SHA-256 hash is stored in `RefreshToken`, so a
 * session can be revoked server-side and rotation can detect reuse.
 *
 * Everything here uses Web Crypto rather than `node:crypto` so the same module
 * verifies tokens in middleware (edge runtime) and in route handlers.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env';

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

const ISSUER = 'trade-bazar-crm';
const AUDIENCE = 'trade-bazar-crm/web';

export interface AccessClaims extends JWTPayload {
  sub: string;
}

export interface RefreshClaims extends JWTPayload {
  sub: string;
  jti: string;
}

export async function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(accessKey);
}

export async function signRefreshToken(userId: string): Promise<{ token: string; jti: string }> {
  const jti = crypto.randomUUID();
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_REFRESH_TTL)
    .sign(refreshKey);
  return { token, jti };
}

/** Returns null on any failure — expired, tampered, wrong audience. Never throws. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey, { issuer: ISSUER, audience: AUDIENCE });
    return typeof payload.sub === 'string' ? (payload as AccessClaims) : null;
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshClaims | null> {
  try {
    const { payload } = await jwtVerify(token, refreshKey, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
    return payload as RefreshClaims;
  } catch {
    return null;
  }
}

/** What goes in the database. The token itself is never stored. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Milliseconds a duration string like "30d" or "15m" represents. */
export function durationMs(spec: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d|w)$/.exec(spec.trim());
  if (!m) throw new Error(`Unparseable duration: "${spec}"`);
  const n = Number(m[1]);
  const unit = m[2] as 'ms' | 's' | 'm' | 'h' | 'd' | 'w';
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * scale[unit];
}
