/**
 * `POST /api/ark/<token>` — the public door ARK Terminal posts account
 * events into. The ONLY conversion path in the product (spec §7): there is
 * no manual Convert button, and nothing else may create a deal.
 *
 * PUBLIC: no session, no cookie. The token IS the credential, exactly as for
 * campaign intake, and for the same reason this route does so little: look
 * the source up, persist the raw body, check the signature slot, enqueue,
 * answer 202. Nothing is parsed for meaning and no record is touched here —
 * the worker matches, converts and records deposits, and a body it cannot
 * digest is a FAILED event with its payload intact, never a rejected request
 * ARK may never retry.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SIGNATURE VERIFICATION.
 *
 * Configured PER SOURCE and applied here: `verifyArkSignature` reads the
 * source's own header, algorithm, encoding and prefix, computes over the raw
 * text, and compares in constant time. Nothing about it needs a deploy —
 * an Admin fills the scheme in from Settings -> ARK Terminal the day ARK
 * publishes it, and sets the secret through its own route.
 *
 * The ordering below is the part to preserve: verify over the RAW text before
 * anything parses it, store the row FIRST (a forged call is evidence worth
 * keeping), and only then refuse — so a rejected body is a stored, marked,
 * non-replayable event rather than a lost payload.
 */
import { NextResponse } from 'next/server';
import { ARK_MAX_BODY_BYTES } from '@crm/shared';
import { requestMeta } from '@/lib/audit';
import { lookupArkSource, storeArkEvent, verifyArkSignature } from '@/lib/ark/receive';
import { payloadFromBody } from '@/lib/intake/receive';
import { rateLimit } from '@/lib/rate-limit';

type Params = { token: string };

/**
 * The same two limiters as intake, for the same reasons: per client IP on the
 * lookup so a token-guessing loop is slowed before it costs a database read,
 * per source on the write so one runaway integration cannot fill the event
 * table. ARK's real volume is account creations — tens a minute at most.
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

  const probe = rateLimit(`ark-probe:${meta.ipAddress ?? 'unknown'}`, PROBE_LIMIT, WINDOW_MS);
  if (!probe.allowed) return tooMany(probe.retryAfterSeconds);

  const lookup = await lookupArkSource(token);
  if (lookup.outcome === 'unknown') return notFound();
  if (lookup.outcome === 'inactive') {
    // 410, not 404: a paused source is a known partner whose retries should
    // stop. Nothing is stored — "paused" means paused, and ARK's own retry
    // log is where those posts live until the source is resumed.
    return NextResponse.json({ error: 'This ARK source is paused' }, { status: 410 });
  }

  const limit = rateLimit(`ark:${lookup.source.id}`, SOURCE_LIMIT, WINDOW_MS);
  if (!limit.allowed) return tooMany(limit.retryAfterSeconds);

  // Body cap, checked twice: the declared length first so an oversized upload
  // is refused before it is read, then the real length, because a chunked
  // body declares nothing. The payload is about to be stored VERBATIM in a
  // Json column on an unauthenticated route.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > ARK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > ARK_MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  // ── signature verification: THE SLOT (see the file header) ────────────
  // Computed over the raw text BEFORE the body is parsed or stored, and
  // applied by `storeArkEvent` AFTER the raw row is written: a failed check
  // is an IGNORED event with the reason, never a lost payload.
  const signature = verifyArkSignature(req, text, lookup.source);

  // PERSIST RAW FIRST. `payloadFromBody` only decides how to STORE the bytes
  // (as the JSON they are, or wrapped as text when they are not JSON); it
  // never decides whether they are acceptable. That question belongs to the
  // worker, and its answer is an event status, not an HTTP status.
  const { eventId } = await storeArkEvent(lookup.source.id, payloadFromBody(text), signature);

  if (!signature.ok) {
    // GENERIC on the wire. `signature.reason` names stored configuration —
    // the algorithm on the source, whether a secret is set — and this is an
    // unauthenticated caller who has proved only that they hold the URL. The
    // specific reason is on the event row, where the Admin reads it.
    return NextResponse.json({ error: 'Signature verification failed', eventId }, { status: 401 });
  }

  // 202: accepted, not processed. ARK gets its acknowledgement the moment the
  // payload is durable; what becomes of it is the worker's job.
  return NextResponse.json({ received: true, eventId }, { status: 202 });
}
