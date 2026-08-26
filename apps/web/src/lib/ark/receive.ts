/**
 * The receiving end of the ARK webhook — what the public endpoint calls.
 *
 * ONE RULE ABOVE ALL OTHERS (CLAUDE.md, spec §7 step 1): **raw payloads
 * persist before parsing.** "No account event is ever lost; any event is
 * replayable." The `WebhookEvent` row is written with exactly the bytes that
 * arrived before anything so much as looks at their shape — and before the
 * signature is checked, because a forged call is evidence worth keeping too.
 *
 * The second rule: **no processing in the request.** This file stores and
 * enqueues. The matching, the four outcomes, the conversion and the ledger
 * are written by `apps/worker/src/jobs/ark-webhook.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SIGNATURE VERIFICATION, PER SOURCE.
 *
 * ARK's authentication scheme is still unspecified. It no longer has to be:
 * the scheme is DATA on each source — which header carries the digest, the
 * algorithm, the encoding, an optional prefix — set from Settings -> ARK
 * Terminal without a deploy, and the secret is set through its own route so
 * it never enters the change log.
 *
 * `verifyWebhookSignature` in ./signature.ts does the arithmetic; this file
 * supplies the credentials. A source with nothing configured accepts as
 * before, with the unguessable token as its gate. A source with ANY of the
 * three set but not all of them REFUSES — half a configuration must never
 * read as verification while verifying nothing.
 *
 * The order is load-bearing and unchanged: the raw row is written BEFORE the
 * check is applied (a forged call is evidence), and a failed check settles
 * the event IGNORED, marked `ARK_SIGNATURE_REJECTED` so replay refuses it —
 * without that marker a forgery would be one click from the pipeline.
 */
import 'server-only';
import { prisma, type Prisma } from '@crm/db';
import { ARK_SIGNATURE_REJECTED, ARK_SOURCE_KIND, ARK_TOKEN_PATTERN } from '@crm/shared';
import { verifyWebhookSignature, type SignatureCheck } from './signature';

export type { SignatureCheck };
import { hashIntakeToken } from '@/lib/intake/sources';
import { enqueueArk } from './queue';

/** A source's verification settings as the receiver needs them: the secret
 *  and the scheme it is used with. Read here and only here. */
export interface ArkSourceCredentials {
  id: string;
  signingSecret: string | null;
  signatureHeader: string | null;
  signatureAlgorithm: string | null;
  signatureFormat: string | null;
  signaturePrefix: string | null;
}

export type ArkLookup =
  | { outcome: 'unknown' }
  | { outcome: 'inactive' }
  | { outcome: 'active'; source: ArkSourceCredentials };

/**
 * Resolve a token to its ARK source without revealing anything to a probe.
 *
 * Kind-scoped: a campaign-intake token posted here is "unknown" (an empty
 * 404), never an account event made out of a campaign lead. Unknown and
 * malformed are one answer; a real-but-paused source is told apart (410)
 * because ARK is a partner whose retries should stop, not an attacker whose
 * guesses should be confirmed.
 */
export async function lookupArkSource(token: string): Promise<ArkLookup> {
  if (!ARK_TOKEN_PATTERN.test(token)) return { outcome: 'unknown' };

  const source = await prisma.webhookSource.findFirst({
    where: { tokenHash: hashIntakeToken(token), kind: ARK_SOURCE_KIND },
    // The secret is read here and only here — for verification — and never
    // leaves this module.
    select: {
      id: true,
      isActive: true,
      signingSecret: true,
      signatureHeader: true,
      signatureAlgorithm: true,
      signatureFormat: true,
      signaturePrefix: true,
    },
  });
  if (!source) return { outcome: 'unknown' };
  if (!source.isActive) return { outcome: 'inactive' };
  return {
    outcome: 'active',
    source: {
      id: source.id,
      signingSecret: source.signingSecret,
      signatureHeader: source.signatureHeader,
      signatureAlgorithm: source.signatureAlgorithm,
      signatureFormat: source.signatureFormat,
      signaturePrefix: source.signaturePrefix,
    },
  };
}

export function verifyArkSignature(
  req: Request,
  rawText: string,
  source: ArkSourceCredentials,
): SignatureCheck {
  return verifyWebhookSignature((name) => req.headers.get(name), rawText, source);
}

/**
 * Persist, then (when the signature allowed it) enqueue. In that order, always.
 *
 * The event insert is its own statement and commits before the queue is
 * touched: if Redis is down the payload is already durable. In that case the
 * event is marked FAILED with a reason rather than left RECEIVED — RECEIVED
 * means "a job is coming", and no job is coming — so it shows up on the
 * events screen as something to replay instead of sitting silently forever.
 *
 * A body that failed the signature check is stored too (raw first applies to
 * forged calls — they are evidence) and settled IGNORED with the reason; it
 * is never enqueued, and the endpoint answers 401.
 *
 * `lastPayload` on the source is updated afterwards and its failure is
 * swallowed: it is a convenience for the mapping editor, not the record of
 * what arrived. The event row is that record.
 */
export async function storeArkEvent(
  sourceId: string,
  payload: Prisma.InputJsonValue,
  signature: SignatureCheck,
): Promise<{ eventId: string }> {
  const event = await prisma.webhookEvent.create({
    data: { sourceId, raw: payload, status: 'RECEIVED' },
    select: { id: true },
  });

  if (!signature.ok) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'IGNORED',
        // Prefixed so the replay path can tell a FORGERY apart from the
        // benign things that also land IGNORED. Without it, a rejected body
        // is one click from running through the pipeline.
        error: `${ARK_SIGNATURE_REJECTED}: ${signature.reason}`,
        processedAt: new Date(),
      },
      select: { id: true },
    });
    return { eventId: event.id };
  }

  try {
    await prisma.webhookSource.update({
      where: { id: sourceId },
      data: { lastPayload: payload },
      select: { id: true },
    });
  } catch (err) {
    console.error(`[ark] lastPayload not updated for source ${sourceId}`, err);
  }

  try {
    await enqueueArk(event.id, 0);
  } catch (err) {
    console.error(`[ark] enqueue failed for event ${event.id}`, err);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        error: 'The ARK queue was unavailable when this arrived. The payload is stored — replay it.',
      },
      select: { id: true },
    });
  }

  return { eventId: event.id };
}
