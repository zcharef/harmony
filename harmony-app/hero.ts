import { heroui } from '@heroui/react'

export default heroui({
  defaultTheme: 'dark',
  themes: {
    light: {
      colors: {
        primary: { DEFAULT: '#5F9EA0', foreground: '#FFFFFF' },
        secondary: { DEFAULT: '#A4C6B8', foreground: '#36454F' },
        success: { DEFAULT: '#10b981' },
        warning: { DEFAULT: '#f59e0b' },
        danger: { DEFAULT: '#ef4444' },
        background: '#FAF9F6',
        foreground: '#36454F',
      },
    },
    dark: {
      colors: {
        primary: { DEFAULT: '#5F9EA0', foreground: '#FFFFFF' },
        secondary: { DEFAULT: '#2B3A42', foreground: '#FAF9F6' },
        success: { DEFAULT: '#10b981' },
        warning: { DEFAULT: '#f59e0b' },
        danger: { DEFAULT: '#ef4444' },
        background: '#1E2D35',
        foreground: '#FAF9F6',
      },
    },
  },
})
