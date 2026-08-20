'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Class joiner. `clsx` is not a dependency and will not become one for four
 * lines. Exported because every primitive in this folder needs exactly this
 * and nothing more — and because all of them are `'use client'`, importing it
 * across them is a plain module import that never crosses the RSC boundary
 * (every export of a `'use client'` module becomes a client reference, so a
 * server component calling this would throw).
 */
export const cn = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(' ');

export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `module.screen.element.action`. REQUIRED, not optional: the interaction
   * logger is a single delegated listener, so a button that forgets this
   * attribute is invisible in InteractionLog forever and nothing at runtime
   * would ever complain. Making it a type error is the only enforcement that
   * cannot be skipped.
   */
  'data-track': string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
}

const BASE =
  'inline-flex shrink-0 items-center justify-center rounded font-medium ' +
  'transition-colors ' +
  // Keyboard users must be able to see where they are. `focus-visible` keeps
  // the ring off pointer clicks, so it costs the mouse path nothing.
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Measured off the "Buttons" frame: Small 32 high, pad 8/12, gap 4, 12px
 * Medium; Medium 37–38 high, pad 8/12, gap 8, 14px Medium; Large 40 high.
 * The Medium height is the one value in this file that is not on the 4px grid
 * — the design is 37–38px and rounding it to 36 or 40 visibly breaks the
 * header row, where Create/Export/Import sit beside a 36px search box.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1 px-3 text-xs',
  md: 'h-[38px] gap-2 px-3 text-sm',
  lg: 'h-10 gap-2 px-3 text-sm',
};

/**
 * The component library draws Primary as black; every real screen instance
 * overrides it to the teal (docs/DESIGN-SPEC.md) — follow the screens.
 * `primary-strong` is the file's `--primary` (#007489), a brighter teal than
 * the resting `--primary-hover` (#00667a), which is exactly what a hover wants.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-surface hover:bg-primary-strong',
  secondary: 'border border-border bg-surface text-heading hover:bg-background',
  destructive: 'border border-error bg-surface text-error hover:bg-subtle',
  ghost: 'text-body hover:bg-subtle',
};

/** Icon sizes in the fig are 14 / 16 / 20 per size; the spinner matches. */
const SPINNER: Record<ButtonSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4',
  lg: 'h-5 w-5',
};

function Spinner({ className }: { className: string }) {
  return (
    <svg
      className={cn('animate-spin shrink-0', className)}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      {/* currentColor: the spinner inherits whatever the variant painted, so
          it never needs to know which variant it is inside. */}
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    iconLeft,
    iconRight,
    loading = false,
    disabled,
    // A bare <button> inside a <form> submits it. Defaulting to "button" makes
    // submitting an explicit, deliberate act rather than an accident.
    type = 'button',
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // Disabling while loading is what actually prevents a double submit; a
      // spinner alone still accepts a second click.
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, SIZE[size], VARIANT[variant], className)}
      {...rest}
    >
      {loading ? (
        <Spinner className={SPINNER[size]} />
      ) : iconLeft ? (
        <span className="inline-flex shrink-0 items-center">{iconLeft}</span>
      ) : null}
      {children}
      {iconRight ? <span className="inline-flex shrink-0 items-center">{iconRight}</span> : null}
    </button>
  );
});
