import { STATUS_TAGS, type StatusTagValue } from './config.js';

/**
 * One person's WORKLOAD — what they are carrying and what they have closed.
 *
 * Deliberately not "a teleseller's dashboard". The question these shapes
 * answer is structural: for every module whose table carries an OWNER, how
 * many of its records point at this person, and how do those records break
 * down by what their status MEANS. A module an Admin creates next year with
 * an owner column answers it too, with no change here and none in the UI —
 * which is the whole test of the record engine.
 *
 * Defined once in `packages/shared` so the query, the route and the panel
 * cannot disagree about the contract.
 */

/**
 * A module this person owns records in.
 *
 * `label` / `labelPlural` are the ADMIN's own words for the module, carried
 * with the numbers so no screen has to look them up — and so a rename shows
 * up here immediately instead of leaving a stale caption in the UI.
 */
export interface WorkloadModule {
  slug: string;
  label: string;
  labelPlural: string;
  /**
   * Every record of this module owned by this person, within the READER's
   * scope. Two people opening the same page can legitimately see different
   * totals: the count is what that reader would get from the list screen.
   */
  total: number;
  /**
   * The pipeline, folded onto the status TAG — never onto a status name,
   * because names are Admin-editable and a report keyed on one breaks the
   * afternoon someone renames "Interested" (CLAUDE.md).
   *
   * Always complete: every tag in `STATUS_TAGS` is present, zero when
   * nothing sits on it, so a reader never guards for a missing key.
   *
   * The tag counts can sum to LESS than `total`: a record with no status
   * set, or one whose status row has been hard-removed, is still that
   * person's work but belongs to no tag.
   */
  byTag: Record<StatusTagValue, number>;
  /**
   * Whether this module's storage carries a status at all. False means
   * `byTag` is all zeros because there is no pipeline here, not because the
   * pipeline is empty — the difference decides whether a breakdown is worth
   * drawing.
   */
  hasStatuses: boolean;
}

/**
 * PERMANENT CREDIT for a conversion (spec §7.1: "the telesales agent who
 * owned the lead at conversion. Immutable. Permanent credit — this is what
 * performance reports count").
 *
 * Deliberately NOT the same question as ownership: a deal transferred to
 * back-office tomorrow still counts for whoever closed it, and will not
 * appear in that person's `owns` entry for the same module.
 */
export interface ClosedCredit {
  slug: string;
  label: string;
  labelPlural: string;
  count: number;
  /**
   * Sum of the ledger total across those records, as EXACT DECIMAL DIGITS in
   * a string. Money never round-trips through a JavaScript number: 0.1 + 0.2
   * is not a figure anyone can reconcile against a bank statement.
   *
   * Null when the module declares no ledger, and null when the reader's role
   * hides the field that total is stored in — an aggregate is a read of that
   * field, so the matrix governs it too.
   */
  ledgerTotal: string | null;
}

export interface PersonWorkload {
  /** modules this person owns records in, in the Admin's nav order */
  owns: WorkloadModule[];
  /** modules that record who CLOSED a record, crediting this person */
  closed: ClosedCredit[];
  /** when these numbers were counted — they are a snapshot, not a live feed */
  generatedAt: string;
}

/**
 * A complete tag histogram at zero.
 *
 * Built here rather than at each call site so the "every tag is always
 * present" promise above has exactly one implementation, and so adding a tag
 * to `STATUS_TAGS` fills it in everywhere at once.
 */
export function emptyTagCounts(): Record<StatusTagValue, number> {
  const counts = {} as Record<StatusTagValue, number>;
  for (const tag of STATUS_TAGS) counts[tag] = 0;
  return counts;
}
