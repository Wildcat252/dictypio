/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        abyss: {
          950: '#030712',
          900: '#060d1a',
          850: '#0a1426',
          800: '#0e1c36',
          750: '#132547',
          700: '#1a325e',
          600: '#24457d',
        },
        ocean: {
          glow: '#00f2fe',
          cyan: '#06b6d4',
          sky: '#38bdf8',
          teal: '#14b8a6',
          emerald: '#10b981',
        },
      },
      boxShadow: {
        'glow-cyan': '0 0 20px -3px rgba(6, 182, 212, 0.45), 0 0 8px -1px rgba(6, 182, 212, 0.3)',
        'glow-cyan-lg': '0 0 35px -5px rgba(6, 182, 212, 0.55), 0 0 15px -2px rgba(6, 182, 212, 0.4)',
        'glow-teal': '0 0 20px -3px rgba(20, 184, 166, 0.45), 0 0 8px -1px rgba(20, 184, 166, 0.3)',
        'glow-emerald': '0 0 20px -3px rgba(16, 185, 129, 0.5), 0 0 8px -1px rgba(16, 185, 129, 0.35)',
        'glow-amber': '0 0 20px -3px rgba(245, 158, 11, 0.5), 0 0 8px -1px rgba(245, 158, 11, 0.35)',
        'glow-rose': '0 0 20px -3px rgba(244, 63, 94, 0.5), 0 0 8px -1px rgba(244, 63, 94, 0.35)',
        'glass-card': '0 8px 32px 0 rgba(0, 0, 0, 0.4), inset 0 1px 0 0 rgba(255, 255, 255, 0.08)',
        'glass-glow': '0 8px 32px 0 rgba(0, 0, 0, 0.5), 0 0 20px -4px rgba(6, 182, 212, 0.2), inset 0 1px 0 0 rgba(255, 255, 255, 0.1)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow-pulse': 'glowPulse 2.5s ease-in-out infinite alternate',
      },
      keyframes: {
        glowPulse: {
          '0%': { boxShadow: '0 0 10px rgba(6, 182, 212, 0.3), inset 0 0 5px rgba(6, 182, 212, 0.1)' },
          '100%': { boxShadow: '0 0 25px rgba(6, 182, 212, 0.6), inset 0 0 12px rgba(6, 182, 212, 0.2)' },
        },
      },
    },
  },
  plugins: [],
}
