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

/**
 * On DEPOSIT_RECEIVED: this deposit was REFUSED as a duplicate, not banked.
 *
 * The most important line the ledger writes. Where ARK sends neither its own
 * reference nor a timestamp, a genuine second identical deposit and a
 * redelivery are the same bytes, and suppressing is a judgement call that can
 * be wrong. Logging it with the amount is what keeps that call reviewable: a
 * reconciliation against ARK's statement lands on this entry instead of on
 * silence.
 */
export const DEPOSIT_SUPPRESSED_KEY = '_duplicateSuppressed';

/** On a suppressed DEPOSIT_RECEIVED: the key the ledger matched on, so an
 *  operator can see WHICH rule refused it — ARK's reference, the deposit's
 *  facts, or the raw body. */
export const DEPOSIT_DEDUPE_KEY = '_dedupeKey';
