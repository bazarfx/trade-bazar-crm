'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, Chip, cn, Panel, PanelBody, PanelHeader } from '@/components/ui';
import { api, ApiClientError } from '@/lib/client-api';
import { absoluteTime } from './time';
import { formatMoney } from './money';

/**
 * The deposit ledger on a record (spec §8.3): every deposit — the FTD and
 * every re-deposit arriving by webhook — as its own row, with the totals the
 * rows add up to in the header.
 *
 * Drawn for any module whose storage keeps a ledger; the page decides that
 * from the storage shape and this panel confirms it by asking the deposits
 * route, which answers 404 for a module that keeps none. Neither side ever
 * asks what the module is called.
 *
 * There is no "add deposit" control here and there must never be one: a
 * deposit is a ledger row written by the ARK webhook pipeline, with the raw
 * event it came from linked beside it. Totals are derived from those rows
 * and are never typed by hand — which is why the header sums the table it
 * sits above rather than printing the record's columns.
 */

interface DepositRow {
  id: string;
  amount: string;
  depositedAt: string;
  isFtd: boolean;
  webhookEventId: string | null;
  webhookSourceId: string | null;
}

interface LedgerResponse {
  deposits: DepositRow[];
  totals: { total: string; count: number; first: DepositRow | null };
}

export interface DepositsPanelProps {
  slug: string;
  recordId: string;
  className?: string;
}

export function DepositsPanel({ slug, recordId, className }: DepositsPanelProps) {
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 404 from the route: this module keeps no ledger — draw nothing at all. */
  const [absent, setAbsent] = useState(false);
  /** bumped by Refresh; a webhook may have landed since the page rendered */
  const [fetchToken, setFetchToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<LedgerResponse>(`/api/modules/${slug}/records/${recordId}/deposits`)
      .then((res) => {
        if (cancelled) return;
        setLedger(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 404) {
          setAbsent(true);
        } else {
          setError(err instanceof Error ? err.message : 'The deposits could not be loaded.');
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, recordId, fetchToken]);

  if (absent) return null;

  return (
    <Panel className={cn('flex flex-col overflow-hidden', className)}>
      <PanelHeader
        title="Deposits"
        actions={
          <>
            {ledger !== null ? (
              // The header is the sum of the rows below it — derived, never
              // typed (spec §8.3). Two chips, one number each, so a floor
              // manager reads the total without reading the table.
              <>
                <Chip tone="success" title="Total deposited — derived from the rows below">
                  Total {formatMoney(ledger.totals.total)}
                </Chip>
                <Chip tone="neutral" title="Deposit count — one row per deposit">
                  {ledger.totals.count} {ledger.totals.count === 1 ? 'deposit' : 'deposits'}
                </Chip>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              loading={loading}
              onClick={() => setFetchToken((n) => n + 1)}
              title="Re-read the ledger — a webhook may have landed since this page opened."
              data-track={`${slug}.detail.deposits.refresh`}
            >
              Refresh
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error !== null ? (
          <p role="alert" className="m-6 rounded bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </p>
        ) : ledger === null ? (
          <p className="px-6 py-4 text-sm text-body">Reading the ledger…</p>
        ) : ledger.deposits.length === 0 ? (
          <PanelBody>
            <p className="text-sm text-body">
              No deposits yet. The first one arrives as a row here the moment ARK posts it — there
              is nothing to type, and nothing that can be typed: every deposit is a row written
              from a stored webhook event.
            </p>
          </PanelBody>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {['Received', 'Amount', '', 'Source event'].map((h, i) => (
                  <th
                    // The empty header is the FTD column; an index key is safe
                    // because this header row never reorders.
                    key={i}
                    scope="col"
                    className="h-10 border-b border-border bg-background px-6 text-xs font-medium text-body"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ledger.deposits.map((deposit) => (
                <tr key={deposit.id} className="h-11 border-b border-border last:border-0">
                  <td className="px-6 text-heading" title={deposit.depositedAt}>
                    {absoluteTime(deposit.depositedAt)}
                  </td>
                  <td className="px-6 font-medium tabular-nums text-heading">
                    {formatMoney(deposit.amount)}
                  </td>
                  <td className="px-6">
                    {deposit.isFtd ? (
                      <Chip tone="info" title="First-time deposit — the one that converted the lead">
                        FTD
                      </Chip>
                    ) : (
                      <Chip tone="neutral">Re-deposit</Chip>
                    )}
                  </td>
                  <td className="px-6">
                    {deposit.webhookEventId !== null && deposit.webhookSourceId !== null ? (
                      // Straight to the stored raw payload behind this row —
                      // the ledger's evidence, one click away.
                      <Link
                        href={`/settings/ark?source=${encodeURIComponent(deposit.webhookSourceId)}&event=${encodeURIComponent(deposit.webhookEventId)}`}
                        className="text-xs font-medium text-primary hover:underline"
                        title="Open the raw webhook event this deposit was read from"
                        data-track={`${slug}.detail.deposits.event.open`}
                      >
                        Open event →
                      </Link>
                    ) : (
                      // A row without an event predates the pipeline or was
                      // written by a replay whose source was since deleted.
                      // Say which rather than drawing a dead link.
                      <span className="text-xs text-body" title={deposit.webhookEventId ?? undefined}>
                        {deposit.webhookEventId === null ? 'No event on record' : 'Source no longer exists'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
