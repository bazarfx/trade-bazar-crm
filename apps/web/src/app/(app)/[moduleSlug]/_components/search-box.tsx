import { Input } from '@/components/ui';
import { SearchIcon } from './icons';

/**
 * The list search box — 206×36 in the frame, with the icon inside the field.
 *
 * Disabled, and deliberately so: searching a module means compiling a
 * condition across its searchable fields, which is the filter engine's job. A
 * box that accepts typing and returns the same rows is a bug report waiting to
 * be filed; a disabled one with a reason is a promise.
 */
export function SearchBox({ slug }: { slug: string }) {
  return (
    <div className="relative w-52">
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-body" />
      <Input
        type="search"
        disabled
        placeholder="Search Here"
        aria-label="Search"
        title="Search arrives with the filter engine slice."
        className="pl-10"
        data-track={`${slug}.list.search.input`}
      />
    </div>
  );
}
