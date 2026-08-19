import IORedis from 'ioredis';
import { env } from './env.js';

/**
 * One shared connection for queues and workers.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ — without it a blocking
 * command that outlives the retry budget kills the worker mid-job.
 */
export const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

connection.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});
