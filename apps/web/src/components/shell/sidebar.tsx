'use client';

import { Fragment, useCallback, useEffect, useState, type ReactElement } from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/button';
import { Icon } from './icons';
import { NavAction, NavLink } from './nav-item';
import { useSignOut } from '@/components/sign-out-button';

/**
 * The app shell's sidebar, measured off the "Sidebar - Open" frame inside
 * `CRM _ Leads` (256×1024): flex-col, gap 24, padding 24, inner width 208,
 * groups separated by 208×2 dividers.
 *
 * It renders GROUPS OF ITEMS and knows nothing else. Which modules exist, what
 * they are called and which glyph they carry are all `ModuleDefinition` rows
 * resolved by the server layout — this component would render an Admin's
 * brand-new module tomorrow without a line changing, which is the point.
 */
export interface ShellNavItem {
  /**
   * Names the item's `data-track` (`<trackKey>.nav.item.open`). It is the
   * module slug for a module, never a label — a rename must not orphan the
   * interaction log.
   */
  trackKey: string;
  href: string;
  /** Pathname prefix that marks this item current. */
  match: string;
  label: string;
  /** `ModuleDefinition.icon`; unknown or null resolves to the fallback glyph. */
  icon: string | null;
}

export interface ShellNavGroup {
  id: string;
  /** The 10px overline above the group. null draws no heading. */
  heading: string | null;
  items: ShellNavItem[];
}

export interface ShellUser {
  fullName: string;
  roleName: string;
}

/**
 * Survives a reload so the choice feels like a setting rather than a gesture
 * that has to be repeated every navigation.
 */
const COLLAPSED_KEY = 'crm.shell.sidebar.collapsed';

/**
 * No avatar image column exists on `User` yet, so the circle carries initials.
 * Returns '?' for a blank name rather than an empty circle.
 */
function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  const initials = (first + last).toUpperCase();
  return initials === '' ? '?' : initials;
}

/** Line 1 / Line 2 in the frame: 208×2, radius 2. */
function Divider(): ReactElement {
  return <div aria-hidden="true" className="h-0.5 shrink-0 rounded-sm bg-subtle" />;
}

export function Sidebar({
  groups,
  user,
}: {
  groups: ShellNavGroup[];
  user: ShellUser;
}): ReactElement {
  const pathname = usePathname();

  // Read AFTER mount, never during render: the server has no localStorage, so
  // seeding state from it would make the first client render disagree with the
  // server HTML and React would throw the tree away instead of hydrating it.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true');
  }, []);

  // Persisted outside the updater on purpose: a state updater must stay pure,
  // and React calls it twice in development to prove that it is.
  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, String(next));
  }, [collapsed]);

  const { signOut, busy } = useSignOut();

  // `/leads` is current on `/leads/abc` but not on `/leads-archive`; a bare
  // startsWith would light up the wrong row for any slug sharing a prefix.
  const isCurrent = (match: string) => pathname === match || pathname.startsWith(`${match}/`);

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
          onClick={toggle}
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

      {/* Profile: avatar 44 + column(role overline, name), gap 12. */}
      <div className={cn('flex shrink-0 items-center gap-3', collapsed && 'justify-center')}>
        <span
          aria-hidden="true"
          className={cn(
            'flex shrink-0 items-center justify-center rounded-pill bg-subtle font-medium text-heading',
            collapsed ? 'h-10 w-10 text-xs' : 'h-11 w-11 text-sm',
          )}
        >
          {initialsOf(user.fullName)}
        </span>
        {collapsed ? null : (
          <span className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-overline text-muted" title={user.roleName}>
              {user.roleName}
            </span>
            <span className="truncate text-sm font-medium text-heading" title={user.fullName}>
              {user.fullName}
            </span>
          </span>
        )}
      </div>

      {/* Scrolls on its own: an Admin may enable more modules than fit 1024. */}
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
        {/* The frame carries exactly two dividers — after the profile and
            between the two headed groups. The trailing group is bottom-pinned
            instead, which is what the 488-tall spacer group in the file does. */}
        <Divider />

        {groups.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 ? <Divider /> : null}
            <nav
              aria-label={group.heading ?? undefined}
              className={cn('flex flex-col gap-2', collapsed && 'items-center')}
            >
              {group.heading !== null && !collapsed ? (
                <p className="px-3 text-overline text-muted">{group.heading}</p>
              ) : null}
              {group.items.map((item) => (
                <NavLink
                  key={item.trackKey}
                  href={item.href}
                  active={isCurrent(item.match)}
                  icon={item.icon}
                  label={item.label}
                  collapsed={collapsed}
                  data-track={`${item.trackKey}.nav.item.open`}
                />
              ))}
            </nav>
          </Fragment>
        ))}

        <nav className={cn('mt-auto flex flex-col gap-2 pt-6', collapsed && 'items-center')}>
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
