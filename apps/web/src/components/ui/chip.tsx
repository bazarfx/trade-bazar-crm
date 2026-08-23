'use client';

import type { HTMLAttributes } from 'react';
import type { StatusTagValue } from '@crm/shared';
import { cn } from './button';

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const CHIP_BASE =
  'inline-flex max-w-full items-center gap-1 truncate rounded-pill border px-2 py-0.5 ' +
  'text-xs font-medium';

const TONE: Record<ChipTone, string> = {
  neutral: 'border-border bg-subtle text-body',
  info: 'border-info bg-subtle text-info',
  success: 'border-success bg-subtle text-success',
  warning: 'border-warning bg-subtle text-warning',
  error: 'border-error bg-subtle text-error',
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
 * HOT is `error` rather than `warning` because the fig paints the Hot badge
 * `#ef4444`; WARM keeps the softer orange.
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
 * Tint and border are derived from the one hex the Admin chose so that any
 * colour they pick stays legible against the surface.
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
    <Chip
      tone="neutral"
      title={name}
      className={className}
      style={{
        color: custom,
        backgroundColor: tint(custom, 0.12),
        borderColor: tint(custom, 0.4),
      }}
    >
      {name}
    </Chip>
  );
}
