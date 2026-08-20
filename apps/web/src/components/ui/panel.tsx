'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './button';

/**
 * The 12px-radius white card. Both body panels on the reference screen are
 * this: `radius 12, bg #ffffff, border #e5e7eb` (docs/DESIGN-SPEC.md).
 *
 * No `overflow-hidden` here on purpose — a DataTable inside a Panel relies on
 * `position: sticky` for its pinned column and header, and an overflow clip on
 * an ancestor turns the panel into the scroll container, which breaks both.
 */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('rounded-lg border border-border bg-surface', className)} {...rest} />;
}

export interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  actions?: ReactNode;
}

export function PanelHeader({ title, actions, className, ...rest }: PanelHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 border-b border-border px-6 py-4',
        className,
      )}
      {...rest}
    >
      {/* Truncate, never wrap: an Admin-named panel title has no length limit
          and a two-line header shifts every row below it. */}
      <h2 className="truncate text-sm font-medium text-heading">{title}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface PanelBodyProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Off for content that owns its own edges — a table bleeds to the panel
   * border. This is a prop rather than a `p-0` passed through `className`
   * because two conflicting padding utilities resolve by stylesheet order,
   * not by the order they appear in the attribute, so the override would work
   * or not depending on which one Tailwind happened to emit first.
   */
  padded?: boolean;
}

export function PanelBody({ padded = true, className, ...rest }: PanelBodyProps) {
  return <div className={cn(padded && 'p-6', className)} {...rest} />;
}
