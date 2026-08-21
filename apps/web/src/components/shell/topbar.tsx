import type { ReactElement } from 'react';

/**
 * The app shell's top bar, measured off "Rectangle 2" in the `CRM _ Leads`
 * frame: x=256 y=0, 1184×68, surface fill, 1px bottom border. The signed-in
 * user's profile lives HERE — right-aligned with a 16px margin (the group
 * sits at x=1216 of 1440) — not in the sidebar, which carries the logo slot
 * instead. Page content starts below this bar.
 *
 * No 'use client': the bar has no state or handlers, so it renders on the
 * server with the rest of the layout and ships no component JS.
 */
export interface ShellUser {
  fullName: string;
  roleName: string;
}

/**
 * No avatar image column exists on `User` yet, so the 44px circle carries
 * initials. Returns '?' for a blank name rather than an empty circle.
 */
function initialsOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  const initials = (first + last).toUpperCase();
  return initials === '' ? '?' : initials;
}

export function TopBar({ user }: { user: ShellUser }): ReactElement {
  return (
    // The file's 68px height is never hardcoded: 44px avatar + 12px padding
    // top and bottom = 68, derived exactly the way the frame's auto-layout
    // derives it. Sticky so the chrome holds still while the page scrolls,
    // matching the sidebar's behaviour.
    <header className="sticky top-0 z-10 flex shrink-0 items-center justify-end border-b border-border bg-surface px-4 py-3">
      {/* Profile: avatar 44 (circle) + column(role overline, name), gap 12. */}
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-subtle text-sm font-medium text-heading"
        >
          {initialsOf(user.fullName)}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-overline text-muted" title={user.roleName}>
            {user.roleName}
          </span>
          <span className="truncate text-sm font-medium text-heading" title={user.fullName}>
            {user.fullName}
          </span>
        </span>
      </div>
    </header>
  );
}
