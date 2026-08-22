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
 * THE SIGNATURE-VERIFICATION SLOT.
 *
 * ARK's authentication scheme is unknown — no technical spec exists for the
 * webhook. `verifyArkSignature` below IS the slot: it reads the header and
 * algorithm `ARK_SIGNATURE_SLOT` names, computes over the raw body with the
 * source's `signingSecret` column, and compares in constant time. Today the
 * slot's header is null, so it answers "not configured" and the unguessable
 * token — 128 random bits, hashed at rest — is the only gate. When ARK says
 * how it signs: set the header and algorithm in `@crm/shared`'s
 * `ARK_SIGNATURE_SLOT`, put the secret on the source, and nothing here moves.
 * ═══════════════════════════════════════════════════════════════════════
 */
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma, type Prisma } from '@crm/db';
import { ARK_SIGNATURE_SLOT, ARK_SOURCE_KIND, ARK_TOKEN_PATTERN } from '@crm/shared';
import { hashIntakeToken } from '@/lib/intake/sources';
import { enqueueArk } from './queue';

export type ArkLookup =
  | { outcome: 'unknown' }
  | { outcome: 'inactive' }
  | { outcome: 'active'; source: { id: string; signingSecret: string | null } };

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
    // The secret is read here and only here — for the slot — and never
    // leaves this module.
    select: { id: true, isActive: true, signingSecret: true },
  });
  if (!source) return { outcome: 'unknown' };
  if (!source.isActive) return { outcome: 'inactive' };
  return { outcome: 'active', source: { id: source.id, signingSecret: source.signingSecret } };
}

export type SignatureCheck =
  /** the slot is not configured: accept, as the file header explains */
  | { ok: true; verified: false }
  /** the slot is configured and the body checked out */
  | { ok: true; verified: true }
  /** the slot is configured and the body did NOT check out */
  | { ok: false; reason: string };

/**
 * THE SLOT. See the file header. Runs over the RAW text, never over a parsed
 * object — a signature is over bytes, and re-serialising JSON changes them.
 */
export function verifyArkSignature(
  req: Request,
  rawText: string,
  source: { signingSecret: string | null },
): SignatureCheck {
  const { header, algorithm } = ARK_SIGNATURE_SLOT;
  if (header === null || algorithm === null) return { ok: true, verified: false };

  // Configured but this source has no secret yet: refusing is the honest
  // answer. Accepting would mean "verification is on" while verifying nothing.
  if (!source.signingSecret) return { ok: false, reason: 'This source has no signing secret configured' };

  const presented = req.headers.get(header);
  if (!presented) return { ok: false, reason: `Missing ${header} header` };

  // `algorithm` is a one-member union today; a second member is added to the
  // slot alongside its branch here, so this switch stays exhaustive.
  switch (algorithm) {
    case 'hmac-sha256': {
      const expected = createHmac('sha256', source.signingSecret).update(rawText, 'utf8').digest('hex');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(presented.trim().toLowerCase(), 'utf8');
      const matches = a.length === b.length && timingSafeEqual(a, b);
      return matches ? { ok: true, verified: true } : { ok: false, reason: ARK_SIGNATURE_SLOT.failureMessage };
    }
    default: {
      const _exhaustive: never = algorithm;
      return { ok: false, reason: 'Unsupported signature algorithm' };
    }
  }
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
      data: { status: 'IGNORED', error: signature.reason, processedAt: new Date() },
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
