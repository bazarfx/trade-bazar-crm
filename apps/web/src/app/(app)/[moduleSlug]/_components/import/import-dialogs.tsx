'use client';

import { useId, useMemo, useState } from 'react';
import { FIELD_TYPES, FIELD_TYPE_SPECS, type FieldType } from '@crm/shared';
import { Input, Popup, PopupFooter, Select } from '@/components/ui';
import { ChevronDownIcon } from '../icons';
import { api } from '@/lib/client-api';
import { sampleValues } from './mapping';
import type { ModuleField, StagedImportWire } from './wire';
import { messageOf } from './wire';

/**
 * The three sub-dialogs the import screen opens over itself, each measured off
 * its own frame in `tools/figma/Zoho.fig`:
 *
 *   CRM _ Leads_Import-Auto Mapping          FRAME "Pop up" @465,411  511x203
 *   CRM _ Leads_Import-Assign Default Values FRAME "Pop up" @465,392  511x242
 *   CRM _ Leads_Import-Create New Fields     FRAME "Pop up" @213,292 1015x440
 *
 * All three are the SAME shell as the saved-filter pop-ups — `flex-col gap:24
 * pad:24`, a Title row with an `Icon/X` 20x20 flush right, a 1px separator,
 * a Content column at gap:20, and a footer of 222x40 buttons at gap:18. That
 * shell is `components/ui/popup.tsx` and it owns every one of those numbers,
 * which is why nothing below states a width twice or a padding at all.
 *
 * Height is NOT set anywhere: the file draws this frame at 203, 242, 252, 353,
 * 378, 440 and follows its content. Only the width is fixed.
 *
 * 465 + 511 = 976 and 213 + 1015 = 1228, both centred on the 1440 frame
 * (1440−976 = 464 ≈ 465; 1440−1228 = 212 ≈ 213), so `Popup`'s centring is the
 * file's own placement rather than a convention laid over it.
 */

/* ── Apply Auto Mapping — 511x203 ──────────────────────────────────────── */

export interface AutoMappingPopupProps {
  open: boolean;
  onCancel: () => void;
  onApply: () => void;
  trackPrefix: string;
}

/**
 * Measured content: a single `Label` line, Regular 14px #111827 —
 * "When you apply auto mapping the unmapped fields will be mapped."
 * Footer "Cancel" (#f6f8fa) · "Apply" (#00667a).
 *
 * WHY IT ASKS AT ALL. Auto Map overwrites every column's field with the
 * server's suggestion, including ones the user set by hand. The file puts a
 * confirmation in front of it for that reason, and the button used to apply
 * straight away — silently discarding hand mapping on a 250-column file.
 */
export function AutoMappingPopup({ open, onCancel, onApply, trackPrefix }: AutoMappingPopupProps) {
  return (
    <Popup
      open={open}
      width={511}
      title="Apply Auto Mapping"
      onClose={onCancel}
      trackPrefix={`${trackPrefix}.automap`}
      footer={
        <PopupFooter
          trackPrefix={`${trackPrefix}.automap`}
          cancel={{ label: 'Cancel', onClick: onCancel }}
          next={{ label: 'Apply', onClick: onApply }}
        />
      }
    >
      <p className="text-sm text-heading">
        When you apply auto mapping the unmapped fields will be mapped.
      </p>
    </Popup>
  );
}

/* ── Assign Default Value — 511x242 ────────────────────────────────────── */

export interface DefaultValuePopupProps {
  open: boolean;
  /** module.labelPlural — the file writes "Field in Zoho CRM" and this is the
   *  half of that sentence we are allowed to keep */
  label: string;
  /** the mapped columns a default could be attached to */
  columns: readonly { column: string; field: string | null }[];
  catalogue: readonly ModuleField[];
  onCancel: () => void;
  onSave: (column: string, value: string) => void;
  trackPrefix: string;
}

/** `Frame 2121453958` — 234x27, `r:2`, pad 4/12, value Regular 10px. */
const PICKER =
  'h-[27px] w-[234px] appearance-none rounded-[2px] border border-border bg-surface pl-3 pr-8 ' +
  'text-[10px] text-body focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';

/**
 * Re-measured on frames [20] and [21], and the earlier reading of it was one
 * control short. `Frame 2121453960` is 463x60, `flex-col gap:12`:
 *
 *   `Frame 2121453959`  463x21, flex-row — TWO labels, Regular 14px `#111827`:
 *                       "Field in Zoho CRM " 121 wide at x=0 and "Default
 *                       Value" 88 wide flush right at x=375, i.e. a head whose
 *                       two labels sit on the row's two ends
 *   `Frame 2121453958`  234x27 — the picker, `#ffffff`, `border #e5e7eb`,
 *                       `r:2`, pad 4/12, value Regular 10px `#6b7280`, an
 *                       `Icon / Chevron` 12x12 flush right
 *
 * So the dialog IS two columns; the file simply leaves the right-hand one
 * empty, because a static frame has nothing to type into. The value input goes
 * under its own measured label rather than being invented below the picker —
 * a default needs a field AND a value, and the file's own header says so.
 *
 * "Field in Zoho CRM" names the reference product; ours names the module.
 * Footer "Cancel" (#f6f8fa) · "Save" (#00667a).
 */
export function DefaultValuePopup({
  open,
  label,
  columns,
  catalogue,
  onCancel,
  onSave,
  trackPrefix,
}: DefaultValuePopupProps) {
  const [column, setColumn] = useState('');
  const [value, setValue] = useState('');
  // Generated ids: this popup can be mounted while closed and more than one
  // import screen can exist in a tab's history, so a hardcoded id could collide
  // and point a label at the wrong control.
  const columnId = useId();
  const valueId = useId();

  const byKey = useMemo(() => new Map(catalogue.map((f) => [f.key, f])), [catalogue]);
  // Only MAPPED columns: a default fills an empty cell of a column that feeds a
  // field, so an unmapped column has nowhere to put it.
  const choices = columns.filter((c) => c.field !== null);

  return (
    <Popup
      open={open}
      width={511}
      title="Assign Default Value"
      onClose={onCancel}
      trackPrefix={`${trackPrefix}.default`}
      footer={
        <PopupFooter
          trackPrefix={`${trackPrefix}.default`}
          cancel={{ label: 'Cancel', onClick: onCancel }}
          next={{
            label: 'Save',
            onClick: () => onSave(column, value),
            // Nothing chosen is not a save. The column is what the value
            // attaches to, and an empty column would write a default nowhere.
            disabled: column === '',
          }}
        />
      }
    >
      {/* `Frame 2121453960` — the two-column head at gap 12, then the row of
          controls beneath it. `Popup`'s Content column is `flex-col gap:20`,
          which is the gap between this block and anything after it. */}
      <div className="flex flex-col gap-3">
        {/* `Frame 2121453959` 463x21 — the two labels are the ENDS of the row,
            not a fixed first column: "Field in Zoho CRM " sits at x=0 (121
            wide) and "Default Value" flush right at x=375 (88 wide, ending on
            the row's own 463). Giving the first one the picker's 234 pushed
            the second to x≈246, a third of the row short of the file. */}
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={columnId} className="min-w-0 truncate text-sm leading-[21px] text-heading">
            Field in {label}
          </label>
          <label htmlFor={valueId} className="shrink-0 text-sm leading-[21px] text-heading">
            Default Value
          </label>
        </div>
        <div className="flex items-center gap-3">
          <span className="relative shrink-0">
            <select
              id={columnId}
              value={column}
              onChange={(e) => setColumn(e.target.value)}
              className={PICKER}
              data-track={`${trackPrefix}.default.column`}
            >
              <option value="">Select Field</option>
              {choices.map((c) => {
                const field = c.field === null ? null : byKey.get(c.field);
                return (
                  <option key={c.column} value={c.column}>
                    {c.column} → {field?.label ?? c.field}
                  </option>
                );
              })}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-body" />
          </span>
          <input
            id={valueId}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            // The file's own placeholder wording on every Input Base it draws.
            placeholder="Enter..."
            className={
              'h-[27px] min-w-0 flex-1 rounded-[2px] border border-border bg-surface px-3 ' +
              'text-[10px] text-heading placeholder:text-body focus:border-primary ' +
              'focus:outline-none focus:ring-1 focus:ring-primary'
            }
            data-track={`${trackPrefix}.default.value`}
          />
        </div>
      </div>
    </Popup>
  );
}

/**
 * The types this dialog may create, straight from the registry — never a list
 * in this file, so a type added to `FIELD_TYPE_SPECS` appears here with no
 * edit. Two exclusions, both structural rather than editorial:
 *
 *  - `isDerived` types are computed, so no spreadsheet column feeds one. This
 *    is the same filter `fieldCreateSchema`'s own CREATABLE_TYPES applies (it
 *    is not exported, so the predicate is repeated rather than the list).
 *  - `hasOptions` types need at least one option and this dialog has nowhere
 *    to author them; the schema would refuse the create.
 */
const CREATABLE: readonly FieldType[] = FIELD_TYPES.filter(
  (t) => !FIELD_TYPE_SPECS[t].isDerived && !FIELD_TYPE_SPECS[t].hasOptions,
);

/* ── Create New Fields — 1015x440 ──────────────────────────────────────── */

export interface CreateFieldsPopupProps {
  open: boolean;
  slug: string;
  staged: StagedImportWire;
  /** columns with no field behind them — the only ones this can create for */
  unmappedColumns: readonly string[];
  onCancel: () => void;
  /** created fields, so the caller can map the columns that produced them */
  onCreated: (created: { column: string; key: string }[]) => void;
  trackPrefix: string;
}

/**
 * Measured: 1015x440. The Title row is 967x43 and carries the whole sentence —
 * "Create New Fields The following from columns from your file aren't mapped
 * to existing fields. choose to create them as a new field". The grammar is
 * the file's; the dialog title here is the first three words and the rest is
 * the explanatory line the Content column opens with, which is what the two
 * type sizes in that node actually are.
 *
 * The table beneath it, measured `Table / Header` 968x45 (#f6f8fa) over
 * `Rows` 28 tall, with four header cells 171 / 256 / 255 / 286 wide:
 *
 *   "Columns in Fields" · "Fields in Zoho CRM" · "Field Type" · "Sample Data from File"
 *
 * The second is renamed: "Zoho CRM" is the reference product, not ours, and
 * this column holds the NAME the new field will take. Footer "Cancel" · "Save".
 *
 * THIS WRITES CONFIG. Each ticked row is a `POST /api/modules/{slug}/fields`,
 * which runs through the same `createField` service the field builder uses —
 * same permission assertion, same `ConfigChangeLog` row, same soft-delete
 * rules. There is deliberately no second creation path.
 */
export function CreateFieldsPopup({
  open,
  slug,
  staged,
  unmappedColumns,
  onCancel,
  onCreated,
  trackPrefix,
}: CreateFieldsPopupProps) {
  /** column → the field it would become. Absent means "not ticked". */
  const [picked, setPicked] = useState<Record<string, { label: string; type: FieldType }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(column: string, on: boolean) {
    setPicked((prev) => {
      const next = { ...prev };
      // SINGLE_LINE is the only type every spreadsheet cell can feed without a
      // conversion that might fail on row 30,000 — the safe opening default,
      // changeable per row before saving.
      if (on) next[column] = { label: column, type: 'SINGLE_LINE' };
      else delete next[column];
      return next;
    });
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    const created: { column: string; key: string }[] = [];
    try {
      // Sequential, not Promise.all: `createField` derives a unique key from
      // the label, and two overlapping creates could race to the same one.
      for (const [column, spec] of Object.entries(picked)) {
        const res = await api<{ field: { key: string } }>(`/api/modules/${slug}/fields`, {
          method: 'POST',
          body: JSON.stringify({ label: spec.label, type: spec.type }),
        });
        created.push({ column, key: res.field.key });
      }
      onCreated(created);
    } catch (err) {
      // Whatever was created before the failure STAYS created and is reported,
      // because it really exists — rolling back silently would leave the
      // module's field list disagreeing with what this dialog said it did.
      setError(messageOf(err, 'Those fields could not be created.'));
      if (created.length > 0) onCreated(created);
    } finally {
      setBusy(false);
    }
  }

  const count = Object.keys(picked).length;

  return (
    <Popup
      open={open}
      width={1015}
      title="Create New Fields"
      onClose={onCancel}
      trackPrefix={`${trackPrefix}.createfields`}
      footer={
        <PopupFooter
          trackPrefix={`${trackPrefix}.createfields`}
          cancel={{ label: 'Cancel', onClick: onCancel }}
          next={{
            label: busy ? 'Saving…' : 'Save',
            onClick: () => void save(),
            disabled: busy || count === 0,
          }}
        />
      }
    >
      <p className="text-sm text-heading">
        The following columns from your file aren’t mapped to existing fields. Choose to create them
        as a new field.
      </p>

      {error !== null ? (
        <p role="alert" className="rounded border border-error bg-surface px-4 py-3 text-sm text-heading">
          {error}
        </p>
      ) : null}

      {unmappedColumns.length === 0 ? (
        <p className="text-sm text-body">Every column in the file already feeds a field.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            {/* Header 45 tall, #f6f8fa — the same measurements the list
                table's header carries, because it is the same component in the
                file. Widths 171 / 256 / 255 / 286. */}
            <thead>
              <tr className="h-[45px] border-b border-border bg-background text-xs">
                <th className="w-[171px] px-3 text-left font-medium text-heading">Columns in File</th>
                <th className="w-[256px] px-3 text-left font-medium text-heading">Field name</th>
                <th className="w-[255px] px-3 text-left font-medium text-heading">Field Type</th>
                <th className="w-[286px] px-3 text-left font-medium text-heading">
                  Sample Data from File
                </th>
              </tr>
            </thead>
            <tbody>
              {unmappedColumns.map((column) => {
                const spec = picked[column];
                const samples = sampleValues(staged.sample, column);
                return (
                  <tr key={column} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      <label className="flex items-center gap-2" title={column}>
                        <input
                          type="checkbox"
                          checked={spec !== undefined}
                          onChange={(e) => toggle(column, e.target.checked)}
                          className="h-5 w-5 shrink-0 rounded accent-primary"
                          data-track={`${trackPrefix}.createfields.column.toggle`}
                        />
                        <span className="block truncate text-heading">{column}</span>
                      </label>
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        value={spec?.label ?? column}
                        disabled={spec === undefined}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const cur = prev[column];
                            if (cur === undefined) return prev;
                            return { ...prev, [column]: { ...cur, label: e.target.value } };
                          })
                        }
                        data-track={`${trackPrefix}.createfields.column.label`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={spec?.type ?? 'SINGLE_LINE'}
                        disabled={spec === undefined}
                        onChange={(e) =>
                          setPicked((prev) => {
                            const cur = prev[column];
                            if (cur === undefined) return prev;
                            return { ...prev, [column]: { ...cur, type: e.target.value as FieldType } };
                          })
                        }
                        data-track={`${trackPrefix}.createfields.column.type`}
                      >
                        {/* The registry decides what may be created, never a
                            list in this file — a type added to
                            FIELD_TYPE_SPECS appears here with no edit. Types
                            carrying options are excluded: this dialog has
                            nowhere to author them, and the schema refuses one
                            without at least one option. */}
                        {CREATABLE.map((t) => (
                          <option key={t} value={t}>
                            {FIELD_TYPE_SPECS[t].label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="max-w-[286px] px-3 py-2 text-body">
                      <span className="block truncate" title={samples.join(', ')}>
                        {samples.length === 0 ? '—' : samples.join(', ')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Popup>
  );
}
