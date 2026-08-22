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
import { ZodError, type TypeOf, type ZodTypeAny } from 'zod';
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

/**
 * Parse a JSON body against a schema; throws ZodError into guarded().
 *
 * Generic over the SCHEMA, not over one type: `ZodType<T>` fixes input and
 * output to the same T, so a schema carrying a `.default()` inferred its INPUT
 * shape and the handler received a value whose defaults were typed as possibly
 * undefined — even though the parser had just filled them in. `TypeOf<S>` is
 * the parsed shape, which is what every caller actually holds.
 */
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<TypeOf<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ConfigError('Malformed JSON body', 400, 'VALIDATION');
  }
  return schema.parse(raw);
}

/**
 * The origin a webhook platform will reach this server on. Behind a proxy the
 * forwarded headers carry the public host; bare, the request URL does. Used by
 * the source-create responses — campaign intake and ARK alike — to print the
 * full receiver URL the one time the token exists. Only ever names the host;
 * the path is the service's.
 */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? req.headers.get('host') ?? url.host;
  return `${proto}://${host}`;
}
