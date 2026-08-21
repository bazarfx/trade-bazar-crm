/**
 * `POST /api/intake/<token>` — the public door campaign platforms post into.
 *
 * PUBLIC: no session, no cookie. The token IS the credential. It is the only
 * route in the product that writes without a principal, which is why it does
 * so little: look the source up, persist the raw body, enqueue, answer 202.
 * Nothing is validated, nothing is parsed for meaning, no record is created
 * here — the worker does all of that, and a body it cannot digest is a FAILED
 * event with its payload intact, never a rejected request the platform may
 * never retry.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE SPACE: NO SIGNATURE VERIFICATION YET.
 *
 * Integrately's authentication scheme is unknown — the account does not
 * exist. Whatever it turns out to be (an HMAC over the body, a shared header,
 * Basic auth on the URL), verification slots in at the marked point below,
 * keyed on a per-source secret the `WebhookSource` row does not yet carry
 * (`tokenHash` authenticates the URL; a signing secret would be a second
 * column, added when there is something to sign). Until then the
 * unguessable token — 128 random bits, hashed at rest — is the only gate,
 * and this comment is the record of that decision rather than a silent gap.
 * ═══════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { INTAKE_MAX_BODY_BYTES } from '@crm/shared';
import { requestMeta } from '@/lib/audit';
import { lookupIntakeSource, payloadFromBody, storeIntakeEvent } from '@/lib/intake/receive';
import { rateLimit } from '@/lib/rate-limit';

type Params = { token: string };

/**
 * Two limiters, both light, both in-process (see `rate-limit.ts` for the
 * single-node caveat):
 *
 *  - per CLIENT IP on the lookup, so a token-guessing loop is slowed before
 *    it costs a database read per guess;
 *  - per SOURCE on the write, so one misconfigured automation that fires in
 *    a loop cannot fill the event table — a real campaign burst is tens of
 *    leads a minute, not hundreds a second.
 *
 * Both answer 429 with Retry-After, which every webhook platform honours.
 */
const PROBE_LIMIT = 120;
const SOURCE_LIMIT = 600;
const WINDOW_MS = 60 * 1000;

/** 404 with NO body: an unknown token must look exactly like a route that
 *  does not exist, so a probe learns nothing about the token space. */
const notFound = (): Response => new Response(null, { status: 404 });

const tooMany = (retryAfterSeconds: number): Response =>
  NextResponse.json(
    { error: 'Too many requests' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );

export async function POST(req: Request, ctx: { params: Promise<Params> }): Promise<Response> {
  const { token } = await ctx.params;
  const meta = requestMeta(req);

  const probe = rateLimit(`intake-probe:${meta.ipAddress ?? 'unknown'}`, PROBE_LIMIT, WINDOW_MS);
  if (!probe.allowed) return tooMany(probe.retryAfterSeconds);

  const lookup = await lookupIntakeSource(token);
  if (lookup.outcome === 'unknown') return notFound();
  if (lookup.outcome === 'inactive') {
    // 410, not 404: a paused source is a known partner whose retries should
    // stop. Nothing is stored — "paused" means paused, and the platform's
    // own retry log is where those posts live until the source is resumed.
    return NextResponse.json({ error: 'This intake source is paused' }, { status: 410 });
  }

  const limit = rateLimit(`intake:${lookup.source.id}`, SOURCE_LIMIT, WINDOW_MS);
  if (!limit.allowed) return tooMany(limit.retryAfterSeconds);

  // ── signature verification slots in HERE once the scheme is known ──────
  // const secret = ...; if (!verify(req, rawText, secret)) return 401;

  // Body cap, checked twice: the declared length first so an oversized upload
  // is refused before it is read, then the real length, because a chunked
  // body declares nothing. The payload is about to be stored VERBATIM in a
  // Json column on an unauthenticated route — this is the only thing that
  // keeps that column from becoming object storage.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > INTAKE_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > INTAKE_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  // PERSIST RAW FIRST. `payloadFromBody` only decides how to STORE the bytes
  // (as the JSON they are, or wrapped as text when they are not JSON); it
  // never decides whether they are acceptable. That question belongs to the
  // worker, and its answer is an event status, not an HTTP status.
  const { eventId } = await storeIntakeEvent(lookup.source.id, payloadFromBody(text));

  // 202: accepted, not processed. The platform gets its acknowledgement the
  // moment the payload is durable; what becomes of it is the worker's job.
  return NextResponse.json({ received: true, eventId }, { status: 202 });
}
