'use client';

import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import { ChevronDownIcon } from '../icons';

/**
 * The wizard's chrome: the chevron stage strip across the top, the segmented
 * tab bar stage 3 draws, and the counted rail rows stages 3 and 4 draw.
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
 * The five chips, re-measured 26 Aug 2026 off `CRM _ Leads_Import ` — absolute
 * positions in the 1440 frame, all at y=93 and 38 tall, with the LEFT and the
 * WIDTH both read off the file rather than one derived from the other:
 *
 *   x=284.0  w=121.5  "Upload"                (Group 6  → Rectangle 19)
 *   x=381.5  w=145.5  "Actions"               (Group 10 → Rectangle 19)
 *   x=503.0  w=255.0  "Module-File Mapping"   (Rectangle 20)
 *   x=728.0  w=195.5  "Fileld Mapping"        (Rectangle 21)
 *   x=904.0  w=145.5  "Assign"                (Rectangle 23)
 *
 * THEY OVERLAP, and that is the point: 284+121.5=405.5 while the next begins
 * at 381.5. Every chip is a VECTOR rather than a ROUNDED_RECTANGLE, and
 * decoding its `fillGeometry` blob out of the .fig shows why — chip 2 is
 *
 *   M(5.73,3.68) … L(116.5,0) … L(142.81,16.43) … L(117.63,37.63)
 *   … L(6.24,38) … L(25.6,19.71) … L(5.73,3.68) Z
 *
 * a chevron: a point on the right that tucks into a notch on the left of the
 * next one. Laid out with a flex gap it would be five separate tabs, which is
 * a different control saying a different thing about the order of the stages.
 *
 * THE OVERLAP IS NOT UNIFORM: right − next left measures 24 / 24 / 30 / 19.5.
 * An earlier revision here fixed ONE point depth of 24 for every chip and then
 * derived each width from the next chip's left, which tessellated but drew
 * chip 3 six pixels short of the file (249 against 255) and chip 4 four and a
 * half long (200 against 195.5).
 *
 * Both can hold at once. A chip's NOSE depth is its own overlap with the chip
 * after it, and that same number is the next chip's NOTCH depth — so every
 * point still sits exactly in the notch it was drawn for, with the file's own
 * lefts and the file's own widths and no seam. Only the last chip has no
 * neighbour to derive a depth from, so it keeps the family's modal 24.
 */
const LAST_POINT = 24;
const CHIP_HEIGHT = 38;
/** `Rectangle 5`'s own y=84 against the chips' y=93. */
const CHIP_TOP = 93 - 84;

/** left = measured x − 272 (the toolbar's left edge); labelInset = the label
 *  frame's measured x − the chip's x. The file's insets are NOT uniform: the
 *  first chip has no incoming point to clear and the rest do. */
const CHIPS: readonly { left: number; width: number; labelInset: number }[] = [
  // label frames at x = 296, 418, 546, 769, 948.
  { left: 284 - 272, width: 121.5, labelInset: 296 - 284 },
  { left: 381.5 - 272, width: 145.5, labelInset: 418 - 381.5 },
  { left: 503 - 272, width: 255, labelInset: 546 - 503 },
  { left: 728 - 272, width: 195.5, labelInset: 769 - 728 },
  { left: 904 - 272, width: 145.5, labelInset: 948 - 904 },
];

/** How deep this chip's point runs — its overlap with the chip after it. */
function noseOf(index: number): number {
  const here = CHIPS[index];
  const next = CHIPS[index + 1];
  if (here === undefined || next === undefined) return LAST_POINT;
  return here.left + here.width - next.left;
}

/** How deep this chip's notch runs — the nose of the chip before it, so the
 *  two are the same number by construction and the seam cannot open. */
function notchOf(index: number): number {
  return index === 0 ? 0 : noseOf(index - 1);
}

/**
 * The chevron as a PATH rather than a `clip-path`.
 *
 * Measured, every chip carries a 1px stroke all the way round — including the
 * two diagonals. `clip-path` cuts the border box, so the diagonal edges come
 * out unstroked and the "todo" chips (#f6f8fa on the #ffffff toolbar) lose the
 * only thing that makes them visible. A stroked path draws all six edges.
 *
 * `i = 0.5` keeps the 1px stroke inside the box; `r:2` is the file's corner
 * radius, drawn only on the first chip's flat left edge — every other corner
 * is a chevron vertex the file leaves sharp.
 */
function chevronPath(w: number, nose: number, notch: number, first: boolean): string {
  const h = CHIP_HEIGHT;
  const i = 0.5;
  const r = 2;
  const mid = h / 2;
  const point = `L ${w - nose} ${i} L ${w - i} ${mid} L ${w - nose} ${h - i}`;
  if (first) {
    return (
      `M ${i + r} ${i} ${point} L ${i + r} ${h - i} ` +
      `Q ${i} ${h - i} ${i} ${h - i - r} L ${i} ${i + r} Q ${i} ${i} ${i + r} ${i} Z`
    );
  }
  return `M ${i} ${i} ${point} L ${i} ${h - i} L ${notch} ${mid} Z`;
}

/**
 * THREE states, read off the chips' own fill paints across the whole family.
 * Frames 1, 3, 15, 18 and 23 walk the current stage from 1 to 5 and every one
 * of them draws the same rule:
 *
 *   index <  current  fill #00667a          stroke #e5e7eb  label #ffffff
 *   index == current  fill #00667a @ **10%** stroke #00667a  label #00667a
 *   index >  current  fill #f6f8fa          stroke #e5e7eb  label #6b7280
 *
 * The current chip is a TINT, not a solid — the file writes it both ways, as a
 * 10%-opacity #00667a paint and as the flat #e5f0f2 that tint resolves to over
 * white, and #00667a on #e5f0f2 is perfectly readable. An earlier reading here
 * took the current chip for a solid fill with an invisible same-colour label
 * and "corrected" it to white-on-teal, which erased the distinction between
 * the stage you are ON and the stages you have finished.
 *
 * `color-mix` against `--neutral-10` reproduces the tint exactly (10% of
 * #00667a over #ffffff is #e5f0f2) without naming a colour the token set does
 * not carry.
 */
const CHIP_FILL: readonly string[] = [
  'var(--primary-hover)',
  'color-mix(in srgb, var(--primary-hover) 10%, var(--neutral-10))',
  'var(--background)',
];
const CHIP_STROKE: readonly string[] = [
  'var(--border)',
  'var(--primary-hover)',
  'var(--border)',
];
const CHIP_LABEL: readonly string[] = [
  'text-surface',
  'text-primary',
  'text-body',
];

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
        const width = chip.width;
        const isCurrent = index === current;
        /** 0 done · 1 current · 2 still to come — see the table above. */
        const state = index < current ? 0 : index === current ? 1 : 2;
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
              width,
              top: CHIP_TOP,
              height: CHIP_HEIGHT,
              paddingLeft: chip.labelInset,
              // The chip BEFORE paints over the chip after, which is how a
              // point sits in a notch. Exact tessellation makes this cosmetic,
              // but a sub-pixel seam still reads better covered than open.
              zIndex: stages.length - index,
            }}
            className={cn(
              'absolute flex items-center gap-2 text-left',
              reachable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
            )}
            data-track={`${trackPrefix}.stage.select`}
          >
            {/* The chevron itself. `absolute inset-0` with a viewBox in real
                pixels — no scaling, so the 1px stroke stays 1px and the nose
                keeps the angle the file draws. */}
            <svg
              viewBox={`0 0 ${width} ${CHIP_HEIGHT}`}
              width={width}
              height={CHIP_HEIGHT}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
            >
              <path
                d={chevronPath(width, noseOf(index), notchOf(index), index === 0)}
                style={{ fill: CHIP_FILL[state], stroke: CHIP_STROKE[state], strokeWidth: 1 }}
              />
            </svg>
            {/* Ellipse 1 — 8x8, 8px before the label (the label frame is
                gap:8 with the dot at its own x). Takes the label's colour,
                which is what the file draws in every instance. */}
            <span
              className={cn(
                'relative h-2 w-2 shrink-0 rounded-pill bg-current',
                CHIP_LABEL[state],
              )}
            />
            {/* Inter Regular 16px, line-height 100% in a 20-tall row, letter
                spacing 0.4 — measured on every chip label in the family.
                Truncates rather than wraps: the chip is a fixed measured width
                and the strip stays one row high however long a translated
                stage name gets. */}
            <span
              className={cn(
                'relative truncate text-lg leading-5 tracking-[0.4px]',
                CHIP_LABEL[state],
              )}
            >
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * `Frame 482702` — the count that follows every tab and rail label in this
 * family. 16x16, r:2, `bg #f6f8fa`, a 0.2px `#e5e7eb` stroke, and the number
 * in parentheses at Regular 8px `#6b7280`.
 *
 * 8px is below every step of the type scale, which is why it is stated inline
 * with the node named — the same way `h-[38px]` and `gap-[18px]` are.
 */
export function CountBadge({ count, onSurface = false }: { count: number; onSurface?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px]',
        'border border-border text-[8px] leading-none text-body',
        // The ACTIVE tab in `Games` puts the badge on #ffffff; everywhere else
        // it is #f6f8fa. Measured, and the only difference between the two.
        onSurface ? 'bg-surface' : 'bg-background',
      )}
    >
      ({count})
    </span>
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
 * The segmented tab bar stage 3 draws — `Games` @469,164, measured:
 *
 *   container  500x36  flex-row gap:10 pad:4  bg #ffffff  border #e5e7eb  r:4
 *   tab         …x28   pad 12/22/12/23  r:4
 *     active    bg #e5f0f2  border #00667a 1px  label #00667a  badge on #ffffff
 *     resting   bg #ffffff  no border          label #6b7280  badge on #f6f8fa
 *   label      Inter Semi Bold 12px, count in the 16x16 badge beside it, gap 8
 *
 * Every count is LIVE: mapping a column moves it between two tabs and both
 * numbers change in the same render, which is the whole point of the row.
 */
export function TabStrip({ tabs, active, onSelect, track, label }: TabStripProps) {
  return (
    <div
      role="tablist"
      aria-label={label}
      // h-9 is 36 exactly; the 4px padding and 10px gap are the file's.
      className="inline-flex h-9 items-center gap-[10px] rounded border border-border bg-surface p-1"
    >
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
            style={
              isActive
                ? // #e5f0f2 is 10% #00667a over white — the same tint the
                  // current stage chip carries, expressed the same way.
                  { backgroundColor: 'color-mix(in srgb, var(--primary-hover) 10%, var(--neutral-10))' }
                : undefined
            }
            className={cn(
              // 28 tall, pad 12/22 — the file draws 23 on the left of the
              // active tab and 22 elsewhere, which is its 1px border.
              'flex h-7 items-center gap-2 rounded px-[22px] text-xs font-semibold',
              isActive ? 'border border-primary text-primary' : 'bg-surface text-body',
              tab.disabled === true ? 'cursor-not-allowed opacity-60' : 'hover:text-primary',
            )}
            data-track={track}
          >
            <span className="truncate">{tab.label}</span>
            <CountBadge count={tab.count} onSurface={isActive} />
          </button>
        );
      })}
    </div>
  );
}

export interface RailRowProps {
  label: string;
  count: number;
  active?: boolean;
  /** omit to draw the row as a heading rather than a control */
  onSelect?: () => void;
  /** required whenever `onSelect` is given — every interactive element in this
   *  product carries one, and the interaction log has no way to name a click
   *  that arrives without it */
  track: string;
  /**
   * The row's own gap, which the file draws differently on the two stages that
   * use this row: 10 on stage 3 (`Frame 2` @284,164 — chevron, 10, label, 10,
   * badge) and 0 on stage 4 (`Frame 2` @284,216, the badge butted straight
   * against the label). Typed as the two measured values so a third cannot be
   * invented at a call site.
   */
  gap?: 0 | 10;
  /** whatever the group holds when it is open — file chips, a module row */
  children?: ReactNode;
}

/**
 * A counted rail row — the left column of stages 3 and 4.
 *
 *   `Frame 2` / `Frame 482739` / `Frame 482740`  @284, 161x16, pitch 28
 *   chevron `Icon / Chevron` 16x16, a `#111827` union vector, FIRST in the row
 *   label   Inter Medium 12px `#111827`
 *   count   the 16x16 `Frame 482702` badge, 0 or 10 after the label
 *   active  the label turns `#00667a` (stage 4's "All Columns")
 *
 * The row is left-packed, NOT justified: re-measured 26 Aug 2026, "Mapped
 * Files"'s badge sits at x=397 — 113 into a 161-wide row, i.e. hugging the
 * 77-wide label — and stage 4's "All Columns" badge at x≈377. An earlier
 * revision here used `justify-between`, which pinned every badge to x≈429 and
 * left each count floating 30–50px away from the label it counts. The 16px
 * that revision reserved with `pl-4` is the chevron's own slot, now drawn.
 *
 * The rail is 161 wide against the panel's own 12px inset, which is why
 * nothing here states an x: the stage lays the column out and this draws one
 * row of it.
 */
export function RailRow({
  label,
  count,
  active = false,
  onSelect,
  track,
  gap = 10,
  children,
}: RailRowProps) {
  const head = (
    <>
      {/* Decorative: the row's accessible name is its label and count, and the
          disclosure it stands for is the group drawn under it. */}
      <ChevronDownIcon className="h-4 w-4 shrink-0 text-heading" />
      <span className={cn('min-w-0 truncate text-xs font-medium', active ? 'text-primary' : 'text-heading')}>
        {label}
      </span>
      <CountBadge count={count} />
    </>
  );
  const row = cn('flex h-4 w-full items-center', gap === 0 ? 'gap-0' : 'gap-[10px]');
  return (
    // `Frame 482726`, the file chip stage 3 opens onto, sits at y=186 under a
    // row whose own box ends at 180 — a 6px gap, not the 8 used before.
    <div className="flex flex-col gap-[6px]">
      {onSelect === undefined ? (
        <div className={row}>{head}</div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={active}
          className={cn(row, 'text-left')}
          data-track={track}
        >
          {head}
        </button>
      )}
      {children}
    </div>
  );
}
