'use client';

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/button';
import { Icon } from './icons';
import { NavAction, NavDisabled, NavLink, NavParent, NavSubLink } from './nav-item';
import { useSignOut } from '@/components/sign-out-button';

/**
 * The app shell's sidebar, measured off the real `CRM _ Leads` screen frame
 * (not the component template): 256×1024, surface fill, right border,
 * flex-col, gap 24, padding 24, inner width 208. Top to bottom: collapse
 * handle, LOGO SLOT (the file draws the text "Logo Here" — the profile lives
 * in the TOP BAR, not here), divider, group "Main" (Dashboard + the CRM
 * dropdown), divider, group "Settings", and a bottom-pinned group (Help +
 * the red "Logout Account") that the file places at y=912.
 *
 * The CRM dropdown's sub-links are whatever `ModuleDefinition` says is
 * enabled, in `navOrder` — the file shows Zoho's set (Leads, Deals, Contacts,
 * Calls) and ours comes from data, never a hardcoded list. An Admin adding a
 * module tomorrow appears here without a deploy, which is the point.
 */
export interface ShellModule {
  /** Module slug — names the `data-track` (`<slug>.nav.item.open`) and href. */
  slug: string;
  label: string;
  /** `ModuleDefinition.icon`; unknown or null resolves to the fallback glyph. */
  icon: string | null;
}

export interface ShellSettingsPage {
  /** Names the `data-track` (`settings.nav.<key>.open`), never the label. */
  key: string;
  href: string;
  label: string;
  /** Glyph for the collapsed icon-only rail, where labels do not render. */
  icon: string;
}

/**
 * All three survive a reload so the choices feel like settings rather than
 * gestures that have to be repeated every navigation.
 *
 * THE TWO DROPDOWNS DEFAULT DIFFERENTLY, because the file draws them
 * differently. In all 73 `Sidebar - Open` frames the CRM row's parent is a
 * `Dropdown` 208×192 holding `[Link, Links container, Cursor/Pointer]` with the
 * chevron rotated 180° — open. The Settings row's parent is a bare
 * `Navigation` 208×488 holding `[Link, Title]`, no `Links container` at all,
 * chevron on the identity transform — closed, 73 times out of 73. So CRM's
 * absent key reads as open and Settings' absent key reads as CLOSED; either
 * way only an explicit choice is remembered.
 */
const COLLAPSED_KEY = 'crm.shell.sidebar.collapsed';
const CRM_OPEN_KEY = 'crm.shell.nav.crm.open';
const SETTINGS_OPEN_KEY = 'crm.shell.nav.settings.open';

/**
 * The 208-wide rule between sidebar groups. `Line 1` / `Line 2` in the frame:
 * a LINE node, 208×0, 1px CENTER stroke, `#e5e7eb` — `--border`, not the
 * `#f6f6f6` the component template uses and not `bg-subtle` (#f9f9f9), which
 * appears nowhere in the file.
 *
 * IT TAKES NO HEIGHT. 208×0 is not a rounding artefact: a Figma stroke does
 * not participate in auto-layout, so the sibling after each line lands on the
 * column's own 24px gap alone. Measured across the 70 screen sidebars: `Profil`
 * 208×20 @24 → line @68 → `Navigation` @92, and `Navigation` 208×260 → line
 * @376 → `Navigation` @400. A plain `h-px` flex item ate a real pixel at each
 * one, so the Main group started at 93 and the Settings group at 402 — the
 * whole nav column drifting 1–2px low. `-mb-px` cancels the height in the flex
 * outer size while the pixel still paints, the same "paint it, don't measure
 * it" trick the top bar's rule uses (see shell/topbar.tsx).
 */
function Divider(): ReactElement {
  return <div aria-hidden="true" className="-mb-px h-px shrink-0 bg-border" />;
}

/**
 * A dropdown's sub-list — `Links container` 172×n, `flex-col gap:4`, right-
 * aligned inside the 208 column (`cross:MAX`), which puts its left edge 36
 * from the group edge. `ml-9` is that 36, and 208 − 36 = 172 falls out, so
 * each row lands on its measured width without a literal.
 *
 * The vertical guide is `Line`, 2×121, `stackPositioning: ABSOLUTE` at
 * (−13, 0) from this container — NOT at its left edge, where the build had
 * it. −13 is exactly where each row's elbow starts (see `NavSubLink`), so the
 * two meet.
 *
 * The 121 is not arbitrary and does not need a row count to reproduce. With a
 * 36px row pitch (32 + 4 gap) the container is 36n − 4 tall and the file's
 * line is 36n − 23, so the line always stops 19px short of the bottom —
 * inside the last row's elbow curve, whatever n is. `bottom-[19px]` is that
 * constant, which is why an Admin adding a module cannot break the drawing.
 */
function SubNav({ id, children }: { id: string; children: ReactNode }): ReactElement {
  return (
    <div id={id} className="relative ml-9 flex flex-col gap-1">
      <span
        aria-hidden="true"
        className="absolute bottom-[19px] left-[-13px] top-0 w-0.5 bg-border"
      />
      {children}
    </div>
  );
}

export function Sidebar({
  modules,
  settingsPages,
}: {
  modules: ShellModule[];
  /** Empty when the actor fails the config-capability gate: no group at all. */
  settingsPages: ShellSettingsPage[];
}): ReactElement {
  const pathname = usePathname();

  // Read AFTER mount, never during render: the server has no localStorage, so
  // seeding state from it would make the first client render disagree with the
  // server HTML and React would throw the tree away instead of hydrating it.
  const [collapsed, setCollapsed] = useState(false);
  const [crmOpen, setCrmOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true');
    setCrmOpen(window.localStorage.getItem(CRM_OPEN_KEY) !== 'false');
    setSettingsOpen(window.localStorage.getItem(SETTINGS_OPEN_KEY) === 'true');
  }, []);

  // Persisted outside the updater on purpose: a state updater must stay pure,
  // and React calls it twice in development to prove that it is.
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, String(next));
  }, [collapsed]);

  const toggleCrm = useCallback(() => {
    const next = !crmOpen;
    setCrmOpen(next);
    window.localStorage.setItem(CRM_OPEN_KEY, String(next));
  }, [crmOpen]);

  const toggleSettings = useCallback(() => {
    const next = !settingsOpen;
    setSettingsOpen(next);
    window.localStorage.setItem(SETTINGS_OPEN_KEY, String(next));
  }, [settingsOpen]);

  const { signOut, busy } = useSignOut();

  // `/leads` is current on `/leads/abc` but not on `/leads-archive`; a bare
  // startsWith would light up the wrong row for any slug sharing a prefix.
  const isCurrent = (match: string) => pathname === match || pathname.startsWith(`${match}/`);

  const crmActive = modules.some((m) => isCurrent(`/${m.slug}`));
  const settingsActive = isCurrent('/settings');

  /**
   * The file only draws the EXPANDED sidebar; the 72px collapsed rail follows
   * the Menu Item component's 40×40 icon-only variants instead. A dropdown
   * has no icon-only shape, so the rail FLATTENS each one into its sub-items:
   * every module (and settings page) becomes a 40×40 icon button — still a
   * real link, still focusable, so nothing becomes keyboard-unreachable when
   * the labels go away. `title`/`aria-label` carry the hidden label.
   */
  const flattened = collapsed;

  return (
    <aside
      className={cn(
        // z-20, not z-10: the collapse handle below hangs 14px past this box
        // into the content column, and the top bar (z-10, later in the DOM)
        // would otherwise paint its white band over that half. The file
        // stacks them the same way — `Sidebar - Open` is drawn AFTER
        // `Rectangle 2` in the frame, so the sidebar is the upper layer.
        'sticky top-0 z-20 flex h-screen shrink-0 flex-col gap-6 border-r border-border bg-surface',
        // 256 open / 72 icon-only. The rail's padding is the collapsed
        // "Sidebar Navigation" variant's measured `pad:24/16/24/16` — 24
        // vertical, 16 horizontal, the 16 being what centres a 40×40
        // "Menu Item" in 72.
        collapsed ? 'w-sidebar-collapsed px-4 py-6' : 'w-sidebar p-6',
      )}
    >
      {/* Collapse handle — 28×28, radius 8, 6px padding, fill #ffffff,
          border #f6f8fa (NOT #e5e7eb; measured 72× as `--background`).
          It is NOT a row in the column: the node carries
          `stackPositioning: ABSOLUTE` with `horizontalConstraint: MAX` and
          sits at @242,20 of the 256-wide frame in 70 of 73 sidebars, so it
          spans 242…270 and STRADDLES the right edge with its centre exactly
          on x=256 — it does not tuck inside the 24px padding, which is where
          the build had it. `top-5` is the measured y=20, four pixels above
          the padding box; there is no top border, so it needs no correction.

          THE RIGHT OFFSET IS −15, NOT −14. `right` resolves against the
          containing block's PADDING box, and this `<aside>` carries
          `border-r`, so its padding edge is at 255, not 256. `right:-14px`
          therefore put the handle at 241…269 — one pixel left of the file,
          with its centre off the border rather than on it. 255 + 15 = 270 is
          the measured right edge. */}
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        data-track="shell.sidebar.collapse.toggle"
        className={
          'absolute right-[-15px] top-5 flex h-7 w-7 items-center justify-center rounded-md ' +
          'border border-background bg-surface p-1.5 ' +
          'text-heading transition-colors hover:border-border focus-visible:outline-none ' +
          'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ' +
          'focus-visible:ring-offset-surface'
        }
      >
        {/* One chevron glyph, rotated. The file rotates it too, on the icon
            FRAME: the handle's `Icon / Chevron` carries [[0,-1],[1,0]] — a
            90° turn that points the shared down-chevron LEFT, in all 73
            sidebars. `rotate-90` is that matrix. */}
        <Icon name="chevron" className={cn('h-4 w-4 shrink-0', collapsed ? '-rotate-90' : 'rotate-90')} />
      </button>

      {/* LOGO SLOT. The file draws placeholder text ("Logo Here", 14px Medium,
          heading colour); no logo asset exists, so the product name wears the
          same typography. Collapses to nothing — a truncated wordmark in a
          72px rail would read as a bug, not a brand. */}
      {collapsed ? null : (
        <p className="shrink-0 truncate text-sm font-medium text-heading" title="Trade Bazar CRM">
          Trade Bazar CRM
        </p>
      )}

      {/* Scrolls on its own: an Admin may enable more modules than fit 1024. */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
        {/* Expanded only. `Line 1`/`Line 2` belong to the 256-wide
            `Sidebar - Open` frame; the collapsed rail is the other component
            (`Sidebar Navigation` 72×768, `flex-col gap:24 pad:24/16`), whose
            `Navigation` groups are separated by that 24px gap and nothing
            else — there is no line node in either collapsed variant. Drawn
            unconditionally it became a 40px rule across a 72px rail that the
            reference does not have. */}
        {collapsed ? null : <Divider />}

        {/* `Navigation` 208×n, `flex-col gap:8`. The collapsed rail is the
            other component's `Navigation 40×120` with three 40×40 items and
            `gap:0` — an icon strip, not a spaced list. */}
        <nav
          aria-label="Main"
          className={cn('flex flex-col', collapsed ? 'items-center gap-0' : 'gap-2')}
        >
          {/* `Title` 208×12, `pad:0/12`, holding a 10px Medium OVERLINE at
              ls 0.4px in #6b7280 — `--body`, measured 72×, not `--muted`. */}
          {!collapsed && <p className="px-3 text-overline text-body">Main</p>}

          {/* Dashboard is phase 1.5 (spec §16): a visible, honest placeholder
              rather than a dead link or an absent row. */}
          <NavDisabled
            reason="Dashboard arrives in a later phase"
            icon="home"
            label="Dashboard"
            collapsed={collapsed}
            data-track="shell.nav.dashboard.open"
          />

          {flattened ? (
            modules.map((m) => (
              <NavLink
                key={m.slug}
                href={`/${m.slug}`}
                active={isCurrent(`/${m.slug}`)}
                icon={m.icon}
                label={m.label}
                collapsed
                data-track={`${m.slug}.nav.item.open`}
              />
            ))
          ) : (
            // `Dropdown` 208×n, `flex-col gap:12` — the parent row and its
            // sub-list sit 12 apart, not the 8 the surrounding Navigation
            // uses between plain rows. It needs its own box to say so.
            <div className="flex flex-col gap-3">
              <NavParent
                icon="grid"
                label="CRM"
                open={crmOpen}
                active={crmActive}
                onToggle={toggleCrm}
                controlsId="shell-subnav-crm"
                data-track="shell.nav.crm.toggle"
              />
              {crmOpen ? (
                <SubNav id="shell-subnav-crm">
                  {modules.map((m) => (
                    <NavSubLink
                      key={m.slug}
                      href={`/${m.slug}`}
                      active={isCurrent(`/${m.slug}`)}
                      label={m.label}
                      data-track={`${m.slug}.nav.item.open`}
                    />
                  ))}
                </SubNav>
              ) : null}
            </div>
          )}
        </nav>

        {settingsPages.length > 0 ? (
          <>
            {/* Expanded only — see the first divider above. */}
            {collapsed ? null : <Divider />}
            <nav
              aria-label="Settings"
              className={cn('flex flex-col', collapsed ? 'items-center gap-0' : 'gap-2')}
            >
              {!collapsed && <p className="px-3 text-overline text-body">Settings</p>}

              {flattened ? (
                settingsPages.map((page) => (
                  <NavLink
                    key={page.key}
                    href={page.href}
                    active={isCurrent(page.href)}
                    icon={page.icon}
                    label={page.label}
                    collapsed
                    data-track={`settings.nav.${page.key}.open`}
                  />
                ))
              ) : (
                <div className="flex flex-col gap-3">
                  <NavParent
                    icon="settings"
                    label="Settings"
                    open={settingsOpen}
                    active={settingsActive}
                    onToggle={toggleSettings}
                    controlsId="shell-subnav-settings"
                    data-track="shell.nav.settings.toggle"
                  />
                  {settingsOpen ? (
                    <SubNav id="shell-subnav-settings">
                      {settingsPages.map((page) => (
                        <NavSubLink
                          key={page.key}
                          href={page.href}
                          active={isCurrent(page.href)}
                          label={page.label}
                          data-track={`settings.nav.${page.key}.open`}
                        />
                      ))}
                    </SubNav>
                  ) : null}
                </div>
              )}
            </nav>
          </>
        ) : null}

        {/* Bottom group, pinned to the sidebar foot: `Navigation` 208×88 at
            @24,912 of 1024 — Help 912…952, Logout 960…1000, and 1000 + the
            24 bottom padding is 1024 exactly. No divider above it and no
            extra padding either; the column's own 24 gap is the whole
            separation, so `mt-auto` alone reproduces it. Help is a
            placeholder like Dashboard; Logout draws icon AND label in
            #ef4444 (`--error`), measured 72×. */}
        <nav
          aria-label="Session"
          className={cn('mt-auto flex flex-col', collapsed ? 'items-center gap-0' : 'gap-2')}
        >
          <NavDisabled
            reason="Help arrives later"
            icon="help-circle"
            label="Help"
            collapsed={collapsed}
            data-track="shell.nav.help.open"
          />
          <NavAction
            onClick={signOut}
            disabled={busy}
            tone="danger"
            icon="logout"
            label={busy ? 'Signing out…' : 'Logout Account'}
            collapsed={collapsed}
            data-track="auth.shell.signout.click"
          />
        </nav>
      </div>
    </aside>
  );
}
