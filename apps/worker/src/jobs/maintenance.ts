import { Worker, type Job } from 'bullmq';
import { prisma } from '@crm/db';
import { connection } from '../lib/redis.js';
import { QUEUE, queue } from '../lib/queues.js';

/**
 * Housekeeping that must not run inside a request.
 *
 * `sweep-refresh-tokens` deletes refresh tokens that are expired or were
 * revoked long enough ago that they can no longer be presented. Revoked rows
 * are kept for a grace period first, so a reuse attempt is still detectable
 * rather than silently looking like an unknown token.
 */

export const MAINTENANCE_JOBS = {
  SWEEP_REFRESH_TOKENS: 'sweep-refresh-tokens',
} as const;

const REVOKED_GRACE_DAYS = 7;

async function sweepRefreshTokens(): Promise<{ deleted: number }> {
  const graceCutoff = new Date(Date.now() - REVOKED_GRACE_DAYS * 86_400_000);

  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: graceCutoff } }],
    },
  });

  return { deleted: count };
}

export function startMaintenanceWorker(): Worker {
  const worker = new Worker(
    QUEUE.MAINTENANCE,
    async (job: Job) => {
      switch (job.name) {
        case MAINTENANCE_JOBS.SWEEP_REFRESH_TOKENS:
          return sweepRefreshTokens();
        default:
          throw new Error(`Unknown maintenance job "${job.name}"`);
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[maintenance] ${job?.name ?? 'unknown'} failed:`, err.message);
  });

  return worker;
}

/** Idempotent — re-registering a repeatable job with the same key replaces it. */
export async function scheduleMaintenance(): Promise<void> {
  await queue(QUEUE.MAINTENANCE).add(
    MAINTENANCE_JOBS.SWEEP_REFRESH_TOKENS,
    {},
    {
      repeat: { pattern: '17 3 * * *' }, // 03:17 daily, off the hour to avoid pile-ups
      jobId: MAINTENANCE_JOBS.SWEEP_REFRESH_TOKENS,
    },
  );
}
