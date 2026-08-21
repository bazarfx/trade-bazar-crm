/**
 * The hand-off from the public intake endpoint to the worker.
 *
 * CLAUDE.md: "Background work never runs in a route handler: the endpoint
 * stores + enqueues + returns." The endpoint has already written the raw
 * payload as a `WebhookEvent` by the time this is called, so the job carries
 * ONLY the event id — the body lives in one place, and replay reads that
 * same place.
 *
 * Same shape as `imports/queue.ts`: one connection and one Queue per process,
 * cached on globalThis because Next's dev server re-evaluates modules on
 * every edit and a fresh Redis connection per reload exhausts the server's
 * connection limit within an afternoon.
 */
import 'server-only';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { CAMPAIGN_INTAKE_QUEUE, intakeJobId, type CampaignIntakeJobData } from '@crm/shared';
import { env } from '@/lib/env';

const g = globalThis as unknown as { intakeQueue?: Queue; intakeRedis?: IORedis };

function intakeQueue(): Queue {
  if (g.intakeQueue) return g.intakeQueue;

  const connection =
    g.intakeRedis ??
    new IORedis(env.REDIS_URL, {
      // Required by BullMQ: a blocking command that outlives the retry budget
      // otherwise kills the client mid-command.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  connection.on('error', (err) => console.error('[intake] redis:', err.message));

  const queue = new Queue(CAMPAIGN_INTAKE_QUEUE, {
    connection,
    defaultJobOptions: {
      /**
       * ONE attempt, deliberately.
       *
       * The outcomes of this job are all written onto the event row — PROCESSED
       * with the record it made, or FAILED with the reason. A payload the
       * mapping cannot digest is still the same payload on the fifth retry;
       * retrying it would only write the same FAILED five times and, worse, a
       * retry after a PARTIAL success (campaign created, lead insert failed)
       * would create the campaign twice. Anything transient — the database
       * blinked — lands as FAILED with its message, and replay from the events
       * screen IS the retry, run by a person who can see what happened.
       */
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  g.intakeRedis = connection;
  g.intakeQueue = queue;
  return queue;
}

/**
 * Enqueue one stored event. Throws when Redis is unreachable — the caller
 * decides what that means (the endpoint marks the event FAILED so it stays
 * replayable; a replay reverts its own status change).
 */
export async function enqueueIntake(eventId: string, replayCount: number): Promise<void> {
  const data: CampaignIntakeJobData = { eventId };
  await intakeQueue().add('process-event', data, { jobId: intakeJobId(eventId, replayCount) });
}
