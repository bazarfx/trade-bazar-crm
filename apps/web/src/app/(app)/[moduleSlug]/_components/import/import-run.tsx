'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { Button } from '@/components/ui';
import {
  downloadCsv,
  formatCount,
  isRunningStatus,
  messageOf,
  toCsv,
  type ImportBatchWire,
  type ImportProgressWire,
  type ImportRowErrorWire,
} from './wire';

/**
 * Stage 6 — the run. Not a stage in the file, because in the file the wizard
 * ends at Save.
 *
 * Everything before the commit happened in a request. Everything after it
 * happens in the worker, one staged row at a time, through the record engine —
 * a multi-megabyte import is the example CLAUDE.md gives for work that never
 * belongs in a route handler. So this screen cannot "do" the import; it can
 * only watch it, which is why it polls and why closing it is harmless.
 *
 * The counters come from the batch row the worker increments per chunk, so a
 * refresh mid-import resumes exactly where the numbers are.
 */

export interface ImportRunProps {
  slug: string;
  labelPlural: string;
  batch: ImportBatchWire;
  /** close the overlay; the import is unaffected either way */
  onClose: () => void;
  /** rows were written — the list behind the overlay is now stale */
  onImported: () => void;
  trackPrefix: string;
}

const POLL_MS = 1_500;
/** The errors route's own ceiling. Asking for more is clamped server-side. */
const ERRORS_PAGE_SIZE = 200;
/** How many failed rows the CSV will gather. "Every row failed" is a real
 *  outcome — a file mapped to the wrong module produces exactly that — and
 *  paging 100,000 of them into the browser to build a file would take the tab
 *  down. The CSV says when it stopped. */
const CSV_MAX_ROWS = 5_000;

export function ImportRun({
  slug,
  labelPlural,
  batch,
  onClose,
  onImported,
  trackPrefix,
}: ImportRunProps) {
  const [progress, setProgress] = useState<ImportProgressWire>({
    id: batch.id,
    status: batch.status,
    total: batch.total,
    succeeded: batch.succeeded,
    failed: batch.failed,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
  });
  const [pollError, setPollError] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ rows: ImportRowErrorWire[]; total: number } | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvNote, setCsvNote] = useState<string | null>(null);

  // The callback is called from inside a polling loop that must NOT restart
  // when the parent re-renders; a ref keeps it live without joining the deps.
  const onImportedRef = useRef(onImported);
  useEffect(() => {
    onImportedRef.current = onImported;
  }, [onImported]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      try {
        const res = await api<{ batch: ImportBatchWire; progress: ImportProgressWire }>(
          `/api/modules/${slug}/imports/${batch.id}`,
        );
        if (cancelled) return;
        setProgress(res.progress);
        setPollError(null);

        if (isRunningStatus(res.progress.status)) {
          // setTimeout rather than setInterval: a slow answer must not stack
          // requests behind itself, which is how a struggling server gets a
          // queue of polls from every open tab.
          timer = setTimeout(() => void tick(), POLL_MS);
          return;
        }

        if (res.progress.succeeded > 0) onImportedRef.current();
        if (res.progress.failed > 0) {
          const page = await api<{ rows: ImportRowErrorWire[]; total: number }>(
            `/api/modules/${slug}/imports/${batch.id}/errors?page=1&pageSize=50`,
          );
          if (!cancelled) setErrors(page);
        }
      } catch (err) {
        if (cancelled) return;
        // A failed poll is not a failed import — the worker neither knows nor
        // cares that this tab lost the network. Say so, back off, keep going.
        setPollError(messageOf(err, 'Could not read the import’s progress just now.'));
        timer = setTimeout(() => void tick(), POLL_MS * 2);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [slug, batch.id]);

  const running = isRunningStatus(progress.status);
  /** Enqueued but not yet claimed. `startedAt` is written by the worker the
   *  moment it takes the batch, so its absence is the only honest signal that
   *  nothing has begun — the status is PENDING either way. */
  const queued = running && progress.startedAt === null;
  const processed = progress.succeeded + progress.failed;
  const percent = progress.total === 0 ? 0 : Math.round((processed / progress.total) * 100);
  // While the worker is still going this is "not reached yet"; once it has
  // finished, the same arithmetic IS the skipped count — an UPDATE_ONLY row
  // that matched nothing, which is a correct outcome and not a failure.
  const remainder = Math.max(progress.total - processed, 0);

  async function downloadErrors(): Promise<void> {
    setCsvBusy(true);
    setCsvNote(null);
    try {
      const gathered: ImportRowErrorWire[] = [];
      let page = 1;
      let total = 0;

      // Paged rather than asked for whole: the endpoint is paginated precisely
      // because the failure set can be the entire file.
      for (;;) {
        const res = await api<{ rows: ImportRowErrorWire[]; total: number }>(
          `/api/modules/${slug}/imports/${batch.id}/errors?page=${page}&pageSize=${ERRORS_PAGE_SIZE}`,
        );
        total = res.total;
        gathered.push(...res.rows);
        if (res.rows.length < ERRORS_PAGE_SIZE || gathered.length >= CSV_MAX_ROWS) break;
        page += 1;
      }

      const rows: string[][] = [
        ['Row', 'Error', ...batch.headers],
        ...gathered.map((row) => [
          String(row.rowNumber),
          row.error,
          ...batch.headers.map((header) => row.raw[header] ?? ''),
        ]),
      ];
      downloadCsv(`${batch.filename.replace(/\.[^.]+$/, '')}-failed-rows.csv`, toCsv(rows));

      if (gathered.length < total) {
        setCsvNote(
          `That file holds the first ${formatCount(gathered.length)} of ${formatCount(total)} failed rows. ` +
            'Fix those, re-import, and the rest will be a shorter list.',
        );
      }
    } catch (err) {
      setCsvNote(messageOf(err, 'The error report could not be downloaded.'));
    } finally {
      setCsvBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 px-8 py-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <div>
            <h3 className="text-lg font-medium text-heading">
              {queued
                ? `Queued — waiting for a worker`
                : running
                  ? `Importing ${labelPlural}`
                  : `Import finished`}
            </h3>
            <p className="mt-1 truncate text-sm text-body" title={batch.filename}>
              {batch.filename} · {formatCount(progress.total)} staged rows
            </p>
          </div>

          <div>
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Rows processed"
              className="h-2 w-full overflow-hidden rounded-pill bg-subtle"
            >
              <div
                className="h-full rounded-pill bg-primary transition-[width] duration-500"
                style={{ width: `${percent}%` }}
              />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-overline uppercase text-body">Imported</dt>
                <dd className="text-lg font-medium text-heading">
                  {formatCount(progress.succeeded)}
                </dd>
              </div>
              <div>
                <dt className="text-overline uppercase text-body">Failed</dt>
                <dd
                  className={`text-lg font-medium ${progress.failed > 0 ? 'text-error' : 'text-heading'}`}
                >
                  {formatCount(progress.failed)}
                </dd>
              </div>
              <div>
                <dt className="text-overline uppercase text-body">
                  {running ? 'Remaining' : 'Skipped'}
                </dt>
                <dd className="text-lg font-medium text-heading">{formatCount(remainder)}</dd>
              </div>
              <div>
                <dt className="text-overline uppercase text-body">Status</dt>
                <dd className="text-lg font-medium text-heading">
                  {progress.status.toLowerCase()}
                </dd>
              </div>
            </dl>
            {!running && remainder > 0 ? (
              <p className="mt-2 text-xs text-body">
                A skipped row is one that matched nothing to update. It is not a failure — with
                “Update existing only” it is the expected outcome for a row that is genuinely new.
              </p>
            ) : null}
          </div>

          {/* The promise this screen has to keep: the work is in the worker,
              so the overlay is a viewer and closing it changes nothing. */}
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-body">
            {queued
              ? 'The batch is on the queue and a worker will take it shortly. Nothing has been written yet. You can close this window — the import does not depend on it being open, and the recent imports list on the upload stage brings you back to it.'
              : running
                ? 'This import is running in the background worker. You can close this window — it will not stop, and the recent imports list on the upload stage brings you back to it.'
                : 'Nothing is left running. The records that imported are in the list, each with its own timeline entry.'}
          </p>

          {progress.status === 'FAILED' ? (
            <p role="alert" className="rounded border border-error bg-surface px-4 py-3 text-sm text-heading">
              The batch itself failed, which is different from rows failing — the file could not be
              processed rather than some of its rows being rejected. Nothing further will be
              written. Re-uploading the file is the fix.
            </p>
          ) : null}

          {pollError !== null ? (
            <p role="status" className="text-xs text-body">
              {pollError} Still trying — the import is unaffected by this.
            </p>
          ) : null}

          {errors !== null && errors.rows.length > 0 ? (
            <div className="rounded-lg border border-border bg-surface">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h4 className="text-sm font-medium text-heading">
                  Rows that did not import ({formatCount(errors.total)})
                </h4>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={csvBusy}
                  onClick={() => void downloadErrors()}
                  data-track={`${trackPrefix}.errors.csv`}
                >
                  Download as CSV
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-background">
                      {/* The row number is the one the user sees in their own
                          spreadsheet: 1-based, counted from the first DATA
                          row. Anything else sends them hunting. */}
                      <th className="px-4 py-2 text-left font-medium text-heading">Row</th>
                      <th className="px-4 py-2 text-left font-medium text-heading">Why it failed</th>
                      <th className="px-4 py-2 text-left font-medium text-heading">What was in it</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.rows.map((row) => {
                      const preview = batch.headers
                        .map((header) => row.raw[header])
                        .filter((value): value is string => typeof value === 'string' && value !== '')
                        .join(' · ');
                      return (
                        <tr key={row.rowNumber} className="border-b border-border last:border-0">
                          <td className="px-4 py-2 font-medium text-heading">{row.rowNumber}</td>
                          <td className="px-4 py-2 text-error">{row.error}</td>
                          <td className="max-w-[28rem] px-4 py-2 text-body">
                            <span className="block truncate" title={preview}>
                              {preview}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {errors.total > errors.rows.length ? (
                <p className="border-t border-border px-4 py-2 text-xs text-body">
                  Showing the first {errors.rows.length} of {formatCount(errors.total)}. The CSV
                  gathers up to {formatCount(CSV_MAX_ROWS)}.
                </p>
              ) : null}

              {csvNote !== null ? (
                <p role="status" className="border-t border-border px-4 py-2 text-xs text-body">
                  {csvNote}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <footer className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-surface px-8 py-4">
        <span className="mr-auto text-xs text-body">
          {running
            ? 'Closing this window does not cancel the import.'
            : `${formatCount(progress.succeeded)} ${labelPlural.toLowerCase()} imported.`}
        </span>
        <Button
          variant={running ? 'secondary' : 'primary'}
          onClick={onClose}
          data-track={running ? `${trackPrefix}.close` : `${trackPrefix}.done`}
        >
          {running ? 'Close and let it run' : 'Done'}
        </Button>
      </footer>
    </div>
  );
}
