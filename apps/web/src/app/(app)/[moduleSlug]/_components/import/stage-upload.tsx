'use client';

import { useEffect, useRef, useState } from 'react';
import {
  IMPORT_ACCEPT,
  IMPORT_CHARSETS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_SUPPORTED_EXTENSIONS,
  type ImportCharset,
} from '@crm/shared';
import { api } from '@/lib/client-api';
import { Button, FieldLabel, Select, cn } from '@/components/ui';
import {
  CHARSET_LABELS,
  formatBytes,
  formatCount,
  isRunningStatus,
  type ImportBatchWire,
  type StagedImportWire,
} from './wire';

/**
 * Stage 1 — Upload.
 *
 * The file's frame offers a drop target, a Browse Files button, a Charset
 * selector and a list of uploaded files. Three things in it are not built, and
 * each is a deliberate omission rather than an oversight:
 *
 *  - **VCF and XLS.** The file lists four formats. A .vcf is a contact card
 *    with no columns at all and .xls is the pre-2007 BIFF binary, a different
 *    format from .xlsx needing a second parser. `IMPORT_SUPPORTED_EXTENSIONS`
 *    is the one place that decides, and the copy below reads from it — so the
 *    screen can never promise a format the parser refuses.
 *  - **More than one file per import.** The design's "You can Upload More then
 *    one file" belongs to Zoho's multi-file flow, which stage 3 then maps to
 *    several modules. Our upload stages ONE file into ONE module; drawing a
 *    multi-file list we cannot honour would be theatre.
 *  - **"Download Demo CSV".** A demo file has to be generated from this
 *    module's own fields to be worth anything, and no endpoint serves one yet.
 *    A dead button is worse than no button.
 */

export interface StageUploadProps {
  slug: string;
  labelPlural: string;
  charset: ImportCharset;
  onCharset: (charset: ImportCharset) => void;
  staged: StagedImportWire | null;
  /** the file the user picked, held so a charset change can re-read the same
   *  bytes — the batch records a size nowhere and cannot be re-decoded */
  file: File | null;
  uploading: boolean;
  onFile: (file: File) => void;
  /** re-upload the held file with the charset now selected */
  onReread: () => void;
  /** jump to the progress view of a batch that is already running */
  onResume: (batch: ImportBatchWire) => void;
  trackPrefix: string;
}

/** How many sample rows the preview shows. The point is to catch a wrong
 *  charset or a shifted header row by eye, which takes five rows, not fifty. */
const PREVIEW_ROWS = 5;

export function StageUpload({
  slug,
  labelPlural,
  charset,
  onCharset,
  staged,
  file,
  uploading,
  onFile,
  onReread,
  onResume,
  trackPrefix,
}: StageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [recent, setRecent] = useState<ImportBatchWire[]>([]);

  // Previous imports of this module, so the promise made on the progress
  // screen — "closing this window does not stop the import" — has a way back.
  // Only while nothing is staged: once a file is up, this stage is about that
  // file. A failure is silent on purpose; the history is a convenience and a
  // role that cannot read it must not be shown an error about it.
  useEffect(() => {
    if (staged !== null) return;
    let cancelled = false;
    api<{ batches: ImportBatchWire[] }>(`/api/modules/${slug}/imports`)
      .then((res) => {
        if (!cancelled) setRecent(res.batches);
      })
      .catch(() => {
        if (!cancelled) setRecent([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, staged]);

  /** Hand the first file over. Returns whether there was one — a drag that
   *  ends on the zone carrying nothing is not an upload. */
  function take(files: FileList | null): boolean {
    const file = files?.[0];
    if (!file || uploading) return false;
    onFile(file);
    return true;
  }

  const formats = IMPORT_SUPPORTED_EXTENSIONS.map((e) => e.replace('.', '').toUpperCase()).join(
    ' and ',
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-medium text-heading">Upload the {labelPlural}</h3>
        <p className="mt-1 text-sm text-body">
          One file, one module. Every row it holds is validated, assigned and logged exactly as a
          record typed into the create form is — an import is not a side door around any of that.
        </p>
      </div>

      <div
        ref={zoneRef}
        onDragOver={(e) => {
          // Without preventDefault on BOTH dragover and drop the browser
          // navigates to the file instead of handing it over.
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!take(e.dataTransfer.files)) return;
          // The delegated interaction listener watches click, change and
          // submit — a drop is none of the three, so a dropped file would be
          // the one way into this wizard that leaves no trace in
          // InteractionLog. Re-announcing the gesture as a `change` on the
          // zone lets the ONE listener record it under this element's own
          // `data-track`, rather than growing a second logger here.
          zoneRef.current?.dispatchEvent(new Event('change', { bubbles: true }));
        }}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-primary bg-subtle' : 'border-border bg-surface',
        )}
        data-track={`${trackPrefix}.file.drop`}
      >
        <p className="text-sm font-medium text-heading">Drag &amp; Drop the files here</p>
        <p className="text-xs text-body">- Or -</p>
        <Button
          variant="secondary"
          loading={uploading}
          onClick={() => inputRef.current?.click()}
          data-track={`${trackPrefix}.file.browse`}
        >
          {uploading ? 'Reading the file…' : 'Browse Files'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={IMPORT_ACCEPT}
          className="sr-only"
          // Cleared after every pick so choosing the SAME file twice — after a
          // failed parse, say — still fires a change event.
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
          data-track={`${trackPrefix}.file.pick`}
        />
        <p className="text-xs text-body">
          Supported file formats are {formats}. The design also lists VCF and XLS; neither can be
          read — a .vcf has no columns and .xls is a different binary format from .xlsx.
        </p>
        <p className="text-xs text-body">
          A file can be at most {formatBytes(IMPORT_MAX_BYTES)} and {formatCount(IMPORT_MAX_ROWS)}{' '}
          rows. A larger export has to be split into two files, which is a real answer — pretending
          to accept it and failing halfway is not.
        </p>
      </div>

      <div className="max-w-sm">
        <FieldLabel htmlFor="import-charset">Charset</FieldLabel>
        <div className="flex items-center gap-2">
          <Select
            id="import-charset"
            value={charset}
            onChange={(e) => onCharset(e.target.value as ImportCharset)}
            data-track={`${trackPrefix}.charset.select`}
          >
            {IMPORT_CHARSETS.map((value) => (
              <option key={value} value={value}>
                {CHARSET_LABELS[value]}
              </option>
            ))}
          </Select>
          {/* Stays live after the upload, and re-reads the same file when it
              changes. Bytes are decoded ONCE, so the preview below is the only
              moment a wrong charset is visible — a selector locked at that
              moment would show the mangling and offer no way to fix it. */}
          {staged !== null && file !== null ? (
            <Button
              variant="secondary"
              size="sm"
              loading={uploading}
              onClick={onReread}
              data-track={`${trackPrefix}.charset.reread`}
            >
              Re-read
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-body">
          Bytes are decoded once, on upload, so this is chosen before the file goes up rather than
          after. A byte-order mark inside the file overrides the choice — the file saying what it
          is beats a dropdown. XLSX carries its own encoding, so this applies to CSV only.
        </p>
      </div>

      {staged ? (
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
            <h4 className="text-sm font-medium text-heading">Uploaded File (1)</h4>
            <span className="text-xs text-body">
              {formatCount(staged.batch.total)} rows · {staged.headers.length} columns · decoded as{' '}
              {staged.batch.charset}
            </span>
          </div>

          <div className="flex items-baseline gap-2 px-4 py-3 text-sm">
            {/* The name is the user's own filename and has no length limit, so
                it truncates and never wraps — the size beside it must stay on
                the same line to read as one file. */}
            <span
              className="min-w-0 truncate font-medium text-heading"
              title={staged.batch.filename}
            >
              {staged.batch.filename}
            </span>
            {file !== null ? (
              <span className="shrink-0 text-body">— ({formatBytes(file.size)})</span>
            ) : null}
          </div>

          {staged.truncated ? (
            <p role="alert" className="mx-4 mb-3 rounded border border-warning px-3 py-2 text-xs text-heading">
              That file holds {formatCount(staged.fileRows)} rows and one batch stages at most{' '}
              {formatCount(IMPORT_MAX_ROWS)}. The first {formatCount(staged.batch.total)} were
              staged and the rest were left out — import the remainder as a second file.
            </p>
          ) : null}

          {/* The preview earns its place: a Windows-1252 export read as UTF-8
              mangles every accented name silently, and this is the only moment
              a human can see that before 40,000 rows are written. */}
          <div className="overflow-x-auto border-t border-border">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-background">
                  {staged.headers.map((header) => (
                    <th
                      key={header}
                      title={header}
                      className="max-w-[16rem] truncate px-3 py-2 text-left font-medium text-heading"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staged.sample.slice(0, PREVIEW_ROWS).map((row, index) => (
                  // The row's position IS its identity here: two identical
                  // duplicate rows are exactly what an import file contains.
                  <tr key={index} className="border-b border-border last:border-0">
                    {staged.headers.map((header) => (
                      <td
                        key={header}
                        title={row[header] ?? ''}
                        className="max-w-[16rem] truncate px-3 py-2 text-body"
                      >
                        {row[header] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : recent.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <h4 className="border-b border-border px-4 py-3 text-sm font-medium text-heading">
            Recent imports
          </h4>
          <ul>
            {recent.slice(0, 5).map((batch) => (
              <li
                key={batch.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2 last:border-0"
              >
                <span className="min-w-0 truncate text-sm text-heading" title={batch.filename}>
                  {batch.filename}
                </span>
                <span className="text-xs text-body">
                  {batch.status.toLowerCase()} · {formatCount(batch.succeeded)} imported ·{' '}
                  {formatCount(batch.failed)} failed
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onResume(batch)}
                  data-track={`${trackPrefix}.recent.open`}
                >
                  {isRunningStatus(batch.status) ? 'View progress' : 'View result'}
                </Button>
              </li>
            ))}
          </ul>
          {/* Said out loud because the batch row genuinely cannot tell the two
              apart: staging writes PENDING, and the worker only moves it to
              RUNNING when it claims the job. A wizard closed at stage 3 and a
              batch waiting in the queue look identical from here. */}
          <p className="border-t border-border px-4 py-2 text-xs text-body">
            A batch still marked pending was either never submitted or is waiting for the worker to
            pick it up. Neither is doing anything to your records yet.
          </p>
        </div>
      ) : null}
    </div>
  );
}
