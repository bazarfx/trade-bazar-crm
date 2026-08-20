'use client';

import { useEffect, useRef } from 'react';

/**
 * The sort dropdown, measured from the file: 132×56, radius 6, white on
 * `#e5e7eb`, two 28px rows of 10px text — Descending in `#6b7280`, Ascending
 * in `#111827` on `#f6f8fa` when it is the selected one.
 *
 * Row ORDER is the file's, descending first. It reads backwards next to every
 * other sort control in the world, and it is what the design shows; the screen
 * spec wins over the instinct until someone re-measures it.
 *
 * The dropdown only sets the DIRECTION, because that is all the file draws.
 * The sort FIELD is chosen where it is obvious — the column header — so the
 * two halves of a sort are never split across two hidden menus.
 */
export interface SortMenuProps {
  slug: string;
  /** the column the direction applies to, already resolved by the caller */
  fieldLabel: string;
  direction: 'asc' | 'desc';
  onSelect: (direction: 'asc' | 'desc') => void;
  onClose: () => void;
}

/** 28px rows and 10px text are below every step of the shared scales, and are
 *  measurements rather than tokens — see docs/DESIGN-SPEC.md, "Sort". */
const ROW =
  'flex h-7 w-full items-center px-3 text-left text-overline ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary';

export function SortMenu({ slug, fieldLabel, direction, onSelect, onClose }: SortMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

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
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);

  const rows: { value: 'asc' | 'desc'; label: string }[] = [
    { value: 'desc', label: 'Descending' },
    { value: 'asc', label: 'Ascending' },
  ];

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Sort ${fieldLabel}`}
      // overflow-hidden gives the rows the container's corners, which is how
      // the file draws them — the radius is on the box, not on each row.
      className="absolute right-0 top-full z-40 mt-1 h-14 w-[132px] overflow-hidden rounded-[6px] border border-border bg-surface"
    >
      {rows.map((row) => (
        <button
          key={row.value}
          type="button"
          role="menuitemradio"
          aria-checked={direction === row.value}
          onClick={() => onSelect(row.value)}
          data-track={`${slug}.sort.direction.select`}
          className={
            `${ROW} ` +
            (direction === row.value
              ? 'bg-background font-medium text-heading'
              : 'text-body hover:bg-background')
          }
        >
          {row.label}
        </button>
      ))}
    </div>
  );
}
