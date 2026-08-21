import { redirect } from 'next/navigation';
import { prisma } from '@crm/db';
import { getPrincipal } from '@/lib/auth/session';
import {
  IntakeManager,
  type EventCounts,
  type ModuleOption,
  type SourceRow,
} from './_components/intake-manager';

/**
 * Campaign intake (spec §6.1): the webhook sources that Integrately — or any
 * other campaign platform — will POST leads into.
 *
 * THE HONEST STATE OF THIS SLICE: the Integrately account and the real
 * payloads DO NOT EXIST YET. That is a fact this screen states rather than
 * papers over. Everything unknown is an Admin-editable SPACE, not a guess in
 * code: the payload mapping is a `WebhookSource.fieldMapping` JSON the Admin
 * fills in when the first real payload arrives, and the events list is where
 * that payload becomes visible — stored raw BEFORE parsing, so a shape nobody
 * predicted is a FAILED event to read and replay, never a lost lead.
 *
 * Sources and counts are read here, server-side, exactly as the settings
 * landing reads its modules: this is a server component, and self-fetching
 * our own API would double the request for no isolation gain. Mutations go
 * through `/api/webhook-sources` from the client components.
 */
export default async function IntakeSettingsPage() {
  const principal = await getPrincipal();
  if (!principal) redirect('/login');

  // UX gate only — the intake API asserts again on every read and write.
  // MANAGE_CAMPAIGNS is the special this surface belongs to: webhook sources
  // exist to feed campaign leads, and the matrix can delegate them together.
  const canManage =
    principal.actor.isAdmin || principal.permissions.specials.has('MANAGE_CAMPAIGNS');
  if (!canManage) redirect('/');

  const [sources, modules, countRows] = await Promise.all([
    prisma.webhookSource.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        fieldMapping: true,
        lastPayload: true,
        createdAt: true,
        module: { select: { slug: true, label: true, labelPlural: true } },
      },
    }),
    // Which modules a source can feed. Every enabled module, not a hardcoded
    // list — an Admin-created module takes webhook leads the day it exists.
    prisma.moduleDefinition.findMany({
      where: { isEnabled: true },
      orderBy: { navOrder: 'asc' },
      select: { id: true, slug: true, label: true, labelPlural: true },
    }),
    // Event volume per source and status, in one grouped query rather than a
    // count per row: a busy source holds tens of thousands of events.
    prisma.webhookEvent.groupBy({
      by: ['sourceId', 'status'],
      _count: { _all: true },
    }),
  ]);

  const counts: Record<string, EventCounts> = {};
  for (const row of countRows) {
    if (row.sourceId === null) continue; // events whose source was deleted
    const bucket = (counts[row.sourceId] ??= {});
    bucket[row.status] = row._count._all;
  }

  const sourceRows: SourceRow[] = sources.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    isActive: s.isActive,
    mapping: s.fieldMapping,
    lastPayload: s.lastPayload,
    createdAt: s.createdAt.toISOString(),
    moduleSlug: s.module.slug,
    moduleLabel: s.module.label,
    counts: counts[s.id] ?? {},
  }));

  const moduleOptions: ModuleOption[] = modules.map((m) => ({
    id: m.id,
    slug: m.slug,
    label: m.label,
    labelPlural: m.labelPlural,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-title font-medium text-heading">Campaign intake</h1>
        <p className="mt-1 max-w-3xl text-sm text-body">
          Each source below is a webhook URL a campaign platform posts leads into. Every payload
          is stored raw before anything reads it, so a shape the mapping does not understand is a
          failed event you can inspect and replay — never a lost lead. Incoming leads route
          through the same assignment engine as every other lead and are never unassigned.
        </p>
      </div>

      <IntakeManager sources={sourceRows} modules={moduleOptions} />
    </div>
  );
}
