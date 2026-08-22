'use client';

import { useState } from 'react';
import {
  FIELD_TYPE_SPECS,
  IMPORT_DEDUPE_NONE,
  IMPORT_MAX_COLUMNS,
  mappedColumns,
  type ImportColumnMapping,
  type ImportMapping,
} from '@crm/shared';
import { Button, Input, Select } from '@/components/ui';
import { claimedFields, isMapped, patchColumn, requiredGaps, sampleValues } from './mapping';
import { AutoMappingPopup, CreateFieldsPopup, DefaultValuePopup } from './import-dialogs';
import { TabStrip, type CountedTab } from './stage-strip';
import type { ModuleField, StagedImportWire } from './wire';

/**
 * Stage 4 — Field Mapping. The substance of the wizard.
 *
 * (The stage strip in the .fig reads "Fileld Mapping". The typo is in the
 * design file, not in the product — the same frame also reads "peocessed" and
 * "Brouse Files". Shipping a misspelling because a mock has one is not
 * fidelity.)
 *
 * Every field offered here comes from the SERVER's own answer to "what may
 * this actor import into" — see `catalogue` in `ImportWizard`. Nothing in this
 * file knows what a lead is, and the picker holds whatever fields the Admin
 * created this morning.
 *
 * The table is a plain one rather than a virtualised list because
 * `IMPORT_MAX_COLUMNS` caps a file at 250 columns: bounded, and every row
 * carries a `<select>` whose native behaviour virtualisation would break.
 */

export interface StageFieldMappingProps {
  /** module slug — the Create New Fields dialog POSTs to this module's fields */
  slug: string;
  labelPlural: string;
  staged: StagedImportWire;
  /** the importable, permitted fields of this module, in the Admin's order */
  catalogue: readonly ModuleField[];
  mapping: ImportMapping;
  onMapping: (mapping: ImportMapping) => void;
  dedupeKey: string;
  systemColumns: Record<string, string | null>;
  fieldsLoading: boolean;
  trackPrefix: string;
}

/** The select value that means "leave this column out". Kept distinct from the
 *  empty value: `skip` and an unset field are different states in
 *  `importColumnMappingSchema`, and skip deliberately REMEMBERS the field so
 *  toggling it back does not lose the user's choice. */
const SKIP_VALUE = '__skip__';

function stateOf(column: ImportColumnMapping): 'mapped' | 'skipped' | 'unmapped' {
  if (column.skip) return 'skipped';
  return column.field === null ? 'unmapped' : 'mapped';
}

export function StageFieldMapping({
  slug,
  labelPlural,
  staged,
  catalogue,
  mapping,
  onMapping,
  dedupeKey,
  systemColumns,
  fieldsLoading,
  trackPrefix,
}: StageFieldMappingProps) {
  const [tab, setTab] = useState('all');
  /** which sub-dialog is open, or null. One at a time: the file draws each of
   *  them alone over the stage, and `Popup` stacks anyway if that ever changes. */
  const [dialog, setDialog] = useState<'automap' | 'default' | 'createfields' | null>(null);

  const byKey = new Map(catalogue.map((f) => [f.key, f]));
  const claimed = claimedFields(mapping);
  const required = catalogue.filter((f) => f.isRequired);
  const optional = catalogue.filter((f) => !f.isRequired);

  const mapped = mapping.columns.filter((c) => stateOf(c) === 'mapped');
  const unmapped = mapping.columns.filter((c) => stateOf(c) === 'unmapped');
  const skipped = mapping.columns.filter((c) => stateOf(c) === 'skipped');

  const tabs: CountedTab[] = [
    { id: 'all', label: 'All Columns', count: mapping.columns.length },
    { id: 'mapped', label: 'Mapped Columns', count: mapped.length },
    { id: 'unmapped', label: 'Unmapped Columns', count: unmapped.length },
    // The file draws three tabs. A column the user deliberately excluded is
    // neither mapped nor "unmapped" — filing it under omissions would label a
    // decision as a mistake — so it gets its own tab, and only once there is
    // one to show. A permanently empty tab would be chrome, not information.
    ...(skipped.length > 0
      ? [{ id: 'skipped', label: 'Not imported', count: skipped.length }]
      : []),
  ];

  const rows =
    tab === 'mapped' ? mapped : tab === 'unmapped' ? unmapped : tab === 'skipped' ? skipped : mapping.columns;

  const gaps = requiredGaps(catalogue, mapping, systemColumns);
  const fedKeys = new Set(mappedColumns(mapping).map((c) => c.field));
  const unmappedFields = catalogue.filter((f) => !fedKeys.has(f.key));
  const dedupeField = dedupeKey === IMPORT_DEDUPE_NONE ? null : (byKey.get(dedupeKey) ?? null);
  const dedupeFed = dedupeKey === IMPORT_DEDUPE_NONE || fedKeys.has(dedupeKey);

  function choose(column: string, value: string): void {
    if (value === SKIP_VALUE) {
      onMapping(patchColumn(mapping, column, { skip: true }));
      return;
    }
    onMapping(patchColumn(mapping, column, { skip: false, field: value === '' ? null : value }));
  }

  /** One field's option, disabled when another column already feeds it —
   *  `importMappingSchema` refuses two columns for one field, and there is no
   *  honest answer to which of them should win. */
  function option(field: ModuleField, column: string) {
    const owner = claimed.get(field.key);
    const takenElsewhere = owner !== undefined && owner !== column;
    return (
      <option key={field.key} value={field.key} disabled={takenElsewhere}>
        {field.label}
        {takenElsewhere ? ` — already fed by “${owner}”` : ''}
      </option>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-heading">Field Mapping</h3>
          <p className="mt-1 text-sm text-body">
            Which column of the file feeds which field of {labelPlural}. A column left unmapped is
            simply not imported — it is not an error, and the counts above say how many there are.
          </p>
        </div>
        {/* The three actions the file puts on this stage: "Auto Map" on the
            stage itself, and "Create New Fields" / "Assign Default Value",
            which appear by name in every Import frame's text. Each opens the
            pop-up measured for it — see ./import-dialogs.tsx. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => setDialog('automap')}
            data-track={`${trackPrefix}.automap.click`}
          >
            Auto Map
          </Button>
          <Button
            variant="secondary"
            onClick={() => setDialog('createfields')}
            data-track={`${trackPrefix}.createfields.open`}
          >
            Create New Fields
          </Button>
          <Button
            variant="secondary"
            onClick={() => setDialog('default')}
            data-track={`${trackPrefix}.default.open`}
          >
            Assign Default Value
          </Button>
        </div>
      </div>

      <AutoMappingPopup
        open={dialog === 'automap'}
        onCancel={() => setDialog(null)}
        onApply={() => {
          // Replays the mapping the server computed on upload rather than
          // re-deriving it here: `autoMap` is pure and its answer must be the
          // same in the request and in the browser, so there is no second
          // implementation to disagree with.
          onMapping(staged.suggestedMapping);
          setDialog(null);
        }}
        trackPrefix={trackPrefix}
      />

      <DefaultValuePopup
        open={dialog === 'default'}
        columns={mapping.columns.map((c) => ({ column: c.column, field: c.field }))}
        catalogue={catalogue}
        onCancel={() => setDialog(null)}
        onSave={(column, value) => {
          onMapping(patchColumn(mapping, column, { defaultValue: value === '' ? null : value }));
          setDialog(null);
        }}
        trackPrefix={trackPrefix}
      />

      <CreateFieldsPopup
        open={dialog === 'createfields'}
        slug={slug}
        staged={staged}
        unmappedColumns={mapping.columns.filter((c) => c.field === null && !c.skip).map((c) => c.column)}
        onCancel={() => setDialog(null)}
        onCreated={(created) => {
          // Point each column at the field it just produced, in ONE update —
          // a patch per column would make every intermediate mapping a render
          // and could interleave with the user editing the table.
          let next = mapping;
          for (const { column, key } of created) next = patchColumn(next, column, { field: key });
          onMapping(next);
          setDialog(null);
        }}
        trackPrefix={trackPrefix}
      />

      <TabStrip
        tabs={tabs}
        active={tab}
        onSelect={setTab}
        label="Column mapping"
        track={`${trackPrefix}.columns.tab`}
      />

      {gaps.length > 0 ? (
        <p role="alert" className="rounded border border-error bg-surface px-4 py-3 text-sm text-heading">
          {gaps.length === 1 ? 'This field is required' : 'These fields are required'} and no column
          feeds {gaps.length === 1 ? 'it' : 'them'}:{' '}
          <strong>{gaps.map((f) => f.label).join(', ')}</strong>. Every row would fail the same way,
          so the import will be refused until {gaps.length === 1 ? 'it is' : 'they are'} mapped.
        </p>
      ) : null}

      {!dedupeFed && dedupeField ? (
        <p role="alert" className="rounded border border-error bg-surface px-4 py-3 text-sm text-heading">
          You chose to match existing records on <strong>{dedupeField.label}</strong>, so a column
          has to feed it — otherwise there is nothing to match with.
        </p>
      ) : null}

      {mapped.length === 0 ? (
        <p role="alert" className="rounded border border-warning bg-surface px-4 py-3 text-sm text-heading">
          Nothing is mapped yet. Use Auto Map, or pick a field for at least one column.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-background text-xs">
              <th className="px-4 py-2 text-left font-medium text-heading">Columns in File</th>
              <th className="px-4 py-2 text-left font-medium text-heading">Fields in {labelPlural}</th>
              <th className="px-4 py-2 text-left font-medium text-heading">Field Type</th>
              <th className="px-4 py-2 text-left font-medium text-heading">Default for empty cells</th>
              <th className="px-4 py-2 text-left font-medium text-heading">Sample Data from File</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((column) => {
              const field = column.field === null ? null : (byKey.get(column.field) ?? null);
              const samples = sampleValues(staged.sample, column.column);
              const missing = column.field !== null && field === null;
              return (
                <tr key={column.column} className="border-b border-border last:border-0 align-top">
                  <td className="max-w-[16rem] px-4 py-3" title={column.column}>
                    <span className="block truncate font-medium text-heading">{column.column}</span>
                    {missing ? (
                      // A saved mapping replayed against a module whose field
                      // was deleted since. Said out loud rather than silently
                      // reset, so the user knows what they are re-choosing.
                      <span className="mt-1 block text-xs text-error">
                        Its field no longer exists on this module.
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      value={column.skip ? SKIP_VALUE : (column.field ?? '')}
                      disabled={fieldsLoading}
                      aria-label={`Field for column ${column.column}`}
                      onChange={(e) => choose(column.column, e.target.value)}
                      className="min-w-[14rem]"
                      data-track={`${trackPrefix}.column.map`}
                    >
                      <option value="">{fieldsLoading ? 'Loading fields…' : 'Select Field'}</option>
                      <option value={SKIP_VALUE}>Do not import this column</option>
                      {/* Required fields are their own group: they are the ones
                          that decide whether the import can run at all. */}
                      {required.length > 0 ? (
                        <optgroup label="Required fields">
                          {required.map((f) => option(f, column.column))}
                        </optgroup>
                      ) : null}
                      {optional.length > 0 ? (
                        <optgroup label="Other fields">
                          {optional.map((f) => option(f, column.column))}
                        </optgroup>
                      ) : null}
                    </Select>
                  </td>
                  <td className="px-4 py-3 text-xs text-body">
                    {field ? FIELD_TYPE_SPECS[field.type].label : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Input
                      value={column.defaultValue ?? ''}
                      disabled={!isMapped(column)}
                      placeholder="Optional"
                      aria-label={`Default value for column ${column.column}`}
                      onChange={(e) =>
                        onMapping(
                          patchColumn(mapping, column.column, {
                            // Empty means "no default", never an empty string:
                            // a blank cell has to stay blank so the field's own
                            // configured default can apply on create.
                            defaultValue: e.target.value === '' ? null : e.target.value,
                          }),
                        )
                      }
                      className="min-w-[10rem]"
                      data-track={`${trackPrefix}.column.default`}
                    />
                  </td>
                  <td className="max-w-[20rem] px-4 py-3 text-xs text-body">
                    {samples.length === 0 ? (
                      <span className="text-body">every sampled row is empty</span>
                    ) : (
                      <span className="block truncate" title={samples.join(' · ')}>
                        {samples.join(' · ')}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-body">No columns in this tab.</p>
      ) : null}

      {unmappedFields.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <h4 className="text-xs font-medium text-heading">
            Unmapped Fields ({unmappedFields.length})
          </h4>
          <p className="mt-1 text-xs text-body">
            Fields of {labelPlural} that no column feeds. They keep whatever default they are
            configured with, and can be filled in later on the record itself.
          </p>
          <p className="mt-2 text-xs text-body">
            {unmappedFields.map((f) => f.label).join(' · ')}
          </p>
        </div>
      ) : null}

      <p className="text-xs text-body">
        A file may map at most {IMPORT_MAX_COLUMNS} columns, and two columns may never feed the
        same field — there is no correct answer to which one would win, and picking silently is how
        half an import ends up wrong in a way nobody notices for a week.
      </p>
    </div>
  );
}
