'use client';

import { useEffect, useRef, useState } from 'react';
import { Select } from '@/components/ui';

/**
 * The sort control — re-measured off the four `CRM _ Leads-Sort Filter` frames
 * on 26 Aug 2026, and the earlier reading of it was wrong.
 *
 * docs/DESIGN-SPEC.md said "a small dropdown, 132×56, radius 6, two 28px rows —
 * Descending and Ascending". That box is real, but it is NOT the sort control:
 * it is the DIRECTION SELECT'S OWN dropdown, drawn open in the fourth frame.
 * What the `Sort` toolbar button opens is `Group 1` — a 300×132 pop-over:
 *
 * | Node | Measured |
 * |---|---|
 * | `Group 1` / `Rectangle 7` | 300×132, `bg #ffffff`, `border #e5e7eb 1px`, `r:4` |
 * | `Frame 482693` | @12,24 — 276×96, `flex-col gap:16` (pad 24 top, 12 elsewhere) |
 * | `Sort By` | 276×12, Inter **Regular 12px** `#111827` |
 * | `Frame 482690` | 276×28, `flex-row gap:12` — two 132×28 selects |
 * | ↳ each select | `bg #f6f8fa`, `border #e5e7eb 0.5px`, `r:4`, pad 8, chevron 12 flush right |
 * | `Frame 482691` | 186×32 right-aligned, `flex-row gap:8` |
 * | ↳ Cancel | 89×32, `border #00667a 1px`, no fill, label `#00667a` 10px |
 * | ↳ Apply | 89×32, `bg #00667a`, label `#ffffff` 10px |
 *
 * Anchoring: the pop-over's right edge is flush with the `Sort` button's right
 * edge and its top is 3px below it (button @1303,164 68×28; group @1071,195).
 *
 * TWO deliberate departures from the file, both noted where they occur:
 *
 *  - It writes "Decending". That is a typo in a Zoho mock, and a typo is
 *    CONTENT — the rule is to match structure, geometry, type and colour and
 *    never to copy the file's data. So this says "Descending".
 *  - The selects' labels are drawn at 8px and the direction dropdown's rows at
 *    10px. 8px is below every step of the type scale, so both render at the
 *    10px the same file uses for the rail's own rows — the precedent this
 *    file's saved-filter menu already set.
 */
export interface SortMenuProps {
  slug: string;
  /** the column the direction applies to, already resolved by the caller */
  fieldLabel: string;
  direction: 'asc' | 'desc';
  onSelect: (direction: 'asc' | 'desc') => void;
  onClose: () => void;
}

/**
 * The two 132×28 selects. `tone="canvas"` is the `#f6f8fa` fill the file gives
 * them; the three arbitrary utilities override the tone's own `h-9`, `px-3`
 * and `text-xs`.
 *
 * They have to be ARBITRARY to win. Two competing utilities for one property
 * resolve by STYLESHEET order, not by the order they appear in the attribute,
 * and Tailwind emits the named scale (`h-7`, `h-8`, `h-9`) before any
 * bracketed value — so `h-7` passed alongside the tone's `h-9` silently loses,
 * while `h-[28px]` reliably wins.
 *
 * The 132 is a flex BASIS rather than a width for the same reason turned the
 * other way: two bracketed values have no guaranteed order between them, and
 * `.w-[132px]` is in fact emitted before the primitive's own `w-full`. A flex
 * item's basis is used in place of its width, so this one cannot lose.
 */
const SELECT = 'h-[28px] shrink-0 basis-[132px] px-[8px] text-[10px]';

/** Cancel and Apply: 89×32, radius 4, 10px label. */
const ACTION =
  'inline-flex h-8 w-[89px] shrink-0 items-center justify-center rounded text-[10px] ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export function SortMenu({ slug, fieldLabel, direction, onSelect, onClose }: SortMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * The file draws Cancel and Apply, so the pop-over holds a DRAFT and commits
   * on Apply — picking a direction no longer navigates on the spot. Apply
   * raises the same `onSelect` the row used to, so the caller's query change,
   * its network call and its permissions are untouched.
   */
  const [draft, setDraft] = useState<'asc' | 'desc'>(direction);

  useEffect(() => {
    // pointerdown, not click: a click that lands on another control should
    // close this and still reach that control, which a click-phase close on
    // the document would swallow.
    function onPointerDown(e: PointerEvent) {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    // The direction select, not the field one — the field select is inert
    // until the toolbar can hand this component the sortable column list.
    ref.current?.querySelector<HTMLElement>('select:not([disabled])')?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Sort"
      // right-0 + mt-[3px]: measured flush with the Sort button's right edge,
      // 3px below its 28px box.
      className="absolute right-0 top-full z-40 mt-[3px] w-[300px] rounded border border-border bg-surface px-3 pb-3 pt-6"
    >
      {/* `Frame 482693` — 276 wide, flex-col gap 16 */}
      <div className="flex flex-col gap-4">
        {/* `Frame 482692` — label + selects, gap 8 */}
        <div className="flex flex-col gap-2">
          <p className="text-xs text-heading">Sort By</p>

          {/* `Frame 482690` — two 132×28 selects, gap 12 */}
          <div className="flex gap-3">
            {/*
              The file's left select lists this module's fields (its own list is
              Zoho's, so it is never copied). The toolbar owns which column the
              list is sorted by and hands this component only the resolved
              label, so the control is drawn at its measured size and disabled
              until that list arrives — the column header's own caret is where
              the field is chosen today. An enabled select with one option would
              be a control that does nothing.
            */}
            <Select
              value="current"
              disabled
              aria-label="Sort field"
              title={`Sorting by ${fieldLabel} — choose the column from its header`}
              className={SELECT}
              data-track={`${slug}.sort.field.select`}
            >
              <option value="current">{fieldLabel}</option>
            </Select>

            <Select
              value={draft}
              aria-label="Sort direction"
              onChange={(e) => setDraft(e.target.value === 'desc' ? 'desc' : 'asc')}
              className={SELECT}
              // The name the interaction log has always carried for this
              // control. Renaming it would break that log's continuity.
              data-track={`${slug}.sort.direction.select`}
            >
              {/* Row order is the file's: descending first. */}
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </Select>
          </div>
        </div>

        {/* `Frame 482691` — 186×32, right-aligned, gap 8 */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            data-track={`${slug}.sort.cancel.click`}
            className={`${ACTION} border border-primary text-primary hover:bg-background`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSelect(draft)}
            data-track={`${slug}.sort.apply.click`}
            className={`${ACTION} bg-primary text-surface hover:bg-primary-strong`}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
