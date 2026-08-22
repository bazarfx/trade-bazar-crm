'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  REPLAYABLE_STATUSES,
  WEBHOOK_STATUSES,
  type WebhookStatusValue,
} from '@crm/shared';
import { FullScreenOverlay } from '@/components/overlay/full-screen-overlay';
import { Button, Chip, cn, Panel, Select, type ChipTone } from '@/components/ui';
import { api } from '@/lib/client-api';
import { absoluteTime, relativeTime } from '@/app/(app)/[moduleSlug]/[recordId]/_components/time';

/**
 * One source's event log — where the unknown payload becomes known.
 *
 * Every inbound call was stored RAW before anything parsed it (the endpoint's
 * first act), so this list is complete by construction: a payload the mapping
 * could not digest is a FAILED row whose body is right here to read, and
 * Replay re-runs it through the CURRENT mapping. That loop — receive, fail,
 * read, map, replay — is the whole plan for connecting a platform nobody has
 * seen the payloads of yet.
 *
 * Shared between campaign intake and the ARK pipeline: the log, the filter,
 * the pager and Replay are identical, and an event is an event. What differs
 * — the API the log lives under, what an event PRODUCED and how to say it —
 * comes in as props, with intake's behaviour as the defaults.
 */

const STATUS_TONE: Record<WebhookStatusValue, ChipTone> = {
  RECEIVED: 'info',
  PROCESSED: 'success',
  FAILED: 'error',
  REPLAYED: 'warning',
  IGNORED: 'neutral',
};

/**
 * An event row, typed defensively: the events APIs are built beside this
 * screen, so the payload travels under whichever of the two honest names it
 * ships with (`raw` is the column, `payload` the contract) and the produced
 * record ids under `leadId`/`recordId`/`dealId`. Tolerance here beats a
 * blank screen the week the halves land.
 */
export interface EventRow {
  id: string;
  status: string;
  error?: string | null;
  /** the ARK worker's outcome, when the API carries it as its own field */
  outcome?: string | null;
  raw?: unknown;
  payload?: unknown;
  createdAt?: string;
  receivedAt?: string;
  processedAt?: string | null;
  replayCount?: number;
  leadId?: string | null;
  recordId?: string | null;
  dealId?: string | null;
}

export function payloadOf(event: EventRow): unknown {
  return event.payload ?? event.raw ?? null;
}

function receivedAtOf(event: EventRow): string | null {
  return event.receivedAt ?? event.createdAt ?? null;
}

export function createdRecordId(event: EventRow): string | null {
  return event.leadId ?? event.recordId ?? null;
}

/** Above this many characters the pretty JSON starts collapsed. */
const PREVIEW_LIMIT = 700;

export interface EventLink {
  href: string;
  label: string;
  track: string;
}

/** What the overlay needs to know about the source whose log it shows. */
export interface EventsSource {
  id: string;
  name: string;
  /** the module the source creates records in, for the default record link */
  moduleSlug: string | null;
}

export interface SourceEventsOverlayProps {
  source: EventsSource;
  onClose: () => void;
  /** the API the log lives under — `/api/webhook-sources/<id>` by default */
  endpointBase?: string;
  trackPrefix?: string;
  intro?: ReactNode;
  /** extra chips beside the status chip — the ARK outcome, say */
  decorate?: (event: EventRow) => ReactNode;
  /** doors to what the event produced; defaults to the created record */
  links?: (event: EventRow) => EventLink[];
  /** an event to open and highlight on first render (a deep link) */
  focusEventId?: string | null;
  /**
   * Which statuses offer Replay. Intake's by default; ARK's include
   * PROCESSED because its pipeline is idempotent on the event (a processed
   * intake event replayed would create a second lead; a processed ARK event
   * replayed creates nothing).
   */
  replayableStatuses?: readonly string[];
  /** When the log carries a per-event outcome, the values to filter by (`?outcome=`). */
  outcomeOptions?: readonly { value: string; label: string }[];
}

const DEFAULT_INTRO =
  'Every call this source has ever received, stored raw before anything parsed it. A failed ' +
  'event is not a lost lead: read its payload here, fix the mapping, then replay it through ' +
  'the current mapping.';

export function SourceEventsOverlay({
  source,
  onClose,
  endpointBase = `/api/webhook-sources/${source.id}`,
  trackPrefix = 'settings.intake.events',
  intro = DEFAULT_INTRO,
  decorate,
  links,
  focusEventId = null,
  replayableStatuses = REPLAYABLE_STATUSES,
  outcomeOptions,
}: SourceEventsOverlayProps) {
  const [status, setStatus] = useState<'' | WebhookStatusValue>('');
  const [outcome, setOutcome] = useState('');
  const [page, setPage] = useState(1);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayErrors, setReplayErrors] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(focusEventId === null ? [] : [focusEventId]),
  );
  /** bumped after a replay so the list re-reads with fresh statuses */
  const [fetchToken, setFetchToken] = useState(0);
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ page: String(page) });
    if (status !== '') query.set('status', status);
    if (outcome !== '') query.set('outcome', outcome);

    api<{ events: EventRow[]; total: number }>(`${endpointBase}/events?${query.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events);
        setTotal(res.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'The events could not be loaded.');
        setEvents([]);
        setTotal(0);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpointBase, status, outcome, page, fetchToken]);

  // A deep link lands on the row it named — once, after the first page is in.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || loading || focusRef.current === null) return;
    scrolled.current = true;
    focusRef.current.scrollIntoView({ block: 'center' });
  }, [loading]);

  // Seeded once — "received 2 hours ago" does not need a live tick here.
  const [nowMs] = useState(() => Date.now());

  const replayable = useMemo(() => new Set<string>(replayableStatuses), [replayableStatuses]);

  function replay(event: EventRow) {
    setReplayingId(event.id);
    setReplayErrors((prev) => {
      const next = { ...prev };
      delete next[event.id];
      return next;
    });
    api<{ ok: boolean }>(`${endpointBase}/events/${event.id}/replay`, { method: 'POST' })
      .then(() => {
        setReplayingId(null);
        setFetchToken((n) => n + 1);
      })
      .catch((err: unknown) => {
        setReplayingId(null);
        setReplayErrors((prev) => ({
          ...prev,
          [event.id]: err instanceof Error ? err.message : 'The replay could not be queued.',
        }));
      });
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function linksFor(event: EventRow): EventLink[] {
    if (links) return links(event);
    const recordId = createdRecordId(event);
    if (recordId === null || source.moduleSlug === null) return [];
    return [
      {
        href: `/${source.moduleSlug}/${recordId}`,
        label: 'Open created record →',
        track: `${trackPrefix}.record.open`,
      },
    ];
  }

  // Total pages are unknowable without the server's page size; what IS known
  // is whether anything came back and how many rows exist in all. The pager
  // stays honest about exactly that.
  const canGoNext = events.length > 0 && page * events.length < total;
  const focusMissing =
    focusEventId !== null && !loading && error === null && !events.some((e) => e.id === focusEventId);

  return (
    <FullScreenOverlay title={`Events — ${source.name}`} onClose={onClose} trackPrefix={trackPrefix}>
      <div className="mx-auto max-w-4xl px-8 py-8">
        <p className="text-sm text-body">{intro}</p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Select
            value={status}
            aria-label="Filter by status"
            className="w-44"
            onChange={(e) => {
              setStatus(e.target.value as '' | WebhookStatusValue);
              setPage(1);
            }}
            data-track={`${trackPrefix}.status.select`}
          >
            <option value="">All statuses</option>
            {WEBHOOK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
          {outcomeOptions !== undefined ? (
            <Select
              value={outcome}
              aria-label="Filter by outcome"
              className="w-52"
              onChange={(e) => {
                setOutcome(e.target.value);
                setPage(1);
              }}
              data-track={`${trackPrefix}.outcome.select`}
            >
              <option value="">All outcomes</option>
              {outcomeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          ) : null}
          <span className="text-xs text-body" role="status">
            {loading ? 'Loading…' : `${total} event${total === 1 ? '' : 's'}`}
          </span>
        </div>

        {error !== null ? (
          <p role="alert" className="mt-4 rounded border border-error bg-surface px-4 py-3 text-sm text-error">
            {error}
          </p>
        ) : null}

        {focusMissing ? (
          <p className="mt-4 rounded border border-border bg-background px-4 py-3 text-xs text-body">
            The event you followed a link to is not on this page — it is older, or filtered out.
          </p>
        ) : null}

        {!loading && error === null && events.length === 0 ? (
          <p className="mt-6 rounded border border-border bg-background px-4 py-6 text-sm text-body">
            {status === ''
              ? 'Nothing has arrived on this source yet. The moment the platform posts its first payload — mapped or not — it appears here.'
              : 'No events with this status.'}
          </p>
        ) : null}

        <div className="mt-4 flex flex-col gap-4">
          {events.map((event) => {
            const payload = payloadOf(event);
            const json = payload === null ? null : JSON.stringify(payload, null, 2);
            const isLong = json !== null && json.length > PREVIEW_LIMIT;
            const isOpen = expanded.has(event.id);
            const shown = json === null ? null : isLong && !isOpen ? `${json.slice(0, PREVIEW_LIMIT)}\n…` : json;
            const received = receivedAtOf(event);
            const statusValue = event.status as WebhookStatusValue;
            const focused = event.id === focusEventId;

            return (
              // The wrapper exists only to carry the scroll target: Panel is a
              // plain element wrapper and does not take a ref.
              <div key={event.id} ref={focused ? focusRef : undefined}>
              <Panel className={cn('overflow-hidden', focused && 'ring-2 ring-primary')}>
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
                  <Chip tone={STATUS_TONE[statusValue] ?? 'neutral'}>{event.status}</Chip>
                  {decorate ? decorate(event) : null}
                  {received !== null ? (
                    <span className="text-xs text-body" title={absoluteTime(received)}>
                      received {relativeTime(received, nowMs)}
                    </span>
                  ) : null}
                  {(event.replayCount ?? 0) > 0 ? (
                    <span className="text-xs text-body">· replayed {event.replayCount}×</span>
                  ) : null}
                  <div className="ml-auto flex items-center gap-3">
                    {linksFor(event).map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="text-xs font-medium text-primary hover:underline"
                        data-track={link.track}
                      >
                        {link.label}
                      </Link>
                    ))}
                    {replayable.has(event.status) ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={replayingId === event.id}
                        disabled={replayingId !== null}
                        onClick={() => replay(event)}
                        title="Re-run this stored payload through the current mapping."
                        data-track={`${trackPrefix}.replay`}
                      >
                        Replay
                      </Button>
                    ) : null}
                  </div>
                </div>

                {event.error ? (
                  <p className="border-b border-border bg-background px-5 py-2.5 text-xs text-error">
                    {event.error}
                  </p>
                ) : null}

                {shown !== null ? (
                  <div className="px-5 py-4">
                    <pre className="max-h-96 overflow-auto rounded border border-border bg-background p-3 font-mono text-xs leading-5 text-heading">
                      {shown}
                    </pre>
                    {isLong ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2"
                        onClick={() => toggleExpanded(event.id)}
                        data-track={`${trackPrefix}.payload.toggle`}
                      >
                        {isOpen ? 'Show less' : 'Show the full payload'}
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p className="px-5 py-4 text-xs text-body">This event carries no payload body.</p>
                )}

                {replayErrors[event.id] !== undefined ? (
                  <p role="alert" className="border-t border-border px-5 py-2.5 text-xs text-error">
                    {replayErrors[event.id]}
                  </p>
                ) : null}
              </Panel>
              </div>
            );
          })}
        </div>

        {(page > 1 || canGoNext) ? (
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={page === 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-track={`${trackPrefix}.page.prev`}
            >
              Previous
            </Button>
            <span className="text-xs text-body">Page {page}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canGoNext || loading}
              onClick={() => setPage((p) => p + 1)}
              data-track={`${trackPrefix}.page.next`}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </FullScreenOverlay>
  );
}
