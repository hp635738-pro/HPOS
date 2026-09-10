/**
 * Minimum Tailwind setup for shadcn/21st.dev components inside HPOS.
 *
 * - Preflight is OFF: HPOS owns the global stylesheet and must not change.
 * - shadcn color tokens map onto HPOS theme vars, so installed components
 *   follow the HPOS light/dark palettes automatically (no :root additions,
 *   no variable collisions with the existing theme).
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'media',
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        border: 'var(--line)',
        input: 'var(--line)',
        ring: 'var(--accent)',
        background: 'var(--surface)',
        foreground: 'var(--text)',
        primary: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-fg)',
        },
        secondary: {
          DEFAULT: 'var(--surface-2)',
          foreground: 'var(--text-2)',
        },
        destructive: {
          DEFAULT: 'var(--danger)',
          foreground: '#fff',
        },
        muted: {
          DEFAULT: 'var(--surface-2)',
          foreground: 'var(--muted)',
        },
        accent: {
          DEFAULT: 'var(--accent-soft)',
          foreground: 'var(--text)',
        },
        popover: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text)',
        },
        card: {
          DEFAULT: 'var(--surface)',
          foreground: 'var(--text)',
        },
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius-sm)',
        sm: '6px',
      },
    },
  },
  plugins: [],
}
