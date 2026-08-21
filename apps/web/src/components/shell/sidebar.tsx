'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
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
 * gestures that have to be repeated every navigation. The dropdowns default
 * OPEN — absent key reads as open, so only an explicit close is remembered.
 */
const COLLAPSED_KEY = 'crm.shell.sidebar.collapsed';
const CRM_OPEN_KEY = 'crm.shell.nav.crm.open';
const SETTINGS_OPEN_KEY = 'crm.shell.nav.settings.open';

/** The 208×1 subtle divider between sidebar groups. */
function Divider(): ReactElement {
  return <div aria-hidden="true" className="h-px shrink-0 bg-subtle" />;
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
  const [settingsOpen, setSettingsOpen] = useState(true);
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true');
    setCrmOpen(window.localStorage.getItem(CRM_OPEN_KEY) !== 'false');
    setSettingsOpen(window.localStorage.getItem(SETTINGS_OPEN_KEY) !== 'false');
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
        'sticky top-0 z-10 flex h-screen shrink-0 flex-col gap-6 border-r border-border bg-surface',
        // 256 open / 72 icon-only, and the padding closes to keep the 40×40
        // "Menu Item" from the file centred in the narrow rail.
        collapsed ? 'w-sidebar-collapsed p-4' : 'w-sidebar p-6',
      )}
    >
      {/* Collapse handle: 28×28, radius 8, 6px padding, bordered. */}
      <div className={cn('flex shrink-0', collapsed ? 'justify-center' : 'justify-end')}>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          data-track="shell.sidebar.collapse.toggle"
          className={
            'flex h-7 w-7 items-center justify-center rounded-md border border-border p-1.5 ' +
            'text-heading transition-colors hover:bg-background focus-visible:outline-none ' +
            'focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ' +
            'focus-visible:ring-offset-surface'
          }
        >
          {/* One chevron glyph, rotated — the file draws the same 16px Union. */}
          <Icon name="chevron" className={cn('h-4 w-4 shrink-0', collapsed ? '-rotate-90' : 'rotate-90')} />
        </button>
      </div>

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
        <Divider />

        <nav aria-label="Main" className={cn('flex flex-col gap-2', collapsed && 'items-center')}>
          {!collapsed && <p className="px-3 text-overline text-muted">Main</p>}

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
            <>
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
                // ml 20 + pl 16 = the file's 36px indent, leaving each
                // sub-link its measured 172×32. The 2px guide line belongs to
                // the container so it runs unbroken past the row gaps.
                <div id="shell-subnav-crm" className="relative ml-5 flex flex-col gap-1 pl-4">
                  <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 rounded-sm bg-subtle" />
                  {modules.map((m) => (
                    <NavSubLink
                      key={m.slug}
                      href={`/${m.slug}`}
                      active={isCurrent(`/${m.slug}`)}
                      label={m.label}
                      data-track={`${m.slug}.nav.item.open`}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </nav>

        {settingsPages.length > 0 ? (
          <>
            <Divider />
            <nav
              aria-label="Settings"
              className={cn('flex flex-col gap-2', collapsed && 'items-center')}
            >
              {!collapsed && <p className="px-3 text-overline text-muted">Settings</p>}

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
                <>
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
                    <div id="shell-subnav-settings" className="relative ml-5 flex flex-col gap-1 pl-4">
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 rounded-sm bg-subtle" />
                      {settingsPages.map((page) => (
                        <NavSubLink
                          key={page.key}
                          href={page.href}
                          active={isCurrent(page.href)}
                          label={page.label}
                          data-track={`settings.nav.${page.key}.open`}
                        />
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </nav>
          </>
        ) : null}

        {/* Bottom group, pinned to the sidebar foot — the file puts it at
            y=912 of 1024. Help is a placeholder like Dashboard; Logout draws
            icon AND label in the error colour, exactly as the frame does. */}
        <nav
          aria-label="Session"
          className={cn('mt-auto flex flex-col gap-2 pt-6', collapsed && 'items-center')}
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
