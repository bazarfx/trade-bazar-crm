'use client';

import { useEffect, useState } from 'react';
import type {
  ClosedCredit,
  PersonWorkload,
  StatusTagValue,
  WorkloadModule,
} from '@crm/shared';
import { Button, cn, Panel, PanelBody, PanelHeader, toneForTag, type ChipTone } from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import { absoluteTime } from './time';
import { formatMoney } from './money';

/**
 * What one PERSON is carrying, and what they have closed.
 *
 * The client's ask, in their words: "the no. of leads they have been assigned,
 * how many have they closed, everything" — all of it on the person's own page,
 * at once, with nothing to click through.
 *
 * THIS FILE NEVER LEARNS THAT A TELESELLER EXISTS, and never learns that a
 * module is called Leads. It is handed `PersonWorkload`, which is a list of
 * "module the storage says carries an owner" and "module the storage says
 * carries a closed-by column" — so an Admin creating a module tomorrow with an
 * owner column gets a tile here with no code change, no migration and no
 * deploy. That is the test.
 *
 * WHY THE COUNTS ARRIVE AS A PROP rather than being fetched on mount, unlike
 * `DepositsPanel` and `AnalyticsPanel` next door: the owned-records table
 * below this panel needs each module's OWNER FIELD KEY, which is resolved from
 * `FieldDefinition.systemColumn` — server-side config no route exposes. The
 * page therefore has to read the workload on the server anyway, and reading it
 * twice would double a query set that is already linear in modules. The route
 * is still the live contract: Refresh re-reads it, and a 404 from it still
 * means "this module is not people", which blanks the panel exactly as the two
 * panels beside it blank themselves.
 *
 * Every number here is a SCOPED read (see lib/records/workload). Two people
 * opening the same person can legitimately see different totals — each sees
 * what their own matrix would show them on the list screen.
 */

/**
 * Fill for a bar segment or a legend swatch, keyed on the tone the tag
 * resolves to — NOT on the tag itself. `toneForTag` is the single tag→tone
 * table `StatusChip` paints from, so a bar can never disagree with the chip
 * beside it; this map only says what that tone looks like when it is a solid
 * area rather than a bordered pill.
 */
/**
 * The bar's segment fills, and they must agree with the CHIP that sits beside
 * them — both resolve through the same `toneForTag`, so a reader seeing a
 * purple chip and a blue bar segment for one status would be right to think
 * one of them is lying.
 *
 * The chips were moved onto the file's own badge pairs (a `-10` tint under a
 * `-60` label) on 26 Aug; the accent hues they used before — `--accents-blue`,
 * `--accents-green`, `--accents-orange` — are painted on no badge anywhere in
 * the Figma file. A bar is a SOLID fill rather than a tint, so it takes the
 * `-60` half of each pair: the same hue family as the chip, at the weight a
 * filled bar needs.
 */
const TONE_FILL: Record<ChipTone, string> = {
  neutral: 'bg-muted',
  info: 'bg-[var(--globalcolors-blue-60)]',
  success: 'bg-[var(--globalcolors-green-60)]',
  warning: 'bg-[var(--globalcolors-orange-60)]',
  error: 'bg-[var(--globalcolors-red-60)]',
};

/** Records that sit on no tag at all — see `remainder` below. */
const UNTAGGED_FILL = 'bg-border';

/**
 * `SIGNED_UP` -> `Signed up`, mechanically.
 *
 * A lookup table of pretty names would need editing every time `STATUS_TAGS`
 * grows, and the tag that got missed would render as a raw enum member in
 * front of a customer. Derived instead, so a new tag reads correctly the day
 * it is added.
 */
function tagLabel(tag: string): string {
  const words = tag.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One drawn slice of a pipeline bar. Zero-count tags never become one. */
interface Segment {
  key: string;
  label: string;
  count: number;
  /** width as a percentage of the module's total */
  share: number;
  fill: string;
}

/**
 * The pipeline of one module, folded onto TAGS.
 *
 * Tags with nothing on them are dropped — a legend of eight entries, six of
 * them zero, is noise — but the bar still totals correctly because the widths
 * are taken against `total`, not against the sum of the drawn slices.
 *
 * The remainder is the difference: a record with no status set, or one whose
 * status row was hard-removed, is still that person's work and still occupies
 * its share of the bar. Silently normalising it away would draw a full bar for
 * a pipeline that is half untriaged, which is the one thing a floor manager
 * opening this page needs to see.
 */
function segmentsFor(module: WorkloadModule): Segment[] {
  if (module.total <= 0) return [];

  const segments: Segment[] = [];
  let tagged = 0;

  for (const [tag, count] of Object.entries(module.byTag) as [StatusTagValue, number][]) {
    tagged += count;
    if (count <= 0) continue;
    segments.push({
      key: tag,
      label: tagLabel(tag),
      count,
      share: (count / module.total) * 100,
      fill: TONE_FILL[toneForTag(tag)],
    });
  }

  const remainder = module.total - tagged;
  if (remainder > 0) {
    segments.push({
      key: '__untagged',
      label: 'No status',
      count: remainder,
      share: (remainder / module.total) * 100,
      fill: UNTAGGED_FILL,
    });
  }

  return segments;
}

function PipelineBar({ module }: { module: WorkloadModule }) {
  const segments = segmentsFor(module);
  if (segments.length === 0) return null;

  // One accessible sentence for the whole bar. Per-segment `title` tooltips
  // are for the pointer; a screen reader gets the same facts in one read
  // rather than eight unlabelled slices.
  const summary = segments.map((s) => `${s.label} ${s.count}`).join(', ');

  return (
    <div className="mt-3">
      <div
        role="img"
        aria-label={`Pipeline: ${summary}`}
        className="flex h-2 w-full overflow-hidden rounded-pill bg-subtle"
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            style={{ width: `${segment.share}%` }}
            // Tooltip per segment, as asked. The percentage is rounded for
            // reading; the count beside it is exact, so nothing is lost.
            title={`${segment.label} — ${segment.count} of ${module.total} (${Math.round(segment.share)}%)`}
            className={cn('h-full', segment.fill)}
          />
        ))}
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((segment) => (
          <li key={segment.key} className="inline-flex items-center gap-1.5 text-xs text-body">
            <span className={cn('h-2 w-2 shrink-0 rounded-pill', segment.fill)} aria-hidden="true" />
            <span className="truncate" title={segment.label}>
              {segment.label}
            </span>
            <span className="font-medium tabular-nums text-heading">{segment.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OwnedTile({ module }: { module: WorkloadModule }) {
  const empty = module.total === 0;
  return (
    <div className="min-w-0 rounded-md border border-border bg-background p-4">
      <p className="text-title font-medium tabular-nums text-heading">{module.total}</p>
      {/* The ADMIN's own plural, never a hardcoded "Leads" — rename the module
          and this caption renames with it. */}
      <p className="truncate text-xs text-body" title={`${module.labelPlural} assigned`}>
        {module.labelPlural} assigned
      </p>

      {empty ? (
        // A bare 0 with nothing beside it reads as a broken panel. Say what the
        // zero MEANS, in the Admin's words for the module.
        <p className="mt-3 text-xs text-muted">
          No {module.labelPlural.toLowerCase()} assigned yet.
        </p>
      ) : module.hasStatuses ? (
        <PipelineBar module={module} />
      ) : (
        // No status column on this module's table — the pipeline is absent,
        // not empty, and drawing an all-grey bar would imply otherwise.
        <p className="mt-3 text-xs text-muted">This module has no pipeline.</p>
      )}
    </div>
  );
}

function ClosedTile({ credit }: { credit: ClosedCredit }) {
  return (
    // Visually distinct from an ownership tile on purpose: closed credit is a
    // different KIND of number — it is what commission is paid on, and it must
    // never be read as "records they are working".
    <div className="min-w-0 rounded-md border border-success bg-[var(--globalcolors-green-10)] p-4">
      <p className="text-title font-medium tabular-nums text-heading">{credit.count}</p>
      <p className="truncate text-xs text-body" title={`${credit.labelPlural} closed`}>
        {credit.labelPlural} closed
      </p>

      {credit.ledgerTotal === null ? null : (
        <p className="mt-2 truncate text-sm font-medium tabular-nums text-heading">
          {formatMoney(credit.ledgerTotal)}{' '}
          <span className="text-xs font-normal text-body">deposited</span>
        </p>
      )}

      {credit.count === 0 ? (
        <p className="mt-3 text-xs text-muted">
          No {credit.labelPlural.toLowerCase()} closed yet.
        </p>
      ) : (
        // Spec §7.1: the closer is stamped once, at conversion, and never
        // written again. Saying so here is the difference between a number
        // somebody trusts and one they query every payroll run.
        <p className="mt-3 text-xs text-muted">
          Permanent credit — it stays with this person even if the{' '}
          {credit.label.toLowerCase()} is transferred to someone else.
        </p>
      )}
    </div>
  );
}

export interface WorkloadPanelProps {
  /** the PERSON module's slug — only ever used to build `data-track` names */
  slug: string;
  recordId: string;
  /** counted on the server for this render; Refresh re-reads the same route */
  initial: PersonWorkload;
  className?: string;
}

export function WorkloadPanel({ slug, recordId, initial, className }: WorkloadPanelProps) {
  const [workload, setWorkload] = useState<PersonWorkload>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** a 404 means this record is not a person any more — draw nothing at all */
  const [absent, setAbsent] = useState(false);

  // The server counts again on every navigation, so a new person's numbers
  // must replace the ones held here from the last one. Without this, opening a
  // second person from the same tree would show the first one's workload.
  useEffect(() => {
    setWorkload(initial);
    setError(null);
    setAbsent(false);
  }, [initial]);

  function refresh() {
    setLoading(true);
    setError(null);
    api<{ workload: PersonWorkload }>(`/api/modules/${slug}/records/${recordId}/workload`)
      .then((res) => {
        setWorkload(res.workload);
        setLoading(false);
      })
      .catch((err: unknown) => {
        // Same detection the deposits and analytics panels use: the route
        // answers 404 for a module that is not the people table, so the
        // absence of a workload is a fact the SERVER states rather than
        // something this file infers from a slug.
        if (err instanceof ApiClientError && err.status === 404) setAbsent(true);
        else setError(err instanceof Error ? err.message : 'The workload could not be counted.');
        setLoading(false);
      });
  }

  if (absent) return null;

  const owns = workload.owns;
  const closed = workload.closed;

  return (
    <Panel className={cn('shrink-0', className)}>
      <PanelHeader
        title="Workload"
        actions={
          <>
            {/* These are a SNAPSHOT, not a live feed, and a number with no
                timestamp invites someone to treat it as one. */}
            <span className="hidden text-xs text-muted sm:inline" title={workload.generatedAt}>
              Counted {absoluteTime(workload.generatedAt)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              loading={loading}
              onClick={refresh}
              title="Re-count — records move between people and pipelines all day."
              data-track={`${slug}.person.workload.refresh`}
            >
              Refresh
            </Button>
          </>
        }
      />

      <PanelBody className="flex flex-col gap-6">
        {error !== null ? (
          <p role="alert" className="rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
            {error}
          </p>
        ) : null}

        {owns.length === 0 && closed.length === 0 ? (
          <p className="text-sm text-body">
            Nothing is assigned to this person, and no module in this workspace records who closed
            a record. Both appear here automatically the moment they do — this page reads the
            storage, not a list of modules.
          </p>
        ) : null}

        {owns.length > 0 ? (
          <section>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              Assigned to this person
            </h3>
            {/* Viewport breakpoints are legitimate here — unlike the analytics
                panel, which lives in the ~470px centre column, this one is
                full-width, so `xl` really does mean there is room for three. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {owns.map((module) => (
                <OwnedTile key={module.slug} module={module} />
              ))}
            </div>
          </section>
        ) : null}

        {closed.length > 0 ? (
          <section>
            <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              Closed by this person
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {closed.map((credit) => (
                <ClosedTile key={credit.slug} credit={credit} />
              ))}
            </div>
          </section>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
