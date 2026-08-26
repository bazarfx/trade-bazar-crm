'use client';

import { useState, type ReactNode } from 'react';
import { SearchIcon } from '../icons';
import { FileIcon, ModuleIcon, TickIcon } from './icons';
import { RailRow, TabStrip, type CountedTab } from './stage-strip';
import { formatCount, type StagedImportWire } from './wire';

/**
 * Stage 3 — Module-File Mapping.
 *
 * IN THE PANEL, in two columns. Frames [15] and [17] carry no `Pop up`
 * AUTO-LAYOUT node, which is what an earlier reading here took for "no panel";
 * the panel is there as a plain `Rectangle 25` @272,152, 1152x544, `#ffffff`,
 * 1px `#e5e7eb`, `r:8`. Everything below is measured off frame [17] in the
 * 1440 frame's own coordinates:
 *
 *   rail          x=284, 161 wide — three counted groups at pitch 28
 *                 ("Mapped Files", "Unmapped Files", "Unsupported Files"),
 *                 each opening 6px onto 161x22 file chips (`#f6f8fa`, `r:4`,
 *                 pad 2, gap 6, a 16 file icon and the name at Regular 8px)
 *   `Games`       x=469 y=164, 500x36 — the segmented tab bar, see TabStrip
 *   search        x=1159 y=164, 253x38, pad 7/12, a 20 icon + Regular 12px;
 *                 its right edge is 1412, the panel's 12px inset
 *   module card   x=469 y=210, 120x124 `#ffffff` `r:8`, with a 120x90
 *                 `#f6f8fa` head, a 20x20 `#16a34a` tick badge flush
 *                 top-right, a 24 module glyph centred, the module name at
 *                 Medium 10px and the file count at Medium 8px
 *   separator     x=457…1424 y=608, 967 wide — the RIGHT column only, and
 *                 FLUSH to the panel's right edge rather than inset
 *   footer        y=632, ending at x=1400 — a 24px inset, not the 12 the text
 *                 rows use
 *
 * WHAT THE STAGE MEANS HERE. The file's nine files and four modules belong to
 * Zoho's multi-file upload, where one drop can contain a Leads export, a
 * Contacts export and a .vcf nobody meant to include. Ours stages ONE file
 * into ONE module: the module comes from the list screen the import was
 * started from, and the file was parsed before this stage could be reached.
 *
 * Every count below is therefore computed over a one-element set rather than
 * written as a literal — the day a second file can be staged, these rows are
 * already telling the truth. None of them is a constant dressed as a tally.
 */

export interface StageModuleFileProps {
  labelPlural: string;
  staged: StagedImportWire;
  /** errors and notices the wizard owns, drawn above the two columns */
  alerts: ReactNode;
  /** the measured 222x40 footer row; the stage places it, the wizard owns it */
  footer: ReactNode;
  trackPrefix: string;
}

export function StageModuleFile({
  labelPlural,
  staged,
  alerts,
  footer,
  trackPrefix,
}: StageModuleFileProps) {
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');

  const modules = [
    {
      label: labelPlural,
      file: staged.batch.filename,
      rows: staged.batch.total,
      columns: staged.headers.length,
      mapped: true,
    },
  ];
  const mapped = modules.filter((m) => m.mapped);
  const unmapped = modules.filter((m) => !m.mapped);

  const tabs: CountedTab[] = [
    { id: 'all', label: 'All Modules', count: modules.length },
    { id: 'mapped', label: 'Mapped Modules', count: mapped.length },
    { id: 'unmapped', label: 'UnMapped Modules', count: unmapped.length },
  ];

  const shown = (tab === 'mapped' ? mapped : tab === 'unmapped' ? unmapped : modules).filter((m) =>
    query.trim() === '' ? true : m.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  /** The file chip the rail's "Mapped Files" group opens onto — `Frame
   *  482726` @284,186, 161x22, pad 2 on every side, gap 6. */
  const fileChip = (
    <div className="flex h-[22px] items-center gap-[6px] rounded border border-border bg-background p-[2px]">
      <FileIcon className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 truncate text-[8px] text-body" title={staged.batch.filename}>
        {staged.batch.filename}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {alerts}
      <div className="flex gap-3">
        {/* The rail — 161 wide, groups at gap 12, each group's contents 6
            below its heading. */}
        <aside className="flex w-[161px] shrink-0 flex-col gap-3">
          <RailRow label="Mapped Files" count={1} track={`${trackPrefix}.rail.mapped`}>
            {fileChip}
          </RailRow>
          <RailRow label="Unmapped Files" count={0} track={`${trackPrefix}.rail.unmapped`} />
          <RailRow label="Unsupported Files" count={0} track={`${trackPrefix}.rail.unsupported`} />
        </aside>

        {/* The right column — x=457…1424, 967 wide. `-mr-3` gives back the
            panel's 12px of right padding: the separator and the table are
            drawn FLUSH to the panel's right edge, while the rows inside carry
            their own 12px inset (`px-3`) so the tab bar starts at x=469 and
            the search box ends at x=1412. */}
        <div className="-mr-3 flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 px-3">
            <TabStrip
              tabs={tabs}
              active={tab}
              onSelect={setTab}
              label="Module file mapping"
              track={`${trackPrefix}.modules.tab`}
            />
            {/* 253x38, pad 7/12, gap 6 — a 20 icon and Regular 12px. */}
            <div className="flex h-[38px] w-[253px] shrink-0 items-center gap-[6px] rounded border border-border bg-surface px-3 py-[7px]">
              <SearchIcon className="h-5 w-5 shrink-0 text-body" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search modules"
                className="min-w-0 flex-1 bg-transparent text-xs text-heading placeholder:text-body focus:outline-none"
                data-track={`${trackPrefix}.modules.search`}
              />
            </div>
          </div>

          {/* The cards — 120x124, laid out from x=469 (the column's 12px
              inset) and 24 below the tab row. */}
          <div className="mt-6 flex flex-wrap gap-3 px-3">
            {shown.map((row) => (
              <div
                key={row.label}
                className="flex h-[124px] w-[120px] flex-col rounded-md border border-border bg-surface"
              >
                <div className="relative flex h-[90px] items-center justify-center rounded-md bg-background">
                  <ModuleIcon className="h-6 w-6 text-body" />
                  {row.mapped ? (
                    // 20x20 `r:8` `#16a34a` with a white `charm:tick`. `--accent`
                    // is the token that colour belongs to; the tailwind
                    // `success` key is a different green (#34c759).
                    <span
                      className="absolute right-px top-px flex h-5 w-5 items-center justify-center rounded-md bg-[var(--accent)]"
                      title={`${row.file} feeds ${row.label}`}
                    >
                      <TickIcon className="h-4 w-4 text-surface" />
                    </span>
                  ) : null}
                </div>
                <span className="truncate px-1 pt-1 text-[10px] font-medium leading-[13px] text-body">
                  {row.label}
                </span>
                <span className="px-[14px] text-[8px] font-medium leading-[9px] text-body">
                  1 File
                </span>
              </div>
            ))}
            {shown.length === 0 ? (
              <p className="text-[10px] leading-[15px] text-body">
                No module matches “{query}”.
              </p>
            ) : null}
          </div>

          {/* What the one card cannot say on its own, at the file's own 10px.
              It is the whole reason this stage is not skippable: an import
              started from the wrong list feeds the wrong module. */}
          <p className="mt-6 px-3 text-[10px] leading-[15px] text-body">
            {staged.batch.filename} — {formatCount(staged.batch.total)} rows,{' '}
            {staged.headers.length} columns — feeds <strong>{labelPlural}</strong>, because that is
            the list this import was started from. To load a file into a different module, start the
            import from that module’s own list.
          </p>

          {/* `Separator` @457,608 — the RIGHT column's full 967, not the
              panel's 1104, and 24 above the footer. */}
          <div className="mt-6 h-px shrink-0 bg-border" aria-hidden="true" />
          {/* `Frame 482729` @698,632 — the three 222x40 buttons end at x=1400,
              a 24px inset from the panel edge rather than the 12 the text rows
              take. */}
          <div className="mt-6 pr-6">{footer}</div>
        </div>
      </div>
    </div>
  );
}
