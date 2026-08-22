'use client';

import { FilterIcon } from './icons';

/**
 * The toolbar band's left control.
 *
 * Measured, frame "CRM _ Leads": `Frame 482685` @284,93 — 122x38, white,
 * 1px #e5e7eb, padding 10/12, gap 10, a 16px `oui:filter` glyph and a 12px
 * MEDIUM label (the three action buttons opposite it are 12px Regular; the
 * file genuinely differs on that, so this one does too).
 *
 * It scrolls the filter rail into view and focuses it rather than toggling a
 * second filter surface. The rail is always visible at this breakpoint — the
 * file draws no collapsed state for it — so a control that hid it would be
 * inventing behaviour the design does not have.
 */
export function FilterToggle({ slug }: { slug: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const rail = document.getElementById(`filter-rail-${slug}`);
        rail?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        rail?.querySelector<HTMLElement>('button, input, select')?.focus();
      }}
      data-track={`${slug}.list.filter.toggle`}
      className="inline-flex h-[38px] w-[122px] items-center justify-center gap-2.5 rounded border border-border bg-surface px-3 text-xs font-medium text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <FilterIcon className="h-4 w-4" />
      Filter
    </button>
  );
}
