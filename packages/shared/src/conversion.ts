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
 * Both values are null today on purpose. A null header means "not configured:
 * accept and enqueue", which is the honest behaviour while the contract is
 * unknown — the token in the URL is the only authentication ARK has been
 * given. Filling these in is a one-line change here plus the secret on the
 * source; no engine code moves.
 */
export const ARK_SIGNATURE_SLOT = {
  header: null as string | null,
  algorithm: null as 'hmac-sha256' | null,
  failureMessage: 'Signature verification failed',
} as const;

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
    isFtd: z.boolean().default(false),
  })
  .strict();
export type DepositInput = z.infer<typeof depositInputSchema>;

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
