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

/**
 * The five chips, measured off `CRM _ Leads_Import ` — absolute positions in
 * the 1440 frame, all at y=93 and 38 tall:
 *
 *   x=284  w=122   "Upload"                 (Group 6 → Rectangle 19)
 *   x=382  w=146   "Actions"                (Group 7 → Rectangle 19)
 *   x=503  w=255   "Module-File Mapping"    (Rectangle 20)
 *   x=728  w=196   "Fileld Mapping"         (Rectangle 21)
 *   x=904  w=146   "Assign"                 (Rectangle 23)
 *
 * THEY OVERLAP, and that is the point: 284+122=406 while the next begins at
 * 382. Every neighbour pair overlaps by 20–30px and every chip is a VECTOR
 * rather than a ROUNDED_RECTANGLE. It is a chevron breadcrumb — each chip ends
 * in a point that tucks into the next chip's notch — not a row of pills. Laid
 * out with a flex gap it would be five separate tabs, which is a different
 * control that says a different thing about the order of the stages.
 *
 * So the chips are positioned ABSOLUTELY at the measured offsets rather than
 * flowed. `LEFT` below is x−272 (the toolbar's own left edge) and the label
 * insets are likewise measured per chip, because the file's are not uniform:
 * the first chip has no incoming point to clear and the rest do.
 */
const CHIPS: readonly { left: number; width: number; labelInset: number }[] = [
  // label frames at x = 296, 418, 546, 769, 948 → inset = that − chip left.
  { left: 284 - 272, width: 122, labelInset: 296 - 284 },
  { left: 382 - 272, width: 146, labelInset: 418 - 382 },
  { left: 503 - 272, width: 255, labelInset: 546 - 503 },
  { left: 728 - 272, width: 196, labelInset: 769 - 728 },
  { left: 904 - 272, width: 146, labelInset: 948 - 904 },
];

/** Measured overlap between neighbours: 24, 25, 30, 20. One value has to draw
 *  the point, and 24 is the modal one — it is also the only one that lands on
 *  the 4px grid the rest of the file uses. */
const POINT = 24;

function chevron(first: boolean, last: boolean): string {
  const nose = last
    ? '100% 0, 100% 100%'
    : `calc(100% - ${POINT}px) 0, 100% 50%, calc(100% - ${POINT}px) 100%`;
  const tail = first ? '' : `, ${POINT}px 50%`;
  return `polygon(0 0, ${nose}, 0 100%${tail})`;
}

/**
 * The wizard's stage strip — a NAVIGATION control, not a progress bar. The
 * file draws all five at once and lets you walk back; forward is gated, so the
 * strip cannot be used to skip the mapping and land on a commit that 422s.
 *
 * TWO states, and the strip is a PROGRESS FILL rather than a single
 * highlight. Read off the fill paints of two frames at opposite ends:
 *
 *   frame [1]  (Upload current)  Upload teal; Actions…Assign all #f6f8fa
 *   frame [19] (Assign current)  ALL FIVE teal; Upload…Module-File labels #ffffff
 *
 * So every chip up to AND INCLUDING the current one is filled #00667a, and
 * everything after it is #f6f8fa. That is the only rule both frames agree on.
 *
 *   index <= current   fill #00667a  label #ffffff  → bg-primary    text-surface
 *   index >  current   fill #f6f8fa  label #6b7280  → bg-background text-body
 *
 * ONE DELIBERATE DEPARTURE, and it is a correction rather than a choice: in
 * both frames the CURRENT chip's label is drawn #00667a on that same #00667a
 * fill — invisible. Frame [1]'s "Upload" and frame [19]'s "Assign" both do it,
 * so it is a consistent slip and not a state. A label the same colour as its
 * background cannot be a specification, so the current chip takes the #ffffff
 * its finished neighbours are given.
 *
 * Label is 16px/20 with an 8x8 dot 8px to its left (dot at the label frame's
 * x, text at x+16, so the gap is 16−8=8). The dot takes the label's colour,
 * which is what the file draws in every readable instance.
 */
export function StageStrip({
  stages,
  current,
  furthest,
  onSelect,
  trackPrefix,
  frozen = false,
}: StageStripProps) {
  return (
    // The strip sits inside `Rectangle 5` (1152x56 at y=84) and the chips are
    // absolute within it, so the nav itself is the positioning context and has
    // the toolbar's own height.
    <nav aria-label="Import stages" className="relative h-[56px] w-full">
      {stages.map((label, index) => {
        const chip = CHIPS[index];
        if (chip === undefined) return null;
        const isCurrent = index === current;
        /** filled: this stage and every one behind it — see the note above. */
        const filled = index <= current;
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
            style={{
              left: chip.left,
              width: chip.width,
              // y=93 against the toolbar's y=84.
              top: 93 - 84,
              height: 38,
              paddingLeft: chip.labelInset,
              clipPath: chevron(index === 0, index === stages.length - 1),
              // Left chip's point paints OVER the next chip's notch, which is
              // the stacking the file draws (each VECTOR sits above the one
              // after it).
              zIndex: stages.length - index,
            }}
            className={cn(
              'absolute flex items-center gap-2 text-left text-base leading-5',
              filled ? 'bg-primary text-surface' : 'bg-background text-body',
              reachable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
            )}
            data-track={`${trackPrefix}.stage.select`}
          >
            {/* Ellipse 1 — 8x8, vertically centred in the 20px label row. */}
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-pill bg-current" />
            {/* Truncates rather than wraps: the chip is a fixed measured width
                and the strip must stay one row high however long a translated
                stage name gets. */}
            <span className="truncate">{label}</span>
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
