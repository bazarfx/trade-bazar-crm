'use client';

import Image from 'next/image';
import { cn } from './button';

/**
 * The circular picture the file draws in exactly two sizes, both measured off
 * the `CRM _ Leads` frame:
 *
 *   ROUNDED_RECTANGLE "Avatar"           44x44  r:36.22  fills: IMAGE/FILL  (top bar)
 *   FRAME             "Display Picture"  24x24  r:24     fills: IMAGE/FILL  (table row)
 *
 * Both radii exceed half the box, so both are full circles — `rounded-pill`
 * (`--border-radius-100-px`) is the token that says so without a literal.
 *
 * There is no AvatarStack in the file. Searching every node named `Avatar`
 * turns up 44x44, 40x40 and 24x24 singles and no overlapping group, so none is
 * built here — an unused primitive is a contract nobody verified.
 */
export type AvatarSize = 24 | 44;

export interface AvatarProps {
  /**
   * Same-origin only in practice: `FILE`/`IMAGE` fields store an
   * `AttachmentRef` and resolve bytes through the Attachment table
   * (CLAUDE.md, "Files: store ids, never URLs"), so this is an app route,
   * never a provider URL. That is why `next.config.ts` needs no
   * `images.remotePatterns` entry for it.
   */
  src?: string;
  /** Used for the initials fallback. Never rendered when `src` resolves. */
  name: string;
  size: AvatarSize;
}

/**
 * The file draws only photographic avatars (every fill is IMAGE/FILL), so the
 * empty state has no measured styling. Nearest tokens: the canvas `#f6f8fa`
 * for the disc and `#111827` for the letters, which is the same pairing the
 * table header uses.
 *
 * 24px carries 10px Medium (`text-overline`, the file's smallest step) and
 * 44px carries 14px Medium — the two sizes DESIGN-SPEC's type table actually
 * lists. Nothing here invents a step.
 */
const BOX: Record<AvatarSize, string> = {
  24: 'h-6 w-6 text-overline',
  44: 'h-11 w-11 text-sm font-medium',
};

/**
 * First letter of the first and last word. Names in this product are
 * Admin-entered and may be one word, may be blank, and may start with
 * punctuation, so this never assumes two parts exist.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return '';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const head = first.charAt(0);
  const tail = last === undefined ? '' : last.charAt(0);
  return (head + tail).toUpperCase();
}

export function Avatar({ src, name, size }: AvatarProps) {
  if (src !== undefined && src !== '') {
    return (
      // alt="": in every place the file draws an avatar it sits beside the
      // same person's name in text, so a description here would be announced
      // twice. object-cover reproduces the file's IMAGE/FILL scale mode.
      <Image
        src={src}
        alt=""
        width={size}
        height={size}
        className={cn(BOX[size], 'shrink-0 rounded-pill object-cover')}
      />
    );
  }

  return (
    <span
      // aria-hidden for the same reason as alt="" above — the initials are a
      // second rendering of the name that is already in the row.
      aria-hidden="true"
      className={cn(
        BOX[size],
        'inline-flex shrink-0 select-none items-center justify-center rounded-pill',
        'bg-background text-heading',
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
