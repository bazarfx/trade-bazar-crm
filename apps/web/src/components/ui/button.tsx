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

/**
 * The file draws SIX hierarchies on the `Buttons` component frame (Internal
 * Only Canvas, 1458x1344 — the one whose palette tokens.css was generated
 * from; the other `Buttons` frame, 862x1965, is a blue/dark-mode kit that
 * shares no colour with this product):
 *
 *   Primary · Secondary · Secondary Border · Tertiary · Destructive · Link
 *
 * Names here keep the ones call sites already pass. `secondary` is the file's
 * **Secondary Border** because that is what every real screen instantiates —
 * white fill plus a 1px border, traced off the Leads header's Export/Import.
 * `ghost` is the file's **Tertiary**. `primary-outline` is drawn only on the
 * screens (Create Leads' "Save as New", the filter rail's Clear/Cancel), never
 * in the component frame.
 */
export type ButtonVariant =
  | 'primary'
  | 'primary-outline'
  | 'secondary'
  | 'secondary-filled'
  | 'destructive'
  | 'ghost'
  | 'link';

/** The file's four sizes: Small 32 · Medium 37–38 · Large 40 · Extra Large 48. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

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

/**
 * Radius is 4 on every one of the 112 drawn variants — the only exceptions are
 * the icon-only ones with `Show Background=False`, which are pills.
 *
 * `font-medium` is NOT here: the file's weight travels with the SIZE, and the
 * 38px action button the screens draw is the one that is Regular.
 */
const BASE =
  'inline-flex shrink-0 items-center justify-center rounded ' +
  'transition-colors ' +
  // Keyboard users must be able to see where they are. `focus-visible` keeps
  // the ring off pointer clicks, so it costs the mouse path nothing. The file
  // draws no focus state at all (State is only Default / Hover / Disable), so
  // this is ours and stays.
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:cursor-not-allowed';

/**
 * Measured off the `Buttons` component frame, then corrected against the real
 * screens wherever the two disagree (DESIGN-SPEC's rule: the screen wins).
 *
 * | Size | Height | Pad V/H | Gap | Label            | Icon |
 * |------|--------|---------|-----|------------------|------|
 * | sm   | 32     | 8/12    | 4   | Medium 12px      | 14   |
 * | md   | 38     | 10/12   | 10  | **Regular 12px** | 18   |
 * | lg   | 40     | 8/18    | 8   | Medium 16px      | 16   |
 * | xl   | 48     | 12/18   | 8   | Medium 18px      | 18   |
 *
 * Gap is the one column that is NOT a pure function of size — see `GAP` and
 * `VARIANT_GAP` below, which is why it is not in this table.
 *
 * `md` is the one row that does not come from the component frame. The frame's
 * "Medium" is 37 high, pad 8/12, gap 8, Medium 14px, icon 16, and the only
 * place a screen instantiates it is the Pagination page indicator (64x37).
 * Every LABELLED action button the screens draw is a different, hand-drawn
 * recipe — `CRM _ Leads` > `Frame 482686` > Frame 8/7/9 (Create Lead 132x38,
 * Export and Import 122x38) and `CRM _ Leads_Create Leads` > `Frame 482710` >
 * Frame 7 (Save as New 122x38) are all pad 10/12 around a `Frame 5` row of
 * `gap:10`, with an 18x18 icon and an Inter **Regular 12px** label. That is
 * the one this primitive has to be, and 38 also keeps the header row honest
 * beside its 36px search box, where 37 would not.
 *
 * `lg` is the pop-up footer button (`Frame 482701` > `Buttons`, 222x40) and
 * matches the frame's Large exactly; `px-[18px]` and 16px are both measured,
 * neither is on the spacing or type scale.
 */
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs font-medium',
  md: 'h-[38px] px-3 text-xs font-normal',
  lg: 'h-10 px-[18px] text-lg font-medium',
  xl: 'h-12 px-[18px] text-[18px] leading-6 font-medium',
};

/**
 * Gap, read off all 112 drawn variants. It is NOT one number per size — the
 * frame gives Destructive and Link their own row:
 *
 * | Size  | Primary · Secondary · Secondary Border · Tertiary | Destructive | Link |
 * |-------|---------------------------------------------------|-------------|------|
 * | Small |  4                                                |  4          | 12   |
 * | Medium|  8                                                |  4          | 12   |
 * | Large |  8                                                | 10          | 10   |
 * | XL    |  8                                                | 10          | 10   |
 *
 * `md` keeps its screen-measured 10 for the mainstream hierarchies (the 38px
 * action button's `Frame 5` is `gap:10`), because no screen draws a Destructive
 * or a Link at that size — for those two the component frame's own Medium row
 * is the only evidence there is, so they take its 4 and 12.
 *
 * Composed as ONE class rather than a size gap plus a variant override: two
 * `gap-*` utilities on the same element are resolved by stylesheet order, not
 * by the order they appear in the class string, so `gap-1` after `gap-2.5`
 * would silently lose.
 */
const GAP: Record<ButtonSize, string> = {
  sm: 'gap-1',
  md: 'gap-2.5',
  lg: 'gap-2',
  xl: 'gap-2',
};

const VARIANT_GAP: Partial<Record<ButtonVariant, Record<ButtonSize, string>>> = {
  destructive: { sm: 'gap-1', md: 'gap-1', lg: 'gap-2.5', xl: 'gap-2.5' },
  link: { sm: 'gap-3', md: 'gap-3', lg: 'gap-2.5', xl: 'gap-2.5' },
};

const gapClass = (variant: ButtonVariant, size: ButtonSize): string =>
  VARIANT_GAP[variant]?.[size] ?? GAP[size];

/**
 * The component frame draws this palette in black and grey; every real screen
 * instance overrides Primary to the teal (`#00667a`, `--primary-hover`), so
 * the screens are followed here — see docs/DESIGN-SPEC.md.
 *
 * Five of the greys the frame uses have no alias in tailwind.config.ts but ARE
 * variables in tokens.css, so they are referenced by variable rather than
 * approximated:
 *
 *   `#f2f2f2` --globalcolors-neutral-30   Secondary resting fill
 *   `#e8e8e8` --globalcolors-neutral-40   every Hover fill
 *   `#d8d8d8` --globalcolors-neutral-60   every Disable label
 *   `#f7eded` --globalcolors-red-10       Destructive hover fill / disable border
 *   `#efdbdb` --globalcolors-red-20       Destructive disable label
 *
 * `primary-strong` is the file's `--primary` (#007489), a brighter teal than
 * the resting `--primary-hover` (#00667a), which is exactly what a hover wants.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-surface hover:bg-primary-strong',
  // Screen-only hierarchy: `Frame 7` on Create Leads is bg #f6f8fa with a 1px
  // #00667a border and a #00667a label; the filter rail's Clear and Cancel are
  // the same with no fill. No hover is drawn for it anywhere, so the lift to
  // the surface white is the smallest one that reads.
  'primary-outline': 'border border-primary bg-background text-primary hover:bg-surface',
  secondary:
    'border border-border bg-surface text-heading hover:bg-[var(--globalcolors-neutral-40)]',
  'secondary-filled':
    'bg-[var(--globalcolors-neutral-30)] text-heading hover:bg-[var(--globalcolors-neutral-40)]',
  // Hierarchy=Destructive is an OUTLINE in the frame — `fill:NONE` in all four
  // sizes at State=Default, 1px border, coloured label — with a #f7eded tint
  // appearing only on hover. `bg-transparent`, not `bg-surface`: a white fill
  // is a pill the file does not draw, and it shows on the app's #f6f8fa page
  // ground and inside every tinted panel. The border and label stay on
  // `--error` (#ef4444), which is the red every screen paints (the Delete
  // pop-up, the sidebar's Logout Account); the frame's #bf6f6f is the
  // library's own muted red and appears on no screen. The SOLID red
  // destructive the Delete pop-up draws belongs to PopupFooter, not here.
  destructive:
    'border border-error bg-transparent text-error hover:bg-[var(--globalcolors-red-10)]',
  // Hierarchy=Tertiary: no fill at rest, #e8e8e8 on hover, and a label the
  // frame paints #000000 at every size in BOTH Default and Hover — never a
  // grey. It was `text-body` (#6b7280), two steps light. `text-heading` for
  // the same reason Secondary/Secondary Border/Link use it: see the note on
  // `link` below.
  ghost: 'text-heading hover:bg-[var(--globalcolors-neutral-40)]',
  // Hierarchy=Link: no fill and no border in any state; the LABEL greys on
  // hover (#000000 → #727272) instead of the background filling.
  //
  // The four black-label hierarchies (Secondary, Secondary Border, Tertiary,
  // Link) are all drawn #000000 and all render `--heading` #111827 here. The
  // exact token DOES exist — `--globalcolors-neutral-100` — so this is a
  // deliberate one-step approximation held in common across the four rather
  // than a missing value; moving them is one coordinated decision, not four,
  // and docs/DESIGN-SPEC.md's type table records #111827 with them.
  link: 'text-heading hover:text-muted',
};

/**
 * State=Disable, measured per hierarchy. The file spells the disabled look out
 * in colour rather than dimming the resting one, which is why this is a table
 * and not an `opacity` on BASE.
 *
 * `primary-outline` has no drawn Disable state — it exists only on screens,
 * which draw no states at all — so it borrows Secondary Border's, the nearest
 * outline the frame does draw.
 */
const DISABLED: Record<ButtonVariant, string> = {
  primary: 'disabled:bg-subtle disabled:text-[var(--globalcolors-neutral-60)]',
  'primary-outline':
    'disabled:border-[color:var(--globalcolors-neutral-30)] disabled:bg-transparent ' +
    'disabled:text-[var(--globalcolors-neutral-60)]',
  secondary:
    'disabled:border-[color:var(--globalcolors-neutral-30)] disabled:bg-transparent ' +
    'disabled:text-[var(--globalcolors-neutral-60)]',
  'secondary-filled': 'disabled:bg-subtle disabled:text-[var(--globalcolors-neutral-60)]',
  destructive:
    'disabled:border-[color:var(--globalcolors-red-10)] disabled:bg-transparent ' +
    'disabled:text-[var(--globalcolors-red-20)]',
  ghost: 'disabled:bg-transparent disabled:text-[var(--globalcolors-neutral-60)]',
  link: 'disabled:text-[var(--globalcolors-neutral-60)]',
};

/**
 * The same measured recipe, for the times the control is a LINK rather than a
 * button — an action that is really a navigation (the list screen's Import,
 * which now opens `/[moduleSlug]/import`) has to be an anchor so it can be
 * middle-clicked, opened in a new tab and reached by the back button.
 *
 * Exported rather than duplicated: two places drawing "a secondary button"
 * from two class strings is exactly how the 38px height drifts.
 */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(
    BASE,
    SIZE[size],
    gapClass(variant, size),
    VARIANT[variant],
    DISABLED[variant],
    className,
  );
}

/**
 * Icon box per size, measured on the labelled variants: Small 14, Large 16,
 * Extra Large 18, and 18 on the 38px action button the screens draw. (The
 * icon-ONLY variants run larger — 14/16/20/24 in a 32/36/40/48 square — but
 * this component always renders a label slot.) The spinner matches so a
 * button does not resize the moment it starts loading.
 */
const SPINNER: Record<ButtonSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-[18px] w-[18px]',
  lg: 'h-4 w-4',
  xl: 'h-[18px] w-[18px]',
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
  // A pressed toggle is showing STATE, not just offering an action, so it has
  // to keep showing it when the control goes read-only — a disabled segmented
  // picker whose chosen segment flattens to Disable grey has stopped saying
  // what it is set to. `aria-pressed` is already how such a button announces
  // itself, so nothing new has to be passed to opt in.
  const pressed = rest['aria-pressed'] === true || rest['aria-pressed'] === 'true';
  return (
    <button
      ref={ref}
      type={type}
      // Disabling while loading is what actually prevents a double submit; a
      // spinner alone still accepts a second click.
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        BASE,
        SIZE[size],
        gapClass(variant, size),
        VARIANT[variant],
        // A loading button is `disabled` so it cannot be clicked twice, but it
        // is not DISABLED in the file's sense — the file draws no loading
        // state, and painting one in Disable grey would hide the spinner in a
        // #f9f9f9 field. Withholding the class, rather than fighting it with
        // specificity, keeps the resting colours under the spinner; a caller
        // that wants a disabled toggle to read as dimmed adds its own opacity.
        loading || pressed ? '' : DISABLED[variant],
        className,
      )}
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
