/**
 * Webhook sources — the Admin's side of campaign intake (spec §6.1).
 *
 * A source is one URL a campaign platform posts leads into, pointed at one
 * module, carrying one payload mapping and one event log. Everything about it
 * is CONFIGURATION in the CLAUDE.md sense: creating one, pausing one and —
 * above all — editing its mapping must never need a deploy, because the
 * mapping is exactly the part of this slice that cannot be written yet (the
 * Integrately account does not exist; no real payload has been seen).
 *
 * Three rules:
 *
 *  1. **Every write goes through `applyConfigChange`.** The permission
 *     assertion (MANAGE_CAMPAIGNS, Admin fallback), the before/after snapshot
 *     and the ConfigChangeLog row are structural — a mapping edit is diffed
 *     and undoable like a field edit.
 *  2. **The token is shown once and stored hashed.** The create response is
 *     the only moment the full intake URL exists. The row keeps a SHA-256 of
 *     the token; a leaked database does not hand out live intake URLs.
 *  3. **Reads are gated the same way as writes.** An event log holds raw
 *     payloads — names and phone numbers posted by a platform — and the
 *     people allowed to read those are the people allowed to configure the
 *     source, nobody broader.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { prisma, Prisma, type WebhookStatus } from '@crm/db';
import {
  CAMPAIGN_SOURCE_KIND,
  INTAKE_EVENT_PAGE_SIZE,
  INTAKE_PAYLOAD_PREVIEW_CHARS,
  REPLAYABLE_STATUSES,
  intakePath,
  type WebhookSourceKind,
  type WebhookEventDto,
  type WebhookEventListDto,
  type WebhookSourceCreateInput,
  type WebhookSourceCreatedDto,
  type WebhookSourceDto,
  type WebhookSourceUpdateInput,
  type WebhookStatusValue,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import {
  applyConfigChange,
  assertConfigPermission,
  ConfigError,
  requireModule,
  type Tx,
} from '@/lib/config/service';
import { enqueueIntake } from './queue';

// ── the token ─────────────────────────────────────────────────────────────

/**
 * 16 random bytes as 32 lowercase hex characters — the shape
 * `INTAKE_TOKEN_PATTERN` admits at the endpoint. Generated here, never chosen
 * by a client: a guessable token is a public write path into the CRM.
 */
export function generateToken(): string {
  return randomBytes(16).toString('hex');
}

/** SHA-256 hex. The same function the endpoint uses to look a token up, so
 *  the two can never disagree about what "this token" hashes to. */
export function hashIntakeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The full URL a platform is given. `origin` comes from the request that
 *  asked, because the server does not otherwise know its public hostname. */
export function intakeUrl(origin: string, token: string): string {
  return `${origin}${intakePath(token)}`;
}

// ── the slug ──────────────────────────────────────────────────────────────

/**
 * A stable, human-readable endpoint id derived from the name at create time.
 * It identifies the source in lists and logs where the token must not appear.
 * Immutable afterwards (a rename changes `name` only) for the same reason a
 * field key is: it is what people will have written down.
 */
function slugFromName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return base || 'source';
}

export async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugFromName(name);
  const taken = new Set(
    (await tx.webhookSource.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    })).map((s) => s.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── shapes ────────────────────────────────────────────────────────────────

/** What a source row selects as. `tokenHash` is deliberately absent from
 *  every read path in this file — nothing returns it, nothing snapshots it. */
const SOURCE_SELECT = {
  id: true,
  name: true,
  slug: true,
  kind: true,
  moduleId: true,
  isActive: true,
  fieldMapping: true,
  defaultValues: true,
  lastPayload: true,
  createdAt: true,
  updatedAt: true,
  module: { select: { slug: true, label: true } },
} satisfies Prisma.WebhookSourceSelect;

type SourceRow = Prisma.WebhookSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

function toSourceDto(row: SourceRow): WebhookSourceDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind as WebhookSourceKind,
    moduleId: row.moduleId,
    moduleSlug: row.module.slug,
    moduleLabel: row.module.label,
    isActive: row.isActive,
    mapping: row.fieldMapping,
    defaults: row.defaultValues,
    lastPayload: row.lastPayload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What the change log snapshots. Name, module, flag, mapping and defaults —
 * the things an Admin edits and may want to undo. NOT the token hash (a
 * secret's fingerprint does not belong in a log other roles can read) and NOT
 * the last payload (a platform's raw lead, not configuration).
 */
async function snapshot(tx: Tx, id: string): Promise<unknown> {
  return tx.webhookSource.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      moduleId: true,
      isActive: true,
      fieldMapping: true,
      defaultValues: true,
    },
  });
}

// ── reads ─────────────────────────────────────────────────────────────────

/**
 * Campaign sources only. ARK sources share the table (`kind = 'ARK'`) but
 * hold an ARK mapping and drain through the conversion pipeline; they are
 * read and replayed through `lib/ark/sources.ts`. Letting one through here
 * would offer it the campaign mapping editor and the campaign replay queue —
 * both the wrong shape for it.
 */
export async function listWebhookSources(principal: Principal): Promise<WebhookSourceDto[]> {
  assertConfigPermission(principal, 'WEBHOOK_SOURCE');
  const rows = await prisma.webhookSource.findMany({
    where: { kind: CAMPAIGN_SOURCE_KIND },
    orderBy: { createdAt: 'desc' },
    select: SOURCE_SELECT,
  });
  return rows.map(toSourceDto);
}

/** Assert first, resolve second: to a caller without the special, an unknown
 *  source and a forbidden one must be indistinguishable. An ARK source is
 *  "unknown" here for the reason `listWebhookSources` gives. */
async function requireSource(principal: Principal, id: string): Promise<SourceRow> {
  assertConfigPermission(principal, 'WEBHOOK_SOURCE');
  const row = await prisma.webhookSource.findFirst({
    where: { id, kind: CAMPAIGN_SOURCE_KIND },
    select: SOURCE_SELECT,
  });
  if (!row) throw new ConfigError('Unknown webhook source', 404, 'NOT_FOUND');
  return row;
}

export async function getWebhookSource(principal: Principal, id: string): Promise<WebhookSourceDto> {
  return toSourceDto(await requireSource(principal, id));
}

// ── writes ────────────────────────────────────────────────────────────────

/**
 * Create a source. `origin` is the public origin of the request, used once
 * to build the intake URL in the response — the token itself is discarded
 * the moment this returns.
 */
export async function createWebhookSource(
  principal: Principal,
  input: WebhookSourceCreateInput,
  origin: string,
): Promise<WebhookSourceCreatedDto> {
  // Fail closed BEFORE touching data; applyConfigChange asserts again.
  assertConfigPermission(principal, 'WEBHOOK_SOURCE');
  const module = await requireModule(input.moduleSlug);

  const token = generateToken();
  const tokenHash = hashIntakeToken(token);

  const { result } = await applyConfigChange<SourceRow>({
    principal,
    configType: 'WEBHOOK_SOURCE',
    action: 'CREATE',
    before: async () => null,
    mutate: async (tx) => {
      const row = await tx.webhookSource.create({
        data: {
          name: input.name,
          slug: await uniqueSlug(tx, input.name),
          tokenHash,
          kind: CAMPAIGN_SOURCE_KIND,
          moduleId: module.id,
          isActive: input.isActive,
          // Empty on purpose. The mapping is THE SPACE left for the unknown
          // Integrately payload; the Admin fills it in from the mapping editor
          // once the first real event has shown its keys.
          fieldMapping: {},
        },
        select: SOURCE_SELECT,
      });
      return { result: row, configId: row.id };
    },
    after: snapshot,
  });

  return { source: toSourceDto(result), intakeUrl: intakeUrl(origin, token) };
}

/**
 * Rename, pause/resume, or — the one that matters — replace the mapping or
 * the defaults. Every branch is an UPDATE in the change log with the whole
 * before/after, so a mapping that broke intake is one revert away from the
 * one that worked.
 */
export async function updateWebhookSource(
  principal: Principal,
  id: string,
  input: WebhookSourceUpdateInput,
): Promise<WebhookSourceDto> {
  await requireSource(principal, id);

  const data: Prisma.WebhookSourceUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    // Stored exactly as validated, so what the worker parses back with
    // `parseIntakeMapping` is what the editor saved — never a translation.
    ...(input.mapping !== undefined
      ? { fieldMapping: input.mapping as Prisma.InputJsonObject }
      : {}),
    ...(input.defaults !== undefined
      ? { defaultValues: input.defaults as Prisma.InputJsonObject }
      : {}),
  };

  if (Object.keys(data).length === 0) {
    throw new ConfigError('Nothing to update', 400, 'VALIDATION');
  }

  const { result } = await applyConfigChange<SourceRow>({
    principal,
    configType: 'WEBHOOK_SOURCE',
    action: 'UPDATE',
    before: (tx) => snapshot(tx, id),
    mutate: async (tx) => {
      const row = await tx.webhookSource.update({ where: { id }, data, select: SOURCE_SELECT });
      return { result: row, configId: row.id };
    },
    after: snapshot,
  });

  return toSourceDto(result);
}

// ── events ────────────────────────────────────────────────────────────────

/** Shared with `lib/ark/sources.ts`: both kinds of source keep their events
 *  in the same table and show them the same way. */
export const EVENT_SELECT = {
  id: true,
  sourceId: true,
  raw: true,
  status: true,
  error: true,
  leadId: true,
  dealId: true,
  outcome: true,
  replayCount: true,
  createdAt: true,
  processedAt: true,
} satisfies Prisma.WebhookEventSelect;

export type EventRow = Prisma.WebhookEventGetPayload<{ select: typeof EVENT_SELECT }>;

/**
 * The list form of a payload: whole when it is small, a preview object when
 * it is not. The preview is an OBJECT rather than a bare string so the same
 * renderer that pretty-prints a payload pretty-prints this, and so the
 * `_truncated` marker cannot be mistaken for a key the platform sent
 * (`fieldKeyFromLabel` strips leading underscores, so no mapping rule can
 * target one either).
 */
function previewPayload(raw: unknown): { payload: unknown; payloadTruncated: boolean } {
  const json = JSON.stringify(raw);
  if (json === undefined || json.length <= INTAKE_PAYLOAD_PREVIEW_CHARS) {
    return { payload: raw, payloadTruncated: false };
  }
  return {
    payload: { _truncated: true, _preview: json.slice(0, INTAKE_PAYLOAD_PREVIEW_CHARS) },
    payloadTruncated: true,
  };
}

export function toEventDto(row: EventRow, full: boolean): WebhookEventDto {
  const body = full ? { payload: row.raw, payloadTruncated: false } : previewPayload(row.raw);
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: row.status as WebhookStatusValue,
    error: row.error,
    ...body,
    recordId: row.leadId,
    dealId: row.dealId,
    outcome: row.outcome,
    replayCount: row.replayCount,
    receivedAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

export interface ListEventsOptions {
  status?: WebhookStatusValue;
  page?: number;
}

export async function listWebhookEvents(
  principal: Principal,
  sourceId: string,
  opts: ListEventsOptions = {},
): Promise<WebhookEventListDto> {
  await requireSource(principal, sourceId);

  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const where: Prisma.WebhookEventWhereInput = {
    sourceId,
    ...(opts.status ? { status: opts.status as WebhookStatus } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.webhookEvent.count({ where }),
    prisma.webhookEvent.findMany({
      where,
      // Newest first: the event the Admin is looking for is the one that just
      // failed, and the mapping editor's reference payload is the newest too.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * INTAKE_EVENT_PAGE_SIZE,
      take: INTAKE_EVENT_PAGE_SIZE,
      select: EVENT_SELECT,
    }),
  ]);

  return {
    events: rows.map((row) => toEventDto(row, false)),
    total,
    page,
    pageSize: INTAKE_EVENT_PAGE_SIZE,
  };
}

async function requireEvent(principal: Principal, sourceId: string, eventId: string): Promise<EventRow> {
  await requireSource(principal, sourceId);
  // Scoped to the source in the URL: an event id from another source is not
  // this caller's to read just because it is a valid uuid.
  const row = await prisma.webhookEvent.findFirst({
    where: { id: eventId, sourceId },
    select: EVENT_SELECT,
  });
  if (!row) throw new ConfigError('Unknown event', 404, 'NOT_FOUND');
  return row;
}

/** One event with its WHOLE payload — what the list truncated. */
export async function getWebhookEvent(
  principal: Principal,
  sourceId: string,
  eventId: string,
): Promise<WebhookEventDto> {
  return toEventDto(await requireEvent(principal, sourceId, eventId), true);
}

/**
 * Replay: re-run a stored event through the CURRENT mapping.
 *
 * This is the other half of "persist raw first". The endpoint promised that a
 * payload nobody could parse is a FAILED event and never a lost lead; replay
 * is how that promise pays out once the Admin has mapped the shape. The
 * stored body is reused as-is — nothing is re-posted, nothing is edited — so
 * what the worker sees on replay is exactly what the platform sent.
 *
 * Status moves to REPLAYED, which means "queued again" (see
 * `REPLAYABLE_STATUSES` for why a queued event may not be replayed twice);
 * the worker settles it to PROCESSED or back to FAILED with a fresh reason.
 */
export async function replayWebhookEvent(
  principal: Principal,
  sourceId: string,
  eventId: string,
): Promise<WebhookEventDto> {
  const event = await requireEvent(principal, sourceId, eventId);

  if (!(REPLAYABLE_STATUSES as readonly string[]).includes(event.status)) {
    throw new ConfigError(
      event.status === 'PROCESSED'
        ? 'This event already produced a record; replaying it would create a second one'
        : 'This event is already queued',
      409,
      'CONFLICT',
    );
  }

  // A conditional update, not a read-then-write: two Admins pressing Replay
  // together must produce one job, not two records.
  const claimed = await prisma.webhookEvent.updateMany({
    where: { id: eventId, status: event.status },
    data: { status: 'REPLAYED', error: null, replayCount: { increment: 1 } },
  });
  if (claimed.count === 0) throw new ConfigError('This event is already queued', 409, 'CONFLICT');

  const replayed = await prisma.webhookEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: EVENT_SELECT,
  });

  try {
    await enqueueIntake(eventId, replayed.replayCount);
  } catch (err) {
    console.error('[intake] replay enqueue failed', err);
    // Put it back where it was — still replayable — and say so. The event
    // has not been lost; it has not been retried either, and claiming
    // otherwise would be the one lie this pipeline must never tell.
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: event.status,
        error: event.error,
        replayCount: { decrement: 1 },
      },
    });
    throw new ConfigError(
      'The intake queue is unavailable, so this event has not been replayed. Try again in a moment.',
      503,
      'VALIDATION',
    );
  }

  return toEventDto(replayed, false);
}
