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

/**
 * Resting label is `--body`, the current item is heading-on-canvas.
 *
 * Both colours are measured off the SCREEN, not the component template, and
 * they disagree with what was written down before. Counting every `Label` node
 * inside all 73 `Sidebar - Open` frames in the file:
 *
 *   72×  resting label / group overline  #6b7280  (`--body`)      — 1× #757575
 *   70×  active `Link` 208x40 fill       #f6f8fa  (`--background`)— 1× #f6f6f6
 *   70×  active label                    #111827  (`--heading`)
 *   72×  "Logout Account"                #ef4444  (`--error`)     — 1× #d55f5a
 *
 * The lone outlier in each row is the unrevised `Sidebar - Open` COMPONENT;
 * every real screen carries the token values. So resting is `text-body` (not
 * `text-muted`, #727272) and the active fill is `bg-background` (not
 * `bg-subtle`, #f9f9f9) — neither of the old values appears in the file at all.
 *
 * `tracking-[-0.02em]` is the file's `letterSpacing: {value: -2, PERCENT}` on
 * every nav `Label`, at both 14px and 12px. Percent letter-spacing is relative
 * to the font size, which is exactly what `em` means in CSS.
 */
function itemClass(collapsed: boolean, active: boolean, tone: 'default' | 'danger'): string {
  return cn(
    'flex h-10 shrink-0 items-center text-sm font-medium tracking-[-0.02em] transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
    'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    collapsed ? 'w-10 justify-center rounded p-2' : 'gap-3 rounded-md px-3 py-2.5',
    tone === 'danger' ? 'text-error hover:bg-background' : undefined,
    tone === 'default' && active ? 'bg-background text-heading' : undefined,
    tone === 'default' && !active ? 'text-body hover:bg-background hover:text-heading' : undefined,
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
 *
 * NO OPACITY. Measured: the "Dashboard" and "Help" `Link` frames are 208x40
 * with `opacity: 1` and a #6b7280 (`--body`) 14px Medium `Label` in all 73
 * `Sidebar - Open` frames — byte-identical to the resting "Settings" row
 * (72x each for all three labels; the single #757575 outlier is the unrevised
 * component). The file draws no faded nav row anywhere, and an `opacity-60`
 * here resolved #6b7280 to roughly #a6a8ac, so two of the six top-level rows
 * read as broken rather than as pending. The row is still inert and still says
 * so — `aria-disabled` for assistive tech, no hover fill, `cursor-not-allowed`,
 * and the reason as its tooltip — none of which is a colour the file measures.
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
        'flex h-10 shrink-0 cursor-not-allowed items-center text-sm font-medium tracking-[-0.02em]',
        'text-body',
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
   * True when any of the sub-links' routes is current. Measured: the active
   * parent's fill is `#f6f8fa` (`bg-background`) with a heading-colour label —
   * the SAME treatment an active plain row and an active sub-link wear. An
   * earlier reading had those two differing; counting the file's `Link` fills
   * shows one value, 70 times each, for both sizes.
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
        'flex h-10 w-full shrink-0 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium',
        'tracking-[-0.02em] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        active ? 'bg-background text-heading' : 'text-body hover:bg-background hover:text-heading',
      )}
    >
      <Icon name={icon} />
      <span className="truncate">{label}</span>
      {/* The rotation IS in the file — it lives on the `Icon / Chevron`
          frame's transform, not on the glyph inside it, which is why the
          two states look identical if you only read the vector offsets.
          Measured across all 73 sidebars: the OPEN "CRM" dropdown's chevron
          carries [[-1,0],[0,-1]] (180°, pointing up) 72 times; the CLOSED
          "Settings" row carries the identity (pointing down) 73 times. */}
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
 * A sub-link under a dropdown parent — `Link` 172×32, pad 8/12, radius 8,
 * 12px Medium, no icon. Active is `bg-background` (#f6f8fa) + heading label;
 * resting is `--body`.
 *
 * THE ELBOW. Each sub-link owns a `Radius` node — 13×8, `stackPositioning:
 * ABSOLUTE`, at (-13, +12) from the row's own top-left — whose stroke is
 * `borderLeftWeight: 2` and `borderBottomWeight: 2` ONLY
 * (`borderStrokeWeightsIndependent: true`), #e5e7eb, with a bottom-left corner
 * radius of 8 and the other three corners at 0. That is an L: down the left,
 * curve, out to the row. It is what turns the sub-list's vertical guide into
 * each row, and the build had the guide with no elbows at all.
 *
 * It belongs to the ROW (as it does in the file) because its y is measured
 * from the row's top; the continuous vertical guide belongs to the LIST, in
 * sidebar.tsx, so it runs unbroken past the 4px row gaps.
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
        'relative flex h-8 shrink-0 items-center rounded-md px-3 text-xs font-medium',
        'tracking-[-0.02em] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        active ? 'bg-background text-heading' : 'text-body hover:bg-background hover:text-heading',
      )}
    >
      {/* `Radius` — see above. left-[-13px]/top-3/h-2/w-[13px] are the node's
          four measured numbers; `rounded-bl-md` is its 8px single corner. */}
      <span
        aria-hidden="true"
        className="absolute left-[-13px] top-3 h-2 w-[13px] rounded-bl-md border-b-2 border-l-2 border-border"
      />
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
