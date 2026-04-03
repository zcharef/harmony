import { heroui } from '@heroui/react'

export default heroui({
  defaultTheme: 'dark',
  themes: {
    light: {
      colors: {
        primary: { DEFAULT: '#5A4EEA', foreground: '#FFFFFF' },
        secondary: { DEFAULT: '#15D4C8', foreground: '#FFFFFF' },
        success: { DEFAULT: '#10B981' },
        warning: { DEFAULT: '#F0B232' },
        danger: { DEFAULT: '#EF4444' },
        background: '#FFFFFF',
        foreground: '#1A1A24',
      },
    },
    dark: {
      colors: {
        // WHY: Brand purple from logo — primary actions, buttons, links, mentions
        primary: { DEFAULT: '#5A4EEA', foreground: '#FFFFFF' },
        // WHY: Accent cyan from logo — badges, active status, toggle switches
        secondary: { DEFAULT: '#15D4C8', foreground: '#111118' },
        success: { DEFAULT: '#10B981' },
        warning: { DEFAULT: '#F0B232' },
        danger: { DEFAULT: '#EF4444' },
        // WHY: Purple-tinted dark surfaces create depth hierarchy (server < sidebar < chat)
        background: '#272732',
        foreground: '#ececf1',
        content1: '#111118',
        content2: '#1A1A24',
        content3: '#272732',
        default: {
          50: '#3f3f4f',
          100: '#1A1A24',
          200: '#31313D',
          300: '#4e4e63',
          400: '#87879f',
          500: '#b1b1c2',
          600: '#d5d5df',
          700: '#e0e2e6',
          800: '#ececf1',
          900: '#f6f6f9',
          foreground: '#ececf1',
          DEFAULT: '#63637e',
        },
        divider: '#2a2a38',
      },
    },
  },
})
