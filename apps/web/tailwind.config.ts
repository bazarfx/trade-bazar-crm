import type { Config } from 'tailwindcss';

/**
 * Theme values map to CSS variables generated from the Figma file by
 * `npm run figma:tokens`. Never hardcode a hex here — it will drift.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary:    'var(--accent)',
        background: 'var(--background)',
        surface:    'var(--neutral-10)',
        border:     'var(--border)',
        heading:    'var(--heading)',
        body:       'var(--body)',
        error:      'var(--error)',
        info:       'var(--accents-blue)',
        success:    'var(--accents-green)',
        warning:    'var(--accents-orange)',
      },
      borderRadius: { DEFAULT: 'var(--border-radius-4-px)', pill: 'var(--border-radius-100-px)' },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
} satisfies Config;
