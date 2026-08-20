import Link from 'next/link';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

/**
 * Pagination, centred under the table as the frame draws it.
 *
 * A server component built from `<Link>`s rather than a client component with
 * a router push: the page number lives in the URL, so a paged list can be
 * bookmarked, shared and re-entered by the browser's back button — none of
 * which survives holding it in component state.
 */
export interface PaginationProps {
  slug: string;
  /** 1-based. */
  page: number;
  pageCount: number;
  /**
   * Builds the href for a page number. Passed in rather than assembled here:
   * the rest of the query state — the saved view, the sort, the search term
   * and the fragment carrying an ad-hoc filter — has to survive a page click,
   * and a pager that rebuilds the URL from two of those parameters silently
   * drops the others. One builder, in the screen that owns the state.
   */
  hrefFor: (page: number) => string;
}

/** Page buttons drawn at once. Beyond this the row is wider than the panel. */
const WINDOW = 7;

function pageWindow(page: number, pageCount: number): number[] {
  const size = Math.min(WINDOW, pageCount);
  // Keep the current page centred until the window hits either end.
  const start = Math.min(Math.max(1, page - Math.floor(size / 2)), pageCount - size + 1);
  return Array.from({ length: size }, (_, i) => start + i);
}

const STEP =
  'inline-flex h-8 items-center justify-center rounded text-xs font-medium ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

export function Pagination({ slug, page, pageCount, hrefFor }: PaginationProps) {
  // An empty module still shows page 1 of 1 — a pager that vanishes reads as a
  // broken screen, and this one is telling the truth.
  const total = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), total);

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-center gap-3 px-3 py-4"
    >
      <Step
        slug={slug}
        href={hrefFor(current - 1)}
        enabled={current > 1}
        label="Previous page"
        icon={<ChevronLeftIcon className="h-4 w-4" />}
      />

      <div className="flex items-center gap-1">
        {pageWindow(current, total).map((n) =>
          n === current ? (
            <span
              key={n}
              aria-current="page"
              className={`${STEP} min-w-8 bg-primary px-2 text-surface`}
            >
              {n}
            </span>
          ) : (
            <Link
              key={n}
              href={hrefFor(n)}
              data-track={`${slug}.list.page.open`}
              className={`${STEP} min-w-8 px-2 text-heading hover:bg-background`}
            >
              {n}
            </Link>
          ),
        )}
      </div>

      <Step
        slug={slug}
        href={hrefFor(current + 1)}
        enabled={current < total}
        label="Next page"
        icon={<ChevronRightIcon className="h-4 w-4" />}
      />
    </nav>
  );
}

function Step({
  slug,
  href,
  enabled,
  label,
  icon,
}: {
  slug: string;
  href: string;
  enabled: boolean;
  label: string;
  icon: React.ReactNode;
}) {
  // A disabled arrow renders as a span, not a dimmed link: a link that goes
  // nowhere is still in the tab order and still announces as a link.
  if (!enabled) {
    return (
      <span aria-disabled="true" className={`${STEP} w-8 bg-subtle text-body opacity-40`}>
        {icon}
      </span>
    );
  }
  return (
    <Link
      href={href}
      aria-label={label}
      data-track={`${slug}.list.page.open`}
      className={`${STEP} w-8 bg-subtle text-heading hover:bg-background`}
    >
      {icon}
    </Link>
  );
}
