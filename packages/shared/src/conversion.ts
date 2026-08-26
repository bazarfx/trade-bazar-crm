import { z } from 'zod';
import { DEAL_HANDOVER_TARGETS } from './settings.js';
import { normalisePhone } from './validation.js';

/**
 * The conversion contract (spec §7, §7.1, §8.3) — what the ARK webhook
 * pipeline, the conversion service in `@crm/records` and the deal screens
 * agree a conversion, a deposit and a handover ARE.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SPACE LEFT FOR ARK.
 *
 * As of today the ARK Terminal webhook has no technical spec: no payload
 * field names, no auth scheme, no retry contract. Everything in this file is
 * therefore designed around NOT knowing the payload shape, exactly as the
 * campaign-intake slice (`./intake.ts`) was designed around not knowing
 * Integrately's:
 *
 *   - the endpoint stores whatever arrives, verbatim, before anything reads it;
 *   - `arkMappingSchema` below maps dot-paths in that payload onto the FIXED
 *     list of concepts the pipeline understands — account number, name, phone,
 *     language, deposit amount, deposit time, referral. The CONCEPTS are code
 *     (spec §7 step 2 names them); the PATHS are data the Admin fills in once
 *     a real payload has been captured on the source;
 *   - signature verification is a documented slot (`ARK_SIGNATURE_SLOT`), not
 *     an implementation: the header name and algorithm are unknown, and a
 *     guess would either reject every real call or verify nothing;
 *   - a mis-mapped or unmapped event is a FAILED `WebhookEvent`, and replay
 *     re-runs it after the mapping is fixed — no account event is ever lost
 *     to our ignorance of a field name.
 *
 * What is NOT a space — what this file fixes because the spec fixes it: the
 * matching order, the four outcomes, Closed By being immutable, totals being
 * derived from deposit rows, and conversion being webhook-driven only.
 *
 * Nothing here may ever grow a hardcoded guess at an ARK field name.
 * ════════════════════════════════════════════════════════════════════════
 */

// ── queue hand-off ────────────────────────────────────────────────────────

/** Lives here for the same reason `CAMPAIGN_INTAKE_QUEUE` does: the enqueuer
 *  is the web app, the consumer is the worker, and a queue name is a Redis
 *  key — typed twice, jobs get accepted and never drained. */
export const ARK_WEBHOOK_QUEUE = 'ark-webhook';

/** The job carries ONLY the event id; the payload is already durable in
 *  `WebhookEvent.raw`, and a second copy on the job could drift from the one
 *  replay reads. */
export const arkWebhookJobSchema = z.object({
  eventId: z.string().uuid(),
});
export type ArkWebhookJobData = z.infer<typeof arkWebhookJobSchema>;

/** Same hyphen-separated shape as `intakeJobId`, same reason: a replay must
 *  be a NEW job id, and BullMQ treats a colon as a namespace separator. */
export function arkJobId(eventId: string, replayCount: number): string {
  return `ark-${eventId}-r${replayCount}`;
}

// ── signature verification — the slot ─────────────────────────────────────

/**
 * Where signature verification goes once ARK says how it signs.
 *
 * The endpoint is expected to: read `ARK_SIGNATURE_SLOT.header` off the
 * request, compute `ARK_SIGNATURE_SLOT.algorithm` over the raw body with the
 * source's secret, and compare in constant time — AFTER the raw event row is
 * written and BEFORE it is enqueued. A failed check marks the event IGNORED
 * with `ARK_SIGNATURE_SLOT.failureMessage`; it never discards the payload,
 * because "persist raw first" applies to forged calls too (they are evidence).
 *
 * SUPERSEDED as the place to configure this. Both values stay null and the
 * struct remains only as a fallback for a source created before per-source
 * settings existed, plus `failureMessage`, which the verifier still returns
 * on a digest mismatch. Do NOT fill these in: setting them here switches
 * verification on for EVERY source at once and needs a deploy, which is the
 * pair of faults `arkSignatureConfigSchema` below exists to remove. Configure
 * the scheme on the source instead.
 */
export const ARK_SIGNATURE_SLOT = {
  header: null as string | null,
  algorithm: null as ArkSignatureAlgorithm | null,
  failureMessage: 'Signature verification failed',
} as const;

/**
 * The marker every signature refusal wears on `WebhookEvent.error`.
 *
 * A refused event is still STORED — "persist raw first" applies to forged
 * calls, which are evidence — and it settles IGNORED. But IGNORED is also
 * where benign outcomes land ("carried no deposit", "this source is paused"),
 * and IGNORED is replayable. Without a marker, an operator working down the
 * IGNORED list could press Replay on a forgery and walk it through the whole
 * pipeline: create a lead, convert it, bank a deposit. The replay path reads
 * this prefix and refuses, so a body that failed verification can never be
 * promoted into the pipeline by hand.
 */
export const ARK_SIGNATURE_REJECTED = 'SIGNATURE_REJECTED';

/** Did this event fail verification? Read off the stored error text. */
export function isSignatureRejection(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(ARK_SIGNATURE_REJECTED);
}

/**
 * How a source signs, as DATA on the source rather than a constant in code.
 *
 * The slot above was written when the answer had to be the same for
 * everybody; it stays as the fallback default. But ARK's scheme is still
 * unspecified while campaign platforms have schemes of their own, and a
 * single global switch has two faults: turning it on demands a deploy — which
 * the prime directive forbids for anything a customer can configure — and it
 * turns on for EVERY source at once, so the first partner to start signing
 * breaks every partner that does not.
 *
 * These three values are what actually differs between real-world schemes.
 * The algorithm is a union so adding one is a compile error at every branch
 * that must handle it, never a silently unverified source.
 */
export const ARK_SIGNATURE_ALGORITHMS = ['hmac-sha256', 'hmac-sha512'] as const;
export type ArkSignatureAlgorithm = (typeof ARK_SIGNATURE_ALGORITHMS)[number];

/** How the digest is written on the wire. Hex and base64 both appear widely
 *  enough that guessing one would reject half of all real callers. */
export const ARK_SIGNATURE_FORMATS = ['hex', 'base64'] as const;
export type ArkSignatureFormat = (typeof ARK_SIGNATURE_FORMATS)[number];

/**
 * A source's verification settings, all optional because "not configured" is
 * a legitimate and common state: no scheme means the unguessable token stays
 * the only gate, exactly as before this existed.
 *
 * VERIFICATION IS ENFORCED only when the header, the algorithm and the
 * source's secret are ALL present. Half a configuration must never read as
 * "verification is on" while verifying nothing — and it must never read as
 * "off" once someone has set a secret either, which is why the receiver
 * refuses a configured-but-secretless source rather than waving it through.
 */
export const arkSignatureConfigSchema = z
  .object({
    /** the header carrying the digest, e.g. `x-ark-signature` */
    header: z.string().trim().min(1).max(100).nullish(),
    algorithm: z.enum(ARK_SIGNATURE_ALGORITHMS).nullish(),
    format: z.enum(ARK_SIGNATURE_FORMATS).nullish(),
    /** a prefix the sender wears on the value, e.g. `sha256=` — stripped
     *  before comparison because it is notation, not signature */
    prefix: z.string().trim().max(20).nullish(),
  })
  .strict();
export type ArkSignatureConfig = z.infer<typeof arkSignatureConfigSchema>;

/** Setting the shared secret is its own operation: it is a credential, it is
 *  write-only, and it must never travel back out in a DTO. Empty string
 *  clears it, which is how verification is switched back off. */
export const arkSigningSecretSchema = z
  .object({ signingSecret: z.string().max(200) })
  .strict();
export type ArkSigningSecretInput = z.infer<typeof arkSigningSecretSchema>;

// ── the payload mapping — THE admin-configurable space ───────────────────

/**
 * The concepts spec §7 step 2 parses out of a webhook — and nothing else.
 * A mapping rule targets one of these, never a field key: which FIELD an
 * account number lands in is the engine's business (it reads the storage
 * shape), and which PATH carries it is the Admin's.
 */
export const ARK_CONCEPTS = [
  'accountNumber',
  'name',
  'phone',
  'language',
  'depositAmount',
  'depositedAt',
  'referral',
  /**
   * ARK's OWN reference for this event, when it sends one — a transaction id,
   * an event id, whatever they call it. The single most valuable field for
   * correctness that the pipeline does not require: mapped, it makes a
   * redelivered deposit exactly identifiable, so the ledger can refuse the
   * second copy on the strength of ARK's word rather than a fingerprint.
   * Unmapped, `depositDedupeKey` falls back to the deposit's own facts.
   */
  'externalId',
] as const;
export type ArkConcept = (typeof ARK_CONCEPTS)[number];

/** `number` and `date` join the intake set because a deposit is money at a
 *  time, and a platform sends both as strings more often than not. */
export const ARK_TRANSFORMS = ['none', 'trim', 'phone', 'number', 'date'] as const;
export type ArkTransform = (typeof ARK_TRANSFORMS)[number];

/**
 * One rule: pluck `source` (a dot-path, see `resolveDotPath`) out of the
 * payload and read it AS `concept`. Two rules naming one concept is a
 * mapping error the schema refuses below — a second phone path would make
 * "which number do we match on" a question nobody answered.
 */
export const arkMappingRuleSchema = z.object({
  source: z.string().trim().min(1).max(200),
  concept: z.enum(ARK_CONCEPTS),
  transform: z.enum(ARK_TRANSFORMS).default('none'),
});
export type ArkMappingRule = z.infer<typeof arkMappingRuleSchema>;

/**
 * What an ARK `WebhookSource.fieldMapping` holds. `accountNumber` and `phone`
 * are the two the pipeline cannot run without — matching is by phone and the
 * account number is what a conversion writes — so a mapping missing either is
 * "no mapping yet" rather than a partial one.
 */
export const arkMappingSchema = z.object({
  rules: z
    .array(arkMappingRuleSchema)
    .max(ARK_CONCEPTS.length)
    .default([])
    .refine(
      (rules) => new Set(rules.map((r) => r.concept)).size === rules.length,
      'Each ARK concept may be mapped once',
    ),
  /**
   * The FIELD KEY on the lead-side module that receives the `referral`
   * concept when the pipeline creates a new lead (spec §7: "with referral
   * info"). Optional: unset, the worker uses the module's single field whose
   * key or label mentions "referral" — a heuristic over Admin vocabulary,
   * which is why this override exists and is the real answer. A key, never
   * a label: the Admin may relabel the field and the mapping still holds.
   */
  referralField: z.string().trim().min(1).max(64).optional(),
});
export type ArkMapping = z.infer<typeof arkMappingSchema>;

/** The concepts without which an ARK event cannot be acted on. */
export const ARK_REQUIRED_CONCEPTS = ['accountNumber', 'phone'] as const satisfies readonly ArkConcept[];

/**
 * The stored `fieldMapping`, or null when it is not usable yet — the EXPECTED
 * state while ARK is unknown. Null, not a throw, for the same reason as
 * `parseIntakeMapping`: the worker turns it into a FAILED event with an honest
 * message, and replay picks the event up once the Admin has mapped it.
 */
export function parseArkMapping(raw: unknown): ArkMapping | null {
  const parsed = arkMappingSchema.safeParse(raw);
  if (!parsed.success) return null;
  const mapped = new Set(parsed.data.rules.map((r) => r.concept));
  return ARK_REQUIRED_CONCEPTS.every((c) => mapped.has(c)) ? parsed.data : null;
}

/**
 * One transform, defined once so the worker and any preview in the mapping
 * UI agree on what "date" does to `"2026-08-22 14:05"`. Null-safe and
 * never throws: the payload is untrusted and the mapping is Admin input.
 * A value a transform cannot read comes back `undefined`, which the caller
 * treats as "not present" — an unreadable amount must not become NaN in a
 * ledger.
 */
export function applyArkTransform(value: unknown, transform: ArkTransform): unknown {
  if (value === null || value === undefined) return undefined;
  switch (transform) {
    case 'none':
      return value;
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'phone':
      return typeof value === 'string' || typeof value === 'number'
        ? normalisePhone(String(value))
        : undefined;
    case 'number': {
      // Strip currency symbols and thousands separators; keep sign and point.
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
    default: {
      const _exhaustive: never = transform;
      return value;
    }
  }
}

// ── the four outcomes (spec §7) ───────────────────────────────────────────

/**
 * What one ARK event did, in the spec's own vocabulary. Written onto the
 * event row's error/outcome surface by the worker and shown on the events
 * screen; fixed here so the two cannot spell them differently.
 */
export const ARK_OUTCOMES = [
  /** an existing deal matched: one more ledger row, no new deal */
  'REDEPOSIT',
  /** a lead matched and a deposit came with it: THE conversion moment */
  'CONVERTED',
  /** a lead matched, account only: account number filled, status to SIGNED_UP */
  'SIGNED_UP',
  /** nothing matched: a new lead, Source = ARK Terminal, routed to the seniors.
   *  When a deposit came with it, the new lead is converted in the same run
   *  (a brand-new account that deposited is a deal) and the event records
   *  CONVERTED — a deal exists — with both `leadId` and `dealId` set; the
   *  lead's own timeline shows it was created by the same event. */
  'NEW_LEAD',
] as const;
export type ArkOutcome = (typeof ARK_OUTCOMES)[number];

// ── the handover rule (spec §7.1) ─────────────────────────────────────────

/**
 * `deals.handoverRule` as the conversion service reads it — the non-null
 * form of the setting declared in `./settings.ts`.
 *
 * `type` is the discriminator the STORED setting already uses (and the
 * settings screen writes), so it is kept rather than renamed: the setting's
 * value shape shipped with its key, and a stored `{ type }` read through a
 * `{ target }` schema would silently resolve to "unset" and route every new
 * deal to the Admin. The members come from `DEAL_HANDOVER_TARGETS`; 'role'
 * means "the id is a Role id", never a role name.
 */
export const dealHandoverRuleSchema = z
  .object({
    type: z.enum(DEAL_HANDOVER_TARGETS),
    id: z.string().uuid('Expected an id'),
  })
  .strict();
export type DealHandoverRuleInput = z.infer<typeof dealHandoverRuleSchema>;

/**
 * Why a deal landed with its owner — rendered on the timeline beside the
 * ASSIGNED / OWNERSHIP_TRANSFERRED entry, under the same `_reason` key the
 * assignment engine uses. `admin_fallback` is shared with that engine on
 * purpose: it is the same last tier for the same reason (nothing is ever
 * unowned).
 */
export const HANDOVER_REASONS = [
  /** the rule names one user, and they are active */
  'handover_user',
  /** round-robin among active holders of the nominated role */
  'handover_role',
  /** round-robin among active members of the nominated group */
  'handover_pool',
  /** no rule, or its target is gone or inactive: the first active Admin */
  'admin_fallback',
] as const;
export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export interface HandoverDecision {
  ownerId: string;
  reason: HandoverReason;
}

// ── conversion & deposit inputs ───────────────────────────────────────────

/** Money as the ledger stores it: positive, at most two decimals, and inside
 *  the column's `Decimal(14, 2)`. A deposit of zero is not a deposit. */
const amountSchema = z
  .number()
  .positive('A deposit must be greater than zero')
  .max(999_999_999_999.99, 'Amount is too large')
  // Zod's multipleOf is float-safe (it compares on shifted integers), so
  // 0.07 passes where a naive modulo would not.
  .multipleOf(0.01, 'Amount may have at most two decimals');

/** `z.coerce.date()` so the worker can hand over an ISO string straight out
 *  of a transform, and a clock in the future is refused: a deposit "at" a
 *  time that has not happened is a mapped timezone error, not a fact. */
const depositedAtSchema = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60 * 1000, 'Deposit time is in the future');

/**
 * A deposit arriving WITH a conversion — the FTD. No `dealId` (the deal does
 * not exist yet) and no `isFtd` (it is, by definition).
 */
export const conversionDepositSchema = z
  .object({
    amount: amountSchema,
    depositedAt: depositedAtSchema,
    /** the raw event that carried it, so the ledger row points at its evidence */
    webhookEventId: z.string().uuid().optional(),
    /** the redelivery-proof key, forwarded to the ledger row this conversion
     *  writes — an FTD is as redeliverable as any other deposit. */
    dedupeKey: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ConversionDepositInput = z.infer<typeof conversionDepositSchema>;

/**
 * What converts a lead. `webhookEventId` is REQUIRED: conversion is
 * webhook-driven only (spec §7, "there is no manual Convert button"), and
 * requiring the event here makes that structural rather than a UI decision —
 * there is no valid input without a raw payload behind it.
 */
export const convertLeadInputSchema = z
  .object({
    leadId: z.string().uuid(),
    arkAccountNo: z.string().trim().min(1, 'Account number is required').max(64),
    deposit: conversionDepositSchema.optional(),
    webhookEventId: z.string().uuid(),
  })
  .strict();
export type ConvertLeadInput = z.infer<typeof convertLeadInputSchema>;

/** A deposit on an EXISTING deal — the re-deposit outcome, or the FTD the
 *  conversion records on the deal it just created. */
export const depositInputSchema = z
  .object({
    dealId: z.string().uuid(),
    amount: amountSchema,
    depositedAt: depositedAtSchema,
    webhookEventId: z.string().uuid().optional(),
    /**
     * What makes a REDELIVERY harmless — see `depositDedupeKey`. Distinct
     * from `webhookEventId`, which identifies our stored copy of an event and
     * so only makes the replay button safe. Absent for a hand-entered
     * deposit, which no webhook can duplicate.
     */
    dedupeKey: z.string().min(1).max(200).optional(),
    isFtd: z.boolean().default(false),
  })
  .strict();
export type DepositInput = z.infer<typeof depositInputSchema>;

/**
 * The key two copies of one ARK deposit must agree on.
 *
 * THE PROBLEM IT SOLVES. `WebhookEvent.id` is ours and is minted per POST, so
 * it identifies a replay of a stored event but NOT a redelivery from ARK —
 * which arrives as a second event, with a second id, carrying the same money.
 * Keyed on the event id alone, the ledger banks it twice and the deal's total
 * is quietly wrong. This key is computed from the EVENT rather than from our
 * receipt of it, so both copies land on the same string and the unique index
 * on `(dealId, dedupeKey)` refuses the second row.
 *
 * THREE SOURCES, IN ORDER OF TRUST. Each prefix is distinct so keys from
 * different sources can never collide by spelling the same characters:
 *   1. `ark:` — `externalId` from the mapping, ARK's own reference. Exact,
 *      and the reason that concept exists. Map it if ARK sends one.
 *   2. `fp:` — the deposit's own facts: account number, the amount to the
 *      paisa, and the instant it was deposited. Only used when ARK actually
 *      TIMESTAMPED the deposit; the parse defaults a missing timestamp to
 *      now(), and a key built on that would differ per delivery and protect
 *      nothing.
 *   3. `raw:` — a digest of the bytes that arrived. The last resort, and the
 *      one that carries the live mapping: with neither a reference nor a
 *      timestamp mapped, a redelivery is recognisable only by being the same
 *      body twice.
 *
 * WHAT THE LAST RESORT CANNOT DO, stated plainly because money depends on it:
 * if ARK sends no reference and no timestamp, then two GENUINE deposits of
 * the same amount on the same account are byte-identical, and no algorithm
 * can tell them apart from a redelivery — the information simply is not in
 * the payload. This function suppresses the second one, which is the safer
 * default against a retrying sender, and `recordDeposit` writes an audit
 * entry naming the amount it refused every time it does so. A suppression is
 * therefore never silent: it is a line on the timeline an operator can
 * reconcile against ARK's own statement. Mapping `externalId` removes the
 * ambiguity outright, which is why the mapping editor asks for it.
 *
 * Deliberately NOT hashed. The value is short, carries no secret, and a
 * readable key is one an operator can match against a payload when a deposit
 * is questioned; a digest would only look tidier in the column.
 *
 * Returns null when there is no deposit to key — an account-only event banks
 * nothing, so it needs no protection.
 */
export function depositDedupeKey(event: {
  accountNumber?: string | null;
  externalId?: string | null;
  depositAmount?: number | null;
  depositedAt?: Date | null;
  /** a stable digest of the RAW body, supplied by the receiver — see the
   *  third source below. Computed by the caller because hashing belongs to a
   *  server runtime and this module is bundled for the browser too. */
  bodyFingerprint?: string | null;
}): string | null {
  const external = typeof event.externalId === 'string' ? event.externalId.trim() : '';
  if (external !== '') return `ark:${external}`;

  const amount = event.depositAmount;
  const hasDeposit = typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  if (!hasDeposit) return null;

  if (event.depositedAt) {
    const account = (event.accountNumber ?? '').trim().toLowerCase();
    // Fixed to two decimals so 1000 and 1000.00 are one deposit, and the
    // timestamp in UTC so the key does not depend on where it was computed.
    return `fp:${account}|${amount.toFixed(2)}|${event.depositedAt.toISOString()}`;
  }

  const body = typeof event.bodyFingerprint === 'string' ? event.bodyFingerprint.trim() : '';
  if (body !== '') return `raw:${body}`;

  return null;
}
/**
 * Transfer of Deal Owner (spec §7.1). The deal id travels in the URL, like
 * `recordAssignSchema`; `reason` is free text for the timeline — "customer
 * asked for a Hindi speaker" — and never a permission argument.
 */
export const transferOwnershipSchema = z
  .object({
    newOwnerId: z.string().uuid('Choose a user'),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

/** The same transfer as the SERVICE receives it — body plus the deal id the
 *  route read off the URL. One schema, so the route and the service cannot
 *  disagree about what an id looks like. */
export const transferDealOwnershipInputSchema = transferOwnershipSchema.extend({
  dealId: z.string().uuid(),
});
export type TransferDealOwnershipInput = z.infer<typeof transferDealOwnershipInputSchema>;

// ── outbound shapes ───────────────────────────────────────────────────────

export interface ConversionResultDto {
  dealId: string;
}

export interface DepositRecordedDto {
  depositId: string;
  /**
   * The deal's total AFTER this deposit, as exact decimal digits — a
   * `Number()` round-trip of a `Decimal(14, 2)` loses precision, and this is
   * money (same rule as `plain()` in the serialiser).
   */
  totalDeposited: string;
  depositCount: number;
  /** false when `webhookEventId` had already produced a row and nothing was inserted */
  inserted: boolean;
}

export interface OwnershipTransferDto {
  dealId: string;
  ownerId: { from: string; to: string };
}
