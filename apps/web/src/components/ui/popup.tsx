'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayStack } from '@/components/overlay/overlay-context';
import { cn } from './button';

/**
 * The CENTRED pop-up the Figma file draws — not a full-screen overlay.
 *
 * CLAUDE.md's UI rules were rewritten on 22 Aug 2026: the file contradicts the
 * old "no small modals anywhere" rule, so overlay size now comes from the file.
 * `FullScreenOverlay` still owns the big authoring surfaces (record form, field
 * builder, layout editor, roles matrix, review queue); this owns everything the
 * file actually draws as a panel over the page.
 *
 * EVERY number below was read out of `tools/figma/Zoho.fig`, not recalled.
 * The `Pop up` frame, identical across all ten instances in the file:
 *
 *   FRAME "Pop up"  511x252  flex-col gap:24 pad:24/24/24/24
 *                   bg:#ffffff  border:#e5e7eb 1px  r:8
 *     FRAME  Title      @24,24   463x22   flex-row gap:16   (title + Icon/X 20x20)
 *     VECTOR Separator  @24,70   463x0    border:#e5e7eb 1px
 *     FRAME  Content    @24,94   463x…    flex-col gap:20
 *     FRAME  Frame 482701  @24,188  463x40  flex-row gap:18  (222x40 buttons)
 *
 * The inner 463 is DERIVED, not assumed: 511 − 24 − 24. Every width in the file
 * agrees — 1015 → 967, 1152 → 1104 — so the padding is one value, `p-6`, and no
 * width needs its own inset.
 *
 * Drop shadow, measured off the same node: `0 -4px 36px` at 16% of #969696.
 * That grey is not in the token set; `--neutral-60` (#878787) is the nearest,
 * and `color-mix` applies the alpha without introducing a literal colour.
 */
export type PopupWidth = 511 | 1015 | 1152;

export interface PopupProps {
  title: string;
  onClose: () => void;
  /** The three widths the file draws. See docs/DESIGN-SPEC.md and CLAUDE.md. */
  width: PopupWidth;
  /** Usually a `<PopupFooter>`; anything else renders in the same slot. */
  footer?: ReactNode;
  children: ReactNode;
  /** `module.screen` prefix; the close button emits `${trackPrefix}.popup.close`. */
  trackPrefix: string;
  /**
   * Mounted-but-closed is supported so a caller can keep the popup in the tree
   * across a toggle. `{open && <Popup …>}` works too — the focus bookkeeping
   * below handles both, which is why it is not simply captured on mount.
   */
  open: boolean;
}

/**
 * Measured: the 511 pop-ups draw ONE separator, under the title. The 1015
 * ("Create New Fields", separator @24,352 before the footer @24,376) and the
 * 1152 stage panels draw a SECOND one above the footer. The file varies this
 * by width and nothing else, so this table is the whole rule.
 */
const FOOTER_SEPARATOR: Record<PopupWidth, boolean> = {
  511: false,
  1015: true,
  1152: true,
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Icon/X, 20x20 in the file's Title row. Traced on the 24 grid the rest of
 *  this codebase's icons use (see the module list screen's icons.tsx). */
function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Popup({
  title,
  onClose,
  width,
  footer,
  children,
  trackPrefix,
  open,
}: PopupProps) {
  const stack = useOverlayStack();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // The stack calls onClose from a document-level listener, which would
  // otherwise capture the closure from the mount render. A ref keeps it live.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Portals need a DOM; render nothing until the first client commit.
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Whatever was focused before this popup opened — the trigger, or a control
  // inside the surface below it when overlays stack.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Captured on the FIRST commit, which is the only moment it is still
    // correct for a popup that mounts already-open: the portal renders on the
    // NEXT commit, and by the time the push effect runs the content has
    // mounted and autofocused, so document.activeElement is already inside.
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHost(document.body);
  }, []);

  useEffect(() => {
    // A popup that stays mounted while CLOSED cannot use the first-commit
    // capture: the trigger takes focus long after that commit, and no render
    // happens in between. Tracking focus while closed is what makes `open`
    // toggling restore focus as correctly as mounting does. The listener is
    // torn down the moment the popup opens, freezing the last value — which
    // is exactly the element that opened it.
    if (open) return;
    const record = () => {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    };
    record();
    document.addEventListener('focusin', record);
    return () => document.removeEventListener('focusin', record);
  }, [open]);

  useEffect(() => {
    if (!host || !open) return;
    // ONE stack for pop-ups and full-screen overlays together. That is what
    // makes Escape close only the top surface and the body scroll lock survive
    // until the last one closes — including a pop-up opened over an overlay,
    // or over another pop-up.
    const id = stack.push(() => onCloseRef.current());
    // Content that autofocuses a field has picked the better landing spot;
    // only take focus when nothing inside the panel claimed it.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      stack.pop(id);
      // Hand focus back to whatever opened this. A trigger that unmounted with
      // the popup cannot take it, and focus falls back to the document.
      openerRef.current?.focus();
    };
  }, [host, open, stack]);

  // Keep Tab inside the dialog; aria-modal alone does not trap real focus.
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // A drag that STARTS inside the panel and ends on the scrim — selecting the
  // text of a filter name and releasing past the edge — fires `click` on the
  // scrim, which would throw the pop-up away mid-edit. Both ends of the
  // gesture have to be on the scrim for it to count as a dismissal.
  const pressedScrim = useRef(false);

  if (!host || !open) return null;

  return createPortal(
    <div
      // The file draws no scrim: each pop-up frame sits straight on the page
      // artwork. A modal without one gives the user nothing to click to get
      // out and no signal that the page behind is inert, so this is an
      // addition, kept to the heading token at 40% rather than a new colour.
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ backgroundColor: 'color-mix(in srgb, var(--heading) 40%, transparent)' }}
      data-track={`${trackPrefix}.popup.dismiss`}
      onMouseDown={(e) => {
        pressedScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedScrim.current) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
        // width from the file; `max-w-full` inside the p-6 scrim is what keeps
        // a 1152 panel from running off a laptop screen. `max-h-full` plus the
        // scrolling content region below does the same vertically — the file's
        // heights (203…516) all assume 1024, and nothing may become unreachable
        // on a shorter viewport.
        style={{
          width,
          // TWO shadows, and the first one is the panel's 1px #e5e7eb stroke.
          //
          // It is NOT a `border`, and that is measured, not stylistic. A CSS
          // border sits inside `width` under border-box, so `w-[1152] + p-6`
          // lays the children out across 1102 — while the file draws them at
          // 1104, because a Figma stroke does not participate in auto-layout.
          // Rendered side by side that put every footer button 2px off the
          // file (Cancel at 400 where the file says 402). A spread-only shadow
          // paints the same 1px line and takes no space, so the inner width
          // derives exactly: 511→463, 1015→967, 1152→1104.
          //
          // Measured DROP_SHADOW on the `Pop up` node: 0 -4px 36px, #969696 @16%.
          // #969696 has no token; --neutral-60 (#878787) is the nearest.
          boxShadow:
            '0 0 0 1px var(--border), ' +
            '0 -4px 36px color-mix(in srgb, var(--neutral-60) 16%, transparent)',
        }}
        className={cn(
          // flex-col gap:24 pad:24 → gap-6 p-6; r:8 → rounded-md; measured
          // bg #ffffff → surface. The #e5e7eb stroke is the ring in `style`
          // above, not a border — see the note there.
          'flex max-h-full max-w-full flex-col gap-6 rounded-md bg-surface p-6',
          'outline-none',
        )}
      >
        {/* Title row: 463x22, flex-row gap:16. The Icon/X sits at x=443 of 463
            — flush right, i.e. space-between, whatever the auto-layout mode
            in the file nominally says. */}
        <div className="flex shrink-0 items-center justify-between gap-4">
          <h2
            id={titleId}
            // Measured 18px Medium #111827. The project type scale
            // (docs/DESIGN-SPEC.md, tailwind.config.ts) has no 18px step;
            // `text-lg` is 16px, the nearest, and matches the brief's 14–16px.
            // truncate: the title carries Admin-authored names with no length
            // limit, and a wrapped title would push the panel taller than the
            // file's measured heights.
            className="min-w-0 truncate text-lg font-medium text-heading"
            title={title}
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            data-track={`${trackPrefix}.popup.close`}
            className={
              'inline-flex shrink-0 items-center justify-center rounded text-heading ' +
              'hover:text-body focus-visible:outline-none focus-visible:ring-2 ' +
              'focus-visible:ring-primary focus-visible:ring-offset-2 ' +
              'focus-visible:ring-offset-surface'
            }
          >
            <CloseIcon />
          </button>
        </div>

        {/* Separator @24,70 — 1px #e5e7eb across the inner width. It is a plain
            child of the p-6 panel, so it spans exactly the measured 463/967/1104. */}
        <div className="h-px shrink-0 bg-border" aria-hidden="true" />

        {/* Content: flex-col gap:20. `min-h-0` is what lets it shrink and
            scroll inside `max-h-full` instead of overflowing the viewport. */}
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">{children}</div>

        {footer !== undefined ? (
          <>
            {FOOTER_SEPARATOR[width] ? (
              <div className="h-px shrink-0 bg-border" aria-hidden="true" />
            ) : null}
            <div className="shrink-0">{footer}</div>
          </>
        ) : null}
      </div>
    </div>,
    host,
  );
}

/* ------------------------------------------------------------------------- */

export type PopupFooterTone = 'primary' | 'neutral' | 'destructive';

export interface PopupFooterAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Defaults: `next` → primary, `cancel`/`previous` → neutral. */
  tone?: PopupFooterTone;
}

export interface PopupFooterProps {
  /** `module.screen`; each button emits `${trackPrefix}.footer.<slot>`. */
  trackPrefix: string;
  cancel?: PopupFooterAction;
  previous?: PopupFooterAction;
  next?: PopupFooterAction;
}

/**
 * The file's footer row. Any subset of the three slots may be omitted, and the
 * order is FIXED because it is measured, not chosen.
 *
 * On the 1152 stage panel (`Frame 482701`, 1104x40, flex-row gap:18, main:MAX)
 * the three buttons sit at x = 402, 642, 882 within 1104:
 *
 *   402 "Cancel"   bg #f6f8fa
 *   642 "Previous" bg #f6f8fa
 *   882 "Next"     bg #00667a, white label
 *
 *   402 + 222 + 18 = 642, 642 + 222 + 18 = 882, 882 + 222 = 1104 → right-aligned.
 *
 * NOTE the order: the file puts **Cancel first, then Previous, then Next** —
 * not Previous/Cancel/Next. Following the file, on the client's twice-stated
 * instruction; if that ordering is ever changed it must change in the .fig
 * first.
 *
 * On the 511 pop-ups only two buttons are drawn and they fill the row exactly
 * (222 + 18 + 222 = 462 of the 463 available), so the alignment is moot there.
 *
 * These are NOT the `Button` primitive: `Button`'s secondary is `bg-surface`
 * (#ffffff), traced from the Leads header's Export/Import. The footer's
 * secondary is measured #f6f8fa. Overriding one background utility with
 * another resolves by stylesheet order rather than attribute order — the trap
 * `PanelBody` documents — so the footer states its own fills outright.
 */
const FOOTER_BUTTON_BASE =
  // 222x40, r:4, pad 8/18, gap 8, label 16px Medium — all measured.
  'inline-flex h-10 w-[222px] shrink-0 items-center justify-center gap-2 rounded ' +
  'px-[18px] text-lg font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-surface ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const FOOTER_TONE: Record<PopupFooterTone, string> = {
  // #00667a → primary; white label → surface.
  primary: 'bg-primary text-surface hover:bg-primary-strong',
  // #f6f8fa → background, border #e5e7eb, label #111827. Hover is measured off
  // the Buttons component's `Hierarchy=Secondary, State=Hover` fill, #e8e8e8;
  // that grey has no alias, and `border` (#e5e7eb) is the nearest, 3 off.
  neutral: 'border border-border bg-background text-heading hover:bg-border',
  // #ef4444 → error, white label. Measured on "Delete" and "Yes, Leave Page".
  // The component library's destructive hover (#f7eded) is a TINT for its
  // outline variant and does not apply to a solid fill, so this dims instead
  // of inventing an `error-strong` colour that no token defines.
  destructive: 'bg-error text-surface hover:opacity-90',
};

function FooterButton({
  action,
  slot,
  trackPrefix,
  fallbackTone,
}: {
  action: PopupFooterAction;
  slot: string;
  trackPrefix: string;
  fallbackTone: PopupFooterTone;
}) {
  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={action.disabled === true}
      data-track={`${trackPrefix}.footer.${slot}`}
      className={cn(FOOTER_BUTTON_BASE, FOOTER_TONE[action.tone ?? fallbackTone])}
    >
      {/* truncate: these labels come from screens, but a translated or
          Admin-worded label must not stretch a fixed 222px button. */}
      <span className="truncate">{action.label}</span>
    </button>
  );
}

export function PopupFooter({ trackPrefix, cancel, previous, next }: PopupFooterProps) {
  return (
    // gap:18 is off the 4px grid and off the spacing scale; it is what the file
    // draws, and the arithmetic above only closes at 18. Same precedent as
    // Button's measured h-[38px].
    <div className="flex items-center justify-end gap-[18px]">
      {cancel ? (
        <FooterButton action={cancel} slot="cancel" trackPrefix={trackPrefix} fallbackTone="neutral" />
      ) : null}
      {previous ? (
        <FooterButton
          action={previous}
          slot="previous"
          trackPrefix={trackPrefix}
          fallbackTone="neutral"
        />
      ) : null}
      {next ? (
        <FooterButton action={next} slot="next" trackPrefix={trackPrefix} fallbackTone="primary" />
      ) : null}
    </div>
  );
}
