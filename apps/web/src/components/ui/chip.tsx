'use client';

import type { HTMLAttributes } from 'react';
import type { StatusTagValue } from '@crm/shared';
import { cn } from './button';

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/**
 * Measured on the file's `Badge` component (Internal Only Canvas, 340x408 —
 * the frame whose fills are the `--globalcolors-*-10 / -60` pairs tokens.css
 * was generated from; the 385x382 `Badge` is a dark-mode kit) and confirmed on
 * the live Leads table, where the "Lead Status" cell at x=1146 is an INSTANCE
 * of that component (`CRM _ Leads > Table > Rows > Status > Badge`).
 *
 *   Type=Contained, Size=Small — 25 high, `flex-row gap:8`, `pad 4/6`,
 *   **radius 4**, **no border**, label Inter Medium 12px.
 *
 * Three corrections against what this file used to draw: it was a PILL, it had
 * a 1px border, and every tone shared one grey fill. The file draws a rounded
 * rectangle and no stroke at all.
 *
 * `leading-[17px]` is the last of the 25: the label's lineHeight is RAW 1.4 on
 * 12px = 16.8, and every `Badge` text node measures 17 tall, so 4 + 17 + 4 =
 * 25. This project's `text-xs` is 12px/**16**, which would render 24. Inline
 * because 17 is on no scale — the same one-off convention as `h-[38px]`.
 *
 * Type=Outlined is the pill — but it carries a leading 8px dot and nothing on
 * the CRM screens instantiates it.
 */
const CHIP_BASE =
  'inline-flex max-w-full items-center gap-2 truncate rounded px-1.5 py-1 ' +
  'text-xs font-medium leading-[17px]';

/**
 * The `Badge` component draws SEVEN fixed colour pairs and nothing else, each
 * one a straight `--globalcolors-<hue>-10` fill under a `--globalcolors-<hue>-60`
 * label:
 *
 *   Blue #edf2fe/#4976f4 · Green #eef5f0/#589e67 · Orange #fbf4ec/#d28e3d
 *   Red #f7eded/#af4b4b  · LimeYellow #f7f7e8/#b1ab1d · Purple #f4edf7/#954baf
 *   Grey #f9f9f9/#000000
 *
 * This table used to paint `--accents-blue` #0088ff, `--accents-green` #34c759
 * and `--accents-orange` #ff8d28 at 10%. None of those three hexes is on any
 * badge anywhere in the file — they are the OS accent swatches, which the file
 * carries as a palette and never instantiates. Every tone is now one of the
 * seven drawn pairs, which also retires the `color-mix` workaround: a `-10`
 * token IS the tint, so nothing has to be mixed and no alpha can be dropped.
 * (Slash-opacity would still be wrong here — `bg-[var(--globalcolors-red-10)]` compiles to a plain
 * `background-color` with the alpha silently gone — but nothing needs it now.)
 *
 * The one hue deliberately NOT taken from the pairs is the Admin-picked colour
 * in `StatusChip` below, which cannot have a `-10` because it does not exist
 * until runtime.
 *
 * `neutral` is `Color=Grey`: fill `#f9f9f9` (`--globalcolors-neutral-20`,
 * aliased `subtle`). Its label is drawn #000000; `heading` (#111827) is kept
 * for it so the chip agrees with `Button`'s Secondary/Tertiary/Link, which sit
 * on the same one-step approximation — see the note in button.tsx.
 *
 * Purple and LimeYellow stay unused: `ChipTone` has five members and adding a
 * sixth would break the exhaustive `Record<ChipTone, string>` in
 * workload-panel.tsx, which is not this file's to edit.
 */
const TONE: Record<ChipTone, string> = {
  neutral: 'bg-subtle text-heading',
  info: 'bg-[var(--globalcolors-blue-10)] text-[color:var(--globalcolors-blue-60)]',
  success: 'bg-[var(--globalcolors-green-10)] text-[color:var(--globalcolors-green-60)]',
  warning: 'bg-[var(--globalcolors-orange-10)] text-[color:var(--globalcolors-orange-60)]',
  error: 'bg-[var(--globalcolors-red-10)] text-[color:var(--globalcolors-red-60)]',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

export function Chip({ tone = 'neutral', className, ...rest }: ChipProps) {
  return <span className={cn(CHIP_BASE, TONE[tone], className)} {...rest} />;
}

export interface StatusChipProps {
  name: string;
  tag: StatusTagValue;
  color?: string | null;
  className?: string;
}

/**
 * Fallback tone per TAG. Statuses are fully Admin-editable — created, renamed,
 * recoloured, re-tagged, reordered — so this table is keyed on `tag` and this
 * file never reads `name` for anything but display. The moment a lookup keys
 * on the string, renaming "Hot" to "Priority" silently changes its colour.
 *
 * Every member of `StatusTagValue` resolves here, and every tone it can resolve
 * to is one of the `Badge` component's drawn pairs — so no tag can reach a
 * colour the file does not paint.
 *
 * HOT is `error` and WARM `warning` because that is how the two read, not
 * because of a hex: the "Hot"/"Warm"/"Cold"/"Junk" badges on `CRM _ Leads` are
 * the **Lead Category** column at x=1670, a different picklist from the **Lead
 * Status** column at x=1146 this component stands in for. Those four are
 * hand-drawn FRAMEs (`--error`@0.12, `--warning`/`--accent`/`--heading`@0.10),
 * not instances of anything; the Status column is the component. A shared
 * primitive implements the component.
 */
const TAG_TONE: Record<StatusTagValue, ChipTone> = {
  NEUTRAL: 'neutral',
  WARM: 'warning',
  HOT: 'error',
  COLD: 'info',
  // LOST and INVALID are terminal, not alarming — they read as greyed-out
  // history, so they take the same quiet tone as NEUTRAL.
  LOST: 'neutral',
  INVALID: 'neutral',
  CONVERTED: 'success',
  SIGNED_UP: 'neutral',
};

/**
 * The tone a tag reads as, for anything that paints a status WITHOUT drawing a
 * chip — a pipeline bar, a legend swatch.
 *
 * Exported so those callers reuse THIS table instead of writing a second one:
 * a duplicate would drift the first time a tag is added or re-toned, and the
 * bar would then disagree with the chip beside it about what "Hot" looks like.
 * `?? 'neutral'` guards a tag value the enum grew after this build shipped.
 */
export function toneForTag(tag: StatusTagValue): ChipTone {
  return TAG_TONE[tag] ?? 'neutral';
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * An Admin-picked status colour is DATA, not a design token — it only exists
 * at runtime, so the "never hardcode a colour" rule neither applies nor could.
 * The fill is derived from the one hex the Admin chose, at the alpha the file
 * paints its own status badges with, so any colour they pick reads the same way
 * the drawn ones do.
 */
function tint(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function StatusChip({ name, tag, color, className }: StatusChipProps) {
  // Colours are validated as #rrggbb on write, but a chip must not trust its
  // props: a row written before that constraint existed still has to render
  // rather than emit `background: undefined` and vanish.
  const custom = typeof color === 'string' && HEX.test(color) ? color : null;

  if (custom === null) {
    return (
      <Chip tone={toneForTag(tag)} title={name} className={className}>
        {name}
      </Chip>
    );
  }

  return (
    // Inline style beats the tone classes, so the tone here is only a base for
    // shape and typography; the Admin's colour wins on every painted property.
    // 0.1 is the alpha the file paints its hand-drawn badges at — the Lead
    // Category cells are `--warning`/`--accent`/`--heading` at 0.10 ("Hot" is
    // 0.12, two points off and invisible). That is the only recipe available
    // for a runtime hex, since a one-off colour has no `-10` companion.
    // No borderColor: the drawn badge has no stroke.
    <Chip
      tone="neutral"
      title={name}
      className={className}
      style={{ color: custom, backgroundColor: tint(custom, 0.1) }}
    >
      {name}
    </Chip>
  );
}
