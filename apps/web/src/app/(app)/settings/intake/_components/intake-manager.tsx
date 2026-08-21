'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Panel } from '@/components/ui';
import { api } from '@/lib/client-api';
import { CopyField } from './copy-field';
import { MappingEditorOverlay } from './mapping-editor-overlay';
import { SourceCreateOverlay, type CreatedSource } from './source-create-overlay';
import { SourceEventsOverlay } from './source-events-overlay';

/**
 * The intake sources screen: the list, and the doors into the three overlays
 * (create, mapping, events).
 *
 * REDECLARED wire types rather than imports from Prisma: this is a client
 * component, and `@crm/db` must never enter its resolution graph — the same
 * reasoning as `TableRow` on the record table.
 */

/** WebhookEvent counts per status — whatever statuses the rows actually hold. */
export type EventCounts = Record<string, number>;

export interface SourceRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  /** `WebhookSource.fieldMapping` as stored — the mapping editor parses it */
  mapping: unknown;
  /** the last raw payload this source received, or null before the first one */
  lastPayload: unknown;
  createdAt: string;
  moduleSlug: string;
  moduleLabel: string;
  counts: EventCounts;
}

export interface ModuleOption {
  id: string;
  slug: string;
  label: string;
  labelPlural: string;
}

export interface IntakeManagerProps {
  sources: SourceRow[];
  modules: ModuleOption[];
}

export function IntakeManager({ sources, modules }: IntakeManagerProps) {
  const router = useRouter();

  const [creating, setCreating] = useState(false);
  const [mappingFor, setMappingFor] = useState<SourceRow | null>(null);
  const [eventsFor, setEventsFor] = useState<SourceRow | null>(null);
  /**
   * The one moment the full intake URL exists client-side. The server stores
   * only a token HASH, so the URL from the 201 can never be shown again —
   * it is held here until dismissed, prominently, with a copy button.
   */
  const [created, setCreated] = useState<CreatedSource | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function toggleActive(source: SourceRow) {
    setTogglingId(source.id);
    setProblem(null);
    api<{ source: unknown }>(`/api/webhook-sources/${source.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !source.isActive }),
    })
      .then(() => {
        setTogglingId(null);
        router.refresh();
      })
      .catch((err: unknown) => {
        setTogglingId(null);
        setProblem(err instanceof Error ? err.message : 'The source could not be updated.');
      });
  }

  function failed(source: SourceRow): number {
    return source.counts['FAILED'] ?? 0;
  }

  return (
    <>
      {created !== null ? (
        <Panel className="border-warning">
          <div className="flex flex-col gap-3 px-6 py-5">
            <p className="text-sm font-medium text-heading">
              “{created.name}” is ready — copy its intake URL now.
            </p>
            <p className="text-sm text-body">
              This URL carries the source&apos;s secret token and is shown ONCE. The server keeps
              only a hash, so once you leave this page it cannot be recovered — only a new source
              can. Paste it into the campaign platform (Integrately, once the account exists) as
              the webhook destination.
            </p>
            <CopyField value={created.intakeUrl} track="settings.intake.source.url.copy" />
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCreated(null)}
                data-track="settings.intake.source.url.dismiss"
              >
                I have copied it
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {problem !== null ? (
        <p role="alert" className="rounded border border-error bg-surface px-4 py-3 text-sm text-error">
          {problem}
        </p>
      ) : null}

      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="text-sm font-medium text-heading">Sources</h2>
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            data-track="settings.intake.source.new.open"
          >
            New source
          </Button>
        </div>

        {sources.length === 0 ? (
          <div className="px-6 py-8">
            <p className="text-sm text-body">
              No sources yet. Integrately is not connected — the account does not exist yet — so
              this is where the connection will start: create a source for the module that should
              receive the leads, copy its intake URL into the platform, and the first payload that
              arrives becomes a stored event you can read and map against.
            </p>
          </div>
        ) : (
          // Not <DataTable>: it takes render callbacks and this table is four
          // columns of config, not virtualised records. Metrics match the
          // settings landing's table so the two screens read as one product.
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  {['Source', 'Module', 'Status', 'Events', 'Actions'].map((h) => (
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
                      {/* The slug identifies the endpoint; the full URL (with
                          its token) was shown once, at creation. */}
                      <p className="mt-0.5 text-xs text-body">endpoint id: {source.slug}</p>
                    </td>
                    <td className="px-6 py-3 text-body">{source.moduleLabel}</td>
                    <td className="px-6 py-3">
                      {source.isActive ? (
                        <Chip tone="success">Active</Chip>
                      ) : (
                        <Chip tone="neutral">Paused</Chip>
                      )}
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
                          data-track="settings.intake.source.mapping.open"
                        >
                          Mapping
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEventsFor(source)}
                          data-track="settings.intake.events.open"
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
                              ? 'Paused sources answer the platform with an error; nothing is silently dropped.'
                              : 'Resume accepting payloads on this URL.'
                          }
                          data-track="settings.intake.source.toggle"
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
        <SourceCreateOverlay
          modules={modules}
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
            router.refresh();
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {mappingFor !== null ? (
        <MappingEditorOverlay
          source={mappingFor}
          onSaved={() => {
            setMappingFor(null);
            router.refresh();
          }}
          onClose={() => setMappingFor(null)}
        />
      ) : null}

      {eventsFor !== null ? (
        <SourceEventsOverlay
          source={eventsFor}
          onClose={() => {
            setEventsFor(null);
            // A replay may have created records and flipped event statuses;
            // the counts column is server-rendered.
            router.refresh();
          }}
        />
      ) : null}
    </>
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

function EventCountChips({ counts }: { counts: EventCounts }) {
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
