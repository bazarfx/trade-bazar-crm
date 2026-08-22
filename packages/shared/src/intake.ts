import { z } from 'zod';

/**
 * The campaign-intake contract — what a webhook source IS, what its payload
 * mapping IS, and the one dot-path resolver both sides of the queue share.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SPACE LEFT FOR INTEGRATELY.
 *
 * As of today the Integrately account does not exist and no real campaign
 * platform payload has ever been seen. Everything in this file is therefore
 * designed around NOT knowing the payload shape:
 *
 *   - the endpoint stores whatever arrives, verbatim, before anything reads it;
 *   - the MAPPING below is data the Admin edits from the UI once real payloads
 *     start landing (`WebhookSource.lastPayload` shows them the latest one to
 *     map against);
 *   - a mis-mapped or unmapped event is a FAILED `WebhookEvent`, and replay
 *     re-runs it after the mapping is fixed — no lead is ever lost to our
 *     ignorance of a field name.
 *
 * Nothing here may ever grow a hardcoded guess at an Integrately field name.
 * When the real shape arrives, the Admin fills the mapping in; code does not
 * change.
 * ════════════════════════════════════════════════════════════════════════
 */

// ── queue hand-off ────────────────────────────────────────────────────────

/**
 * Lives here because the ENQUEUER is in the web app and the consumer is in
 * the worker: a queue name is a Redis key, and a literal typed into both apps
 * produces jobs that are accepted and never drained (same reasoning as
 * `IMPORT_QUEUE`).
 */
export const CAMPAIGN_INTAKE_QUEUE = 'campaign-intake';

/** The job carries ONLY the event id. The payload is already durable in
 *  `WebhookEvent.raw` — a job that carried the body would be a second copy
 *  that could drift from the one replay reads. */
export const campaignIntakeJobSchema = z.object({
  eventId: z.string().uuid(),
});
export type CampaignIntakeJobData = z.infer<typeof campaignIntakeJobSchema>;

// ── the public endpoint's constants ───────────────────────────────────────

/** `/api/intake/<token>` — one home for the path so the create response, the
 *  route and any UI copy-to-clipboard agree about what the URL looks like. */
export function intakePath(token: string): string {
  return `/api/intake/${token}`;
}

/** Tokens are 32 lowercase hex chars (16 random bytes). The endpoint rejects
 *  anything else BEFORE hashing, so a probe learns nothing about the space. */
export const INTAKE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Cap on the raw request body. The payload is persisted verbatim into a Json
 * column BEFORE parsing, so an unbounded body is an unbounded database write
 * on an UNAUTHENTICATED route. A campaign lead is a few KB; 256 KB is two
 * orders of magnitude of headroom without letting the log column become
 * object storage.
 */
export const INTAKE_MAX_BODY_BYTES = 256 * 1024;

/**
 * A body that is not JSON is stored as `{ _raw: '<text>' }` so even garbage
 * is replayable — "persist raw first" means raw, not "raw if well-formed".
 * Underscore-prefixed for the same reason `_reason` is: `fieldKeyFromLabel`
 * strips leading underscores, so no Admin-created field key can collide.
 */
export const INTAKE_RAW_TEXT_KEY = '_raw';

// ── webhook source kinds ──────────────────────────────────────────────────

/**
 * What a `WebhookSource` IS — the `kind` column's vocabulary.
 *
 * `CAMPAIGN`: a campaign platform posts leads; the source's mapping is an
 * `intakeMappingSchema` and events drain through `CAMPAIGN_INTAKE_QUEUE`.
 * `ARK`: the terminal posts account events; the mapping is an
 * `arkMappingSchema` and events drain through `ARK_WEBHOOK_QUEUE` into the
 * conversion pipeline (`./ark.ts`, `./conversion.ts`).
 *
 * A column, never a name prefix: the name is the Admin's to edit, and the two
 * kinds answer on different public endpoints — a token of one kind posted to
 * the other's endpoint is a 404, which is only possible if the kind is data
 * the lookup can filter on.
 */
export const WEBHOOK_SOURCE_KINDS = ['CAMPAIGN', 'ARK'] as const;
export type WebhookSourceKind = (typeof WEBHOOK_SOURCE_KINDS)[number];

export const CAMPAIGN_SOURCE_KIND = 'CAMPAIGN' satisfies WebhookSourceKind;
export const ARK_SOURCE_KIND = 'ARK' satisfies WebhookSourceKind;

// ── webhook source payloads ───────────────────────────────────────────────

/** Matches the actual `WebhookSource` model: name + target module + active
 *  flag. The token is GENERATED server-side (never chosen by a client) and
 *  the slug is derived from the name. */
export const webhookSourceCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  /** the module intake creates records IN — resolved to `moduleId` on write */
  moduleSlug: z.string().trim().min(1).max(60),
  isActive: z.boolean().default(true),
});
export type WebhookSourceCreateInput = z.infer<typeof webhookSourceCreateSchema>;

// ── the payload mapping — THE admin-configurable space ───────────────────

export const INTAKE_TRANSFORMS = ['none', 'trim', 'phone'] as const;
export type IntakeTransform = (typeof INTAKE_TRANSFORMS)[number];

/**
 * One mapping rule: pluck `source` out of the payload, write it to the field
 * keyed `target` on the source's module.
 *
 * `source` is a dot-path into the payload (`data.phone`, `answers.3.value` —
 * see `resolveDotPath`). Integrately's REAL paths are unknown today; this
 * string is exactly the part the Admin fills in when they are, against the
 * `lastPayload` the source has captured.
 *
 * `target` is a `FieldDefinition` KEY on the source's module — never a label,
 * never a column name. An unknown key fails the module's generated schema
 * loudly, which marks the event FAILED and replayable; it is never dropped.
 */
export const intakeMappingRuleSchema = z.object({
  source: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(64),
  transform: z.enum(INTAKE_TRANSFORMS).default('none'),
});
export type IntakeMappingRule = z.infer<typeof intakeMappingRuleSchema>;

/**
 * What `WebhookSource.fieldMapping` holds.
 *
 * `campaignNameSource` — dot-path whose value NAMES the Campaign record the
 * lead came from. When it yields a name, the worker find-or-creates that
 * Campaign through the record engine and links the new record to it.
 *
 * `campaignLinkField` — the RECORD_LINK field key on the source's module that
 * carries that link. Optional: when the module has exactly ONE record-link
 * field pointing at another module, it is used automatically; this override
 * exists for modules where that is ambiguous. A field key, so it is Admin
 * vocabulary like everything else here.
 */
export const intakeMappingSchema = z.object({
  rules: z.array(intakeMappingRuleSchema).max(100).default([]),
  campaignNameSource: z.string().trim().min(1).max(200).optional(),
  campaignLinkField: z.string().trim().min(1).max(64).optional(),
});
export type IntakeMapping = z.infer<typeof intakeMappingSchema>;

/**
 * The stored `fieldMapping` Json, or null when no usable mapping exists yet.
 *
 * Null — not a throw — because "not configured yet" is the EXPECTED state
 * while Integrately is unknown: the worker turns it into a FAILED event with
 * an honest message, and replay picks the event up once the Admin has mapped.
 * A malformed value (hand-edited, or a shape from a future version) reads the
 * same way: no mapping is no mapping.
 */
export function parseIntakeMapping(raw: unknown): IntakeMapping | null {
  const parsed = intakeMappingSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.rules.length > 0 || parsed.data.campaignNameSource ? parsed.data : null;
}

/**
 * Per-source DEFAULTS — `WebhookSource.defaultValues`. Field-keyed values
 * written onto every record this source creates when the mapping yields
 * nothing for that key: a source wired to a Hindi landing page sets
 * `{ language: 'Hindi' }` here instead of hoping the payload carries it.
 * Keys are field KEYS; a key the module does not know fails the generated
 * schema loudly, exactly like a bad mapping target.
 */
export const intakeDefaultsSchema = z.record(z.string().min(1).max(64), z.unknown());
export type IntakeDefaults = z.infer<typeof intakeDefaultsSchema>;

/** `defaultValues` as stored, reduced to the only shape the worker applies.
 *  Anything else (null, an array, a hand-edited scalar) is "no defaults". */
export function parseIntakeDefaults(raw: unknown): IntakeDefaults {
  const parsed = intakeDefaultsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export const webhookSourceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    /** soft-disable: the endpoint answers 410 and stores nothing */
    isActive: z.boolean().optional(),
    mapping: intakeMappingSchema.optional(),
    defaults: intakeDefaultsSchema.optional(),
  })
  .strict();
export type WebhookSourceUpdateInput = z.infer<typeof webhookSourceUpdateSchema>;

// ── event listing / replay payloads ───────────────────────────────────────

/** Mirrors the `WebhookStatus` enum in schema.prisma. */
export const WEBHOOK_STATUSES = ['RECEIVED', 'PROCESSED', 'FAILED', 'REPLAYED', 'IGNORED'] as const;
export type WebhookStatusValue = (typeof WEBHOOK_STATUSES)[number];

export const webhookStatusSchema = z.enum(WEBHOOK_STATUSES);

/** Only a settled event may be replayed. RECEIVED/REPLAYED are queued or in
 *  flight — replaying one would race the worker over the same row. */
export const REPLAYABLE_STATUSES = ['FAILED', 'IGNORED'] as const satisfies readonly WebhookStatusValue[];

/** One screenful of events. Each row carries a payload preview, so a larger
 *  page is bytes, not insight. */
export const INTAKE_EVENT_PAGE_SIZE = 20;

/**
 * Serialised-JSON ceiling for a payload in the LIST. A body may be up to
 * `INTAKE_MAX_BODY_BYTES`; twenty of those on one page is megabytes the
 * screen cannot show anyway. Past this the list ships a preview object (see
 * `WebhookEventDto.payload`) and the single-event endpoint carries the whole.
 */
export const INTAKE_PAYLOAD_PREVIEW_CHARS = 8 * 1024;

/**
 * The BullMQ job id for one run of one event.
 *
 * Carries the replay count so a replay is a NEW job: BullMQ refuses a second
 * job with an id it still holds, and a completed job lingers for hours, so an
 * id made of the event alone would make every replay a silent no-op. A hyphen
 * separator, never a colon — see `enqueueImport` for the scar.
 */
export function intakeJobId(eventId: string, replayCount: number): string {
  return `intake-${eventId}-r${replayCount}`;
}

// ── outbound shapes ───────────────────────────────────────────────────────

export interface WebhookSourceDto {
  id: string;
  name: string;
  /** the stable endpoint id shown in lists — NOT the token, which is never stored */
  slug: string;
  kind: WebhookSourceKind;
  moduleId: string;
  moduleSlug: string;
  moduleLabel: string;
  isActive: boolean;
  /** `fieldMapping` as stored; `parseIntakeMapping` turns it into rules */
  mapping: unknown;
  /** `defaultValues` as stored; `parseIntakeDefaults` reads it */
  defaults: unknown;
  /** the newest raw payload received, for mapping against — null before the first */
  lastPayload: unknown;
  createdAt: string;
  updatedAt: string;
}

/** The create response. `intakeUrl` is the ONE time the full URL exists:
 *  only the token's hash is stored, so it can never be shown again. */
export interface WebhookSourceCreatedDto {
  source: WebhookSourceDto;
  intakeUrl: string;
}

export interface WebhookEventDto {
  id: string;
  sourceId: string | null;
  status: WebhookStatusValue;
  error: string | null;
  /**
   * The stored raw body. In a LIST, a body whose JSON exceeds
   * `INTAKE_PAYLOAD_PREVIEW_CHARS` is replaced by
   * `{ _truncated: true, _preview: '<first N chars of its JSON>' }` and
   * `payloadTruncated` is true; the single-event endpoint always carries the
   * whole thing.
   */
  payload: unknown;
  payloadTruncated: boolean;
  /** the record the event produced, if any (`WebhookEvent.leadId`) */
  recordId: string | null;
  dealId: string | null;
  /** which pipeline outcome the event took — an `ArkOutcome` on an ARK
   *  source, null on campaign intake and on events that never settled */
  outcome: string | null;
  replayCount: number;
  receivedAt: string;
  processedAt: string | null;
}

export interface WebhookEventListDto {
  events: WebhookEventDto[];
  /** how many events match the filter in all, not just this page */
  total: number;
  page: number;
  pageSize: number;
}

// ── dot-path resolution ───────────────────────────────────────────────────

/**
 * Resolve a dot-path into an unknown payload. Null-safe: returns `undefined`
 * for anything unreachable, never throws — the payload is untrusted input and
 * the mapping is Admin input, and neither may crash the worker.
 *
 * Semantics (tests in `resolveDotPath` form — payload on the left):
 *
 *   { a: { b: 1 } }            + 'a.b'      → 1
 *   { a: [{ b: 'x' }] }        + 'a.0.b'    → 'x'     (arrays by index)
 *   { a: null }                + 'a.b'      → undefined (null-safe)
 *   { a: 1 }                   + 'a.b'      → undefined (primitives end the walk)
 *   { 'a.b': 1 }               + 'a.b'      → undefined (no quoted-key syntax)
 *   { a: [1, 2] }              + 'a.-1'     → undefined (no negative indexes)
 *   anything                   + ''         → undefined
 *   null / 'text' / 42         + 'a'        → undefined
 */
export function resolveDotPath(payload: unknown, path: string): unknown {
  if (!path) return undefined;

  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      // Only a plain non-negative integer indexes an array; anything else is
      // a key the array does not have.
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
