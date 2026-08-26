'use client';

import { IMPORT_ACTIONS, IMPORT_DEDUPE_NONE, type ImportAction } from '@crm/shared';
import { cn } from '@/components/ui';
import { ChevronDownIcon } from '../icons';
import { canMatchOn } from './mapping';
import type { ModuleField } from './wire';

/**
 * Stage 2 — Actions.
 *
 * MEASURED off frames [3], [9] and [11] of the family, which draw the same
 * stage with each of the three options selected in turn:
 *
 *   `Frame 482728`  flex-col gap:10, at the panel's own 24px inset
 *   ├ row 21 tall — `system-uicons:radio-on` 16 (a 12 circle, 8 dot when on),
 *   │   gap 6, label Inter Regular 14px `#6b7280`
 *   └ the SELECTED row is wrapped in `Frame 482739` — flex-col gap:10,
 *       pad 12, `bg #f6f8fa`, `border #00667a 1px`, `r:4` — and the controls
 *       that depend on it sit inside that card:
 *         `Group 9`  a label with a 203x28 select flush right
 *                    (`#ffffff` / `#e5e7eb` / `r:4`, value Regular 10px)
 *         `Input Base` 417x33 `bg #edf2fe` — the "can't be undone" note
 *
 * That card is the whole grammar of the stage: a chosen option OPENS, and its
 * consequences are stated inside it rather than in a paragraph below the list.
 * This screen used to draw three equal bordered blocks with three sentences
 * each, which reads as three settings rather than one choice.
 *
 * The copy is generated from the module's own plural label — there is no
 * "leads" in this file — and the match key is any field of this module whose
 * TYPE can be compared for equality, never a fixed Email/Phone list.
 */

export interface StageActionsProps {
  labelPlural: string;
  action: ImportAction;
  onAction: (action: ImportAction) => void;
  dedupeKey: string;
  onDedupeKey: (key: string) => void;
  /** the importable fields of this module, as the server permits them */
  catalogue: readonly ModuleField[];
  /** the catalogue is not final yet — an empty match list means "not known",
   *  not "this module has none" */
  catalogueLoading: boolean;
  trackPrefix: string;
}

/**
 * The label of each option and the label of the match-key select it opens,
 * keyed on the whole union so adding an action to `IMPORT_ACTIONS` is a
 * compile error here rather than an unexplained radio.
 *
 * The file's wording, with its module name replaced by ours: "Add as new
 * Leads", "Update Existing Leads Only", "Both"; "Skip leads based on" and
 * "Fixing Existing Leads based on" for the two selects.
 */
const ACTION_COPY: Record<ImportAction, { title: (n: string) => string; match: (n: string) => string }> = {
  ADD_NEW: {
    title: (n) => `Add as new ${n}`,
    match: (n) => `Skip ${n.toLowerCase()} based on`,
  },
  UPDATE_ONLY: {
    title: (n) => `Update Existing ${n} Only`,
    match: (n) => `Fixing Existing ${n} based on`,
  },
  BOTH: {
    title: () => 'Both',
    match: (n) => `Match existing ${n.toLowerCase()} on`,
  },
};

/** What the option does to a row that matches, and to a row that does not.
 *  Both halves matter: "update only" silently drops every new row, and that is
 *  the half nobody reads. Drawn in the option's own card, at the file's 10px. */
const ACTION_EFFECT: Record<ImportAction, string> = {
  ADD_NEW:
    'Every row is created. A row that matches an existing record is created too and the pair is flagged for review — duplicates are never blocked and never merged automatically.',
  UPDATE_ONLY:
    'A matching record is edited in place, field by field, through the same path a manual edit takes. A row that matches nothing is SKIPPED — nothing is created.',
  BOTH: 'A matching record is edited in place; a row that matches nothing is created and assigned like any other new record.',
};

/**
 * `system-uicons:radio-on` — a 12.19 circle centred in a 16x16 icon frame,
 * `#6b7280` when off and `#00667a` with a 7.62 dot when on. `appearance-none`
 * plus an inset ring is what draws that dot without replacing the native
 * control: this is still a real radio, so arrow-key selection, the group name
 * and the label association all behave exactly as they did.
 *
 * The `mx-[2px]` is the icon FRAME: the glyph is 12 but the slot it occupies
 * is 16, which is why the file's "Add as new Leads" starts 22px from the row's
 * left edge (16 + the row's 6px gap) and not 18. Stated inline with the node
 * named, since neither 12-in-16 nor a 2px margin is on the spacing scale.
 */
const RADIO =
  'mx-[2px] h-3 w-3 shrink-0 appearance-none rounded-pill border border-body bg-transparent ' +
  'checked:border-primary checked:bg-primary ' +
  'checked:shadow-[inset_0_0_0_2px_var(--neutral-10)] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

/** `Rectangle 24` / `Frame 2121453966` — 203x28, `#ffffff`, `#e5e7eb`, `r:4`,
 *  value Inter Regular 10px `#6b7280`, an `Icon / Chevron` 16 flush right. */
const RULE_SELECT =
  'h-7 w-[203px] appearance-none rounded border border-border bg-surface pl-[10px] pr-8 ' +
  'text-[10px] text-body focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function StageActions({
  labelPlural,
  action,
  onAction,
  dedupeKey,
  onDedupeKey,
  catalogue,
  catalogueLoading,
  trackPrefix,
}: StageActionsProps) {
  const matchable = catalogue.filter(canMatchOn);
  const unique = matchable.filter((f) => f.isUnique);
  const others = matchable.filter((f) => !f.isUnique);

  // The combination the commit refuses: with no match key nothing can match,
  // so "update only" would skip every row and "both" would create every row.
  // Two no-ops dressed as imports — said here rather than after five stages.
  const noKeyConflict = dedupeKey === IMPORT_DEDUPE_NONE && action !== 'ADD_NEW';

  return (
    // `Frame 482728` — flex-col gap:10, hugging its content rather than
    // filling the 1104 column, exactly as the file draws it.
    <div className="flex w-full max-w-[441px] flex-col gap-[10px]">
      <fieldset className="flex flex-col gap-[10px]">
        <legend className="sr-only">What to do with each row</legend>

        {IMPORT_ACTIONS.map((value) => {
          const copy = ACTION_COPY[value];
          const selected = value === action;
          const row = (
            // `Frame 482726` — 21 tall, radio then a 6px gap then the label.
            <label className="flex h-[21px] cursor-pointer items-center gap-[6px]">
              <input
                type="radio"
                name="import-action"
                value={value}
                checked={selected}
                onChange={() => onAction(value)}
                className={RADIO}
                data-track={`${trackPrefix}.action.select`}
              />
              <span className="text-sm leading-[21px] text-body">{copy.title(labelPlural)}</span>
            </label>
          );

          if (!selected) return <div key={value}>{row}</div>;

          return (
            // `Frame 482739` — the open card. Only ever one, because only one
            // radio in a group can be selected.
            <div
              key={value}
              className="flex flex-col gap-[10px] rounded border border-primary bg-background p-3"
            >
              {row}

              {/* `Group 9` — the label with the 203x28 select flush right. */}
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="import-dedupe"
                  className="min-w-0 truncate text-sm leading-[21px] text-body"
                >
                  {copy.match(labelPlural)}
                </label>
                <div className="relative shrink-0">
                  <select
                    id="import-dedupe"
                    value={dedupeKey}
                    disabled={catalogueLoading}
                    onChange={(e) => onDedupeKey(e.target.value)}
                    className={RULE_SELECT}
                    data-track={`${trackPrefix}.dedupe.select`}
                  >
                    <option value={IMPORT_DEDUPE_NONE}>None</option>
                    {/* Grouped by uniqueness rather than by name: a field the
                        Admin marked unique is the only kind that identifies
                        ONE record, and a match key that hits three records is
                        how the wrong one gets overwritten. Everything
                        comparable is still offered. */}
                    {unique.length > 0 ? (
                      <optgroup label="Unique fields">
                        {unique.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {others.length > 0 ? (
                      <optgroup label="Other fields">
                        {others.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                  <ChevronDownIcon className="pointer-events-none absolute right-[10px] top-1/2 h-4 w-4 -translate-y-1/2 text-body" />
                </div>
              </div>

              {/* `Input Base` 417x33, `bg #edf2fe` — the file gives this slot
                  to "Note: Records updated through import can’t be undone."
                  and to the "Dont Update Empty values" line beside it. Both are
                  STATEMENTS of what the engine does rather than settings: an
                  empty cell never erases a value here, and there is no toggle
                  behind it to draw. */}
              <div className="flex flex-col gap-1 rounded border border-border px-3 py-[10px] bg-[var(--globalcolors-blue-10)]">
                <p className="text-[10px] font-medium leading-[15px] text-heading">
                  {ACTION_EFFECT[value]}
                </p>
                <p className="text-[10px] leading-[15px] text-body">
                  {value === 'ADD_NEW'
                    ? 'Nothing existing is changed by this option.'
                    : 'Records updated through import can’t be undone in bulk — every change is in the record’s timeline as before → after. An empty cell never erases a value.'}
                </p>
              </div>

              <p className="text-[10px] leading-[15px] text-body">
                {catalogueLoading
                  ? 'Still reading this module’s fields — the list of match keys is not complete yet.'
                  : matchable.length === 0
                    ? `No field of ${labelPlural} can identify an existing record, so rows can only be added as new.`
                    : 'Any field of this module that can be compared for equality may be the match key — the field types decide, so a field added next year appears here on its own. Whichever you pick, a column has to be mapped to it in the next stage.'}
              </p>
            </div>
          );
        })}
      </fieldset>

      {noKeyConflict ? (
        <p
          role="alert"
          className={cn(
            'rounded border border-warning bg-surface px-3 py-[10px]',
            'text-[10px] leading-[15px] text-heading',
          )}
        >
          With no match key nothing can match, so “{ACTION_COPY[action].title(labelPlural)}” would{' '}
          {action === 'UPDATE_ONLY' ? 'skip every row' : 'create every row'} and change nothing you
          intended. Choose a field to match on, or switch to “{ACTION_COPY.ADD_NEW.title(labelPlural)}”.
        </p>
      ) : null}
    </div>
  );
}
