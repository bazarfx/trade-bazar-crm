/**
 * The icons this screen needs, inline.
 *
 * The .fig pulls them from icon sets (icon-park-outline:search, ic:round-plus,
 * iconoir:import, oui:filter, basil:sort-outline). There is no icon package in
 * this app yet and the design-system slice owns that decision, so these are
 * traced at the sizes the frame uses — 20 in the search box, 18 in a button,
 * 16 in a filter row, 12 in the compact toolbar.
 *
 * Every one paints `currentColor` and takes its size from the caller, so an
 * icon can never hardcode a colour the way a filled SVG would.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/** Shared geometry: 1.5px strokes on a 24 grid, matching the traced sets. */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Icon({ children, ...rest }: IconProps) {
  // aria-hidden on every one: each of these sits beside its own text label, and
  // a screen reader announcing "image" before it is noise, not information.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" {...STROKE} />
      <path d="m16 16 4 4" {...STROKE} />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" {...STROKE} />
    </Icon>
  );
}

/** Export: arrow leaving the tray. Import is the same glyph mirrored. */
export function ExportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15V3m0 0L8 7m4-4 4 4" {...STROKE} />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" {...STROKE} />
    </Icon>
  );
}

export function ImportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v12m0 0-4-4m4 4 4-4" {...STROKE} />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" {...STROKE} />
    </Icon>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" {...STROKE} />
    </Icon>
  );
}

export function SortIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M6 12h12M9 17h6" {...STROKE} />
    </Icon>
  );
}

/**
 * One chevron, rotated by the caller. A second "chevron up" component would be
 * a second thing to keep in step with this one for no gain.
 */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" {...STROKE} />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 6-6 6 6 6" {...STROKE} />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 6 6 6-6 6" {...STROKE} />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 13 4 4L19 7" {...STROKE} />
    </Icon>
  );
}
