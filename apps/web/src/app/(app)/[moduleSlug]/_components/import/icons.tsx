/**
 * The icons the import family needs, inline and traced from the sets the .fig
 * names on its own nodes:
 *
 *   `clarity:file-line`   28x28 in the drop target, 16x16 on a file chip
 *   `charm:tick`          12/14 inside the 16/20/22 tick squares
 *   `mage:goals`          12/24 — the module glyph on stage 3's card and
 *                         stage 4's rail
 *   `Icon / Chevron`      14/16 on the charset and rule selects
 *   `material-symbols-light:assignment-turned-in`
 *                         16x16 in stage 4's "Assign Default Value" pill
 *
 * Same rules as `../icons.tsx`, which owns the list screen's set and which
 * this folder does not edit: every one paints `currentColor` and takes its
 * size from the caller, so an icon can never hardcode a colour.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Icon({ children, ...rest }: IconProps) {
  // aria-hidden on every one: each sits beside its own text label, and a
  // screen reader announcing "image" before it is noise, not information.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

/** `clarity:file-line` — a sheet with a folded corner. */
export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path {...STROKE} d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4Z" />
      <path {...STROKE} d="M14 3v4h4" />
    </Icon>
  );
}

/** `charm:tick`, drawn 1.5px round in the file. */
export function TickIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path {...STROKE} d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

/**
 * `material-symbols-light:assignment-turned-in` — a clipboard with a tick,
 * drawn 16x16 (a 10.7x12 vector) in stage 4's "Assign Default Value" pill.
 */
export function AssignmentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path {...STROKE} d="M9 4H6a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3" />
      <path {...STROKE} d="M9 4a3 3 0 1 1 6 0" />
      <path {...STROKE} d="m8.5 13 2.5 2.5 5-5" />
    </Icon>
  );
}

/** `mage:goals` — concentric rings with an arrow, the file's module glyph. */
export function ModuleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle {...STROKE} cx="11" cy="13" r="9" />
      <circle {...STROKE} cx="11" cy="13" r="5" />
      <circle {...STROKE} cx="11" cy="13" r="1" />
      <path {...STROKE} d="m11 13 8-8m0 0h-3.5M19 5v3.5" />
    </Icon>
  );
}
