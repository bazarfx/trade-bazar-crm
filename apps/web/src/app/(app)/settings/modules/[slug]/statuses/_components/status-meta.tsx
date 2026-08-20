'use client';

import { useEffect, useState } from 'react';
import { SYSTEM_TAGS, type StatusTagValue } from '@crm/shared';
import { Chip, cn } from '@/components/ui';

/**
 * Presentation facts shared by the status list and the status form.
 *
 * The tag notes explain BEHAVIOUR, not naming: six tags are pure reporting
 * buckets, two drive the webhook pipeline. Keyed by the tag value so a
 * missing note becomes a compile error the day STATUS_TAGS grows.
 */
export const TAG_NOTES: Record<StatusTagValue, string> = {
  NEUTRAL: 'Reporting bucket — new or uncategorised, neither positive nor negative.',
  WARM: 'Reporting bucket — showing interest, worth active follow-up.',
  HOT: 'Reporting bucket — high intent, surfaces first in pipeline reports.',
  COLD: 'Reporting bucket — little interest or activity right now.',
  LOST: 'Reporting bucket — pursued and not won.',
  INVALID: 'Reporting bucket — junk, duplicate or unreachable.',
  CONVERTED:
    'Carries webhook behaviour: the conversion pipeline moves records to a status with this tag.',
  SIGNED_UP:
    'Carries webhook behaviour: account sign-up events move records to a status with this tag.',
};

/**
 * The fixed row the colour picker offers, as TOKEN NAMES — never as hexes.
 * tokens.css is the single source of the values and `npm run figma:tokens`
 * rewrites it; a hex copied into this file goes stale silently on the next
 * regeneration, so the picker would show one colour and store another.
 */
const COLOR_TOKENS = [
  { token: '--accents-blue', label: 'Blue' },
  { token: '--accents-green', label: 'Green' },
  { token: '--accents-indigo', label: 'Indigo' },
  { token: '--accents-orange', label: 'Orange' },
  { token: '--accents-purple', label: 'Purple' },
  { token: '--accents-yellow', label: 'Yellow' },
  { token: '--globalcolors-red-60', label: 'Red' },
  { token: '--globalcolors-neutral-80', label: 'Grey' },
] as const;

export interface ColorSwatch {
  token: string;
  label: string;
  /** Lowercased so it compares directly against a stored Status.color. */
  hex: string;
}

/**
 * Resolves the picker's tokens to the hexes they hold right now.
 *
 * `Status.color` stores a literal hex, not a token name, and has to: the value
 * is copied verbatim into `AuditLog.changes`, which is append-only forever
 * (invariant 2) — a stored token name would silently re-colour every historical
 * timeline row the day the palette changes. So the picker persists a hex and
 * reads it off the live custom property instead of keeping a second copy that
 * can drift from tokens.css.
 *
 * Null until the browser has resolved them: no DOM on the server, and a swatch
 * that cannot state its hex must not be clickable.
 */
export function useColorSwatches(): ColorSwatch[] | null {
  const [swatches, setSwatches] = useState<ColorSwatch[] | null>(null);

  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setSwatches(
      COLOR_TOKENS.map((t) => ({ ...t, hex: style.getPropertyValue(t.token).trim().toLowerCase() }))
        // A token dropped or renamed by a regeneration resolves to '' — offer
        // one swatch fewer rather than persist an empty string as a colour.
        .filter((s) => /^#[0-9a-f]{6}$/.test(s.hex)),
    );
  }, []);

  return swatches;
}

/**
 * The tag chip is deliberately louder than a colour dot: the tag — never the
 * name — is what the system reads, so the UI keeps it in view everywhere a
 * status appears. Tags that drive the webhook pipeline read from SYSTEM_TAGS,
 * not from a name comparison.
 */
export function TagChip({ tag }: { tag: StatusTagValue }) {
  const carriesBehaviour = (SYSTEM_TAGS as readonly StatusTagValue[]).includes(tag);
  return (
    // A square-cornered Chip: the pill shape belongs to a status NAME, and the
    // tag has to stay visually distinct from the name it sits beside.
    <Chip
      title={TAG_NOTES[tag]}
      className={cn(
        'shrink-0 rounded',
        // Teal is not a Chip tone — it is the brand, spent here on the two
        // tags that actually drive the webhook pipeline.
        carriesBehaviour && 'border-primary bg-surface text-primary',
      )}
    >
      {tag}
    </Chip>
  );
}

/** Colour dot for list rows. The hex is record data; the fallback is a token. */
export function ColorDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 rounded-pill border border-border"
      style={{ backgroundColor: color ?? 'var(--globalcolors-neutral-40)' }}
    />
  );
}
