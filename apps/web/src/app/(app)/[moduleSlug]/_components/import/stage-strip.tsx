'use client';

import { cn } from '@/components/ui';

/**
 * The wizard's chrome: the numbered stage strip across the top, and the
 * counted tab rows stages 3 and 4 use.
 *
 * The strip is a NAVIGATION control, not a progress bar — the file draws all
 * five stages at once and lets you walk back. Forward is gated: a stage is
 * reachable only once every stage before it is satisfied, so the strip cannot
 * be used to skip the mapping and land on a commit that 422s.
 */

export interface StageStripProps {
  stages: readonly string[];
  current: number;
  /** how far the answers so far allow the user to jump */
  furthest: number;
  onSelect: (index: number) => void;
  trackPrefix: string;
  /** the run has started; the strip becomes a legend rather than a control */
  frozen?: boolean;
}

export function StageStrip({
  stages,
  current,
  furthest,
  onSelect,
  trackPrefix,
  frozen = false,
}: StageStripProps) {
  return (
    <nav
      aria-label="Import stages"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-8 py-3"
    >
      {stages.map((label, index) => {
        const isCurrent = index === current;
        const reachable = !frozen && index <= furthest;
        return (
          <button
            key={label}
            type="button"
            disabled={!reachable}
            aria-current={isCurrent ? 'step' : undefined}
            onClick={() => onSelect(index)}
            // Not `title` on the enabled ones: a tooltip repeating the label
            // is noise. On a locked stage it is the only explanation there is.
            title={reachable ? undefined : 'Finish the stage before this one first.'}
            className={cn(
              'flex items-center gap-2 rounded px-3 py-1.5 text-xs font-medium transition-colors',
              isCurrent ? 'bg-subtle text-heading' : 'text-body',
              reachable && !isCurrent ? 'hover:bg-background' : '',
              reachable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
            )}
            data-track={`${trackPrefix}.stage.select`}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex h-5 w-5 items-center justify-center rounded-pill text-overline',
                isCurrent ? 'bg-primary text-surface' : 'border border-border text-body',
              )}
            >
              {index + 1}
            </span>
            {/* Truncates rather than wraps: the strip must stay one row high
                however long a translated stage name gets. */}
            <span className="max-w-[14rem] truncate">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export interface CountedTab {
  id: string;
  label: string;
  count: number;
  /** nothing to show here, and saying why beats an empty list */
  disabled?: boolean;
}

export interface TabStripProps {
  tabs: readonly CountedTab[];
  active: string;
  onSelect: (id: string) => void;
  track: string;
  label: string;
}

/**
 * The file's tab rows — "All Columns (9)", "Mapped Modules (9)". Every count
 * is LIVE: mapping a column moves it between two tabs and both numbers change
 * in the same render, which is the whole point of the row.
 */
export function TabStrip({ tabs, active, onSelect, track, label }: TabStripProps) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap items-center gap-1">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled === true}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium transition-colors',
              isActive ? 'bg-primary text-surface' : 'border border-border bg-surface text-body',
              tab.disabled === true ? 'cursor-not-allowed opacity-60' : 'hover:border-primary',
            )}
            data-track={track}
          >
            {tab.label} ({tab.count})
          </button>
        );
      })}
    </div>
  );
}
