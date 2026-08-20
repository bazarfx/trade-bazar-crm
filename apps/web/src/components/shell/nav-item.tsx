'use client';

import Link from 'next/link';
import type { ReactElement } from 'react';
import { cn } from '@/components/ui/button';
import { Icon } from './icons';

/**
 * One nav row, in the two shapes the design file draws it:
 *
 *   expanded  — "Link" 208×40, flex-row, gap 12, padding 10/12, radius 8,
 *               icon 20 + 14px Medium label
 *   collapsed — "Menu Item" 40×40, padding 8, radius 4, icon only
 *
 * A link and an action (logout) must be pixel-identical, so the geometry lives
 * here once and both `NavLink` and `NavAction` wear it. Two copies of these
 * classes would drift the first time one of them is touched.
 */

/** Resting label is muted; the current item is heading-on-subtle. */
function itemClass(collapsed: boolean, active: boolean, tone: 'default' | 'danger'): string {
  return cn(
    'flex h-10 shrink-0 items-center text-sm font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    collapsed ? 'w-10 justify-center rounded p-2' : 'gap-3 rounded-md px-3 py-2.5',
    tone === 'danger' ? 'text-error hover:bg-subtle' : undefined,
    tone === 'default' && active ? 'bg-subtle text-heading' : undefined,
    tone === 'default' && !active ? 'text-muted hover:bg-subtle hover:text-heading' : undefined,
  );
}

export interface NavItemVisual {
  /** `ModuleDefinition.icon`, or a shell glyph name. Unknown names fall back. */
  icon: string | null;
  label: string;
  collapsed: boolean;
}

/**
 * The label truncates and never wraps (CLAUDE.md: unbounded content). `title`
 * gives the full string back on hover — and is the only affordance a collapsed
 * item has, since its label is not rendered at all.
 */
function Body({ icon, label, collapsed }: NavItemVisual): ReactElement {
  return (
    <>
      <Icon name={icon} />
      {collapsed ? null : <span className="truncate">{label}</span>}
    </>
  );
}

export interface NavLinkProps extends NavItemVisual {
  href: string;
  active: boolean;
  /** `module.screen.element.action` — see CLAUDE.md. Required, never derived. */
  'data-track': string;
}

export function NavLink({
  href,
  active,
  icon,
  label,
  collapsed,
  'data-track': track,
}: NavLinkProps): ReactElement {
  return (
    <Link
      href={href}
      title={label}
      // Assistive tech gets the destination even when the label is not drawn.
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      data-track={track}
      className={itemClass(collapsed, active, 'default')}
    >
      <Body icon={icon} label={label} collapsed={collapsed} />
    </Link>
  );
}

export interface NavActionProps extends NavItemVisual {
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
  'data-track': string;
}

/** Same row, but it does something instead of going somewhere. */
export function NavAction({
  onClick,
  disabled = false,
  tone = 'default',
  icon,
  label,
  collapsed,
  'data-track': track,
}: NavActionProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={collapsed ? label : undefined}
      data-track={track}
      className={cn(itemClass(collapsed, false, tone), 'disabled:opacity-60')}
    >
      <Body icon={icon} label={label} collapsed={collapsed} />
    </button>
  );
}
