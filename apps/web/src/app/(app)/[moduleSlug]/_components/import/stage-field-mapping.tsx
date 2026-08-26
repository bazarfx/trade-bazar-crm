'use client';

import { useState, type ReactNode } from 'react';
import {
  FIELD_TYPE_SPECS,
  IMPORT_DEDUPE_NONE,
  IMPORT_MAX_COLUMNS,
  mappedColumns,
  type ImportColumnMapping,
  type ImportMapping,
} from '@crm/shared';
import { cn } from '@/components/ui';
import { ChevronDownIcon, PlusIcon } from '../icons';
import { AssignmentIcon, ModuleIcon, TickIcon } from './icons';
import { claimedFields, isMapped, patchColumn, requiredGaps, sampleValues } from './mapping';
import { AutoMappingPopup, CreateFieldsPopup, DefaultValuePopup } from './import-dialogs';
import { RailRow } from './stage-strip';
import type { ModuleField, StagedImportWire } from './wire';

/**
 * Stage 4 — Field Mapping. The substance of the wizard.
 *
 * IN THE PANEL too — frames [18] to [22] carry the same plain `Rectangle 25`
 * @272,152 1152x544 stage 3 does, with no `Pop up` auto-layout node and no
 * title row. Every number below is measured off frame [18]:
 *
 *   rail       x=284, 161 wide: "Mapped Modules" (Medium 14px `#111827`), the
 *              module row (a 12 glyph, gap 4, Regular 10px `#6b7280`), then
 *              "All Columns" / "Mapped Columns" / "Unmapped Columns" at pitch
 *              28, the CURRENT one in `#00667a`. Each of those three rows is
 *              chevron 16 + label + badge at gap 0 — see `RailRow`.
 *   title      x=469 y=162 — the module's own name, Medium 16px ls 0.4
 *   actions    x=1158 and x=1295, y=164 — `Frame 2121453957` 127x22 and
 *              `Frame 2121453956` 117x22, the two pop-up triggers, 10 apart
 *              and ending at 1412
 *   separator  x=457…1424 y=198, 967 wide
 *   `Table`    x=457 y=210, 967 wide, `border #e5e7eb`
 *     header   45 tall, `bg #f6f8fa`, `r:4`; cells 171 / 256 / 255 / 286 at
 *              pad 12 gap 8, the first carrying a 20x20 `#00667a` tick
 *     rows     28 tall, alternating `#ffffff` and `#f6f8fa`, cells pad 10/12
 *              gap 12; the pickers are `Frame 2121453958` 234x18 — `#ffffff`,
 *              `border #e5e7eb`, `r:2`, pad 3/6, value Regular 8px `#6b7280`,
 *              an `Icon / Chevron` 10 flush right
 *   separator  x=457…1424 y=608, 967 wide
 *   "Auto Map" x=469 y=640 — a bare TEXT, Medium 16px `#00667a`, on the
 *              footer's own row; the footer itself ends at x=1400
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
  /** errors and notices the wizard owns, drawn above the two columns */
  alerts: ReactNode;
  /** the measured 222x40 footer row; "Auto Map" shares its line */
  footer: ReactNode;
  trackPrefix: string;
}

/** The select value that means "leave this column out". Kept distinct from the
 *  empty value: `skip` and an unset field are different states in
 *  `importColumnMappingSchema`, and skip deliberately REMEMBERS the field so
 *  toggling it back does not lose the user's choice. */
const SKIP_VALUE = '__skip__';

/** `Frame 2121453958` — 234x18, `r:2`, pad 3/6, Regular 8px. 8px and 18px are
 *  below every step of the type and size scales, so both are stated inline
 *  with the node named, the way `h-[38px]` and `gap-[18px]` are elsewhere. */
const CELL_SELECT =
  'h-[18px] w-[234px] max-w-full appearance-none rounded-[2px] border border-border bg-surface ' +
  'pl-[6px] pr-5 text-[8px] leading-none text-body ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/** The four measured header widths, plus the one column the file does not
 *  draw — see the note on the default column below. */
const COL = {
  column: 171,
  field: 256,
  type: 255,
  sample: 286,
} as const;

function stateOf(column: ImportColumnMapping): 'mapped' | 'skipped' | 'unmapped' {
  if (column.skip) return 'skipped';
  return column.field === null ? 'unmapped' : 'mapped';
}

/** "Auto Map" — a bare TEXT @469,640 in the file, Inter Medium 16px `#00667a`
 *  with no chrome at all. It is the ONLY action drawn on the footer row. */
const LINK_ACTION =
  'text-lg font-medium leading-6 text-primary hover:underline ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/**
 * The two pop-up triggers, which the file draws as PILL BUTTONS in the panel's
 * top-right rather than as text on the footer row — `Frame 2121453957`
 * (@1158,164, 127x22, "Assign Default Value") and `Frame 2121453956`
 * (@1295,164, 117x22, "Create New Fields"), both:
 *
 *   bg `#f6f8fa` · border `#00667a` 1px · `r:4` · pad 2/4 · gap 6
 *   a 16x16 `#00667a` icon (material-symbols-light:assignment-turned-in,
 *   ic:round-plus) then the label at Regular 10px `#00667a`, 15px line box
 *
 * An earlier revision put both on the footer row in "Auto Map"'s 16px teal
 * text, on the reasoning that the file draws no trigger for them. It does —
 * here, at a third of that size and with a border and an icon.
 */
const PANEL_ACTION =
  'flex h-[22px] shrink-0 items-center gap-[6px] rounded border border-primary bg-background ' +
  'px-1 py-[2px] text-[10px] leading-[15px] text-primary hover:bg-surface ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

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
  alerts,
  footer,
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

  const rows =
    tab === 'mapped'
      ? mapped
      : tab === 'unmapped'
        ? unmapped
        : tab === 'skipped'
          ? skipped
          : mapping.columns;

  const gaps = requiredGaps(catalogue, mapping, systemColumns);
  const fedKeys = new Set(mappedColumns(mapping).map((c) => c.field));
  const unmappedFields = catalogue.filter((f) => !fedKeys.has(f.key));
  const dedupeField = dedupeKey === IMPORT_DEDUPE_NONE ? null : (byKey.get(dedupeKey) ?? null);
  const dedupeFed = dedupeKey === IMPORT_DEDUPE_NONE || fedKeys.has(dedupeKey);
  const allMapped = mapping.columns.length > 0 && unmapped.length === 0 && skipped.length === 0;

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
    <div className="flex flex-col gap-3">
      {alerts}

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
        label={labelPlural}
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

      <div className="flex gap-3">
        {/* The rail — the module this import feeds, then the three counted
            column groups. These are TABS drawn as a list: picking one filters
            the table, which is what the file's `#00667a` "All Columns" says. */}
        {/* Not `role="tablist"`: these rows are toggles over one table, and a
            tablist would promise tab semantics (arrow-key roving, a tabpanel)
            that a filtered table below does not have. `aria-pressed` on each
            row, which `RailRow` sets, says what they actually are. */}
        <aside className="flex w-[161px] shrink-0 flex-col gap-3" aria-label="Column mapping">
          {/* `Mapped Modules` @284,164 with `Frame 2121453955` 8px under it. */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium leading-4 text-heading">Mapped Modules</span>
            <div className="flex items-center gap-1">
              <ModuleIcon className="h-3 w-3 shrink-0 text-body" />
              <span className="min-w-0 truncate text-[10px] leading-4 text-body">{labelPlural}</span>
            </div>
          </div>
          {/* gap 0: stage 4's rows butt the badge straight against the label,
              where stage 3's put 10 between every part. Both measured. */}
          <RailRow
            label="All Columns"
            count={mapping.columns.length}
            active={tab === 'all'}
            onSelect={() => setTab('all')}
            gap={0}
            track={`${trackPrefix}.columns.tab`}
          />
          <RailRow
            label="Mapped Columns"
            count={mapped.length}
            active={tab === 'mapped'}
            onSelect={() => setTab('mapped')}
            gap={0}
            track={`${trackPrefix}.columns.tab`}
          />
          <RailRow
            label="Unmapped Columns"
            count={unmapped.length}
            active={tab === 'unmapped'}
            onSelect={() => setTab('unmapped')}
            gap={0}
            track={`${trackPrefix}.columns.tab`}
          />
          {/* The file draws three groups. A column the user deliberately
              excluded is neither mapped nor "unmapped" — filing it under
              omissions would label a decision as a mistake — so it gets its
              own group, and only once there is one to show. A permanently
              empty group would be chrome, not information. */}
          {skipped.length > 0 ? (
            <RailRow
              label="Not imported"
              count={skipped.length}
              active={tab === 'skipped'}
              onSelect={() => setTab('skipped')}
              gap={0}
              track={`${trackPrefix}.columns.tab`}
            />
          ) : null}
        </aside>

        {/* The right column — x=457…1424, 967 wide. `-mr-3` hands back the
            panel's 12px of right padding so the separators and the table are
            flush to the panel edge, while the rows inside keep their own 12px
            inset (`px-3`) — the title at x=469, the action pills ending at
            1412. */}
        <div className="-mr-3 flex min-w-0 flex-1 flex-col">
          {/* The module's own name at the file's Medium 16px ls 0.4 — this is
              `ModuleDefinition.labelPlural`, never a heading typed in code —
              and, on the same row, the two 22-tall pop-up triggers the file
              draws in the panel's top-right, 10 apart and flush to its 12px
              inset. */}
          {/* Centred rather than top-aligned: the file's title box runs
              162…188 and both pills 164…186, so the two share a centre. */}
          <div className="flex items-center justify-between gap-3 px-3">
            <h3 className="min-w-0 truncate text-lg font-medium leading-[26px] tracking-[0.4px] text-heading">
              {labelPlural}
            </h3>
            <div className="flex shrink-0 items-center gap-[10px]">
              <button
                type="button"
                onClick={() => setDialog('default')}
                className={PANEL_ACTION}
                data-track={`${trackPrefix}.default.open`}
              >
                <AssignmentIcon className="h-4 w-4 shrink-0" />
                Assign Default Value
              </button>
              <button
                type="button"
                onClick={() => setDialog('createfields')}
                className={PANEL_ACTION}
                data-track={`${trackPrefix}.createfields.open`}
              >
                <PlusIcon className="h-4 w-4 shrink-0" />
                Create New Fields
              </button>
            </div>
          </div>
          {/* `Separator` @457,198 — 12 below the title, 12 above the table. */}
          <div className="mt-3 h-px shrink-0 bg-border" aria-hidden="true" />

          {gaps.length > 0 ? (
            <p
              role="alert"
              className="mx-3 mt-3 rounded border border-error bg-surface px-3 py-[10px] text-[10px] leading-[15px] text-heading"
            >
              {gaps.length === 1 ? 'This field is required' : 'These fields are required'} and no
              column feeds {gaps.length === 1 ? 'it' : 'them'}:{' '}
              <strong>{gaps.map((f) => f.label).join(', ')}</strong>. Every row would fail the same
              way, so the import will be refused until {gaps.length === 1 ? 'it is' : 'they are'}{' '}
              mapped.
            </p>
          ) : null}

          {!dedupeFed && dedupeField ? (
            <p
              role="alert"
              className="mx-3 mt-3 rounded border border-error bg-surface px-3 py-[10px] text-[10px] leading-[15px] text-heading"
            >
              You chose to match existing records on <strong>{dedupeField.label}</strong>, so a
              column has to feed it — otherwise there is nothing to match with.
            </p>
          ) : null}

          {mapped.length === 0 ? (
            <p
              role="alert"
              className="mx-3 mt-3 rounded border border-warning bg-surface px-3 py-[10px] text-[10px] leading-[15px] text-heading"
            >
              Nothing is mapped yet. Use Auto Map, or pick a field for at least one column.
            </p>
          ) : null}

          {/* `Table` — 967 wide, 1px #e5e7eb, its header 45 tall on #f6f8fa
              and its rows 28 with the file's own zebra. */}
          <div className="mt-3 overflow-x-auto rounded border border-border">
            <table className="min-w-full border-collapse">
              <thead>
                <tr className="h-[45px] bg-background">
                  <th
                    style={{ width: COL.column }}
                    className="border-b border-border px-3 text-left align-middle"
                  >
                    <span className="flex items-center gap-2">
                      {/* The 20x20 `tICK` the file draws in the header — filled
                          `#00667a` when every column has been dealt with,
                          hollow while some have not. It is a STATE, not a
                          control: what a select-all would toggle here is
                          "which field", and there is no one answer. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-5 w-5 items-center justify-center rounded border',
                          allMapped ? 'border-primary bg-primary' : 'border-border bg-surface',
                        )}
                      >
                        {allMapped ? <TickIcon className="h-[14px] w-[14px] text-surface" /> : null}
                      </span>
                      <span className="text-sm leading-[21px] text-heading">Columns in Fields</span>
                    </span>
                  </th>
                  <th
                    style={{ width: COL.field }}
                    className="border-b border-border px-3 text-left align-middle text-sm font-normal leading-[21px] text-heading"
                  >
                    {/* The file reads "Fields in Zoho CRM". Zoho is the
                        reference product, not ours, and the column holds this
                        MODULE's fields — so it names the module. */}
                    Fields in {labelPlural}
                  </th>
                  <th
                    style={{ width: COL.type }}
                    className="border-b border-border px-3 text-left align-middle text-sm font-normal leading-[21px] text-heading"
                  >
                    Field Type
                  </th>
                  <th className="border-b border-border px-3 text-left align-middle text-sm font-normal leading-[21px] text-heading">
                    {/* NOT in the file's four columns: the file gives the
                        default to the "Assign Default Value" pop-up, which
                        this stage also opens. The column stays because the
                        pop-up sets one column at a time and this table is
                        where a 250-column file is actually worked through. */}
                    Default Value
                  </th>
                  <th
                    style={{ width: COL.sample }}
                    className="border-b border-border px-3 text-left align-middle text-sm font-normal leading-[21px] text-heading"
                  >
                    Sample Data from File
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((column, index) => {
                  const field = column.field === null ? null : (byKey.get(column.field) ?? null);
                  const samples = sampleValues(staged.sample, column.column);
                  const missing = column.field !== null && field === null;
                  return (
                    <tr
                      key={column.column}
                      className={index % 2 === 1 ? 'bg-background' : 'bg-surface'}
                    >
                      <td className="px-3 py-[10px] align-middle">
                        <span className="flex items-center gap-3">
                          {/* `Checkbox` 20x20 with an 18x18 `r:4` box — ticked
                              once the column feeds a field, which is the only
                              thing the row can be "done" about. */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border',
                              isMapped(column)
                                ? 'border-primary bg-primary'
                                : 'border-border bg-surface',
                            )}
                          >
                            {isMapped(column) ? (
                              <TickIcon className="h-3 w-3 text-surface" />
                            ) : null}
                          </span>
                          <span className="min-w-0">
                            <span
                              className="block truncate text-sm leading-[21px] text-heading"
                              title={column.column}
                            >
                              {column.column}
                            </span>
                            {missing ? (
                              // A saved mapping replayed against a module whose
                              // field was deleted since. Said out loud rather
                              // than silently reset, so the user knows what
                              // they are re-choosing.
                              <span className="block text-[8px] text-error">
                                Its field no longer exists on this module.
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-[10px] align-middle">
                        <span className="relative inline-block">
                          <select
                            value={column.skip ? SKIP_VALUE : (column.field ?? '')}
                            disabled={fieldsLoading}
                            aria-label={`Field for column ${column.column}`}
                            onChange={(e) => choose(column.column, e.target.value)}
                            className={CELL_SELECT}
                            data-track={`${trackPrefix}.column.map`}
                          >
                            <option value="">
                              {fieldsLoading ? 'Loading fields…' : 'Select Field'}
                            </option>
                            <option value={SKIP_VALUE}>Do not import this column</option>
                            {/* Required fields are their own group: they are
                                the ones that decide whether the import can run
                                at all. */}
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
                          </select>
                          <ChevronDownIcon className="pointer-events-none absolute right-[6px] top-1/2 h-[10px] w-[10px] -translate-y-1/2 text-body" />
                        </span>
                      </td>
                      <td className="px-3 py-[10px] align-middle text-sm leading-[21px] text-body">
                        {/* The file draws a second select here, because in Zoho
                            the import chooses a type. Ours reads it off the
                            field the row is mapped to — the Admin owns field
                            types, and an import that could change one would be
                            a config write hidden inside a data load. */}
                        {field ? FIELD_TYPE_SPECS[field.type].label : '—'}
                      </td>
                      <td className="px-3 py-[10px] align-middle">
                        <input
                          type="text"
                          value={column.defaultValue ?? ''}
                          disabled={!isMapped(column)}
                          placeholder="Enter..."
                          aria-label={`Default value for column ${column.column}`}
                          onChange={(e) =>
                            onMapping(
                              patchColumn(mapping, column.column, {
                                // Empty means "no default", never an empty
                                // string: a blank cell has to stay blank so the
                                // field's own configured default can apply on
                                // create.
                                defaultValue: e.target.value === '' ? null : e.target.value,
                              }),
                            )
                          }
                          className={
                            'h-[18px] w-[234px] max-w-full rounded-[2px] border border-border ' +
                            'bg-surface px-[6px] text-[8px] leading-none text-heading ' +
                            'placeholder:text-body focus:border-primary focus:outline-none ' +
                            'focus:ring-1 focus:ring-primary disabled:cursor-not-allowed ' +
                            'disabled:opacity-60'
                          }
                          data-track={`${trackPrefix}.column.default`}
                        />
                      </td>
                      <td className="max-w-[286px] px-3 py-[10px] align-middle text-sm leading-[21px] text-body">
                        {samples.length === 0 ? (
                          <span>every sampled row is empty</span>
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
            <p className="mt-3 px-3 text-[10px] leading-[15px] text-body">No columns in this tab.</p>
          ) : null}

          {/* Which fields no column feeds. The file says this in the field
              picker's OWN open menu (`Group 11` 234x114, a header at Regular
              8px `#111827` over the names at Regular 8px `#6b7280`, hanging
              under the row's 234-wide select) rather than in the rail — the
              rail draws three counted groups and nothing else. A native
              `<select>` cannot carry that menu's chrome, so the count lives
              here, in the right column's own body copy, instead of as a rail
              item the file never draws. */}
          {unmappedFields.length > 0 ? (
            <p className="mt-3 px-3 text-[10px] leading-[15px] text-body">
              <strong className="font-medium text-heading">
                Unmapped Fields ({unmappedFields.length})
              </strong>{' '}
              — fields of {labelPlural} that no column feeds. They keep whatever default they are
              configured with.
            </p>
          ) : null}

          <p className="mt-3 px-3 text-[10px] leading-[15px] text-body">
            A file may map at most {IMPORT_MAX_COLUMNS} columns, and two columns may never feed the
            same field — there is no correct answer to which one would win, and picking silently is
            how half an import ends up wrong in a way nobody notices for a week.
          </p>

          {/* `Separator` @457,608, then the footer row — "Auto Map" at x=469
              on the LEFT of the same line the three 222x40 buttons end at
              x=1400. "Auto Map" is the only action the file draws here; the
              other two are the pills up beside the title. */}
          <div className="mt-6 h-px shrink-0 bg-border" aria-hidden="true" />
          <div className="mt-6 flex flex-wrap items-center justify-between gap-6 pl-3 pr-6">
            <button
              type="button"
              onClick={() => setDialog('automap')}
              className={LINK_ACTION}
              data-track={`${trackPrefix}.automap.click`}
            >
              Auto Map
            </button>
            <div className="min-w-0">{footer}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
