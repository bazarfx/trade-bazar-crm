'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui';
import { buildListHref, withCurrentHash, type ListQuery, type ListQueryLimits } from './list-query';
import { SearchIcon } from './icons';

/**
 * The list search box — 206×36 in the frame, with the icon inside the field.
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
    <div className="relative w-52">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-body" />
      <Input
        type="search"
        value={term}
        placeholder="Search Here"
        aria-label="Search"
        onChange={(e) => setTerm(e.target.value)}
        className="pl-10"
        data-track={`${slug}.list.search.input`}
      />
    </div>
  );
}
