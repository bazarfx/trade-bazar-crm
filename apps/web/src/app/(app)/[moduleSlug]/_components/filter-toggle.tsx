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

/**
 * The event the band's Save Filter button raises, and the rail answers.
 *
 * The band is rendered by `page.tsx`, a SERVER component; the pop-up it has to
 * open is client state (`saving`) held in `list-screen.tsx`, which this slice
 * does not own. So the button raises a window event and `FilterPanel` — which
 * already receives `onSaveOpen` — calls it. The pop-up, its validation and its
 * permissions are byte-for-byte the ones the rail's own button raised; only
 * where the user presses has moved.
 *
 * The slug travels in the detail so two rails on one page could never answer
 * each other's button.
 */
export const SAVE_FILTER_EVENT = 'crm:save-filter';

export interface SaveFilterEventDetail {
  slug: string;
}

/**
 * The band's SECOND filter control.
 *
 * Measured, `Frame 482700` @416,93 in both
 * `…_When user apply the filter then a save filter option pop ups` frames:
 * 122x38, `bg #f6f8fa`, `border #00667a 1px`, `r:4`, padding 10/12, gap 10, a
 * teal `oui:filter` 16x16 and a MEDIUM 12px `#00667a` label — the same
 * anatomy as the Filter button beside it, in the brand colour. It sits 10px
 * right of that button (284…406, so 416…538).
 *
 * It is drawn in exactly those two frames and in no other: the plain
 * `CRM _ Leads_Filter By leads` rail, the four `-Sort Filter` frames and both
 * saved-filter frames have the Filter button alone. So the band renders it
 * only while a filter is live — there is nothing to name before then.
 */
export function SaveFilterButton({ slug }: { slug: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent<SaveFilterEventDetail>(SAVE_FILTER_EVENT, { detail: { slug } }),
        )
      }
      // The name the interaction log has carried for this action since it lived
      // in the rail footer. Moving the button must not break that continuity.
      data-track={`${slug}.view.save.open`}
      className="inline-flex h-[38px] w-[122px] items-center justify-center gap-2.5 rounded border border-primary bg-background px-3 text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <FilterIcon className="h-4 w-4" />
      Save Filter
    </button>
  );
}
