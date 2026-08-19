import { NextResponse, type NextRequest } from 'next/server';
import { verifyAccessToken } from '@/lib/auth/jwt';
import { ACCESS_COOKIE } from '@/lib/auth/constants';

/**
 * A signature check and nothing more. Middleware cannot reach the database, so
 * it answers only "is there a live session" — every authorisation decision is
 * made by the permission engine in the repository layer, where it cannot be
 * forgotten.
 */
const PUBLIC_PATHS = ['/login'];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  const claims = token ? await verifyAccessToken(token) : null;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!claims && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    // Only ever round-trip a same-origin path, never an absolute URL.
    if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (claims && isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = '/leads';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Page routes only. Everything except:
     *  - /api/**  — see below
     *  - Next internals and static assets
     *
     * API routes are deliberately EXCLUDED. Redirecting them would answer a
     * fetch() with a 307 to /login, which fetch follows to a 200 HTML page —
     * so the caller sees a successful response containing no JSON instead of
     * a 401, and cannot tell an expired session from a server fault. Worse,
     * a 307 preserves the method, so an expired POST would be replayed
     * against /login. Every route under /api asserts its own principal via
     * guarded(), which returns a real 401, so nothing is left unprotected.
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
