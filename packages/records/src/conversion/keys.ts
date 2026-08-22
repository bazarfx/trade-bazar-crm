/**
 * The non-field keys the conversion service writes into `AuditLog.changes`.
 *
 * Underscore-prefixed for the reason `ASSIGNMENT_REASON_KEY` is: every other
 * key in a diff is a field key, an Admin can create a field labelled "Deal"
 * or "Amount" tomorrow, and `fieldKeyFromLabel` strips leading underscores
 * — so none of these can ever collide with a field that exists or one
 * invented later. The timeline humanises them ("Deal", "Amount") and the
 * hidden-field strip leaves them alone, so a reader who may not see the
 * Owner field still reads that a conversion happened.
 */

/** On the CONVERTED entry written to the originating record: the deal it became. */
export const CONVERTED_DEAL_KEY = '_deal';

/** On CONVERTED and DEPOSIT_RECEIVED: the raw `WebhookEvent` that caused it,
 *  so any line on the timeline can be traced back to its stored payload. */
export const WEBHOOK_EVENT_KEY = '_webhookEvent';

/** On DEPOSIT_RECEIVED: the ledger row's own amount and time. Not deal
 *  fields — a deposit is a row, not a column — hence not field keys. */
export const DEPOSIT_AMOUNT_KEY = '_amount';
export const DEPOSIT_AT_KEY = '_depositedAt';
export const DEPOSIT_FTD_KEY = '_firstDeposit';
