/**
 * ARK sources — the Admin's side of the ARK webhook (spec §7).
 *
 * An ARK source is one URL the terminal posts account events into, carrying
 * one payload mapping (`arkMappingSchema` — dot-paths onto the pipeline's
 * concepts) and one event log. It shares the `WebhookSource` table with
 * campaign intake under `kind = 'ARK'`, and everything about it is
 * CONFIGURATION in the CLAUDE.md sense: the mapping is exactly the part of
 * this slice that cannot be written yet, because no real ARK payload exists.
 *
 * The same three rules as `intake/sources.ts`, with the same mechanics
 * (token generated here and stored hashed, slug derived once, reads gated
 * like writes under MANAGE_CAMPAIGNS / Admin):
 *
 *  1. every write goes through `applyConfigChange`;
 *  2. the token is shown once — `receiverUrl` on the create response;
 *  3. the event log holds raw payloads, so reading it is the same privilege
 *     as configuring the source.
 *
 * What differs: the module an ARK source carries is not chosen by the Admin.
 * An ARK event runs through the conversion pipeline, which resolves the lead-
 * side and deal-side modules from their storage shapes; the source row's
 * `moduleId` (a foreign key) is filled in from that same resolution, so it
 * names the lead-side module without this file ever naming a slug.
 */
import 'server-only';
import { prisma, Prisma, type WebhookStatus } from '@crm/db';
import {
  ARK_REPLAYABLE_STATUSES,
  isSignatureRejection,
  ARK_SOURCE_KIND,
  INTAKE_EVENT_PAGE_SIZE,
  arkPath,
  type ArkOutcome,
  type ArkSourceCreateInput,
  type ArkSourceCreatedDto,
  type ArkSourceDto,
  type ArkSourceUpdateInput,
  type WebhookEventDto,
  type WebhookEventListDto,
  type WebhookStatusValue,
} from '@crm/shared';
import type { Principal } from '@/lib/auth/actor';
import { audit } from '@/lib/audit';
import {
  applyConfigChange,
  assertConfigPermission,
  ConfigError,
  resolveConversionModules,
  type Tx,
} from '@/lib/config/service';
import {
  EVENT_SELECT,
  generateToken,
  hashIntakeToken,
  toEventDto,
  uniqueSlug,
  type EventRow,
} from '@/lib/intake/sources';
import { enqueueArk } from './queue';

/** The full URL ARK is given. `origin` comes from the request that asked. */
export function arkReceiverUrl(origin: string, token: string): string {
  return `${origin}${arkPath(token)}`;
}

// ── shapes ────────────────────────────────────────────────────────────────

/** What a source row selects as. `tokenHash` and `signingSecret` are
 *  deliberately absent from every read path in this file. */
const SOURCE_SELECT = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
  fieldMapping: true,
  lastPayload: true,
  // The SCHEME is configuration an Admin edits and must be able to read back.
  // The SECRET is a credential and stays out of this select entirely —
  // whether one exists is answered by `secretFlags` below, which reads ids
  // and nothing else, so the value never enters a row a DTO is built from.
  signatureHeader: true,
  signatureAlgorithm: true,
  signatureFormat: true,
  signaturePrefix: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WebhookSourceSelect;

type SourceRow = Prisma.WebhookSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

function toSourceDto(row: SourceRow, hasSecret: boolean): ArkSourceDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: ARK_SOURCE_KIND,
    isActive: row.isActive,
    mapping: row.fieldMapping,
    lastPayload: row.lastPayload,
    signature: {
      header: row.signatureHeader,
      algorithm: row.signatureAlgorithm,
      format: row.signatureFormat,
      prefix: row.signaturePrefix,
      // Whether a secret exists, never the secret. This is what lets the
      // screen distinguish "configured and enforcing" from "half configured
      // and refusing every call", which are very different states to be in.
      hasSecret: hasSecret,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Which of these sources hold a signing secret. A separate, minimal read so
 *  the secret itself never enters a row that a DTO is built from. */
async function secretFlags(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.webhookSource.findMany({
    where: { id: { in: ids }, NOT: { signingSecret: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** What the change log snapshots: the things an Admin edits and may want to
 *  undo. Never the token hash, never the signing secret, never the last
 *  payload (an account event is data, not configuration). */
async function snapshot(tx: Tx, id: string): Promise<unknown> {
  return tx.webhookSource.findUnique({
    where: { id },
    // An explicit allow-list, not an exclusion: `signingSecret` is absent
    // because it is a credential and the change log is append-only, so a
    // secret written here could never be taken back out. The signature
    // SCHEME is not secret and belongs in the snapshot — without it, undoing
    // a configuration change would silently leave verification pointing at
    // the wrong header.
    select: {
      id: true,
      name: true,
      slug: true,
      kind: true,
      moduleId: true,
      isActive: true,
      fieldMapping: true,
      signatureHeader: true,
      signatureAlgorithm: true,
      signatureFormat: true,
      signaturePrefix: true,
    },
  });
}

// ── reads ─────────────────────────────────────────────────────────────────

export async function listArkSources(principal: Principal): Promise<ArkSourceDto[]> {
  assertConfigPermission(principal, 'WEBHOOK_SOURCE');
  const rows = await prisma.webhookSource.findMany({
    where: { kind: ARK_SOURCE_KIND },
    orderBy: { createdAt: 'desc' },
    select: SOURCE_SELECT,
  });
  const withSecret = await secretFlags(rows.map((r) => r.id));
  return rows.map((row) => toSourceDto(row, withSecret.has(row.id)));
}

/** Assert first, resolve second: to a caller without the special, an unknown
 *  source and a forbidden one must be indistinguishable. A campaign source
 *  is "unknown" here — it is not this pipeline's. */
async function requireSource(principal: Principal, id: string): Promise<SourceRow> {
  assertConfigPermission(principal, 'WEBHOOK_SOURCE');
  const row = await prisma.webhookSource.findFirst({
    where: { id, kind: ARK_SOURCE_KIND },
    select: SOURCE_SELECT,
  });
  if (!row) throw new ConfigError('Unknown ARK source', 404, 'NOT_FOUND');
  return row;
}

export async function getArkSource(principal: Principal, id: string): Promise<ArkSourceDto> {
  const row = await requireSource(principal, id);
  return toSourceDto(row, (await secretFlags([row.id])).has(row.id));
}

// ── writes ────────────────────────────────────────────────────────────────

/**
 * Create an ARK source. `origin` is the public origin of the request, used
 * once to build the receiver URL in the response — the token itself is
 * discarded the moment this returns.
 */
export async function createArkSource(
  principal: Principal,
  input: ArkSourceCreateInput,
  origin: string,
): Promise<ArkSourceCreatedDto> {
  // Fail closed BEFORE touching data; applyConfigChange asserts again.
  assertConfigPermission(principal, 'WEBHOOK_SOURCE');

  // The lead-side module, found through the conversion shapes — which also
  // proves, before a URL is handed out, that a conversion path exists at all.
  const { source: leadSide } = await resolveConversionModules(principal);

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
          kind: ARK_SOURCE_KIND,
          moduleId: leadSide.module.id,
          isActive: input.isActive,
          // Empty on purpose. The mapping is THE SPACE left for the unknown
          // ARK payload; the Admin fills it in once the first real event has
          // shown its keys on `lastPayload`.
          fieldMapping: {},
        },
        select: SOURCE_SELECT,
      });
      return { result: row, configId: row.id };
    },
    after: snapshot,
  });

  return { source: toSourceDto(result, false), receiverUrl: arkReceiverUrl(origin, token) };
}

/**
 * Rename, pause/resume, or — the one that matters — replace the mapping.
 * Every branch is an UPDATE in the change log with the whole before/after,
 * so a mapping that broke the pipeline is one revert away from the one that
 * worked.
 */
export async function updateArkSource(
  principal: Principal,
  id: string,
  input: ArkSourceUpdateInput,
): Promise<ArkSourceDto> {
  await requireSource(principal, id);

  const data: Prisma.WebhookSourceUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    // Stored exactly as validated, so what the worker parses back with
    // `parseArkMapping` is what the editor saved — never a translation.
    ...(input.mapping !== undefined ? { fieldMapping: input.mapping as Prisma.InputJsonObject } : {}),
    // The signature SCHEME is ordinary configuration: audited, undoable, and
    // editable without a deploy. The SECRET is not — it has its own operation
    // below, because a credential must never sit in a change-log snapshot.
    ...(input.signature?.header !== undefined ? { signatureHeader: input.signature.header ?? null } : {}),
    ...(input.signature?.algorithm !== undefined
      ? { signatureAlgorithm: input.signature.algorithm ?? null }
      : {}),
    ...(input.signature?.format !== undefined ? { signatureFormat: input.signature.format ?? null } : {}),
    ...(input.signature?.prefix !== undefined ? { signaturePrefix: input.signature.prefix ?? null } : {}),
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

  return toSourceDto(result, (await secretFlags([result.id])).has(result.id));
}

/**
 * Set or clear this source's signing secret.
 *
 * Its OWN operation, deliberately, and the reasons are not stylistic:
 *
 *  - a secret must never enter `ConfigChangeLog`, and `applyConfigChange`
 *    snapshots the row before and after every edit it handles. So this write
 *    does not go through it. What IS logged is that the secret changed, by
 *    whom and when — an audit entry with no value in it;
 *  - an empty string CLEARS the secret, which is how verification is switched
 *    back off without also unsetting the scheme;
 *  - the DTO returned reflects the new state, so a screen can immediately
 *    show "enforcing" or "no secret set" without another round trip.
 *
 * The secret is never read back by anything but the receiver.
 */
export async function setArkSigningSecret(
  principal: Principal,
  id: string,
  signingSecret: string,
): Promise<ArkSourceDto> {
  await requireSource(principal, id);
  // Whether one was set BEFORE, so the log records a real transition rather
  // than a placeholder. The value itself is never read.
  const had = (await secretFlags([id])).has(id);

  const trimmed = signingSecret.trim();
  const row = await prisma.webhookSource.update({
    where: { id },
    data: { signingSecret: trimmed === '' ? null : trimmed },
    select: SOURCE_SELECT,
  });

  // The FACT, never the value. `changes` deliberately carries booleans: the
  // append-only log can never be corrected, so a secret written into it could
  // never be taken back out (CLAUDE.md, and the same rule the password reset
  // follows).
  await audit.log({
    entityType: 'WebhookSource',
    entityId: id,
    action: 'CONFIG_CHANGED',
    actorType: 'USER',
    actorId: principal.actor.userId,
    changes: {
      // The TRANSITION, never the value. The append-only log can never be
      // corrected, so a secret written into it could never be taken back out.
      signingSecret: {
        from: had ? '(set)' : '(not set)',
        to: trimmed === '' ? '(cleared)' : '(set)',
      },
    },
  });
  return toSourceDto(row, trimmed !== '');
}

// ── events ────────────────────────────────────────────────────────────────

export interface ListArkEventsOptions {
  status?: WebhookStatusValue;
  /** narrow to one of spec §7's outcomes — "show me every conversion" */
  outcome?: ArkOutcome;
  page?: number;
}

export async function listArkEvents(
  principal: Principal,
  sourceId: string,
  opts: ListArkEventsOptions = {},
): Promise<WebhookEventListDto> {
  await requireSource(principal, sourceId);

  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const where: Prisma.WebhookEventWhereInput = {
    sourceId,
    ...(opts.status ? { status: opts.status as WebhookStatus } : {}),
    ...(opts.outcome ? { outcome: opts.outcome } : {}),
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
export async function getArkEvent(
  principal: Principal,
  sourceId: string,
  eventId: string,
): Promise<WebhookEventDto> {
  return toEventDto(await requireEvent(principal, sourceId, eventId), true);
}

/**
 * Replay: re-run a stored event through the CURRENT mapping.
 *
 * This is the other half of "persist raw first" (spec §7 step 1, "any event
 * is replayable"). The stored body is reused as-is — nothing is re-posted,
 * nothing is edited — so what the worker sees on replay is exactly what ARK
 * sent.
 *
 * PROCESSED events may be replayed here, unlike intake's, because the
 * pipeline is IDEMPOTENT ON THE EVENT ID: `recordDeposit` looks for a ledger
 * row already pointing at `webhookEventId` and inserts nothing when it finds
 * one; a replayed conversion matches the deal it created (deals are searched
 * first, by account number) and takes the re-deposit path, which dedupes the
 * same way; a replayed account-only event writes the account number and
 * status the lead already carries, which `updateRecord` diffs to nothing.
 * So a replayed deposit can never be counted twice, and an Admin can press
 * the button to re-run an event after fixing a mapping without first
 * working out whether it "half happened". Only RECEIVED and REPLAYED are
 * refused — a job is already in flight for those, and two jobs over one
 * event would race each other over the same row.
 *
 * Status moves to REPLAYED ("queued again"); the worker settles it to
 * PROCESSED or back to FAILED with a fresh reason.
 */
export async function replayArkEvent(
  principal: Principal,
  sourceId: string,
  eventId: string,
): Promise<WebhookEventDto> {
  const event = await requireEvent(principal, sourceId, eventId);

  if (!(ARK_REPLAYABLE_STATUSES as readonly string[]).includes(event.status)) {
    throw new ConfigError('This event is already queued', 409, 'CONFLICT');
  }

  // A body that FAILED VERIFICATION is never replayable. It is kept because
  // a forged call is evidence, not because it is work waiting to be done —
  // and replay does not re-verify, so allowing it would make the signature
  // check one click from bypassed by an operator who assumed IGNORED meant
  // "benign". Re-posting it correctly signed is the legitimate route.
  if (isSignatureRejection(event.error)) {
    throw new ConfigError(
      'This event failed signature verification and cannot be replayed. If it is genuine, ' +
        'have the sender post it again with a valid signature.',
      422,
      'GUARDRAIL',
    );
  }

  // A conditional update, not a read-then-write: two Admins pressing Replay
  // together must produce one job, not two.
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
    await enqueueArk(eventId, replayed.replayCount);
  } catch (err) {
    console.error('[ark] replay enqueue failed', err);
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
      'The ARK queue is unavailable, so this event has not been replayed. Try again in a moment.',
      503,
      'VALIDATION',
    );
  }

  return toEventDto(replayed, false);
}
