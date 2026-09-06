/** @type {import('tailwindcss').Config} */

// Every palette color resolves through a CSS variable holding a
// space-separated RGB triplet, so `data-theme` on <html> reskins the whole app
// without touching a single utility class — and `/60`-style opacity modifiers
// keep working via <alpha-value>. Values live in src/index.css.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`

const scale = (prefix, steps) =>
  Object.fromEntries(steps.map((step) => [step, v(`${prefix}-${step}`)]))

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        abyss: scale('abyss', [950, 900, 850, 800, 750, 700, 600]),
        ocean: {
          glow: v('ocean-glow'),
          cyan: v('ocean-cyan'),
          sky: v('ocean-sky'),
          teal: v('ocean-teal'),
          emerald: v('ocean-emerald'),
        },
        // Overrides of the Tailwind built-ins the components already use, so
        // text and accents flip with the theme too.
        slate: scale('slate', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        cyan: scale('cyan', [100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        // Secondary accents (gradients) and the status colors. Their light
        // steps carry text on a dark ground, so on a light ground they have to
        // flip to the deep steps — hence tokens rather than the built-ins.
        ...Object.fromEntries(
          ['teal', 'sky', 'rose', 'emerald', 'amber'].map((name) => [
            name,
            scale(name, [100, 200, 300, 400, 500, 600, 900, 950]),
          ])
        ),
        // Neutral overlay ink: white on dark grounds, near-black on light ones.
        ink: v('ink'),
      },
      fontFamily: {
        sans: ['var(--font-ui)'],
        // `font-typing` is the user's dictation face; `font-mono` stays a plain
        // monospace so numeric labels don't follow the typing choice.
        typing: ['var(--font-typing)'],
      },
      boxShadow: {
        'glow-cyan': 'var(--shadow-glow)',
        'glow-cyan-lg': 'var(--shadow-glow-lg)',
        'glow-teal': 'var(--shadow-glow-teal)',
        'glass-card': 'var(--shadow-card)',
        'glass-glow': 'var(--shadow-card-glow)',
        // Semantic status glows read correctly on either ground.
        'glow-emerald': '0 0 20px -3px rgba(16, 185, 129, 0.5), 0 0 8px -1px rgba(16, 185, 129, 0.35)',
        'glow-amber': '0 0 20px -3px rgba(245, 158, 11, 0.5), 0 0 8px -1px rgba(245, 158, 11, 0.35)',
        'glow-rose': '0 0 20px -3px rgba(244, 63, 94, 0.5), 0 0 8px -1px rgba(244, 63, 94, 0.35)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow-pulse': 'glowPulse 2.5s ease-in-out infinite alternate',
      },
      keyframes: {
        glowPulse: {
          '0%': { boxShadow: '0 0 10px rgb(var(--ocean-cyan) / 0.3), inset 0 0 5px rgb(var(--ocean-cyan) / 0.1)' },
          '100%': { boxShadow: '0 0 25px rgb(var(--ocean-cyan) / 0.6), inset 0 0 12px rgb(var(--ocean-cyan) / 0.2)' },
        },
      },
    },
  },
  plugins: [],
}
