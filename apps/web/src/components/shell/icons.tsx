import type { ReactElement, ReactNode } from 'react';

/**
 * The icon set. Hand-drawn inline SVG on a 20×20 grid — no icon library.
 *
 * WHY inline: `ModuleDefinition.icon` is a free-text string an Admin picks, so
 * whatever renders it must tolerate a name nobody shipped code for. A library
 * lookup would either bundle every glyph it owns (hundreds of KB for the eight
 * we use) or blow up on an unknown key. A local map plus a fallback glyph does
 * neither, and it keeps the shell independent of a package we would then have
 * to keep in step with the design file.
 *
 * WHY these numbers: the "Sidebar - Open" frame in `CRM _ Leads` draws every
 * nav glyph at 20×20 and the collapse chevron at 16×16, so the grid is 20 and
 * the size is a class, never a hardcoded width attribute.
 */
export interface IconProps {
  /** Overrides the default 20px nav size — the 28px collapse button wants 16. */
  className?: string;
}

export type IconComponent = (props: IconProps) => ReactElement;

/**
 * Every glyph shares one wrapper so stroke weight, caps and joins cannot drift
 * icon by icon. `currentColor` means an icon never names a colour: it inherits
 * whatever the nav link painted, which is how resting/active/destructive all
 * work with no per-icon variant.
 */
function Glyph({
  className = 'h-5 w-5 shrink-0',
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * Keys are the strings that land in `ModuleDefinition.icon`, plus the shell's
 * own chrome. Adding a glyph here is additive — no existing name changes
 * meaning, so no seeded module can lose its icon to a refactor.
 */
export const ICONS = {
  // --- shell chrome -------------------------------------------------------
  /** Points down at rest; the collapse button rotates it. */
  chevron: (p) => (
    <Glyph {...p}>
      <path d="M5.5 7.8 10 12.3l4.5-4.5" />
    </Glyph>
  ),
  // A 6-tooth gear: the polygon is generated on a circle (r 8.2 outer, 5.8
  // inner) rather than eyeballed, so the teeth are actually evenly spaced.
  settings: (p) => (
    <Glyph {...p}>
      <path d="M7.9 2.1 12.1 2.1 11.5 4.4 14.1 5.9 15.8 4.2 17.9 7.9 15.6 8.5 15.6 11.5 17.9 12.1 15.8 15.8 14.1 14.1 11.5 15.6 12.1 17.9 7.9 17.9 8.5 15.6 5.9 14.1 4.2 15.8 2.1 12.1 4.4 11.5 4.4 8.5 2.1 7.9 4.2 4.2 5.9 5.9 8.5 4.4Z" />
      <circle cx="10" cy="10" r="2.6" />
    </Glyph>
  ),
  logout: (p) => (
    <Glyph {...p}>
      <path d="M7.5 17.5H4.2A1.7 1.7 0 0 1 2.5 15.8V4.2A1.7 1.7 0 0 1 4.2 2.5h3.3" />
      <path d="m13.3 14.2 4.2-4.2-4.2-4.2" />
      <path d="M17.5 10h-10" />
    </Glyph>
  ),
  /** The CRM dropdown parent: a 2×2 tile grid, the file's "apps" glyph. */
  grid: (p) => (
    <Glyph {...p}>
      <rect x="2.5" y="2.5" width="6.3" height="6.3" rx="1.2" />
      <rect x="11.2" y="2.5" width="6.3" height="6.3" rx="1.2" />
      <rect x="2.5" y="11.2" width="6.3" height="6.3" rx="1.2" />
      <rect x="11.2" y="11.2" width="6.3" height="6.3" rx="1.2" />
    </Glyph>
  ),
  /** The Help placeholder row. */
  'help-circle': (p) => (
    <Glyph {...p}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.7 7.6a2.4 2.4 0 0 1 4.6.8c0 1.6-2.3 2-2.3 3.3" />
      <path d="M10 14.6h.01" />
    </Glyph>
  ),
  search: (p) => (
    <Glyph {...p}>
      <circle cx="9.2" cy="9.2" r="5.8" />
      <path d="m17.5 17.5-4.2-4.2" />
    </Glyph>
  ),
  filter: (p) => (
    <Glyph {...p}>
      <path d="M18.3 2.5H1.7l6.6 7.9v5.4l3.4 1.7v-7.1z" />
    </Glyph>
  ),
  sort: (p) => (
    <Glyph {...p}>
      <path d="M3.3 5h13.4M3.3 10h8.4M3.3 15h4.2" />
    </Glyph>
  ),
  plus: (p) => (
    <Glyph {...p}>
      <path d="M10 4.2v11.6M4.2 10h11.6" />
    </Glyph>
  ),
  download: (p) => (
    <Glyph {...p}>
      <path d="M10 2.5v10" />
      <path d="m6.2 8.8 3.8 3.7 3.8-3.7" />
      <path d="M2.9 13.3v2.5a1.7 1.7 0 0 0 1.7 1.7h10.8a1.7 1.7 0 0 0 1.7-1.7v-2.5" />
    </Glyph>
  ),
  upload: (p) => (
    <Glyph {...p}>
      <path d="M10 12.5v-10" />
      <path d="m6.2 6.2 3.8-3.7 3.8 3.7" />
      <path d="M2.9 13.3v2.5a1.7 1.7 0 0 0 1.7 1.7h10.8a1.7 1.7 0 0 0 1.7-1.7v-2.5" />
    </Glyph>
  ),

  // --- glyphs a module may name -------------------------------------------
  home: (p) => (
    <Glyph {...p}>
      <path d="M2.9 8.3 10 2.5l7.1 5.8v7.5a1.7 1.7 0 0 1-1.7 1.7H4.6a1.7 1.7 0 0 1-1.7-1.7z" />
      <path d="M7.9 17.5v-5.8h4.2v5.8" />
    </Glyph>
  ),
  users: (p) => (
    <Glyph {...p}>
      <path d="M13.3 17.5v-1.7a3.3 3.3 0 0 0-3.3-3.3H5a3.3 3.3 0 0 0-3.3 3.3v1.7" />
      <circle cx="7.5" cy="5.8" r="3.3" />
      <path d="M18.3 17.5v-1.7a3.3 3.3 0 0 0-2.5-3.2" />
      <path d="M13.3 2.7a3.3 3.3 0 0 1 0 6.4" />
    </Glyph>
  ),
  user: (p) => (
    <Glyph {...p}>
      <path d="M16.7 17.5v-1.7a4.2 4.2 0 0 0-4.2-4.2H7.5a4.2 4.2 0 0 0-4.2 4.2v1.7" />
      <circle cx="10" cy="6.2" r="3.7" />
    </Glyph>
  ),
  'user-cog': (p) => (
    <Glyph {...p}>
      <path d="M11.7 17.5v-1.7a4.2 4.2 0 0 0-4.2-4.2H5.8a4.2 4.2 0 0 0-4.1 4.2v1.7" />
      <circle cx="6.7" cy="5.8" r="3.3" />
      <circle cx="15.4" cy="13.3" r="2.1" />
      <path d="M15.4 10.4v.8M15.4 15.4v.8M18 11.9l-.7.4M13.5 14.4l-.7.4M18 14.7l-.7-.4M13.5 12.2l-.7-.4" />
    </Glyph>
  ),
  handshake: (p) => (
    <Glyph {...p}>
      <path d="m9.17 14.17 1.67 1.67a.83.83 0 1 0 2.5-2.5" />
      <path d="m11.67 11.67 2.08 2.08a.83.83 0 1 0 2.5-2.5l-3.23-3.23a2.5 2.5 0 0 0-3.53 0l-.73.73a.83.83 0 1 1-2.5-2.5l2.34-2.34a4.83 4.83 0 0 1 5.88-.73l.39.23a1.67 1.67 0 0 0 1.18.21l1.45-.29" />
      <path d="m17.5 2.5.83 9.17h-1.67" />
      <path d="M2.5 2.5 1.67 11.67l5.42 5.42a.83.83 0 1 0 2.5-2.5" />
      <path d="M2.5 3.33h6.67" />
    </Glyph>
  ),
  megaphone: (p) => (
    <Glyph {...p}>
      <path d="M16.7 4.2v11.6l-10-3.3H4.2A1.7 1.7 0 0 1 2.5 10.8V9.2a1.7 1.7 0 0 1 1.7-1.7h2.5z" />
      <path d="M6.7 12.5v2.9a1.7 1.7 0 0 0 3.3 0v-1.8" />
    </Glyph>
  ),
  banknote: (p) => (
    <Glyph {...p}>
      <rect x="1.7" y="5" width="16.6" height="10" rx="1.7" />
      <circle cx="10" cy="10" r="2.1" />
      <path d="M5 8.3v3.4M15 8.3v3.4" />
    </Glyph>
  ),
  briefcase: (p) => (
    <Glyph {...p}>
      <rect x="2.5" y="6.7" width="15" height="10.8" rx="1.7" />
      <path d="M7.1 6.7V5a1.7 1.7 0 0 1 1.7-1.7h2.4A1.7 1.7 0 0 1 12.9 5v1.7" />
      <path d="M2.5 11.2h15" />
    </Glyph>
  ),
  calendar: (p) => (
    <Glyph {...p}>
      <rect x="2.5" y="4.2" width="15" height="13.3" rx="1.7" />
      <path d="M2.5 8.3h15M6.7 2.5v3.3M13.3 2.5v3.3" />
    </Glyph>
  ),
  mail: (p) => (
    <Glyph {...p}>
      <rect x="1.7" y="4.2" width="16.6" height="11.6" rx="1.7" />
      <path d="m1.7 5.8 7.4 4.6a1.7 1.7 0 0 0 1.8 0l7.4-4.6" />
    </Glyph>
  ),
  phone: (p) => (
    <Glyph {...p}>
      <path d="M13.3 17.5C7.4 17.5 2.5 12.6 2.5 6.7V5A2.5 2.5 0 0 1 5 2.5h1.2a.8.8 0 0 1 .8.7l.6 3a.8.8 0 0 1-.4.8l-1.5.9a11.7 11.7 0 0 0 5.4 5.4l.9-1.5a.8.8 0 0 1 .8-.4l3 .6a.8.8 0 0 1 .7.8V15a2.5 2.5 0 0 1-2.5 2.5z" />
    </Glyph>
  ),
  file: (p) => (
    <Glyph {...p}>
      <path d="M11.7 1.7H5.8a1.7 1.7 0 0 0-1.7 1.7v13.3a1.7 1.7 0 0 0 1.7 1.6h8.4a1.7 1.7 0 0 0 1.6-1.6V5.8z" />
      <path d="M11.7 1.7v4.1h4.1" />
    </Glyph>
  ),
  chart: (p) => (
    <Glyph {...p}>
      <path d="M2.5 2.5v13.3a1.7 1.7 0 0 0 1.7 1.7h13.3" />
      <path d="M6.7 13.3V10M10 13.3V6.7M13.3 13.3v-5" />
    </Glyph>
  ),
  tag: (p) => (
    <Glyph {...p}>
      <path d="M17 10.8 10.9 17a1.7 1.7 0 0 1-2.4 0L2.1 10.5a1.7 1.7 0 0 1-.5-1.2V3.3a1.7 1.7 0 0 1 1.7-1.7h6a1.7 1.7 0 0 1 1.2.5l6.5 6.4a1.7 1.7 0 0 1 0 2.3z" />
      <circle cx="6.2" cy="6.2" r="1.2" />
    </Glyph>
  ),
  /**
   * The fallback. An Admin can type any string into `icon`, and a module that
   * renders without a glyph is a broken nav row — so an unknown name resolves
   * here rather than throwing or rendering nothing.
   */
  module: (p) => (
    <Glyph {...p}>
      <rect x="2.5" y="2.5" width="15" height="15" rx="2.5" />
      <path d="M2.5 7.5h15M7.9 7.5v10" />
    </Glyph>
  ),
} satisfies Record<string, IconComponent>;

export type IconName = keyof typeof ICONS;

const FALLBACK: IconName = 'module';

/** True when `name` is a glyph we ship. Exported for pickers that list icons. */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/**
 * Renders a glyph by config-supplied name. Never throws: an unknown, empty or
 * null name falls back, because the name comes from a database column an Admin
 * edits and a typo there must not take the whole shell down.
 */
export function Icon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}): ReactElement {
  const Glyphed = ICONS[name && isIconName(name) ? name : FALLBACK];
  return <Glyphed className={className} />;
}
