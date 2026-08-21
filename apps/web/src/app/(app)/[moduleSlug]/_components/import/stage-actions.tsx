'use client';

import {
  IMPORT_ACTIONS,
  IMPORT_DEDUPE_NONE,
  type ImportAction,
} from '@crm/shared';
import { FieldLabel, Select, cn } from '@/components/ui';
import { canMatchOn } from './mapping';
import type { ModuleField } from './wire';

/**
 * Stage 2 — Actions.
 *
 * This is the setting people get wrong and then ask why 4,000 leads
 * duplicated, so every option states what happens to a row that MATCHES and to
 * a row that does not. Both halves matter: "update only" silently drops every
 * new row, and that is the half nobody reads.
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
 * What each action does, keyed on the whole union so adding an action to
 * `IMPORT_ACTIONS` is a compile error here rather than an unexplained radio.
 * `matched`/`unmatched` are read against the chosen match key, which is why
 * they are functions of the label rather than fixed sentences.
 */
const ACTION_COPY: Record<
  ImportAction,
  { title: string; matched: string; unmatched: string }
> = {
  ADD_NEW: {
    title: 'Add new only',
    matched:
      'A row that matches an existing record is still created, and the pair is flagged for review. ' +
      'Duplicates are never blocked and never merged automatically.',
    unmatched: 'Every other row is created too.',
  },
  UPDATE_ONLY: {
    title: 'Update existing only',
    matched:
      'A matching record is edited in place, field by field, through the same path a manual edit ' +
      'takes — so every change lands in that record’s timeline as before → after.',
    unmatched: 'A row that matches nothing is SKIPPED. Nothing is created.',
  },
  BOTH: {
    title: 'Both — update on a match, create on a miss',
    matched: 'A matching record is edited in place, exactly as above.',
    unmatched: 'A row that matches nothing is created and assigned like any other new record.',
  },
};

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
  const chosen = matchable.find((f) => f.key === dedupeKey) ?? null;

  // The combination the commit refuses: with no match key nothing can match,
  // so "update only" would skip every row and "both" would create every row.
  // Two no-ops dressed as imports — said here rather than after five stages.
  const noKeyConflict = dedupeKey === IMPORT_DEDUPE_NONE && action !== 'ADD_NEW';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-lg font-medium text-heading">
          How should the records be processed
        </h3>
        <p className="mt-1 text-sm text-body">
          Whether a row becomes a new {labelPlural.toLowerCase()} record or edits one that already
          exists depends on two answers: what to do, and what counts as “already exists”.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">What to do with each row</legend>
        {IMPORT_ACTIONS.map((value) => {
          const copy = ACTION_COPY[value];
          const selected = value === action;
          return (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer gap-3 rounded-lg border bg-surface px-4 py-3',
                selected ? 'border-primary' : 'border-border',
              )}
            >
              <input
                type="radio"
                name="import-action"
                value={value}
                checked={selected}
                onChange={() => onAction(value)}
                className="mt-1 h-4 w-4 shrink-0 accent-primary"
                data-track={`${trackPrefix}.action.select`}
              />
              <span>
                <span className="block text-sm font-medium text-heading">{copy.title}</span>
                <span className="mt-1 block text-xs text-body">{copy.matched}</span>
                <span className="mt-1 block text-xs text-body">{copy.unmatched}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="max-w-md">
        <FieldLabel htmlFor="import-dedupe">
          Match existing {labelPlural.toLowerCase()} on
        </FieldLabel>
        <Select
          id="import-dedupe"
          value={dedupeKey}
          onChange={(e) => onDedupeKey(e.target.value)}
          data-track={`${trackPrefix}.dedupe.select`}
        >
          <option value={IMPORT_DEDUPE_NONE}>None — nothing is matched</option>
          {/* Grouped by uniqueness rather than by name: a field the Admin
              marked unique is the only kind that identifies ONE record, and a
              match key that hits three records is how the wrong one gets
              overwritten. Everything comparable is still offered. */}
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
        </Select>
        <p className="mt-1 text-xs text-body">
          {catalogueLoading
            ? 'Still reading this module’s fields — the list of match keys is not complete yet.'
            : matchable.length === 0
              ? 'No field of this module can identify an existing record, so rows can only be added as new.'
              : 'Any field of this module that can be compared for equality may be the match key — the field types decide, so a field added next year appears here on its own. Whichever you pick, a column has to be mapped to it in the next stage.'}
        </p>
      </div>

      {noKeyConflict ? (
        <p
          role="alert"
          className="rounded border border-warning bg-surface px-4 py-3 text-sm text-heading"
        >
          With no match key nothing can match, so “{ACTION_COPY[action].title}” would{' '}
          {action === 'UPDATE_ONLY' ? 'skip every row' : 'create every row'} and change nothing you
          intended. Choose a field to match on, or switch to “Add new only”.
        </p>
      ) : null}

      <div className="rounded-lg border border-border bg-surface px-4 py-3">
        <p className="text-xs text-heading">
          Two facts worth knowing before you press on
        </p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-body">
          <li>
            Records updated through an import cannot be undone in bulk. Every change is in the
            record’s timeline as before → after, so nothing is lost — but there is no one button
            that puts 4,000 records back.
          </li>
          <li>
            An empty cell never erases a value. A blank column in the file means “this column had
            nothing to say about that record”, not “clear it”.
          </li>
          {chosen ? (
            <li>
              Rows matching an existing record on <strong>{chosen.label}</strong>{' '}
              {action === 'ADD_NEW'
                ? 'are created anyway and flagged for review — nothing is blocked and nothing is merged.'
                : 'are edited in place rather than duplicated.'}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
