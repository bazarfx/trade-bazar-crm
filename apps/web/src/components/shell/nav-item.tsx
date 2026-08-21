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

export interface NavDisabledProps extends NavItemVisual {
  /** Why the row is inert — surfaced as the hover tooltip. */
  reason: string;
  'data-track': string;
}

/**
 * A deliberate visible space: the destination exists in the design and the
 * plan but not in the product yet (Dashboard is phase 1.5; Help has no
 * content). It renders as a real row so the sidebar matches the file, but it
 * goes nowhere and says why on hover.
 *
 * It carries `aria-disabled`, NOT the `disabled` attribute: a disabled button
 * swallows clicks before the delegated `data-track` listener sees them, and
 * how often users reach for an unshipped feature is exactly the demand signal
 * the interaction log exists to capture.
 */
export function NavDisabled({
  reason,
  icon,
  label,
  collapsed,
  'data-track': track,
}: NavDisabledProps): ReactElement {
  return (
    <button
      type="button"
      aria-disabled="true"
      title={reason}
      aria-label={collapsed ? label : undefined}
      data-track={track}
      className={cn(
        'flex h-10 shrink-0 cursor-not-allowed items-center text-sm font-medium text-muted opacity-60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        collapsed ? 'w-10 justify-center rounded p-2' : 'gap-3 rounded-md px-3 py-2.5',
      )}
    >
      <Body icon={icon} label={label} collapsed={collapsed} />
    </button>
  );
}

export interface NavParentProps {
  icon: string | null;
  label: string;
  open: boolean;
  /**
   * True when any of the sub-links' routes is current. The file gives the
   * active PARENT its own treatment — canvas background (`#f6f8fa`,
   * `bg-background`) with a heading-colour label — distinct from the
   * `bg-subtle` an active plain row or sub-link wears.
   */
  active: boolean;
  onToggle: () => void;
  /** id of the sub-list this row expands, for `aria-controls`. */
  controlsId: string;
  'data-track': string;
}

/**
 * A dropdown parent row — 208×40 like a plain link, plus a trailing chevron
 * that rotates while open. Only drawn expanded: the collapsed rail flattens
 * dropdowns into their sub-items, so this row never renders at 40×40.
 */
export function NavParent({
  icon,
  label,
  open,
  active,
  onToggle,
  controlsId,
  'data-track': track,
}: NavParentProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controlsId}
      title={label}
      data-track={track}
      className={cn(
        'flex h-10 w-full shrink-0 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        active ? 'bg-background text-heading' : 'text-muted hover:bg-subtle hover:text-heading',
      )}
    >
      <Icon name={icon} />
      <span className="truncate">{label}</span>
      <Icon
        name="chevron"
        className={cn('ml-auto h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
      />
    </button>
  );
}

export interface NavSubLinkProps {
  href: string;
  active: boolean;
  label: string;
  'data-track': string;
}

/**
 * A sub-link under a dropdown parent — 172×32, radius 8, 12px Medium, no
 * icon. Active is `bg-subtle` + heading label; resting is muted. The indent
 * and the 2px guide line belong to the sub-LIST container in the sidebar,
 * not to each row, so the line runs unbroken past the row gaps.
 */
export function NavSubLink({
  href,
  active,
  label,
  'data-track': track,
}: NavSubLinkProps): ReactElement {
  return (
    <Link
      href={href}
      title={label}
      aria-current={active ? 'page' : undefined}
      data-track={track}
      className={cn(
        'flex h-8 shrink-0 items-center rounded-md px-3 text-xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        active ? 'bg-subtle text-heading' : 'text-muted hover:bg-subtle hover:text-heading',
      )}
    >
      <span className="truncate">{label}</span>
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
