'use client';

import { useState } from 'react';
import { TabStrip, type CountedTab } from './stage-strip';
import { formatCount, type StagedImportWire } from './wire';

/**
 * Stage 3 — Module-File Mapping.
 *
 * The file draws four tabs — All Modules · Mapped Modules · UnMapped Modules ·
 * Unsupported Files — each carrying a count, over a list of nine files. That
 * belongs to Zoho's multi-file upload, where one drop can contain a Leads
 * export, a Contacts export and a .vcf nobody meant to include, and the stage
 * exists to say which file feeds which module.
 *
 * Ours stages ONE file into ONE module: the module comes from the list screen
 * the import was started from, and the file was parsed before this stage could
 * be reached. So two of the four tabs are kept — "All Modules" and "Mapped
 * Modules" count something that is genuinely computed — and two are omitted:
 *
 *  - **UnMapped Modules** can only ever be 0. There is no second module in
 *    this import to leave unmapped.
 *  - **Unsupported Files** can only ever be 0. A file we cannot read is
 *    refused at the drop target with the reason, which is a better place to
 *    say it than a tab the user has to go looking for.
 *
 * A tab whose count is a constant zero is chrome pretending to be information.
 * If multi-file upload ever lands, both come back and both mean something.
 */

export interface StageModuleFileProps {
  labelPlural: string;
  staged: StagedImportWire;
  trackPrefix: string;
}

export function StageModuleFile({ labelPlural, staged, trackPrefix }: StageModuleFileProps) {
  const [tab, setTab] = useState('all');

  // Both counts are over the same one-element set today. They are computed
  // rather than written as "1" so that the day a second file can be staged,
  // this row is already telling the truth.
  const modules = [{ label: labelPlural, file: staged.batch.filename, mapped: true }];
  const tabs: CountedTab[] = [
    { id: 'all', label: 'All Modules', count: modules.length },
    { id: 'mapped', label: 'Mapped Modules', count: modules.filter((m) => m.mapped).length },
  ];
  const rows = tab === 'mapped' ? modules.filter((m) => m.mapped) : modules;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-medium text-heading">Module-File Mapping</h3>
        <p className="mt-1 text-sm text-body">
          One file, one module. This import feeds <strong>{labelPlural}</strong> because that is
          the list it was started from — to load a file into a different module, start the import
          from that module’s own list.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabStrip
          tabs={tabs}
          active={tab}
          onSelect={setTab}
          label="Module file mapping"
          track={`${trackPrefix}.modules.tab`}
        />
        <span className="text-xs text-body">1 File</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-background text-xs">
              <th className="px-4 py-2 text-left font-medium text-heading">Module</th>
              <th className="px-4 py-2 text-left font-medium text-heading">File</th>
              <th className="px-4 py-2 text-left font-medium text-heading">Rows</th>
              <th className="px-4 py-2 text-left font-medium text-heading">Columns</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="px-4 py-3 text-heading">{row.label}</td>
                <td className="max-w-[24rem] truncate px-4 py-3 text-body" title={row.file}>
                  {row.file}
                </td>
                <td className="px-4 py-3 text-body">{formatCount(staged.batch.total)}</td>
                <td className="px-4 py-3 text-body">{staged.headers.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
