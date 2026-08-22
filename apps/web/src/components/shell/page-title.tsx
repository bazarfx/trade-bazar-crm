'use client';

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';

/**
 * The page title's home is the TOP BAR, not the page body.
 *
 * Measured across every 1440x1024 frame in `tools/figma/Zoho.fig` — the title
 * text node sits at the SAME place on all six designed screens:
 *
 *   CRM _ Leads               TEXT "Leads"         @286,21  71x26
 *   CRM _ Leads_Import        TEXT "Import Leads"  @286,21 176x26
 *   CRM _ Leads_Create Leads  TEXT "Create Leads"  @286,21 159x26
 *
 * y=21 with a 26px line box spans 21…47, which is INSIDE `Rectangle 2`
 * (@256,0 1184x68) — the top bar. The profile group sits in the same band on
 * the right (`Profil` @1216,12 208x44). The bar is a two-ended row: title
 * left, profile right.
 *
 * This is load-bearing rather than cosmetic. It is WHY the toolbar strip
 * (`Rectangle 5`) begins at y=84 and the body panels at y=152: with the title
 * in the bar, the content column starts immediately under 68. A title rendered
 * as the first thing in `main` pushes both down by its own height plus a gap,
 * which is what the built pages were doing.
 *
 * WHY A CONTEXT and not a layout prop: `(app)/layout.tsx` is a server
 * component that receives `children` already rendered — it cannot ask the page
 * below it what it is called, and the record screen's title is a database
 * value the shell has no business fetching a second time. So the page declares
 * it and the bar consumes it.
 *
 * THE ONE COST, stated plainly: the server-rendered HTML carries an empty
 * title and the effect below fills it in. `useLayoutEffect` runs before the
 * browser paints, so there is no visible flash — but the title is absent from
 * the SSR stream, which means it is not in view-source. That is acceptable for
 * chrome that is duplicated by `<title>` and the `h1` a screen reader reads;
 * it would not be acceptable for page content.
 */

interface PageTitleStore {
  title: string | null;
  setTitle: (title: string | null) => void;
}

const PageTitleContext = createContext<PageTitleStore | null>(null);

/** Rendered by the shell layout, above both the top bar and the page. */
export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <PageTitleContext.Provider value={{ title, setTitle }}>{children}</PageTitleContext.Provider>
  );
}

/** Read by `TopBar`. Null outside the provider, so the bar simply draws no
 *  title rather than throwing — the login screen has no shell at all. */
export function usePageTitle(): string | null {
  return useContext(PageTitleContext)?.title ?? null;
}

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * React warns that `useLayoutEffect` does nothing during SSR, which is true
 * and is exactly why the swap exists: on the server neither hook runs, and on
 * the client the layout variant is what keeps the title from appearing a frame
 * late.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Declares this page's title. Renders nothing.
 *
 * A page that omits it leaves the bar's title empty, which is the behaviour
 * every screen had before this existed — so adopting it is per-screen and
 * nothing regresses by being left alone.
 */
export function PageTitle({ title }: { title: string }) {
  const store = useContext(PageTitleContext);
  const setTitle = store?.setTitle;

  useIsomorphicLayoutEffect(() => {
    if (setTitle === undefined) return;
    setTitle(title);
    // Cleared on unmount so a screen that does NOT set one cannot inherit the
    // previous page's title through a client-side navigation.
    return () => setTitle(null);
  }, [title, setTitle]);

  return null;
}
