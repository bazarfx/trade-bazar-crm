import {
  filterTreeSchema,
  systemFilterListSchema,
  type FilterNode,
  type SortSpec,
  type SystemFilterSelection,
} from '@crm/shared';

/**
 * The list screen's URL state: what is in the query string, what is in the
 * fragment, and why the filter tree is in the second one.
 *
 * A filtered list has to be linkable — a link that loses its filter sends
 * someone to a different result set than the one being discussed. But a filter
 * VALUE is record data ("email contains @acme.co", "phone starts with 98"),
 * and CLAUDE.md's privacy rule is that personal data never travels in a URL
 * parameter. That is not a style preference: a query string lands in the
 * access log, the proxy log and the Referer header of every asset the page
 * then loads. It is the same reason the engine put the tree in a POST body
 * rather than on `GET ?filters=` (see api/modules/[slug]/records/query).
 *
 * So the state is split by whether the SERVER needs to see it:
 *
 *   query string  `view` `sort` `page` `size` `q` `f`
 *                 — ids, keys and numbers. The server renders from these.
 *   fragment      `#f=<base64url(json)>` — the ad-hoc filter tree itself,
 *                 and `#s=<base64url(json)>` — the System Defined Filters
 *                 ticked on the rail.
 *                 A fragment is never sent to any server, never logged and
 *                 never in a Referer, yet it survives a copied link, a reload
 *                 and the back button. It is the one part of a URL that is
 *                 purely the browser's.
 *
 * The system selection carries no record data — it is a list of filter IDS and
 * at most a picked enum value — so a query parameter would have been legal for
 * it. It rides in the fragment anyway, for a mechanical reason: it and the
 * tree are ONE filter, and splitting them across the two halves of a URL would
 * let a copied link keep one and lose the other. A link that drops half of an
 * AND matches MORE rows than the filter it displays, which is the single
 * failure this whole file is arranged to prevent.
 *
 * `f=1` in the query string is the PRESENCE flag, carrying no values. It is
 * what lets the server skip its own record query entirely when a filter is
 * active: without it the page would render the unfiltered rows first and the
 * client would replace them a moment later, which is a list showing records
 * that do not match the filter it is displaying. Fail closed instead — the
 * server renders no rows and says the client owns the query.
 */

/**
 * `?view=none` — an EXPLICIT "no saved view", which is not the same thing as
 * an absent parameter. Absent means "whatever this module's default view is",
 * so without a marker there would be no way to get back to the unfiltered list
 * once an Admin has pinned a default.
 */
export const NO_VIEW = 'none';

export interface ListQuery {
  /** saved view id, `NO_VIEW`, or null for "the module's default, if any" */
  view: string | null;
  /** an ad-hoc filter tree is active; its values live in the fragment */
  filtered: boolean;
  /**
   * The rail edits ONE sort key. A saved view may store up to `MAX_SORT_KEYS`
   * and those are honoured when the URL names none — this only overrides.
   */
  sort: SortSpec | null;
  /** 1-based */
  page: number;
  size: number;
  search: string | null;
}

export interface ListQueryLimits {
  /** the sizes the page-size control offers; anything else is ignored */
  sizes: readonly number[];
  defaultSize: number;
}

type RawParams = Record<string, string | string[] | undefined>;

/** First value of a repeated parameter. `?page=1&page=9` is a hand-edited URL. */
function one(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === '' ? null : value;
}

function positiveInt(raw: string | string[] | undefined): number | null {
  const value = one(raw);
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `?sort=lead_status:desc` — the same compact form the records API takes, so
 * the two never need translating between.
 *
 * An unknown KEY is deliberately not filtered out here. It travels to the
 * repository, which resolves it and throws a 400 naming the key; dropping it
 * silently would mean a link that quietly sorts by something other than what
 * it says it sorts by.
 */
function parseSort(raw: string | string[] | undefined): SortSpec | null {
  const value = one(raw);
  if (value === null) return null;
  const [fieldKey, direction] = value.split(':');
  const key = fieldKey?.trim();
  if (!key) return null;
  return { fieldKey: key, direction: direction === 'desc' ? 'desc' : 'asc' };
}

export function parseListQuery(params: RawParams, limits: ListQueryLimits): ListQuery {
  const requested = positiveInt(params['size']);
  return {
    view: one(params['view']),
    filtered: one(params['f']) === '1',
    sort: parseSort(params['sort']),
    page: positiveInt(params['page']) ?? 1,
    // Only a size the control actually offers is honoured: `?size=5000` in a
    // hand-edited URL is a query that reads the whole module into memory.
    size: requested !== null && limits.sizes.includes(requested) ? requested : limits.defaultSize,
    search: one(params['q']),
  };
}

/** Everything that is not a default, in a stable order so URLs compare equal. */
export function buildListHref(
  slug: string,
  query: ListQuery,
  patch: Partial<ListQuery>,
  limits: ListQueryLimits,
): string {
  const next: ListQuery = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.view !== null) params.set('view', next.view);
  if (next.search !== null && next.search !== '') params.set('q', next.search);
  if (next.sort !== null) params.set('sort', `${next.sort.fieldKey}:${next.sort.direction}`);
  if (next.size !== limits.defaultSize) params.set('size', String(next.size));
  if (next.page > 1) params.set('page', String(next.page));
  if (next.filtered) params.set('f', '1');
  const qs = params.toString();
  return qs === '' ? `/${slug}` : `/${slug}?${qs}`;
}

// ── the fragment ──────────────────────────────────────────────────────────

/** `#f=` — the filter tree. Never a query parameter; see the file header. */
const HASH_KEY = 'f';

/** `#s=` — the System Defined Filters ticked on the rail. */
const SYSTEM_KEY = 's';

/**
 * One ticked System Defined Filter, as it travels to
 * `POST /api/modules/:slug/records/query` in its `system` array.
 *
 * The shared type, not a local copy: `SystemFilterSelection` is what the query
 * envelope's `system` array is made of, so a URL that carries something this
 * alias accepts is a URL the route accepts too. Whether a given module can
 * ANSWER a row is a separate question and not one a URL can settle — the
 * server decides it, and says so with a 400 naming the id rather than by
 * dropping the condition.
 */
export type SystemSelection = SystemFilterSelection;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // A loop, not `String.fromCharCode(...bytes)`: spreading a large tree past
  // the argument limit throws, and the tree is user input.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** The fragment for a tree, ready to append to an href. */
export function encodeFilterHash(node: FilterNode): string {
  return `#${HASH_KEY}=${toBase64Url(JSON.stringify(node))}`;
}

/**
 * The fragment for a whole ad-hoc filter — the tree, the system selection, or
 * both. Empty string when there is neither, which is what "no filter" looks
 * like in a URL.
 *
 * `encodeListHash(node, [])` is byte-for-byte `encodeFilterHash(node)`, so
 * every link written before the system rows existed still reads back.
 */
export function encodeListHash(node: FilterNode | null, system: readonly SystemSelection[]): string {
  const parts: string[] = [];
  if (node !== null) parts.push(`${HASH_KEY}=${toBase64Url(JSON.stringify(node))}`);
  if (system.length > 0) parts.push(`${SYSTEM_KEY}=${toBase64Url(JSON.stringify(system))}`);
  return parts.length === 0 ? '' : `#${parts.join('&')}`;
}

/**
 * Read a tree back out of `window.location.hash`.
 *
 * The fragment is USER INPUT — hand-edited, or pasted from anywhere — so it is
 * parsed through `filterTreeSchema`, the same schema the API parses the body
 * with. Validation is defined once, in packages/shared, and this is one of its
 * callers rather than a second, weaker copy.
 *
 * Returns null when there is no filter in the fragment, and throws when there
 * is one that cannot be read. The difference matters: "no filter" shows the
 * whole list, and a broken filter must NOT — a list that quietly shows more
 * records than the filter it displays is the exact failure this whole slice is
 * built to avoid.
 */
export function readFilterHash(hash: string): FilterNode | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return null;
  const encoded = new URLSearchParams(raw).get(HASH_KEY);
  if (encoded === null || encoded === '') return null;

  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(encoded));
  } catch {
    throw new Error('The filter in this link could not be read.');
  }
  const parsed = filterTreeSchema.safeParse(json);
  if (!parsed.success) throw new Error('The filter in this link is not a valid filter.');
  return parsed.data;
}

/**
 * Read the ticked System Defined Filters back out of the fragment.
 *
 * Same contract as `readFilterHash`, and parsed the same way: through
 * `systemFilterListSchema`, the very schema the route parses the body's
 * `system` array with. One definition in packages/shared, two callers — never
 * a second, weaker copy here.
 *
 * An ABSENT `#s=` is an empty list; a PRESENT one that does not parse throws.
 * Nothing in between, and no entry is ever skipped: skipping one drops a
 * condition out of an AND, and an AND with a condition missing matches more
 * rows, not fewer.
 */
export function readSystemHash(hash: string): SystemSelection[] {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return [];
  const encoded = new URLSearchParams(raw).get(SYSTEM_KEY);
  if (encoded === null || encoded === '') return [];

  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(encoded));
  } catch {
    throw new Error('The filter in this link could not be read.');
  }
  const parsed = systemFilterListSchema.safeParse(json);
  if (!parsed.success) throw new Error('The filter in this link is not a valid filter.');
  return parsed.data;
}

/**
 * Carry the current fragment across a navigation that KEEPS the ad-hoc filter.
 *
 * A relative href resolves against the current URL and drops its fragment, so
 * a plain `?page=2` link would leave `f=1` in the query string with no tree
 * behind it — a list that says it is filtered and cannot say how. Every
 * navigation that means "same filter, different page/sort/size" appends this;
 * the ones that mean "different filter" deliberately do not.
 */
export function withCurrentHash(href: string): string {
  if (typeof window === 'undefined') return href;
  const hash = window.location.hash;
  return hash === '' || hash === '#' ? href : `${href}${hash}`;
}
