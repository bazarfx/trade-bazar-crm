import { ARK_OUTCOMES, type ArkOutcome } from '@crm/shared';
import type { ChipTone } from '@/components/ui';
import type { EventRow } from '@/app/(app)/settings/intake/_components/source-events-overlay';

/**
 * What one ARK event DID, as the events screen says it.
 *
 * Spec §7 names four outcomes — re-deposit on an existing deal, conversion,
 * sign-up without a deposit, a brand-new lead — and the worker writes which
 * one happened. This reads it back tolerantly: off an `outcome` field when
 * the API carries one, off the `error`/note column when the worker wrote it
 * there, and, for an older PROCESSED row that says neither, off what the
 * event produced. Anything unsettled or unsuccessful is named for its status.
 */

export type ArkOutcomeKey =
  | 'existing_deal_deposit'
  | 'converted'
  | 'signed_up'
  | 'new_lead'
  | 'ignored'
  | 'failed'
  | 'waiting'
  | 'processed';

export interface ArkOutcomeChip {
  key: ArkOutcomeKey;
  label: string;
  tone: ChipTone;
  title: string;
}

const BY_OUTCOME: Record<ArkOutcome, ArkOutcomeKey> = {
  REDEPOSIT: 'existing_deal_deposit',
  CONVERTED: 'converted',
  SIGNED_UP: 'signed_up',
  NEW_LEAD: 'new_lead',
};

const CHIPS: Record<ArkOutcomeKey, Omit<ArkOutcomeChip, 'key'>> = {
  existing_deal_deposit: {
    label: 'existing deal · deposit',
    tone: 'success',
    title: 'Matched an existing deal: a deposit row was added and the totals recomputed. No new deal.',
  },
  converted: {
    label: 'converted',
    tone: 'success',
    title: 'Matched a lead with a deposit present: the deal was created and the lead moved to the Converted tag.',
  },
  signed_up: {
    label: 'signed up',
    tone: 'info',
    title: 'Matched a lead, account only: the account number was filled and the lead moved to the Signed Up tag.',
  },
  new_lead: {
    label: 'new lead',
    tone: 'warning',
    title: 'Matched nothing: a new lead was created with source ARK Terminal and routed to the senior pool.',
  },
  ignored: {
    label: 'ignored',
    tone: 'neutral',
    title: 'Stored but deliberately not acted on — the reason is on the row.',
  },
  failed: {
    label: 'failed',
    tone: 'error',
    title: 'Stored, but could not be processed — read the reason, fix the mapping, replay.',
  },
  waiting: {
    label: 'waiting',
    tone: 'info',
    title: 'Queued for the worker; nothing has been decided yet.',
  },
  processed: {
    label: 'processed',
    tone: 'success',
    title: 'Processed; the event record does not say which of the four outcomes applied.',
  },
};

function asOutcome(value: unknown): ArkOutcome | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return (ARK_OUTCOMES as readonly string[]).includes(upper) ? (upper as ArkOutcome) : null;
}

export function outcomeOf(event: EventRow): ArkOutcomeChip {
  const explicit = asOutcome(event.outcome) ?? (event.status === 'PROCESSED' ? asOutcome(event.error) : null);
  let key: ArkOutcomeKey;
  if (explicit !== null) {
    key = BY_OUTCOME[explicit];
  } else if (event.status === 'FAILED') {
    key = 'failed';
  } else if (event.status === 'IGNORED') {
    key = 'ignored';
  } else if (event.status === 'PROCESSED') {
    // Inferred from what the event produced. A deal AND a lead id is the
    // conversion moment; a deal alone is a re-deposit; a lead alone could be
    // either of the two lead outcomes, so it stays "processed" rather than
    // guessing.
    const dealId = event.dealId ?? null;
    const leadId = event.leadId ?? event.recordId ?? null;
    key = dealId && leadId ? 'converted' : dealId ? 'existing_deal_deposit' : 'processed';
  } else {
    key = 'waiting';
  }
  return { key, ...CHIPS[key] };
}
