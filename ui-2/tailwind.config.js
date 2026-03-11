/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: '1rem',
        sm: '1.5rem',
        lg: '2rem',
      },
    },
    extend: {
      colors: {
        'dark-bg-primary': '#0f1724',
        'dark-bg-secondary': '#0b1220',
        'dark-surface': '#0f1724', // Unified dark background
        'dark-surface-alt': '#0f1724', // Unified dark background (alt also maps to main)
        'dark-border': '#2d3e52',
        'dark-text': '#e6edf3',
        'dark-text-muted': '#9aa6b2',
        'dark-accent-blue': '#60a5fa',
        'dark-accent-purple': '#a78bfa',
        'dark-accent-pink': '#f472b6',
      },
      backgroundImage: {},
      transitionDuration: {
        120: '120ms',
        180: '180ms',
      },
      keyframes: {
        slideFade: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'slide-fade-fast': 'slideFade 120ms ease-out both',
        'slide-fade': 'slideFade 180ms ease-out both',
      },
    },
  },
  plugins: [],
};