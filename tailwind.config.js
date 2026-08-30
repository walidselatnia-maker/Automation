/**
 * Design tokens for the dashboard.
 *
 * `darkMode: 'class'` rather than the media query: the theme is a choice the
 * operator makes and it is remembered in localStorage, so the OS setting is a
 * starting point rather than the answer. layout.ts sets the class on <html>
 * before first paint — see the boot script there.
 *
 * `content` scans the server-rendered templates. They are TypeScript files
 * holding HTML in tagged template literals, which Tailwind reads as plain text
 * like any other file: a class name in a string is found the same way it would
 * be in a .html file. Utilities used inside @apply are emitted regardless, so
 * the component layer in styles/input.css does not depend on this.
 */
export default {
  darkMode: 'class',
  content: ['./src/web/**/*.ts'],
  theme: {
    extend: {
      colors: {
        /* Surfaces. Named by role so a template never has to remember which
           slate belongs to a card and which to the page behind it. */
        page: { DEFAULT: '#f8fafc', dark: '#0d0e12' },
        surface: { DEFAULT: '#ffffff', dark: '#151821' },
        edge: { DEFAULT: '#e2e8f0', dark: '#232736' },
        fill: { DEFAULT: '#f1f5f9', dark: '#1c202c' },

        /* Functional accents. The same three hues in both themes, because a
           status colour that changes meaning with the theme is not a status
           colour. Each carries a soft tint for the backgrounds of badges and
           banners. */
        brand: { DEFAULT: '#e63946', soft: 'rgba(230, 57, 70, 0.12)' },
        emerald: { DEFAULT: '#10b981', soft: 'rgba(16, 185, 129, 0.12)' },
        amber: { DEFAULT: '#f59e0b', soft: 'rgba(245, 158, 11, 0.12)' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
