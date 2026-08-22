/**
 * Background worker.
 *
 * Everything that must not block a request lives here: the ARK webhook
 * pipeline, campaign intake, interaction-log batching and imports. Route
 * handlers enqueue; they never process.
 *
 * Consumers are registered per slice — a queue declared in `lib/queues.ts`
 * without a worker here will accept jobs and never drain.
 */
import type { Worker } from 'bullmq';
import { prisma } from '@crm/db';
import { connection } from './lib/redis.js';
import { closeQueues } from './lib/queues.js';
import { startMaintenanceWorker, scheduleMaintenance } from './jobs/maintenance.js';
import { startImportsWorker } from './jobs/imports.js';
import { startCampaignIntakeWorker } from './jobs/campaign-intake.js';
import { startArkWebhookWorker } from './jobs/ark-webhook.js';

const workers: Worker[] = [];

async function main() {
  workers.push(startMaintenanceWorker());
  await scheduleMaintenance();

  // The import consumer. Enqueued by the wizard's commit in apps/web; this is
  // the half that actually writes records, one staged row at a time through
  // the record engine.
  workers.push(startImportsWorker());

  // Campaign intake. The public endpoint in apps/web stores each raw payload
  // and enqueues its id; this consumer runs the source's Admin-edited mapping
  // over it and creates the record through the engine as a system actor.
  workers.push(startCampaignIntakeWorker());

  // The ARK webhook — the only conversion path (spec §7). The public endpoint
  // in apps/web stores each raw account event and enqueues its id; this
  // consumer matches it (deals first, then active leads, by phone), takes one
  // of the four outcomes through the conversion service, and settles the
  // event in the same transaction as the deal or deposit it produced.
  workers.push(startArkWebhookWorker());

  console.log(`▸ worker up — ${workers.length} consumer(s): ${workers.map((w) => w.name).join(', ')}`);
}

async function shutdown(signal: string) {
  console.log(`\n▸ ${signal} — draining`);
  // Close workers first so in-flight jobs finish before the queues go.
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  await connection.quit();
  await prisma.$disconnect();
  console.log('▸ worker down');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  console.error('worker failed to start:', err);
  process.exit(1);
});
