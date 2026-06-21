/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
        ink: {
          DEFAULT: '#e2e8f0',
          muted: '#94a3b8',
          dim: '#64748b',
        },
        accent: {
          DEFAULT: '#2dd4bf',
          hover: '#14b8a6',
          glow: 'rgba(45, 212, 191, 0.25)',
        },
        cost: {
          DEFAULT: '#fbbf24',
          hover: '#f59e0b',
        },
        danger: {
          DEFAULT: '#f87171',
          hover: '#ef4444',
        },
      },
      fontFamily: {
        sans: ['Sora', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 3px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.04)',
        glow: '0 0 24px rgba(45, 212, 191, 0.12)',
      },
      animation: {
        'fade-in': 'fadeIn 0.25s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
