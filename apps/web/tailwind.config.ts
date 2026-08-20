import type { Config } from 'tailwindcss';

/**
 * Theme values map to CSS variables generated from the Figma file by
 * `npm run figma:tokens`. Never hardcode a hex here — it will drift.
 *
 * Scales below (type, radius, spacing) are not Figma *variables* — the file
 * carries them as literal values on nodes — so they were extracted by reading
 * the frames and are documented in docs/DESIGN-SPEC.md with usage counts.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // The brand colour is TEAL. The variable literally named `--primary`
        // (#007489) appears 11 times in the file, mostly as a swatch label;
        // `--primary-hover` (#00667a) is what every button and active nav item
        // actually uses — 508 times. See docs/DESIGN-SPEC.md.
        primary: 'var(--primary-hover)',
        'primary-strong': 'var(--primary)',
        background: 'var(--background)',
        surface: 'var(--neutral-10)',
        border: 'var(--border)',
        heading: 'var(--heading)',
        body: 'var(--body)',
        // muted sidebar labels: the file uses #757575, which is not a
        // variable; this is the nearest token in the set.
        muted: 'var(--globalcolors-neutral-80)',
        subtle: 'var(--globalcolors-neutral-20)',
        error: 'var(--error)',
        info: 'var(--accents-blue)',
        success: 'var(--accents-green)',
        warning: 'var(--accents-orange)',
      },
      borderRadius: {
        DEFAULT: 'var(--border-radius-4-px)', // 4px — buttons, inputs, chips
        md: '8px', // nav links, small containers
        lg: '12px', // panels and cards
        pill: 'var(--border-radius-100-px)',
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      fontSize: {
        // [size, lineHeight] — the scale the CRM screens actually use
        overline: ['10px', { lineHeight: '12px', letterSpacing: '0.4px' }],
        xs: ['12px', { lineHeight: '16px' }],
        sm: ['14px', { lineHeight: '20px' }],
        base: ['14px', { lineHeight: '20px' }],
        lg: ['16px', { lineHeight: '24px' }],
        title: ['24px', { lineHeight: '32px', letterSpacing: '0.4px' }],
      },
      spacing: {
        sidebar: '256px', // Sidebar - Open, measured
        'sidebar-inner': '208px',
        // Icon-only rail: the file's collapsed "Menu Item" is 40×40, so 16px
        // of padding either side is what makes it centre.
        'sidebar-collapsed': '72px',
        filters: '230px', // left filter panel
      },
    },
  },
  plugins: [],
} satisfies Config;
