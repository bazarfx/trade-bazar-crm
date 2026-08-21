'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  DuplicateFlagDto,
  DuplicateQueueDto,
  DuplicateQueueFieldDto,
  DuplicateResolution,
} from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, Chip, Panel, type ChipTone } from '@/components/ui';
import { cn } from '@/components/ui/button';
import { api } from '@/lib/client-api';
import { renderValue } from '@/app/(app)/[moduleSlug]/[recordId]/_components/value';
import { absoluteTime, relativeTime } from '@/app/(app)/[moduleSlug]/[recordId]/_components/time';
import type { StatusOption } from './cell';
import { nameMap, useDirectory } from './directory';

/**
 * The duplicate review queue (spec §6.6): flagged pairs side by side, resolved
 * one decision at a time. Full screen, like everything else in this product.
 *
 * Three things this screen will never do:
 *
 *  - **Merge.** There is no auto-merge in this product and none may be built.
 *    "Mark as merged" records that a PERSON already copied what they needed
 *    onto the record they keep — through the ordinary edit form, where every
 *    change lands on the timeline — and the button only writes that decision.
 *  - **Block.** Both records already exist; the engine created the new one and
 *    flagged the pair. Nothing here deletes, locks or hides either record.
 *  - **Know it is Leads.** The pair's fields come from the API per module, the
 *    labels from `FieldDefinition`, the chips from `Status` — an Admin-created
 *    module whose storage supports flags gets this queue for free.
 */

/** `matchReason` as the record engine writes it, said in words. A reason this
 *  build has never seen still renders — as itself, not as a blank. */
const MATCH_COPY: Record<string, string> = {
  phone: 'Same phone number',
  name_language: 'Same name and language',
};

const CONFIDENCE_TONE: Record<string, ChipTone> = {
  HIGH: 'error',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

export interface ReviewQueueOverlayProps {
  slug: string;
  /** module.label — SINGULAR, what one of these records is called. */
  label: string;
  labelPlural: string;
  statuses: StatusOption[];
  /** One pair was settled — the toolbar count comes down by one. */
  onResolved: () => void;
  onClose: () => void;
}

interface QueueState {
  flags: DuplicateFlagDto[];
  fields: DuplicateQueueFieldDto[];
  /** PENDING pairs in the module, not just the page on screen. */
  total: number;
}

/** Values compare as their serialised JSON — the same equality the audit
 *  logger's diff uses, so "differs" here means what the timeline would say. */
function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

export function ReviewQueueOverlay({
  slug,
  label,
  labelPlural,
  statuses,
  onResolved,
  onClose,
}: ReviewQueueOverlayProps) {
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** which pair a resolve is in flight for, and which decision was clicked */
  const [busy, setBusy] = useState<{ flagId: string; resolution: DuplicateResolution } | null>(null);
  const [pairErrors, setPairErrors] = useState<Record<string, string>>({});
  /** bumped to refetch — used when the page on screen is worked down */
  const [fetchToken, setFetchToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Always page 1: resolving removes pairs from the PENDING set, so the
    // first page IS the next batch — a page cursor would skip over pairs.
    api<DuplicateQueueDto>(`/api/modules/${slug}/duplicates?status=PENDING&page=1`)
      .then((res) => {
        if (cancelled) return;
        setQueue({ flags: res.flags, fields: res.fields, total: res.total });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'The review queue could not be loaded.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, fetchToken]);

  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  // Owner and any other USER_LOOKUP field store an id; resolve names once for
  // the whole queue rather than printing UUIDs beside every pair.
  const hasUserField = (queue?.fields ?? []).some((f) => f.type === 'USER_LOOKUP');
  const directory = useDirectory(hasUserField);
  const userNames = useMemo(() => nameMap(directory.users), [directory.users]);

  // Seeded once on mount; "flagged 3 hours ago" does not need a live tick.
  const [nowMs] = useState(() => Date.now());

  function resolve(flag: DuplicateFlagDto, resolution: DuplicateResolution) {
    setBusy({ flagId: flag.id, resolution });
    setPairErrors((prev) => {
      const next = { ...prev };
      delete next[flag.id];
      return next;
    });

    api<{ flag: DuplicateFlagDto }>(
      `/api/modules/${slug}/duplicates/${flag.id}/resolve`,
      { method: 'POST', body: JSON.stringify({ resolution }) },
    )
      .then(() => {
        setBusy(null);
        setQueue((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                flags: prev.flags.filter((f) => f.id !== flag.id),
                total: Math.max(0, prev.total - 1),
              },
        );
        onResolved();
      })
      .catch((err: unknown) => {
        setBusy(null);
        setPairErrors((prev) => ({
          ...prev,
          [flag.id]: err instanceof Error ? err.message : 'The decision could not be recorded.',
        }));
      });
  }

  const flags = queue?.flags ?? [];
  const fields = queue?.fields ?? [];
  const remaining = queue?.total ?? 0;

  return (
    <FullScreenOverlay
      title={`Review duplicates — ${labelPlural}`}
      onClose={onClose}
      trackPrefix={`${slug}.review`}
    >
      <div className="mx-auto max-w-6xl px-8 py-8">
        <p className="text-sm text-body">
          Each pair below was created and flagged by the system — nothing was blocked and nothing
          was merged. Decide per pair: <strong className="font-medium text-heading">Keep both</strong>{' '}
          when they are genuinely two different {labelPlural.toLowerCase()},{' '}
          <strong className="font-medium text-heading">Dismiss</strong> when the match is a false
          alarm, or <strong className="font-medium text-heading">Mark as merged</strong> after you
          have copied everything you need onto the record you are keeping. Merging is manual on
          purpose: edit the record you keep first, then record the decision here — every decision
          lands on both records&apos; timelines.
        </p>

        {error !== null ? (
          <p role="alert" className="mt-6 rounded border border-error bg-surface px-4 py-3 text-sm text-error">
            {error}
          </p>
        ) : null}

        {loading ? (
          <p role="status" className="mt-6 text-sm text-body">
            Loading flagged pairs…
          </p>
        ) : null}

        {!loading && error === null && flags.length === 0 ? (
          <p role="status" className="mt-6 text-sm text-body">
            {remaining === 0
              ? 'Nothing to review — every flagged pair has been resolved.'
              : // The page on screen was worked down but more PENDING pairs
                // exist beyond it; the refetch pulls the next batch.
                `${remaining} more flagged ${remaining === 1 ? 'pair' : 'pairs'} to review.`}
          </p>
        ) : null}

        {!loading && flags.length === 0 && remaining > 0 ? (
          <Button
            className="mt-3"
            variant="secondary"
            onClick={() => setFetchToken((n) => n + 1)}
            data-track={`${slug}.review.loadmore`}
          >
            Load the next {Math.min(remaining, 20)} pairs
          </Button>
        ) : null}

        {flags.length > 0 && remaining > flags.length ? (
          <p className="mt-4 text-xs text-body">
            Showing the first {flags.length} of {remaining} pending pairs — resolving these loads
            the next batch.
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-6">
          {flags.map((flag) => (
            <PairCard
              key={flag.id}
              slug={slug}
              label={label}
              flag={flag}
              fields={fields}
              statusById={statusById}
              userNames={userNames}
              nowMs={nowMs}
              busy={busy?.flagId === flag.id ? busy.resolution : null}
              anyBusy={busy !== null}
              problem={pairErrors[flag.id] ?? null}
              onResolve={(resolution) => resolve(flag, resolution)}
            />
          ))}
        </div>
      </div>
    </FullScreenOverlay>
  );
}

// ── one flagged pair ───────────────────────────────────────────────────────

interface PairCardProps {
  slug: string;
  label: string;
  flag: DuplicateFlagDto;
  fields: DuplicateQueueFieldDto[];
  statusById: Map<string, StatusOption>;
  userNames: Map<string, string>;
  nowMs: number;
  /** the decision in flight for THIS pair, or null */
  busy: DuplicateResolution | null;
  /** a decision is in flight somewhere — all actions hold still */
  anyBusy: boolean;
  problem: string | null;
  onResolve: (resolution: DuplicateResolution) => void;
}

function PairCard({
  slug,
  label,
  flag,
  fields,
  statusById,
  userNames,
  nowMs,
  busy,
  anyBusy,
  problem,
  onResolve,
}: PairCardProps) {
  const primary = flag.primary;
  const candidate = flag.candidate;

  // Rows where both sides are empty carry no signal; a 30-field module would
  // otherwise bury the six rows that matter. They are counted, not hidden —
  // the reader is told exactly what was left out.
  const rows = fields.filter(
    (f) => !(isEmpty(primary?.values[f.key]) && isEmpty(candidate?.values[f.key])),
  );
  const skipped = fields.length - rows.length;
  const differing = rows.filter((f) =>
    differs(primary?.values[f.key], candidate?.values[f.key]),
  ).length;

  const matchCopy = MATCH_COPY[flag.matchReason] ?? flag.matchReason;
  const confidenceTone = CONFIDENCE_TONE[flag.confidence] ?? 'neutral';
  // The rows the engine decided the match on, named by the server from the
  // module's own field definitions — never "the field called phone".
  const matched = new Set(flag.matchedFieldKeys);

  return (
    <Panel className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-4">
        <Chip tone={confidenceTone}>{matchCopy}</Chip>
        <Chip tone="neutral">{flag.confidence} confidence</Chip>
        <span className="text-xs text-body" title={absoluteTime(flag.createdAt)}>
          flagged {relativeTime(flag.createdAt, nowMs)}
        </span>
        {differing > 0 && primary !== null && candidate !== null ? (
          <span className="text-xs text-body">
            · {differing} {differing === 1 ? 'field differs' : 'fields differ'}
          </span>
        ) : null}
      </div>

      {primary === null || candidate === null ? (
        <p className="border-b border-border bg-background px-6 py-3 text-xs text-body">
          {primary === null && candidate === null
            ? 'Neither record is visible to you — both are outside your view scope or were deleted.'
            : `The ${primary === null ? 'new' : 'existing'} record is outside your view scope or was
               deleted, so its values cannot be shown here.`}
        </p>
      ) : null}

      {/* The comparison scrolls inside its own container — long values must
          never make the page scroll sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="w-48 px-6 py-3 text-xs font-medium text-body">Field</th>
              <SideHeader
                slug={slug}
                label={label}
                caption="New record"
                side={primary}
                track={`${slug}.review.record.open`}
              />
              <SideHeader
                slug={slug}
                label={label}
                caption="Existing record"
                side={candidate}
                track={`${slug}.review.record.open`}
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((field) => {
              const a = primary?.values[field.key];
              const b = candidate?.values[field.key];
              const changed = primary !== null && candidate !== null && differs(a, b);
              const isMatch = matched.has(field.key);
              return (
                <tr
                  key={field.key}
                  data-match={isMatch ? 'true' : undefined}
                  className={cn(
                    'border-b border-border',
                    // The highlight is a background, not a colour on the text:
                    // the values themselves must stay exactly as every other
                    // screen renders them.
                    changed && 'bg-subtle',
                    // The matched row is the reason this pair exists, so it
                    // carries the same tone as the reason chip above it — a
                    // left rule plus a "Match" chip beside the label.
                    isMatch && 'bg-subtle shadow-[inset_2px_0_0_0_theme(colors.error)]',
                  )}
                >
                  <td className="max-w-48 px-6 py-2.5 text-xs font-medium text-heading" title={field.label}>
                    <span className="flex items-center gap-2">
                      <span className="truncate">{field.label}</span>
                      {isMatch ? <Chip tone={confidenceTone}>Match</Chip> : null}
                    </span>
                  </td>
                  <ValueCell
                    field={field}
                    value={a}
                    present={primary !== null}
                    statusById={statusById}
                    userNames={userNames}
                    emphasise={changed}
                  />
                  <ValueCell
                    field={field}
                    value={b}
                    present={candidate !== null}
                    statusById={statusById}
                    userNames={userNames}
                    emphasise={changed}
                  />
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-6 py-4 text-sm text-body">
                  There are no field values to compare on this pair.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {skipped > 0 ? (
        <p className="border-t border-border px-6 py-2 text-xs text-body">
          {skipped} {skipped === 1 ? 'field that is' : 'fields that are'} empty on both records{' '}
          {skipped === 1 ? 'is' : 'are'} not shown.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-border bg-background px-6 py-4">
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'KEPT_BOTH'}
          disabled={anyBusy}
          onClick={() => onResolve('KEPT_BOTH')}
          data-track={`${slug}.review.keepboth`}
        >
          Keep both
        </Button>
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'MERGED'}
          disabled={anyBusy}
          onClick={() => onResolve('MERGED')}
          data-track={`${slug}.review.merged`}
        >
          Mark as merged
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={busy === 'DISMISSED'}
          disabled={anyBusy}
          onClick={() => onResolve('DISMISSED')}
          data-track={`${slug}.review.dismiss`}
        >
          Dismiss
        </Button>
        <p className="min-w-0 flex-1 text-xs text-body">
          &quot;Mark as merged&quot; only records the decision — copy anything you need onto the{' '}
          {label.toLowerCase()} you are keeping <em>first</em>, through its own edit form. Nothing
          is merged automatically.
        </p>
      </div>

      {problem !== null ? (
        <p role="alert" className="border-t border-border px-6 py-3 text-xs text-error">
          {problem}
        </p>
      ) : null}
    </Panel>
  );
}

interface SideHeaderProps {
  slug: string;
  label: string;
  caption: string;
  side: { id: string; values: Record<string, unknown> } | null;
  track: string;
}

function SideHeader({ slug, label, caption, side, track }: SideHeaderProps) {
  return (
    <th className="px-4 py-3 text-xs font-medium text-body">
      <span className="inline-flex items-center gap-2">
        {caption}
        {side !== null ? (
          <Link
            href={`/${slug}/${side.id}`}
            className="font-medium text-primary hover:underline"
            title={`Open this ${label.toLowerCase()} in its own page`}
            data-track={track}
          >
            Open →
          </Link>
        ) : null}
      </span>
    </th>
  );
}

interface ValueCellProps {
  field: DuplicateQueueFieldDto;
  value: unknown;
  /** false when this whole side is out of scope — the cell says nothing. */
  present: boolean;
  statusById: Map<string, StatusOption>;
  userNames: Map<string, string>;
  emphasise: boolean;
}

function ValueCell({ field, value, present, statusById, userNames, emphasise }: ValueCellProps) {
  if (!present) {
    return <td className="px-4 py-2.5 text-sm text-body">—</td>;
  }
  return (
    <td className={emphasise ? 'px-4 py-2.5 text-sm font-medium text-heading' : 'px-4 py-2.5 text-sm text-body'}>
      {renderValue({ field, value, statusById, userNameById: userNames })}
    </td>
  );
}
