import { z } from 'zod';
import {
  ARK_OUTCOMES,
  applyArkTransform,
  arkMappingSchema,
  type ArkConcept,
  type ArkMapping,
} from './conversion.js';
import { INTAKE_MAX_BODY_BYTES, INTAKE_TOKEN_PATTERN, resolveDotPath, type WebhookStatusValue } from './intake.js';
import { normalisePhone } from './validation.js';

/**
 * The ARK receiver contract — the half of the ARK slice that sits ABOVE the
 * conversion service: what an ARK source is, what its endpoint looks like,
 * how a stored payload is read through the Admin's mapping into the concepts
 * the pipeline acts on, and how a name conflict is recorded.
 *
 * `./conversion.ts` fixes what a conversion, a deposit and a handover ARE;
 * this file fixes how an event REACHES them. Both sides of the queue — the
 * Next endpoint and the worker — import from here, so the endpoint cannot
 * accept a token shape the worker would not, and the worker cannot parse a
 * payload differently from the preview a mapping editor will one day show.
 *
 * THE SPACE is the same one `./conversion.ts` describes: no field name of
 * ARK's is guessed anywhere in this file. The dot-paths are the Admin's.
 */

// ── the public endpoint ───────────────────────────────────────────────────

/** `/api/ark/<token>` — one home for the path so the create response, the
 *  route and any copy-to-clipboard agree about what the URL looks like. */
export function arkPath(token: string): string {
  return `/api/ark/${token}`;
}

/** Same token shape as intake: 32 lowercase hex chars, rejected BEFORE the
 *  hash so a probe never costs a query. */
export const ARK_TOKEN_PATTERN = INTAKE_TOKEN_PATTERN;

/** Same body cap as intake, for the same reason: the body is stored verbatim
 *  in a Json column on an unauthenticated route. An account event is bytes. */
export const ARK_MAX_BODY_BYTES = INTAKE_MAX_BODY_BYTES;

// ── source payloads ───────────────────────────────────────────────────────

/**
 * Creating an ARK source takes a name and nothing else. No `moduleSlug`: an
 * ARK event is not "created in a module", it is run through the conversion
 * pipeline, which resolves the lead-side and deal-side modules from their
 * storage shapes. The source row still carries the lead-side module id (the
 * column is a foreign key), filled in by the service from that resolution.
 */
export const arkSourceCreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  isActive: z.boolean().default(true),
});
export type ArkSourceCreateInput = z.infer<typeof arkSourceCreateSchema>;

/** Rename, pause/resume, or — the one that matters — fill in the mapping. */
export const arkSourceUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
    mapping: arkMappingSchema.optional(),
  })
  .strict();
export type ArkSourceUpdateInput = z.infer<typeof arkSourceUpdateSchema>;

export interface ArkSourceDto {
  id: string;
  name: string;
  /** the stable endpoint id shown in lists — NOT the token, which is never stored */
  slug: string;
  kind: 'ARK';
  isActive: boolean;
  /** `fieldMapping` as stored; `parseArkMapping` turns it into rules */
  mapping: unknown;
  /** the newest raw payload received, for mapping against — null before the first */
  lastPayload: unknown;
  createdAt: string;
  updatedAt: string;
}

/** The create response. `receiverUrl` is the ONE time the full URL exists:
 *  only the token's hash is stored, so it can never be shown again. */
export interface ArkSourceCreatedDto {
  source: ArkSourceDto;
  receiverUrl: string;
}

// ── replay ────────────────────────────────────────────────────────────────

/**
 * Which ARK events may be replayed. Broader than intake's, deliberately:
 * PROCESSED is included because the pipeline is idempotent on the event —
 * `recordDeposit` dedupes on `webhookEventId`, a re-run of a conversion
 * finds the deal first and takes the re-deposit path (which dedupes), and a
 * re-run of an account-only event writes nothing the record does not already
 * carry. Replaying a processed intake event would create a second lead;
 * replaying a processed ARK event creates nothing. RECEIVED and REPLAYED
 * stay excluded: a job is already in flight for those.
 */
export const ARK_REPLAYABLE_STATUSES = ['FAILED', 'IGNORED', 'PROCESSED'] as const satisfies readonly WebhookStatusValue[];

/** `?outcome=` on the ARK events list. */
export const arkOutcomeSchema = z.enum(ARK_OUTCOMES);

// ── the parsed event ──────────────────────────────────────────────────────

/**
 * What the worker acts on once the mapping has been executed over the raw
 * body: spec §7 step 2's concepts, typed. Validated ONCE here so the worker
 * and a mapping preview cannot disagree about what "the payload is usable"
 * means.
 *
 *  - `accountNumber` and `phone` are required — matching is by phone and the
 *    account number is what every outcome writes. `phone` is already
 *    normalised by `coerceArkConcept`.
 *  - `depositAmount` may be absent (an account-only event) or ZERO, which
 *    reads as "no deposit": a platform that always sends the field sends 0
 *    for an account that has not funded, and that is not a deposit of
 *    nothing. Negative is refused — it is neither a deposit nor its absence.
 *  - `depositedAt` defaults to now (`parseArkPayload` fills it) because a
 *    platform that sends no timestamp still sent the event at a time.
 */
export const arkParsedEventSchema = z
  .object({
    accountNumber: z.string().trim().min(1, 'Account number is missing from the payload').max(64),
    phone: z.string().min(2, 'Phone is missing from the payload'),
    name: z.string().trim().min(1).optional(),
    language: z.string().trim().min(1).optional(),
    depositAmount: z
      .number()
      .finite('Deposit amount is not a number')
      .nonnegative('Deposit amount cannot be negative')
      .optional(),
    depositedAt: z.coerce.date(),
    referral: z.string().trim().min(1).optional(),
  })
  .strict();
export type ArkParsedEvent = z.infer<typeof arkParsedEventSchema>;

/** The deposit an event carried, or null for an account-only event. */
export function depositOf(event: ArkParsedEvent): { amount: number; depositedAt: Date } | null {
  return event.depositAmount !== undefined && event.depositAmount > 0
    ? { amount: event.depositAmount, depositedAt: event.depositedAt }
    : null;
}

/**
 * A transformed value, coerced to the TYPE its concept needs. Null-safe and
 * never throws — `undefined` means "not present", and the schema above says
 * whether that is acceptable for the concept.
 *
 * The phone is ALWAYS normalised here, whatever transform the rule carried:
 * it is the matching key (spec §7 step 3), and every record's phone was
 * normalised by the same function on the way in, so a raw "98765 43210"
 * must become the same `+919876543210` the lead carries.
 */
export function coerceArkConcept(concept: ArkConcept, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  switch (concept) {
    case 'accountNumber':
    case 'name':
    case 'language':
    case 'referral': {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      const text = String(value).trim();
      return text === '' ? undefined : text;
    }
    case 'phone': {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      const normalised = normalisePhone(String(value));
      return normalised === '' ? undefined : normalised;
    }
    case 'depositAmount':
      return applyArkTransform(value, 'number');
    case 'depositedAt':
      return applyArkTransform(value, 'date');
    default: {
      const _exhaustive: never = concept;
      return undefined;
    }
  }
}

/**
 * Execute the mapping over a stored body. Throws a `ZodError` naming the
 * concept that is missing or malformed — which the worker writes onto the
 * event as its FAILED reason, so the Admin reads "accountNumber: Account
 * number is missing from the payload" and fixes the dot-path.
 *
 * A path that resolves to nothing is OMITTED, not written as null, so a
 * required concept left empty fails with its own name rather than a type
 * error about null.
 */
export function parseArkPayload(raw: unknown, mapping: ArkMapping): ArkParsedEvent {
  const found: Partial<Record<ArkConcept, unknown>> = {};
  for (const rule of mapping.rules) {
    const value = resolveDotPath(raw, rule.source);
    if (value === null || value === undefined) continue;
    const coerced = coerceArkConcept(rule.concept, applyArkTransform(value, rule.transform));
    if (coerced !== undefined) found[rule.concept] = coerced;
  }
  return arkParsedEventSchema.parse({
    ...found,
    depositedAt: found.depositedAt ?? new Date(),
  });
}

// ── match confidence (spec §7) ────────────────────────────────────────────

/**
 * Name agreement, as spec §7's "exact phone + name agreement" reads it:
 * case-insensitive, whitespace-insensitive. "  Priya  SHARMA" and "priya
 * sharma" are one person typed twice; the comparison must not say otherwise.
 */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Do two names agree? A MISSING name on either side counts as agreement:
 * the payload may not carry one and a record's title may be blank, and an
 * absent name is no evidence of a different person. Only two PRESENT names
 * that differ are a conflict.
 */
export function namesAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (left === '' || right === '') return true;
  return left === right;
}

/**
 * The `DuplicateFlag` written for a phone hit with a conflicting name
 * (spec §7: "processed AND flagged for review, consistent with duplicate
 * handling"). `matchReason` joins the record engine's own `phone` and
 * `name_language`; `confidence` is the lowest rung of the same vocabulary
 * the engine writes (`HIGH` for phone, `MEDIUM` for name+language), because
 * the phone matched but the name did not.
 */
export const ARK_NAME_CONFLICT_REASON = 'ark_name_conflict';
export const ARK_NAME_CONFLICT_CONFIDENCE = 'LOW';

// ── audit keys ────────────────────────────────────────────────────────────

/**
 * Keys the pipeline writes into `AuditLog.changes` beside the ones
 * `@crm/records` owns (`_webhookEvent`, `_deal`, …). Underscore-prefixed for
 * the same reason: no field key can ever begin with one, so the timeline can
 * never mistake these for a field.
 */

/** On DUPLICATE_FLAGGED for a name conflict: the name ARK sent. */
export const ARK_CONFLICT_NAME_KEY = '_arkName';
/** On WEBHOOK_RECEIVED: which outcome the event took on this record. */
export const ARK_OUTCOME_KEY = '_outcome';
