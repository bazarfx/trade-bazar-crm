/**
 * Route-handler plumbing. Route handlers are THIN ADAPTERS — parse, call,
 * serialise. Anything resembling business logic in a route file is a bug.
 *
 * `guarded()` is the only way a config route comes into existence: it resolves
 * the principal and maps errors to the uniform ApiError shape. The permission
 * check itself lives in the config service — a route CANNOT forget it.
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import type { ApiError } from '@crm/shared';
import { getPrincipal } from '@/lib/auth/session';
import type { Principal } from '@/lib/auth/actor';
import { ConfigError } from '@/lib/config/service';

type Ctx<P> = { params: Promise<P> };

export function guarded<P = Record<string, string>>(
  handler: (req: Request, principal: Principal, params: P) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
    const principal = await getPrincipal();
    if (!principal) return fail(401, 'Not authenticated');

    try {
      return await handler(req, principal, await ctx.params);
    } catch (err) {
      if (err instanceof ConfigError) {
        return NextResponse.json(
          { error: err.message, code: err.code, ...err.extra } as ApiError,
          { status: err.status },
        );
      }
      if (err instanceof ZodError) {
        return NextResponse.json(
          { error: 'Validation failed', code: 'VALIDATION', fields: err.flatten().fieldErrors } as ApiError,
          { status: 400 },
        );
      }
      console.error('[api]', err);
      return fail(500, 'Something went wrong');
    }
  };
}

export function fail(status: number, error: string): Response {
  return NextResponse.json({ error } satisfies ApiError, { status });
}

/** Parse a JSON body against a schema; throws ZodError into guarded(). */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ConfigError('Malformed JSON body', 400, 'VALIDATION');
  }
  return schema.parse(raw);
}
