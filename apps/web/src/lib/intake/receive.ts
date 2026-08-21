/**
 * The receiving end of campaign intake — what the public endpoint calls.
 *
 * ONE RULE ABOVE ALL OTHERS (CLAUDE.md): **raw payloads persist before
 * parsing.** The `WebhookEvent` row is written with exactly the bytes that
 * arrived before anything so much as looks at their shape. That is the whole
 * reason this slice can ship while the Integrately payload is unknown: a
 * body the mapping cannot read becomes a FAILED event with its payload
 * intact, visible on the events screen and replayable once the mapping
 * exists. Nothing is validated here; nothing can be lost here.
 *
 * The second rule: **no processing in the request.** This file stores and
 * enqueues. The record — with its validation, its assignment, its audit rows
 * and its duplicate scan — is written by `apps/worker/src/jobs/campaign-intake.ts`.
 */
import 'server-only';
import { prisma, Prisma } from '@crm/db';
import { INTAKE_RAW_TEXT_KEY, INTAKE_TOKEN_PATTERN } from '@crm/shared';
import { enqueueIntake } from './queue';
import { hashIntakeToken } from './sources';

export type IntakeLookup =
  | { outcome: 'unknown' }
  | { outcome: 'inactive' }
  | { outcome: 'active'; source: { id: string } };

/**
 * Resolve a token to its source without revealing anything to a probe.
 *
 * The pattern check runs BEFORE the hash so a malformed token never costs a
 * query. Unknown and malformed are the same answer — the endpoint turns both
 * into an empty 404 — while a real-but-paused source is told apart (410)
 * because the platform on the other end is a partner whose retries should
 * stop, not an attacker whose guesses should be confirmed.
 */
export async function lookupIntakeSource(token: string): Promise<IntakeLookup> {
  if (!INTAKE_TOKEN_PATTERN.test(token)) return { outcome: 'unknown' };

  const source = await prisma.webhookSource.findFirst({
    where: { tokenHash: hashIntakeToken(token) },
    select: { id: true, isActive: true },
  });
  if (!source) return { outcome: 'unknown' };
  if (!source.isActive) return { outcome: 'inactive' };
  return { outcome: 'active', source: { id: source.id } };
}

/**
 * The body, as a JSON value that can be stored in a Json column.
 *
 * JSON that parses is stored as parsed — object, array or scalar, whatever
 * the platform sent. Anything else (a form post, XML, an empty body, a
 * truncated upload) is wrapped as `{ _raw: '<text>' }` so that even garbage
 * is a replayable event rather than a 400 the platform may never retry.
 * A literal JSON `null` is wrapped the same way: Prisma cannot store a bare
 * JSON null in a non-nullable Json column, and "the platform sent null" is
 * still worth keeping.
 */
export function payloadFromBody(text: string): Prisma.InputJsonValue {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null) return parsed as Prisma.InputJsonValue;
  } catch {
    // not JSON — fall through to the raw wrapper
  }
  return { [INTAKE_RAW_TEXT_KEY]: text };
}

/**
 * Persist, then enqueue. In that order, always.
 *
 * The event insert is its own statement and commits before the queue is
 * touched: if Redis is down the payload is already durable. In that case the
 * event is marked FAILED with a reason rather than left RECEIVED — RECEIVED
 * means "a job is coming", and no job is coming — so it shows up on the
 * events screen as something to replay instead of sitting silently forever.
 *
 * `lastPayload` on the source is updated afterwards and its failure is
 * swallowed: it is a convenience for the mapping editor, not the record of
 * what arrived. The event row is that record.
 */
export async function storeIntakeEvent(sourceId: string, payload: Prisma.InputJsonValue): Promise<{ eventId: string }> {
  const event = await prisma.webhookEvent.create({
    data: { sourceId, raw: payload, status: 'RECEIVED' },
    select: { id: true },
  });

  try {
    await prisma.webhookSource.update({
      where: { id: sourceId },
      data: { lastPayload: payload },
      select: { id: true },
    });
  } catch (err) {
    console.error(`[intake] lastPayload not updated for source ${sourceId}`, err);
  }

  try {
    await enqueueIntake(event.id, 0);
  } catch (err) {
    console.error(`[intake] enqueue failed for event ${event.id}`, err);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        error: 'The intake queue was unavailable when this arrived. The payload is stored — replay it.',
      },
      select: { id: true },
    });
  }

  return { eventId: event.id };
}
