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
import { Button, cn } from '@/components/ui';
import { ChevronDownIcon } from '../icons';
import { FileIcon } from './icons';
import { CountBadge } from './stage-strip';
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
 * MEASURED off two frames of the family, which draw two different states of
 * the same stage. Nothing here is a proportion or a guess:
 *
 *   EMPTY (frame [1], `Pop up` 1152x497)
 *     `Text Area`  1104x303  flex-col gap:8, children 627 wide and CENTRED
 *     ├ `Input Base` 627x171  #ffffff / #e5e7eb / r:4 / pad 10-12  ← drop target
 *     │   `clarity:file-line` 28 (#00667a), "Drag & Drop the files here" 10px,
 *     │   " - Or - " 10px, `Buttons` 65x18 "Brouse Files", formats line 10px
 *     ├ `Input Base` 627x58   #edf2fe / #e5e7eb / r:4   ← the two limits
 *     └ `Input Base` 627x58   #16a34a @6% / #16a34a     ← "Download Demo CSV"
 *
 *   FILLED (frames [2] and [4], `Pop up` 1152x386)
 *     `Text Area`  1104x180  flex-col gap:8, children 463 wide and CENTRED
 *     ├ `Input Base` 463x131  ← "Uploaded File" + the 16x16 count badge, the
 *     │   439x28 file chip (#f6f8fa), the re-browse row, the formats line
 *     └ `Text Area` 463x41 flex-row gap:8  ← `Label` 76 "Charset" (Regular
 *         14px #6b7280) + `Input Base` 379x41 showing "Auto Detect"
 *
 * Three things the file draws are NOT built, and each is a deliberate omission
 * rather than an oversight:
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
 *  - **"Download Demo CSV"** — the third card above. A demo file has to be
 *    generated from this module's own fields to be worth anything, and no
 *    endpoint serves one yet. A dead button is worse than no button.
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

/**
 * `Buttons` 65x18 — pad 8/18, `bg #f6f8fa`, `border #00667a 1px`, `r:4`, label
 * Inter Medium **8px** `#00667a`. 8px is below every step of the type scale,
 * so it is stated inline with the node named, the same way `h-[38px]` is.
 */
const BROWSE_BUTTON =
  'inline-flex h-[18px] shrink-0 items-center justify-center rounded border border-primary ' +
  'bg-background px-[18px] text-[8px] font-medium leading-none text-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

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
    const picked = files?.[0];
    if (!picked || uploading) return false;
    onFile(picked);
    return true;
  }

  const formats = IMPORT_SUPPORTED_EXTENSIONS.map((e) => e.replace('.', '').toUpperCase()).join(
    ' and ',
  );

  /** The hidden native input every browse affordance opens. One instance: two
   *  would be two ids for one job, and the drop zone and the filled card never
   *  render at the same time. */
  const picker = (
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
  );

  return (
    // `Text Area` — flex-col gap:8, its children CENTRED at a fixed measured
    // width inside the 1104 content column.
    <div className="flex flex-col items-center gap-2">
      {staged === null ? (
        <>
          {/* `Input Base` 627x171 — the drop target. Not `border-dashed`: the
              file draws a solid 1px #e5e7eb, and the dashed edge was this
              screen's own invention. The dragging state recolours it, which is
              the one thing a static frame cannot show. */}
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
              // submit — a drop is none of the three, so a dropped file would
              // be the one way into this wizard that leaves no trace in
              // InteractionLog. Re-announcing the gesture as a `change` on the
              // zone lets the ONE listener record it under this element's own
              // `data-track`, rather than growing a second logger here.
              zoneRef.current?.dispatchEvent(new Event('change', { bubbles: true }));
            }}
            className={cn(
              'flex h-[171px] w-[627px] max-w-full flex-col items-center justify-center gap-[10px]',
              'rounded border px-3 py-[10px] text-center transition-colors',
              dragging ? 'border-primary bg-background' : 'border-border bg-surface',
            )}
            data-track={`${trackPrefix}.file.drop`}
          >
            {/* `Frame 482726` — icon 28, gap 6, then the line. */}
            <div className="flex flex-col items-center gap-[6px]">
              <FileIcon className="h-7 w-7 text-primary" />
              <p className="text-[10px] leading-[15px] text-body">Drag &amp; Drop the files here</p>
            </div>
            <p className="text-[10px] leading-[15px] text-body"> - Or - </p>
            {/* `Frame 482727` — the button, gap 6, then the formats line. */}
            <div className="flex flex-col items-center gap-[6px]">
              <button
                type="button"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
                className={BROWSE_BUTTON}
                data-track={`${trackPrefix}.file.browse`}
              >
                {uploading ? 'Reading the file…' : 'Browse Files'}
              </button>
              <p className="text-[10px] leading-[15px] text-body">
                Supported file formats are {formats}
              </p>
            </div>
            {picker}
          </div>

          {/* `Input Base` 627x58, `bg #edf2fe` (= --globalcolors-blue-10),
              `border #e5e7eb`, `r:4`, two 10px lines at gap 4. The numbers are
              read from the shared caps, never written out — the file's "25 MB
              / 100,000 records" is Zoho's limit, not ours. */}
          <div className="flex w-[627px] max-w-full flex-col gap-1 rounded border border-border px-3 py-[10px] bg-[var(--globalcolors-blue-10)]">
            <p className="text-[10px] leading-[15px] text-body">
              A file can be at most {formatBytes(IMPORT_MAX_BYTES)} and you can import at most{' '}
              {formatCount(IMPORT_MAX_ROWS)} records to the {labelPlural} module.
            </p>
            <p className="text-[10px] leading-[15px] text-body">
              One file per import. A larger export has to be split and imported as two files.
            </p>
          </div>
        </>
      ) : (
        <>
          {/* `Input Base` 463x131 — the uploaded-file card. Height follows its
              content here because the preview beneath it does too; only the
              463 is fixed. */}
          <div className="flex w-[463px] max-w-full flex-col gap-[10px] rounded border border-border bg-surface px-3 py-[10px]">
            {/* `Frame 482731` — label, gap 6, the 16x16 count badge. */}
            <div className="flex items-center gap-[6px]">
              <span className="text-[10px] leading-[15px] text-body">Uploaded File </span>
              <CountBadge count={1} />
            </div>

            {/* `Frame 482728` 439x28 — `bg #f6f8fa`, `border #e5e7eb`, `r:4`,
                pad 2/8, a 16 file icon and the name at Regular 8px. */}
            <div className="flex h-7 items-center gap-[6px] rounded border border-border bg-background px-2 py-[2px]">
              <FileIcon className="h-4 w-4 shrink-0 text-primary" />
              {/* The name is the user's own filename with no length limit, so
                  it truncates and never wraps — the size beside it must stay on
                  the same line to read as one file. */}
              <span className="min-w-0 truncate text-[8px] text-body" title={staged.batch.filename}>
                {staged.batch.filename}
                {file !== null ? ` - (${formatBytes(file.size)})` : ''}
              </span>
              <span className="ml-auto shrink-0 text-[8px] text-body">
                {formatCount(staged.batch.total)} rows · {staged.headers.length} columns
              </span>
            </div>

            {/* `Frame 482730` — the re-browse row, then the formats line. */}
            <div className="flex items-center gap-[10px]">
              <span className="text-[10px] leading-[15px] text-body">
                Drag and drop the files here, -or-{' '}
              </span>
              <button
                type="button"
                disabled={uploading}
                onClick={() => inputRef.current?.click()}
                className={BROWSE_BUTTON}
                data-track={`${trackPrefix}.file.browse`}
              >
                {uploading ? 'Reading the file…' : 'Browse Files'}
              </button>
            </div>
            <p className="text-[10px] leading-[15px] text-body">
              Supported file formats are {formats}
            </p>
            {picker}
          </div>

          {staged.truncated ? (
            <p
              role="alert"
              className="w-[463px] max-w-full rounded border border-warning px-3 py-2 text-[10px] leading-[15px] text-heading"
            >
              That file holds {formatCount(staged.fileRows)} rows and one batch stages at most{' '}
              {formatCount(IMPORT_MAX_ROWS)}. The first {formatCount(staged.batch.total)} were
              staged and the rest were left out — import the remainder as a second file.
            </p>
          ) : null}

          {/* `Text Area` 463x41 flex-row gap:8 — `Label` 76 + `Input Base` 379.
              A native select rather than the `Select` primitive: that
              primitive's tones are 36 (canvas) and 34 (form) tall on their own
              fills, and overriding a height or a background through
              `className` resolves by stylesheet order rather than by attribute
              order — the trap `PanelBody` documents. Same element, same
              events, same keyboard behaviour; only the measured chrome
              differs. */}
          <div className="flex w-[463px] max-w-full items-center gap-2">
            <label
              htmlFor="import-charset"
              className="w-[76px] shrink-0 text-sm leading-[21px] text-body"
            >
              Charset
            </label>
            <div className="relative min-w-0 flex-1">
              <select
                id="import-charset"
                value={charset}
                onChange={(e) => onCharset(e.target.value as ImportCharset)}
                className={
                  'h-[41px] w-full appearance-none rounded border border-border bg-surface ' +
                  'px-3 pr-9 text-sm text-body focus:border-primary focus:outline-none ' +
                  'focus:ring-1 focus:ring-primary'
                }
                data-track={`${trackPrefix}.charset.select`}
              >
                {IMPORT_CHARSETS.map((value) => (
                  <option key={value} value={value}>
                    {CHARSET_LABELS[value]}
                  </option>
                ))}
              </select>
              {/* `Icon / Chevron` 14x14, flush right inside the 12px inset. */}
              <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-heading" />
            </div>
            {/* Stays live after the upload, and re-reads the same file when it
                changes. Bytes are decoded ONCE, so the preview below is the
                only moment a wrong charset is visible — a selector locked at
                that moment would show the mangling and offer no way to fix
                it. */}
            {file !== null ? (
              <button
                type="button"
                disabled={uploading}
                onClick={onReread}
                className={BROWSE_BUTTON}
                data-track={`${trackPrefix}.charset.reread`}
              >
                Re-read
              </button>
            ) : null}
          </div>

          {/* The preview earns its place and is the one block with no node in
              the file: a Windows-1252 export read as UTF-8 mangles every
              accented name silently, and this is the only moment a human can
              see that before 40,000 rows are written. Kept to the file's own
              table metrics — header 45 tall on #f6f8fa, rows 28, cells 10/12. */}
          <div className="w-full overflow-x-auto rounded border border-border bg-surface">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="h-[45px] border-b border-border bg-background">
                  {staged.headers.map((header) => (
                    <th
                      key={header}
                      title={header}
                      className="max-w-[16rem] truncate px-3 text-left text-sm font-normal text-heading"
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
                  <tr key={index} className={index % 2 === 1 ? 'bg-background' : 'bg-surface'}>
                    {staged.headers.map((header) => (
                      <td
                        key={header}
                        title={row[header] ?? ''}
                        className="h-7 max-w-[16rem] truncate px-3 text-sm text-body"
                      >
                        {row[header] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {staged === null && recent.length > 0 ? (
        <div className="w-[627px] max-w-full rounded border border-border bg-surface">
          <h4 className="border-b border-border px-3 py-[10px] text-[10px] font-medium leading-[15px] text-heading">
            Recent imports
          </h4>
          <ul>
            {recent.slice(0, 5).map((batch) => (
              <li
                key={batch.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-0"
              >
                <span className="min-w-0 truncate text-[10px] text-heading" title={batch.filename}>
                  {batch.filename}
                </span>
                <span className="text-[10px] text-body">
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
          <p className="border-t border-border px-3 py-2 text-[10px] leading-[15px] text-body">
            A batch still marked pending was either never submitted or is waiting for the worker to
            pick it up. Neither is doing anything to your records yet.
          </p>
        </div>
      ) : null}
    </div>
  );
}
