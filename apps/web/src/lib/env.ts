/**
 * Environment access, validated once at module load.
 *
 * A missing secret must fail the process at boot, not silently sign tokens with
 * `undefined` at 3am.
 */
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * OPTIONAL, so the app boots without a queue.
   *
   * Redis backs the BullMQ hand-off to the worker — the ARK webhook, campaign
   * intake and CSV imports. A serverless host (Vercel) runs no worker, so
   * demanding it here would refuse to start an app whose every synchronous
   * screen works perfectly well. The queue modules connect LAZILY and throw a
   * named error when it is missing, and each caller already handles that by
   * storing the event and marking it replayable — nothing is lost, it simply
   * waits for a worker to exist.
   */
  REDIS_URL: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment:\n${missing}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
