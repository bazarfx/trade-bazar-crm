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
     * Everything except:
     *  - /api/auth/*  (login and refresh must be reachable without a session)
     *  - Next internals and static assets
     */
    '/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
