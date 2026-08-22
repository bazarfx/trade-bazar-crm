'use client';

import Link from 'next/link';
import { cn } from '@/components/ui';

/**
 * The Profile module's sub-navigation (spec §5): Users | Groups | Departments
 * | Roles, drawn directly under the toolbar band.
 *
 * WHEN IT APPEARS is decided by the page, never here, and never from a slug:
 * the page asks `storageFor(...)` whether the module's rows live in the user
 * table — the same storage-shape question the record screen asks to decide
 * whether a deposits ledger exists. A module renamed from "Users" to "Staff"
 * keeps its tabs; a module an Admin names "Users" that is NOT the user table
 * does not get them.
 *
 * The Figma file draws no Profile screens, so this composes from the existing
 * chrome: the tab row is the file's 14px Medium nav label, the active state is
 * the heading colour with a 2px primary rule — the same pairing the sidebar's
 * current item uses — and the rest is the muted label token.
 *
 * Roles LINKS to `/settings/roles` rather than moving the matrix: that screen
 * already exists and is gated on its own special; two copies of the roles
 * matrix is exactly the drift CLAUDE.md's "one page component per view type"
 * rule forbids.
 */
export type ProfileTab = 'users' | 'groups' | 'departments' | 'roles';

export interface ProfileTabsProps {
  slug: string;
  /** module.labelPlural — the first tab is the module itself, by its own name. */
  labelPlural: string;
  active: ProfileTab;
  /** MANAGE_DEPARTMENTS_GROUPS or Admin — resolved server-side. */
  canManageGroups: boolean;
  /** MANAGE_USERS_ROLES or Admin — resolved server-side. */
  canManageRoles: boolean;
}

interface TabSpec {
  id: ProfileTab;
  label: string;
  href: string;
  visible: boolean;
}

export function ProfileTabs({
  slug,
  labelPlural,
  active,
  canManageGroups,
  canManageRoles,
}: ProfileTabsProps) {
  const tabs: TabSpec[] = [
    { id: 'users', label: labelPlural, href: `/${slug}`, visible: true },
    // Gated on the CAPABILITY, never on a role name. The server pages behind
    // these links 404 without it, so a hidden tab and a typed URL agree.
    { id: 'groups', label: 'Groups', href: `/${slug}/groups`, visible: canManageGroups },
    { id: 'departments', label: 'Departments', href: `/${slug}/departments`, visible: canManageGroups },
    { id: 'roles', label: 'Roles', href: '/settings/roles', visible: canManageRoles },
  ];

  return (
    // A navigation row, not an ARIA tablist: these are real routes with real
    // URLs, and `aria-current` is what tells a screen reader which one the
    // page is. A tablist would promise in-page panel switching that is not
    // what happens when one is activated.
    <nav aria-label="Profile sections" className="flex items-center gap-2 border-b border-border">
      {tabs
        .filter((tab) => tab.visible)
        .map((tab) => {
          const isActive = tab.id === active;
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={isActive ? 'page' : undefined}
              data-track={`${slug}.profile.tab.open`}
              className={cn(
                // -mb-px: the 2px rule sits ON the row's 1px border, so the
                // active tab reads as joined to the panel below it rather
                // than floating 1px above a second line.
                'inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                '-mb-px',
                isActive
                  ? 'border-primary text-heading'
                  : 'border-transparent text-muted hover:text-heading',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
    </nav>
  );
}
