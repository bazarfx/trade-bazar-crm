import { Queue, type JobsOptions } from 'bullmq';
import { connection } from './redis.js';

/**
 * Every background queue in the platform. Names are stable strings — they
 * appear in Redis keys, so renaming one orphans its pending jobs.
 *
 * Queues are declared here as they are needed by a slice. A queue with no
 * consumer registered in `index.ts` will accept jobs and never drain, so the
 * two lists must stay in step.
 */
export const QUEUE = {
  /** Layer C. Batched click/view events. ~3.6M rows a month. */
  INTERACTION_LOGS: 'interaction-logs',
  /** ARK Terminal account-creation webhooks — the only conversion path. */
  ARK_WEBHOOK: 'ark-webhook',
  /** Campaign leads arriving via Integrately. */
  CAMPAIGN_INTAKE: 'campaign-intake',
  /** CSV / XLSX import batches. */
  IMPORTS: 'imports',
  /** Housekeeping: expired token sweep, index builds. */
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const registry = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  const existing = registry.get(name);
  if (existing) return existing;
  const q = new Queue(name, { connection, defaultJobOptions });
  registry.set(name, q);
  return q;
}

export const closeQueues = (): Promise<void[]> =>
  Promise.all([...registry.values()].map((q) => q.close()));
