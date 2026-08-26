'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
 * EVERY number below was read out of `tools/figma/Zoho.fig`, not recalled, and
 * re-verified against the three saved-filter frames on 26 Aug 2026. The file
 * draws 27 `Pop up` frames — 10 at 511, 1 at 1015, 16 at 1152 — and the shell
 * is identical in all of them:
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
 * Title type: Inter **Medium 18px**, line-height 100% → 22 tall, `#111827`.
 * Verified on every `Pop up` in the file, not just these three.
 *
 * Drop shadow, measured off the same node: `0 -4px 36px` at 16% of #969696,
 * spread 0. That grey is not in the token set; `--neutral-60` (#878787) is the
 * nearest, and `color-mix` applies the alpha without introducing a literal
 * colour.
 *
 * SCRIM: measured, not invented — `Rectangle 12`, 1440x1024, SOLID `#111827`
 * at paint opacity 0.25, drawn under the `Pop up` in all eight frames that
 * show one. See the note on the scrim element below.
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

/**
 * Title-row CROSS axis, re-measured across all 27 `Pop up` frames on
 * 26 Aug 2026 by reading `stackCounterAlignItems` off every `Title` node:
 *
 *   511  (10 frames)  unset → Figma's default **MIN**
 *   1015 (1 frame)    unset → **MIN**
 *   1152 (16 frames)  **CENTER**
 *
 * MIN is what the drawn geometry shows: the 511 Title is 463x22 with the 20x20
 * `Icon/X` at rel y=0 (so 0…20, not 1…21), and the 1015 Title is 967x43 — a
 * two-line heading — with its `Icon/X` also at rel y=0, i.e. **11px** above
 * centre. `items-center` was 1px out on the 511s and 11px out on the 1015.
 *
 * The 1152's CENTER is recorded for completeness and is moot in the file: those
 * Title rows hold a single 22px-tall TEXT in a 22-tall row and draw no close
 * icon at all. We still render one (a dialog needs a pointer route out), so the
 * measured value is what it gets.
 */
const TITLE_CROSS: Record<PopupWidth, string> = {
  511: 'items-start',
  1015: 'items-start',
  1152: 'items-center',
};

/**
 * Footer MAIN axis, from `stackPrimaryAlignItems` on the same 27 frames:
 *
 *   511   unset → **MIN**  — the two 222 Buttons are drawn at rel x=0 and 240
 *                            in a FIXED 463 row (222+18+222 = 462), so the one
 *                            pixel of slack sits on the RIGHT.
 *   1015  **MAX** — Buttons at 505 and 745 of 967; 745+222 = 967, flush right.
 *   1152  **MAX** — Buttons at 402, 642, 882 of 1104; 882+222 = 1104.
 *
 * Reaching this from `PopupFooter` needs the width, which the footer is handed
 * as a `footer` PROP by the caller rather than composed by `Popup`. Context
 * carries it instead, so no call site changes and a `PopupFooter` rendered
 * outside a `Popup` — the import wizard's 1152 stage panel is one, it is a page
 * panel and not a dialog — keeps the MAX the file gives that width anyway.
 */
const FOOTER_MAIN: Record<PopupWidth, 'start' | 'end'> = {
  511: 'start',
  1015: 'end',
  1152: 'end',
};

const PopupWidthContext = createContext<PopupWidth | null>(null);

/**
 * The file's `Separator`: a VECTOR **463x0** (967x0 at 1015, 1104x0 at 1152)
 * carrying a 1px `#e5e7eb` stroke at `align=CENTER`.
 *
 * Zero height is the load-bearing part. A Figma stroke does not participate in
 * auto-layout, which is why the Delete panel's column comes to exactly 203:
 * 24 + 22 + 24 + **0** + 24 + 21 + 24 + 40 + 24. `h-px bg-border` spent that
 * pixel, so every 511 panel computed 204 and every 1015/1152 panel — which
 * draws a SECOND separator above its footer — computed two tall.
 *
 * A spread-only box-shadow on a zero-height box paints the same 1px line, takes
 * no layout space, and straddles the flow position the way a CENTER stroke
 * straddles the vector. Same trick, and the same reason, as the panel's own 1px
 * stroke below.
 */
function Separator() {
  return (
    <div
      className="h-0 shrink-0"
      style={{ boxShadow: '0 0 0 0.5px var(--border)' }}
      aria-hidden="true"
    />
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Icon/X, drawn 20x20 in the file's Title row.
 *
 * Measured on the `Icon/X` SYMBOL: a 24x24 master whose cross is a **14x14**
 * VECTOR at (5,5) — so the strokes run 5→19, not 6→18 — `strokeWeight 1.5`,
 * `strokeCap ROUND`. Traced on the 24 grid the rest of this codebase's icons
 * use (see the module list screen's icons.tsx).
 */
function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 5l14 14M19 5L5 19"
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
      // The scrim IS in the file, and this was previously documented as absent.
      // Measured `Rectangle 12` — a 1440x1024 ROUNDED_RECTANGLE sitting under
      // the `Pop up` frame in every one of the eight frames that draw one
      // (Save Filter, Saved filter Edit, Saved filter delete, Create Leads
      // -cANCEL, and the four Import dialogs): SOLID `#111827` at paint
      // opacity **0.25**. `#111827` is exactly `--heading`, so the only value
      // here is the measured 25% — it was 40%, which read visibly darker than
      // the file.
      //
      // The pop-up is centred in that 1440x1024: 511 wide at x=465 →
      // (1440−511)/2 = 464.5, and 203 tall at y=411 → (1024−203)/2 = 410.5.
      // Hence items-center justify-center rather than a measured offset.
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ backgroundColor: 'color-mix(in srgb, var(--heading) 25%, transparent)' }}
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
        <PopupWidthContext.Provider value={width}>
          {/* Title row: 463x22, flex-row gap:16, MAIN=SPACE_EVENLY (Figma's name
              for space-between) — the Icon/X sits at x=443 of 463, flush right.
              CROSS is per-width and measured; see TITLE_CROSS. */}
          <div className={cn('flex shrink-0 justify-between gap-4', TITLE_CROSS[width])}>
            <h2
              id={titleId}
              // Measured Inter **Medium 18px**, line-height 100% → the 22px-tall
              // Title row, fill `#111827` (= --heading). EVERY `Pop up` in the
              // file that carries a title draws it at 18/Medium, across all
              // three widths — so this is the primitive's size, not one screen's.
              //
              // 18px is NOT on the project type scale (tailwind.config.ts stops
              // at `lg` = 16px), so it is stated inline with the node named, the
              // same way `h-[38px]` and `gap-[18px]` are. It used to render as
              // `text-lg`, i.e. 2px small on every pop-up in the app.
              //
              // truncate: the title carries Admin-authored names with no length
              // limit, and a wrapped title would push the panel taller than the
              // file's measured heights.
              className="min-w-0 truncate text-[18px] font-medium leading-[22px] text-heading"
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
          <Separator />

          {/* Content: flex-col gap:20. `min-h-0` is what lets it shrink and
              scroll inside `max-h-full` instead of overflowing the viewport. */}
          <div className="flex min-h-0 flex-col gap-5 overflow-y-auto">{children}</div>

          {footer !== undefined ? (
            <>
              {FOOTER_SEPARATOR[width] ? <Separator /> : null}
              <div className="shrink-0">{footer}</div>
            </>
          ) : null}
        </PopupWidthContext.Provider>
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
 * On the 511 pop-ups only two buttons are drawn and they fill the row to within
 * a pixel (222 + 18 + 222 = 462 of the 463 available) — but the row's alignment
 * is not the same one: `Frame 482701` leaves `stackPrimaryAlignItems` unset
 * there, i.e. MIN, and the buttons are drawn at x=0 and x=240, putting the odd
 * pixel on the RIGHT. See FOOTER_MAIN; the width arrives through context.
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
  const width = useContext(PopupWidthContext);
  const slots = (cancel ? 1 : 0) + (previous ? 1 : 0) + (next ? 1 : 0);
  // MIN vs MAX per width — see FOOTER_MAIN. The `slots > 1` guard is honest
  // about where the file stops speaking: every 511 footer it draws holds TWO
  // 222 buttons that fill the 463 row to within a pixel, so MIN and MAX differ
  // by 1 there and the measured MIN is free to take. It draws no single-button
  // 511 footer at all, and packing a lone button left would move it 241px on
  // the strength of a value the file never exercised — so one action keeps the
  // right edge every other footer in the file uses.
  const packLeft = width !== null && FOOTER_MAIN[width] === 'start' && slots > 1;

  return (
    // gap:18 is off the 4px grid and off the spacing scale; it is what the file
    // draws, and the arithmetic above only closes at 18. Same precedent as
    // Button's measured h-[38px].
    <div
      className={cn(
        'flex items-center gap-[18px]',
        packLeft ? 'justify-start' : 'justify-end',
      )}
    >
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
