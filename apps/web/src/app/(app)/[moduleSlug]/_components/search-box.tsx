'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui';
import { buildListHref, withCurrentHash, type ListQuery, type ListQueryLimits } from './list-query';
import { SearchIcon } from './icons';

/**
 * The list search box.
 *
 * Measured, frame "CRM _ Leads": `Rectangle 4` @284,190 — 206x36, fill
 * #f6f8fa, 1px #e5e7eb. It lives INSIDE the filter rail, directly under the
 * "Filter by Leads" heading — not in a row of its own above the panels, which
 * is where it used to be. 206 is the rail's full inner width (230 − 12 − 12),
 * so it stretches rather than carrying a fixed width.
 *
 * The magnifier is on the RIGHT (@460,198, 20x20 — ten pixels in from the
 * field's right edge at 490), and the placeholder is 12px LIGHT #6b7280
 * @294,200. Both are easy to get backwards from memory; both are measured.
 *
 * The term is compiled by the engine into an OR across this module's
 * SEARCHABLE field types (`FIELD_TYPE_SPECS[type].searchable`) and ANDed under
 * the reader's scope filter, exactly like a filter tree. It narrows; it can
 * never widen. A module where nothing is substring-matchable denies the search
 * rather than ignoring it, which is why an unsearchable module returns nothing
 * instead of everything.
 */
export interface SearchBoxProps {
  slug: string;
  query: ListQuery;
  limits: ListQueryLimits;
}

/** Long enough that a typed word is one query, short enough to feel live. */
const DEBOUNCE_MS = 350;

export function SearchBox({ slug, query, limits }: SearchBoxProps) {
  const router = useRouter();
  const [term, setTerm] = useState(query.search ?? '');

  useEffect(() => {
    const current = query.search ?? '';
    if (term === current) return;
    const timer = setTimeout(() => {
      // A new term is a new result set, so it starts at page one — page 7 of
      // the old term is not page 7 of the new one.
      const href = buildListHref(slug, query, { search: term === '' ? null : term, page: 1 }, limits);
      // replace, not push: pushing would put every intermediate spelling of a
      // word in the history and make the back button re-type it.
      router.replace(withCurrentHash(href), { scroll: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, query, slug, limits, router]);

  return (
    <div className="relative w-full">
      <Input
        type="search"
        value={term}
        placeholder="Search Here"
        aria-label="Search"
        onChange={(e) => setTerm(e.target.value)}
        // pr-9 keeps the caret clear of the magnifier; font-light is the
        // file's placeholder weight, which the shared Input does not assume.
        //
        // The last rule hides WebKit's own clear button, which `type="search"`
        // draws in exactly the 10px-from-the-right slot the file gives the
        // magnifier — two glyphs on top of each other, and only once something
        // has been typed. Clearing stays a select-all-and-delete, which is what
        // every other field on the screen offers.
        className="h-9 w-full pr-9 font-light placeholder:font-light [&::-webkit-search-cancel-button]:hidden"
        data-track={`${slug}.list.search.input`}
      />
      <SearchIcon className="pointer-events-none absolute right-2.5 top-1/2 h-5 w-5 -translate-y-1/2 text-body" />
    </div>
  );
}
