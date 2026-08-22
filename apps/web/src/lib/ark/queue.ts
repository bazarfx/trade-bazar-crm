/**
 * The hand-off from the public ARK endpoint to the worker.
 *
 * Same shape and same reasons as `intake/queue.ts`: the endpoint has already
 * written the raw payload as a `WebhookEvent` by the time this is called, so
 * the job carries ONLY the event id; one connection and one Queue per process,
 * cached on globalThis because Next's dev server re-evaluates modules on every
 * edit. Its own queue rather than the intake one because the consumer is a
 * different job — the conversion pipeline, not record intake — and a queue
 * name is a Redis key.
 */
import 'server-only';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ARK_WEBHOOK_QUEUE, arkJobId, type ArkWebhookJobData } from '@crm/shared';
import { env } from '@/lib/env';

const g = globalThis as unknown as { arkQueue?: Queue; arkRedis?: IORedis };

function arkQueue(): Queue {
  if (g.arkQueue) return g.arkQueue;

  const connection =
    g.arkRedis ??
    new IORedis(env.REDIS_URL, {
      // Required by BullMQ: a blocking command that outlives the retry budget
      // otherwise kills the client mid-command.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  connection.on('error', (err) => console.error('[ark] redis:', err.message));

  const queue = new Queue(ARK_WEBHOOK_QUEUE, {
    connection,
    defaultJobOptions: {
      /**
       * ONE attempt, deliberately — the same decision intake made, and it
       * matters more here. A payload the mapping cannot digest is the same
       * payload on the fifth retry; and a retry after a PARTIAL success would
       * be worse than no retry, because the outcomes here are money: the
       * pipeline is idempotent on the event id (`recordDeposit` dedupes on
       * it), but "idempotent" is a property to lean on for a human-pressed
       * replay, not something to exercise five times a minute by default.
       * Anything transient lands as FAILED with its message and stays
       * replayable from the events screen.
       */
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  g.arkRedis = connection;
  g.arkQueue = queue;
  return queue;
}

/**
 * Enqueue one stored event. Throws when Redis is unreachable — the caller
 * decides what that means (the endpoint marks the event FAILED so it stays
 * replayable; a replay reverts its own status change).
 */
export async function enqueueArk(eventId: string, replayCount: number): Promise<void> {
  const data: ArkWebhookJobData = { eventId };
  await arkQueue().add('process-event', data, { jobId: arkJobId(eventId, replayCount) });
}
