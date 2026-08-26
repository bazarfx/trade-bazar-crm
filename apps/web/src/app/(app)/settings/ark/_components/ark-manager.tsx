'use client';

import { useEffect, useState } from 'react';
import { ARK_OUTCOMES, ARK_REPLAYABLE_STATUSES } from '@crm/shared';
import { Button, Chip, Panel } from '@/components/ui';
import { api } from '@/lib/client-api';
import { CopyField } from '@/app/(app)/settings/intake/_components/copy-field';
import {
  SourceEventsOverlay,
  createdRecordId,
  type EventLink,
  type EventRow,
} from '@/app/(app)/settings/intake/_components/source-events-overlay';
import { ArkMappingOverlay } from './ark-mapping-overlay';
import { outcomeOf } from './ark-outcome';
import {
  ARK_SIGNATURE_STATE,
  ArkSignatureOverlay,
  arkSignatureState,
  type ArkSignatureView,
} from './ark-signature-overlay';
import { ArkSourceCreateOverlay, type CreatedArkSource } from './ark-source-create-overlay';

/**
 * The ARK Terminal screen: the sources ARK posts account events into, and
 * the doors into the three overlays (create, mapping, events).
 *
 * Reads `/api/ark-sources` rather than the table: which `WebhookSource` rows
 * are ARK's is the conversion slice's own knowledge, and this screen is not
 * the place to encode it twice.
 *
 * REDECLARED wire types rather than imports from Prisma: this is a client
 * component, and `@crm/db` must never enter its resolution graph.
 */

export interface ArkSourceRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  /** `fieldMapping` as stored — the mapping editor parses it */
  mapping: unknown;
  /** the last raw payload this source received, or null before the first one */
  lastPayload: unknown;
  /**
   * How this source authenticates its caller, and whether a secret is set —
   * never the secret. Optional only so a response written before the
   * signature block existed still renders; `arkSignatureState` reads a
   * missing block as "token only", which is what such a source is.
   */
  signature?: ArkSignatureView;
  createdAt: string;
  /** the module an unmatched event creates a record in, when the API says */
  moduleSlug?: string | null;
  moduleLabel?: string | null;
  /** per-status event counts, when the API carries them */
  counts?: Record<string, number>;
}

/**
 * Where an event's products live, resolved by the page from the STORAGE
 * SHAPES (the module with a deposit ledger, and the one it inherits its
 * timeline from) — never from a slug typed here. Null when the conversion
 * path is not configured, in which case no record links are drawn.
 */
export interface ConversionModules {
  /** the module an unmatched event creates a record in, and a sign-up updates */
  leadSlug: string;
  /** the module a conversion creates a record in, and a re-deposit updates */
  dealSlug: string;
}

export interface ArkManagerProps {
  /** a deep link from a deposit row: open this source's log on this event */
  focus: { sourceId: string; eventId: string } | null;
  modules: ConversionModules | null;
}

/** Outcome filter options, in spec §7's order. */
const OUTCOME_OPTIONS = ARK_OUTCOMES.map((o) => ({
  value: o,
  label: outcomeOf({ id: '', status: 'PROCESSED', outcome: o }).label,
}));

export function ArkManager({ focus, modules }: ArkManagerProps) {
  const [sources, setSources] = useState<ArkSourceRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchToken, setFetchToken] = useState(0);

  const [creating, setCreating] = useState(false);
  const [mappingFor, setMappingFor] = useState<ArkSourceRow | null>(null);
  const [signatureFor, setSignatureFor] = useState<ArkSourceRow | null>(null);
  const [eventsFor, setEventsFor] = useState<ArkSourceRow | null>(null);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  /** the one moment the full URL exists client-side — see the intake screen */
  const [created, setCreated] = useState<CreatedArkSource | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ sources: ArkSourceRow[] }>('/api/ark-sources')
      .then((res) => {
        if (cancelled) return;
        setSources(res.sources);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'The ARK sources could not be loaded.');
        setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchToken]);

  // Honour the deep link once the list is in: open that source's log on that
  // event. Consumed once, so closing the overlay does not reopen it.
  const [focusConsumed, setFocusConsumed] = useState(false);
  useEffect(() => {
    if (focus === null || focusConsumed || sources === null) return;
    const source = sources.find((s) => s.id === focus.sourceId);
    setFocusConsumed(true);
    if (!source) return;
    setFocusEventId(focus.eventId);
    setEventsFor(source);
  }, [focus, focusConsumed, sources]);

  function refresh() {
    setFetchToken((n) => n + 1);
  }

  function toggleActive(source: ArkSourceRow) {
    setTogglingId(source.id);
    setProblem(null);
    api<{ source: unknown }>(`/api/ark-sources/${source.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !source.isActive }),
    })
      .then(() => {
        setTogglingId(null);
        refresh();
      })
      .catch((err: unknown) => {
        setTogglingId(null);
        setProblem(err instanceof Error ? err.message : 'The source could not be updated.');
      });
  }

  function failed(source: ArkSourceRow): number {
    return source.counts?.['FAILED'] ?? 0;
  }

  /** Doors to what an event produced or touched: the deal, the lead. */
  function eventLinks(event: EventRow): EventLink[] {
    if (modules === null) return [];
    const out: EventLink[] = [];
    const dealId = event.dealId ?? null;
    const leadId = createdRecordId(event);
    if (dealId !== null) {
      out.push({ href: `/${modules.dealSlug}/${dealId}`, label: 'Open deal →', track: 'settings.ark.events.deal.open' });
    }
    if (leadId !== null) {
      out.push({ href: `/${modules.leadSlug}/${leadId}`, label: 'Open lead →', track: 'settings.ark.events.lead.open' });
    }
    return out;
  }

  return (
    <>
      {/* THE honest banner. */}
      <div className="rounded-lg border border-warning bg-surface px-5 py-4">
        <p className="text-sm font-medium text-heading">ARK is not connected yet.</p>
        <p className="mt-1 text-sm text-body">
          No webhook spec has been received from ARK — no payload field names, no signature
          scheme, no retry contract — and none has been guessed in code. Create a source below
          and hand its URL to ARK. The first real account event will land here as FAILED: open it,
          read its shape, map it, replay. From then on every account event matches deals first and
          leads second by phone, and does one of four things — a deposit on an existing deal, a
          conversion, a sign-up, or a new lead for the senior pool — with every step on the
          record&apos;s timeline as System (ARK Webhook). Signature verification is configured per
          source under Signature — nothing about ARK&apos;s scheme is fixed in code, so the day
          ARK says how it signs, an Admin switches it on here without a developer.
        </p>
      </div>

      {created !== null ? (
        <Panel className="border-warning">
          <div className="flex flex-col gap-3 px-6 py-5">
            <p className="text-sm font-medium text-heading">
              “{created.name}” is ready — copy its webhook URL now.
            </p>
            <p className="text-sm text-body">
              This URL carries the source&apos;s secret token and is shown ONCE. The server keeps
              only a hash, so once you leave this page it cannot be recovered — only a new source
              can. Hand it to ARK as the account-event destination.
            </p>
            <CopyField value={created.intakeUrl} track="settings.ark.source.url.copy" />
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCreated(null)}
                data-track="settings.ark.source.url.dismiss"
              >
                I have copied it
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {problem !== null || loadError !== null ? (
        <p role="alert" className="rounded border border-error bg-surface px-4 py-3 text-sm text-error">
          {problem ?? loadError}
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="text-sm font-medium text-heading">Sources</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              loading={sources === null}
              onClick={refresh}
              data-track="settings.ark.sources.refresh"
            >
              Refresh
            </Button>
            <Button size="sm" onClick={() => setCreating(true)} data-track="settings.ark.source.new.open">
              New source
            </Button>
          </div>
        </div>

        {sources === null ? (
          <p className="px-6 py-8 text-sm text-body">Loading…</p>
        ) : sources.length === 0 ? (
          <div className="px-6 py-8">
            <p className="text-sm text-body">
              No sources yet. This is where the connection starts: create a source, hand its
              webhook URL to ARK, and the first account event that arrives becomes a stored event
              you can read and map against — never a lost account.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Source', 'Mapping', 'Signature', 'Status', 'Events', 'Actions'].map((h) => (
                    <th key={h} className="px-6 py-3 text-xs font-medium text-body">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id} className="border-b border-border last:border-b-0">
                    <td className="px-6 py-3">
                      <p className="font-medium text-heading">{source.name}</p>
                      <p className="mt-0.5 text-xs text-body">endpoint id: {source.slug}</p>
                    </td>
                    <td className="px-6 py-3">
                      <MappingState mapping={source.mapping} />
                    </td>
                    <td className="px-6 py-3">
                      <SignatureState signature={source.signature} />
                    </td>
                    <td className="px-6 py-3">
                      {source.isActive ? <Chip tone="success">Active</Chip> : <Chip tone="neutral">Paused</Chip>}
                    </td>
                    <td className="px-6 py-3">
                      <EventCountChips counts={source.counts} />
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setMappingFor(source)}
                          data-track="settings.ark.source.mapping.open"
                        >
                          Mapping
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setSignatureFor(source)}
                          title="How this source authenticates ARK: which header carries the digest, how it is computed, and the shared secret behind it."
                          data-track="settings.ark.signature.open"
                        >
                          Signature
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setFocusEventId(null);
                            setEventsFor(source);
                          }}
                          data-track="settings.ark.events.open"
                        >
                          Events{failed(source) > 0 ? ` (${failed(source)} failed)` : ''}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={togglingId === source.id}
                          onClick={() => toggleActive(source)}
                          title={
                            source.isActive
                              ? 'Paused sources answer ARK with an error; nothing is silently dropped.'
                              : 'Resume accepting account events on this URL.'
                          }
                          data-track="settings.ark.source.toggle"
                        >
                          {source.isActive ? 'Pause' : 'Resume'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {creating ? (
        <ArkSourceCreateOverlay
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
            refresh();
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {mappingFor !== null ? (
        <ArkMappingOverlay
          source={mappingFor}
          onSaved={() => {
            setMappingFor(null);
            refresh();
          }}
          onClose={() => setMappingFor(null)}
        />
      ) : null}

      {signatureFor !== null ? (
        <ArkSignatureOverlay
          source={signatureFor}
          onSaved={() => {
            setSignatureFor(null);
            // The row's chip is read off the DTO, and a save moved it — a
            // stale "Token only" beside a source that now refuses every call
            // is the one thing this column exists to prevent.
            refresh();
          }}
          onClose={() => setSignatureFor(null)}
        />
      ) : null}

      {eventsFor !== null ? (
        <SourceEventsOverlay
          source={{ id: eventsFor.id, name: eventsFor.name, moduleSlug: eventsFor.moduleSlug ?? null }}
          endpointBase={`/api/ark-sources/${eventsFor.id}`}
          trackPrefix="settings.ark.events"
          intro="Every account event ARK has ever posted to this source, stored raw before anything parsed it. Each row says which of the four outcomes it produced. A failed event is not a lost account: read its payload, fix the mapping, then replay it — replays are safe, a deposit already recorded from an event is never recorded twice."
          decorate={(event) => {
            const outcome = outcomeOf(event);
            return (
              <Chip tone={outcome.tone} title={outcome.title}>
                {outcome.label}
              </Chip>
            );
          }}
          links={eventLinks}
          focusEventId={focusEventId}
          replayableStatuses={ARK_REPLAYABLE_STATUSES}
          outcomeOptions={OUTCOME_OPTIONS}
          onClose={() => {
            setEventsFor(null);
            setFocusEventId(null);
            // A replay may have converted a lead and flipped event statuses.
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Whether the stored mapping is usable, said as a chip. Read through the
 *  same structural test the worker applies: both required concepts present. */
function MappingState({ mapping }: { mapping: unknown }) {
  const raw = mapping as { rules?: unknown } | null | undefined;
  const rules = Array.isArray(raw?.rules) ? (raw.rules as { concept?: unknown }[]) : [];
  const concepts = new Set(rules.map((r) => r.concept).filter((c): c is string => typeof c === 'string'));
  if (rules.length === 0) return <Chip tone="warning">Not mapped</Chip>;
  const ready = concepts.has('phone') && concepts.has('accountNumber');
  return ready ? (
    <Chip tone="success">{concepts.size} concept{concepts.size === 1 ? '' : 's'}</Chip>
  ) : (
    <Chip tone="warning" title="Phone and account number must both be mapped before an event can be acted on">
      Incomplete
    </Chip>
  );
}

/**
 * Whether this source verifies its caller, said as a chip.
 *
 * Read through `arkSignatureState`, which mirrors the receiver's own branches
 * — including the state worth a whole column: a scheme configured with no
 * secret behind it, where verification fails CLOSED and every real call from
 * ARK is refused. That one is invisible from the source's name, its mapping
 * and its Active chip alike, and it is the reason this is a column rather
 * than something you find by opening the pop-up.
 */
function SignatureState({ signature }: { signature: ArkSignatureView | undefined }) {
  const state = ARK_SIGNATURE_STATE[arkSignatureState(signature)];
  return (
    <Chip tone={state.tone} title={state.title}>
      {state.label}
    </Chip>
  );
}

/** The per-status volume, in the order a reader triages: failed first. */
const COUNT_ORDER: { status: string; label: string; tone: 'error' | 'info' | 'success' | 'warning' | 'neutral' }[] = [
  { status: 'FAILED', label: 'failed', tone: 'error' },
  { status: 'RECEIVED', label: 'waiting', tone: 'info' },
  { status: 'PROCESSED', label: 'processed', tone: 'success' },
  { status: 'REPLAYED', label: 'replayed', tone: 'warning' },
  { status: 'IGNORED', label: 'ignored', tone: 'neutral' },
];

function EventCountChips({ counts }: { counts: Record<string, number> | undefined }) {
  if (counts === undefined) {
    return <span className="text-xs text-body">open the log</span>;
  }
  const shown = COUNT_ORDER.filter((c) => (counts[c.status] ?? 0) > 0);
  if (shown.length === 0) {
    return <span className="text-xs text-body">none yet</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((c) => (
        <Chip key={c.status} tone={c.tone}>
          {counts[c.status]} {c.label}
        </Chip>
      ))}
    </div>
  );
}
