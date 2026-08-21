/**
 * The hand-off. Everything above this line ran in the request; everything
 * below it runs in `apps/worker/src/jobs/imports.ts`.
 *
 * CLAUDE.md draws the line here explicitly and names this exact case: a
 * multi-megabyte import is background work, and background work never runs in
 * a route handler. Staging the rows is cheap and synchronous; PROCESSING them
 * is forty thousand transactions, each with an assignment, an audit row and a
 * duplicate scan. The commit endpoint therefore does one thing — it enqueues —
 * and returns while the worker drains.
 */
import 'server-only';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { IMPORT_QUEUE, type ImportJobData } from '@crm/shared';
import { env } from '@/lib/env';
import { ConfigError } from '@/lib/config/service';

/**
 * One connection and one Queue per process, cached on globalThis for the same
 * reason the Prisma client is: Next's dev server re-evaluates modules on every
 * edit, and a fresh Redis connection per reload exhausts the server's
 * connection limit within an afternoon.
 */
const g = globalThis as unknown as { importQueue?: Queue; importRedis?: IORedis };

function importQueue(): Queue {
  if (g.importQueue) return g.importQueue;

  const connection =
    g.importRedis ??
    new IORedis(env.REDIS_URL, {
      // Required by BullMQ: a blocking command that outlives the retry budget
      // otherwise kills the client mid-command.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  connection.on('error', (err) => console.error('[imports] redis:', err.message));

  const queue = new Queue(IMPORT_QUEUE, {
    connection,
    defaultJobOptions: {
      // Three attempts, because the job is RESUMABLE rather than idempotent by
      // luck: a retry re-reads the rows still marked PENDING and cannot touch
      // one already decided. What it recovers from is a dropped connection
      // mid-import, which would otherwise strand 30,000 rows.
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  g.importRedis = connection;
  g.importQueue = queue;
  return queue;
}

/**
 * Enqueue one staged batch.
 *
 * `jobId` is the batch id, so a double-tap on the wizard's final Next is a
 * no-op while the job exists rather than a second pass over the same file.
 * The row-level guard in the worker is what makes that safe even after the
 * job id has aged out.
 *
 * The separator is a HYPHEN, not a colon: BullMQ builds its Redis keys as
 * `bull:<queue>:<jobId>` and rejects any custom id containing `:` outright, so
 * `import:<uuid>` threw on every single enqueue — which the catch below then
 * reported as "the import queue is unavailable". No file could ever start.
 */
export async function enqueueImport(data: ImportJobData): Promise<void> {
  try {
    await importQueue().add('process-batch', data, { jobId: `import-${data.batchId}` });
  } catch (err) {
    console.error('[imports] enqueue failed', err);
    // The batch is still PENDING and its rows are still staged, so the honest
    // answer is "not started", not "started and lost". The user can press it
    // again once the queue is back.
    throw new ConfigError(
      'The import queue is unavailable, so this import has not started. Your file is saved — try again in a moment.',
      503,
      'VALIDATION',
    );
  }
}
