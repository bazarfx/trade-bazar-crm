'use client';

import type { ReactNode } from 'react';
import { Button, Input, Select } from '@/components/ui';

/**
 * THE payload-mapping editor, shared by every webhook surface that maps
 * dot-paths out of an unknown payload onto a list of targets.
 *
 * Campaign intake maps onto a module's FIELDS; the ARK pipeline maps onto a
 * fixed list of CONCEPTS (account number, phone, deposit…). The rule row is
 * identical — a path, a target, a transform — so the row lives once, here,
 * and each overlay hands in its own target list, transform vocabulary and
 * tracking prefix. Two editors would be two places for the "half-filled row"
 * rule to drift apart.
 *
 * Strings all the way down: the editor holds what the Admin typed and each
 * overlay validates against its own shared schema on save.
 */

export interface MappingTarget {
  value: string;
  label: string;
}

export interface DraftRule {
  source: string;
  target: string;
  transform: string;
}

export interface MappingRulesEditorProps {
  rules: DraftRule[];
  onChange: (rules: DraftRule[]) => void;
  /** what a rule may point at — module fields, or the ARK concept list */
  targets: MappingTarget[];
  targetsLoading?: boolean;
  /** accessible name of the target picker — "Target field" / "Concept" */
  targetLabel: string;
  targetPlaceholder: string;
  transforms: readonly string[];
  transformLabel: Record<string, string>;
  /** `${trackPrefix}.rule.source.input`, `.rule.target.select`, … */
  trackPrefix: string;
  /** the paragraph above the rows, saying what a rule does HERE */
  intro: ReactNode;
  emptyText: string;
}

/** A rule the Admin started but did not finish — refused on save, never
 *  silently dropped, because dropping it saves a mapping they did not write. */
export function hasHalfDoneRule(rules: DraftRule[]): boolean {
  return rules
    .filter((r) => r.source.trim() !== '' || r.target !== '')
    .some((r) => r.source.trim() === '' || r.target === '');
}

/** The rows worth saving: both halves present. */
export function completedRules(rules: DraftRule[]): DraftRule[] {
  return rules
    .filter((r) => r.source.trim() !== '' && r.target !== '')
    .map((r) => ({ ...r, source: r.source.trim() }));
}

export function MappingRulesEditor({
  rules,
  onChange,
  targets,
  targetsLoading = false,
  targetLabel,
  targetPlaceholder,
  transforms,
  transformLabel,
  trackPrefix,
  intro,
  emptyText,
}: MappingRulesEditorProps) {
  function patch(index: number, change: Partial<DraftRule>) {
    onChange(rules.map((r, i) => (i === index ? { ...r, ...change } : r)));
  }

  function remove(index: number) {
    onChange(rules.filter((_, i) => i !== index));
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-heading">Rules</h3>
      <p className="mt-1 text-xs text-body">{intro}</p>

      <div className="mt-4 flex flex-col gap-3">
        {rules.length === 0 ? (
          <p className="rounded border border-border bg-background px-4 py-3 text-sm text-body">
            {emptyText}
          </p>
        ) : null}

        {rules.map((rule, index) => (
          // Index keys are safe here: rows reorder only by removal, and a
          // stable id would have to be invented per keystroke.
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              value={rule.source}
              placeholder="payload path, e.g. data.phone"
              aria-label="Payload path"
              className="w-56 flex-1 font-mono"
              onChange={(e) => patch(index, { source: e.target.value })}
              data-track={`${trackPrefix}.rule.source.input`}
            />
            <span aria-hidden="true" className="text-xs text-body">
              →
            </span>
            <Select
              value={rule.target}
              aria-label={targetLabel}
              className="w-52"
              disabled={targetsLoading}
              onChange={(e) => patch(index, { target: e.target.value })}
              data-track={`${trackPrefix}.rule.target.select`}
            >
              <option value="">{targetsLoading ? 'Loading…' : targetPlaceholder}</option>
              {targets.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <Select
              value={rule.transform}
              aria-label="Transform"
              className="w-40"
              onChange={(e) => patch(index, { transform: e.target.value })}
              data-track={`${trackPrefix}.rule.transform.select`}
            >
              {transforms.map((t) => (
                <option key={t} value={t}>
                  {transformLabel[t] ?? t}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => remove(index)}
              aria-label="Remove this rule"
              data-track={`${trackPrefix}.rule.remove`}
            >
              Remove
            </Button>
          </div>
        ))}

        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onChange([...rules, { source: '', target: '', transform: transforms[0] ?? 'none' }])}
            data-track={`${trackPrefix}.rule.add`}
          >
            Add rule
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The newest raw payload a source has received, beside the rules, so the
 * Admin maps against REAL keys rather than remembered ones. Nothing arrived
 * yet is a state worth saying out loud: it is the whole reason the mapping
 * is still empty.
 */
export function ReferencePayload({ payload }: { payload: unknown }) {
  const hasPayload = payload !== null && payload !== undefined;
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium text-heading">Reference payload</h3>
      <p className="mt-1 text-xs text-body">
        {hasPayload
          ? 'The newest raw payload this source has received — map against these keys, not remembered ones.'
          : 'Nothing has arrived on this source yet. The first payload — even a failed one — will appear here to map against.'}
      </p>
      {hasPayload ? (
        <pre className="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-border bg-background p-4 font-mono text-xs leading-5 text-heading">
          {JSON.stringify(payload, null, 2)}
        </pre>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border bg-background px-4 py-8 text-center text-xs text-body">
          Waiting for the first payload.
        </div>
      )}
    </div>
  );
}
