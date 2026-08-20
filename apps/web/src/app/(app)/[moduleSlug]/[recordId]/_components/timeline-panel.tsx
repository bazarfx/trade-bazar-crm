'use client';

import { useEffect, useMemo, useState } from 'react';
import type { StatusOption } from '@/app/(app)/[moduleSlug]/_components/cell';
import { Button, cn, Panel, PanelBody, PanelHeader } from '@/components/ui';
import { api } from '@/lib/client-api';
import { changeEntries, humanise } from './changes';
import { absoluteTime, relativeTime } from './time';
import { renderValue, valueTooltip, type DetailField } from './value';

/**
 * The timeline — the centre of the record screen (spec §6.5).
 *
 * It renders `AuditLog` for this record and nothing else: there is no timeline
 * table and there must never be one (invariant 2). Every line here is a row
 * the record engine wrote inside the same transaction as the change it
 * describes, which is why "created", "moved the status" and "updated Phone"
 * can be trusted as an account of what happened.
 *
 * The wording is the point. A floor manager reads this without training, so
 * nothing renders as a raw enum, a field KEY or a bare uuid.
 */

/**
 * Structurally identical to `TimelineEntry` from the record service,
 * redeclared here so a client module never imports from a `server-only` file
 * — a type-only import still puts that file in the bundler's resolution graph.
 */
export interface TimelineRow {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  changes: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Plain language per action. Keyed on the ACTION, which is a fixed vocabulary
 * in the schema — never on a module, a status name or a field label, all three
 * of which are Admin-editable data.
 *
 * FIELD_CHANGED is absent on purpose: its sentence carries the field's label,
 * so it is composed below rather than looked up.
 */
const ACTION_COPY: Record<string, string> = {
  RECORD_CREATED: 'created this record',
  RECORD_UPDATED: 'updated this record',
  RECORD_DELETED: 'deleted this record',
  RECORD_RESTORED: 'restored this record',
  STATUS_CHANGED: 'moved the status',
  ASSIGNED: 'set the owner',
  REASSIGNED: 'changed the owner',
  OWNERSHIP_TRANSFERRED: 'transferred ownership',
  DEPOSIT_RECEIVED: 'recorded a deposit',
  CONVERTED: 'converted this record',
  NOTE_ADDED: 'added a note',
  CALL_LOGGED: 'logged a call',
  IMPORTED: 'imported this record',
  WEBHOOK_RECEIVED: 'received an update from a webhook',
  DUPLICATE_FLAGGED: 'flagged as a possible duplicate',
  DUPLICATE_RESOLVED: 'resolved the duplicate review',
  CONFIG_CHANGED: 'changed the configuration',
};

/**
 * A system actor has no user row, so `actorName` is null by design — and a
 * blank name on a webhook-written line is exactly how a timeline stops being
 * evidence. Every `SYSTEM_*` actor type names itself here.
 */
const SYSTEM_ACTOR: Record<string, string> = {
  SYSTEM_ARK_WEBHOOK: 'System (ARK Webhook)',
  SYSTEM_ROUND_ROBIN: 'System (Round Robin)',
  SYSTEM_IMPORT: 'System (Import)',
  SYSTEM_CAMPAIGN_INTAKE: 'System (Campaign Intake)',
};

const SYSTEM_PREFIX = 'SYSTEM_';

function actorLabel(entry: TimelineRow): string {
  if (entry.actorType.startsWith(SYSTEM_PREFIX)) {
    // A system actor type added after this build shipped still renders as an
    // identity rather than as a blank: "System (Ark Webhook)" beats nothing.
    return SYSTEM_ACTOR[entry.actorType] ?? `System (${humanise(entry.actorType.slice(SYSTEM_PREFIX.length))})`;
  }
  // `AuditLog.actorId` is SetNull on user delete; the entry survives, the name
  // does not. Naming that state is more honest than an empty span.
  return entry.actorName ?? 'A user no longer in the system';
}

export interface TimelinePanelProps {
  slug: string;
  recordId: string;
  entries: TimelineRow[];
  nextCursor: string | null;
  /** the module's live fields, for turning a diff KEY into its label */
  fields: DetailField[];
  statuses: StatusOption[];
  userNames: [string, string][];
  /** the server's clock at render time — see ./time.ts */
  nowIso: string;
  hasTimeline: boolean;
  className?: string;
}

export function TimelinePanel({
  slug,
  recordId,
  entries,
  nextCursor,
  fields,
  statuses,
  userNames,
  nowIso,
  hasTimeline,
  className,
}: TimelinePanelProps) {
  const [rows, setRows] = useState<TimelineRow[]>(entries);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A quick action PATCHes and calls router.refresh(), which re-renders the
  // server component and hands down a fresh newest page. Adopting it — and
  // dropping pages loaded by hand — is what makes the status change the reader
  // just made appear at the top of the log immediately.
  useEffect(() => {
    setRows(entries);
    setCursor(nextCursor);
  }, [entries, nextCursor]);

  // Seeded with the SERVER's clock so the first client render is identical to
  // the SSR output, then corrected on mount and ticked while the page is open.
  const [nowMs, setNowMs] = useState(() => Date.parse(nowIso));
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const userNameById = useMemo(() => new Map(userNames), [userNames]);

  /** A diff key as a person reads it: the field's LABEL, never its key. */
  function labelFor(key: string): string {
    return fieldByKey.get(key)?.label ?? humanise(key);
  }

  function phraseFor(entry: TimelineRow): string {
    if (entry.action === 'FIELD_CHANGED') {
      // The engine writes one entry per changed field, so there is exactly one
      // key here — but an older row with none still has to say something.
      const first = changeEntries(entry.changes)[0];
      return first ? `updated ${labelFor(first[0])}` : 'updated a field';
    }
    return ACTION_COPY[entry.action] ?? humanise(entry.action).toLowerCase();
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ entries: TimelineRow[]; nextCursor: string | null }>(
        `/api/modules/${slug}/records/${recordId}/timeline?cursor=${encodeURIComponent(cursor)}`,
      );
      setRows((prev) => [...prev, ...res.entries]);
      setCursor(res.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more of the timeline');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel className={cn('flex flex-col overflow-hidden', className)}>
      <PanelHeader title="Timeline" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelBody>
          {!hasTimeline ? (
            <p className="text-sm text-body">This module does not keep a timeline.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-body">
              Nothing has happened to this record yet. Every change, assignment and status move
              lands here as it happens.
            </p>
          ) : (
            <ol className="flex flex-col">
              {rows.map((entry) => {
                // RECORD_CREATED carries the whole opening snapshot as
                // `null -> value` for every field. That is the record itself,
                // which the information panel is already showing — rendering
                // it again would bury every later line under 30 rows.
                const diffs = entry.action === 'RECORD_CREATED' ? [] : changeEntries(entry.changes);
                const showLabels = diffs.length > 1;

                return (
                  <li
                    key={entry.id}
                    // The rail is the border; the dot sits on it. Last-child
                    // drops the rail so the log does not trail into nothing.
                    className="relative border-l border-border pb-5 pl-5 last:border-transparent last:pb-0"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute -left-1 top-1.5 h-2 w-2 rounded-pill bg-border"
                    />

                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 text-sm text-body">
                        <span className="font-medium text-heading">{actorLabel(entry)}</span>{' '}
                        {phraseFor(entry)}
                      </p>
                      <time
                        dateTime={entry.createdAt}
                        title={absoluteTime(entry.createdAt)}
                        className="shrink-0 text-xs text-muted"
                      >
                        {relativeTime(entry.createdAt, nowMs)}
                      </time>
                    </div>

                    {diffs.length > 0 ? (
                      <dl className="mt-1.5 flex flex-col gap-1">
                        {diffs.map(([key, pair]) => {
                          const field = fieldByKey.get(key);
                          const from = { field, value: pair.from, statusById, userNameById };
                          const to = { field, value: pair.to, statusById, userNameById };
                          return (
                            <div key={key} className="flex min-w-0 items-center gap-2 text-xs">
                              {/* Always rendered, hidden when the sentence
                                  above already names the field: a <dd> with no
                                  <dt> is not a description list, and a screen
                                  reader would announce two bare values. */}
                              <dt
                                className={showLabels ? 'shrink-0 truncate text-body' : 'sr-only'}
                                title={labelFor(key)}
                              >
                                {labelFor(key)}
                              </dt>
                              <dd className="flex min-w-0 items-center gap-2">
                                <span className="min-w-0 truncate text-body" title={valueTooltip(from)}>
                                  {renderValue(from)}
                                </span>
                                {/* The arrow is decoration; the direction is
                                    read out for assistive tech instead. */}
                                <span aria-hidden="true" className="shrink-0 text-muted">
                                  →
                                </span>
                                <span className="sr-only">changed to</span>
                                <span
                                  className="min-w-0 truncate font-medium text-heading"
                                  title={valueTooltip(to)}
                                >
                                  {renderValue(to)}
                                </span>
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}

          {error !== null ? (
            <p role="alert" className="mt-4 rounded bg-error/10 px-3 py-2 text-xs text-error">
              {error}
            </p>
          ) : null}

          {cursor !== null ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={loading}
                onClick={() => void loadMore()}
                data-track={`${slug}.timeline.loadmore`}
              >
                {loading ? 'Loading…' : 'Load older entries'}
              </Button>
            </div>
          ) : null}
        </PanelBody>
      </div>
    </Panel>
  );
}
