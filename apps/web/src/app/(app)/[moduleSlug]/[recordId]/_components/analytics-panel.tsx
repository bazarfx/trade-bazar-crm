'use client';

import { useEffect, useState } from 'react';
import { Button, cn, Panel, PanelBody, PanelHeader } from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import { formatMoney, formatPercent } from './money';

/**
 * Basic analytics for a record other records are attributed to (spec §9):
 * leads in, converted, conversion rate, total deposited, cost per conversion
 * when a spend has been entered.
 *
 * Drawn on any record whose analytics route answers. The route answers 404
 * for a module nothing links to, and this panel then renders nothing — it is
 * the route, not a slug, that decides whether a record has analytics.
 *
 * Every number is the product of scoped reads, so two people can open the
 * same campaign and see different counts: each sees the leads their matrix
 * lets them see, which is the same answer the list would give them.
 */

interface Analytics {
  leadsIn: number;
  converted: number;
  conversionRate: number | null;
  totalDeposited: string | null;
  spend: string | null;
  costPerConversion: string | null;
  labels: { source: string; target: string; spendField: string | null };
}

export interface AnalyticsPanelProps {
  slug: string;
  recordId: string;
  className?: string;
}

export function AnalyticsPanel({ slug, recordId, className }: AnalyticsPanelProps) {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [absent, setAbsent] = useState(false);
  const [fetchToken, setFetchToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ analytics: Analytics | null }>(`/api/modules/${slug}/records/${recordId}/analytics`)
      .then((res) => {
        if (cancelled) return;
        // Null is the route's "no analytics for this module" — a 200, so the
        // probe on every record detail stays silent in the console. The 404
        // branch below is left for a record that is itself missing.
        if (res.analytics === null) {
          setAbsent(true);
        } else {
          setData(res.analytics);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404) {
          setAbsent(true);
        } else {
          setError(err instanceof Error ? err.message : 'The analytics could not be loaded.');
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, recordId, fetchToken]);

  if (absent) return null;

  const tiles: { label: string; value: string; note?: string }[] = data
    ? [
        { label: `${data.labels.source} in`, value: String(data.leadsIn) },
        {
          label: 'Converted',
          value: String(data.converted),
          note: 'Status tagged Converted — renaming the status changes nothing here.',
        },
        { label: 'Conversion rate', value: formatPercent(data.conversionRate) },
        {
          label: 'Total deposited',
          value: data.totalDeposited === null ? '—' : formatMoney(data.totalDeposited),
          note:
            data.totalDeposited === null
              ? `Not available: ${data.labels.target} do not link back here, or the total is hidden from your role.`
              : `Across ${data.labels.target} attributed to this record, from their deposit ledgers.`,
        },
        {
          label: 'Cost per conversion',
          value: data.costPerConversion === null ? '—' : formatMoney(data.costPerConversion),
          note:
            data.spend === null
              ? data.labels.spendField === null
                ? 'Needs one money field on this module to hold the spend.'
                : `Enter ${data.labels.spendField} on this record to compute it.`
              : data.converted === 0
                ? `${formatMoney(data.spend)} spent, nothing converted yet.`
                : `${formatMoney(data.spend)} ÷ ${data.converted} converted.`,
        },
      ]
    : [];

  return (
    <Panel className={cn('shrink-0', className)}>
      <PanelHeader
        title="Performance"
        actions={
          <Button
            variant="ghost"
            size="sm"
            loading={loading}
            onClick={() => setFetchToken((n) => n + 1)}
            data-track={`${slug}.detail.analytics.refresh`}
          >
            Refresh
          </Button>
        }
      />
      <PanelBody>
        {error !== null ? (
          <p role="alert" className="rounded bg-[var(--globalcolors-red-10)] px-3 py-2 text-xs text-error">
            {error}
          </p>
        ) : data === null ? (
          <p className="text-sm text-body">Counting…</p>
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            {/* Two across, never five: `lg:` reads the VIEWPORT, but this
                panel lives in the detail page's centre column (~470px at
                1440), so a viewport breakpoint would squeeze five ~80px tiles
                into it and truncate every label. Two tracks fit the column it
                is actually drawn in at every width the page allows. */}
            {tiles.map((tile) => (
              <div key={tile.label} className="min-w-0 rounded-md border border-border bg-background px-4 py-3">
                <dt className="truncate text-xs text-body" title={tile.label}>
                  {tile.label}
                </dt>
                <dd className="mt-1 truncate text-lg font-medium tabular-nums text-heading" title={tile.value}>
                  {tile.value}
                </dd>
                {tile.note ? <p className="mt-1 text-xs text-muted">{tile.note}</p> : null}
              </div>
            ))}
          </dl>
        )}
      </PanelBody>
    </Panel>
  );
}
