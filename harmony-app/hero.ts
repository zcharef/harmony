import { heroui } from '@heroui/react'

export default heroui({
  defaultTheme: 'dark',
  themes: {
    light: {
      colors: {
        primary: { DEFAULT: '#5865F2', foreground: '#FFFFFF' },
        secondary: { DEFAULT: '#4E5058', foreground: '#FFFFFF' },
        success: { DEFAULT: '#23A559' },
        warning: { DEFAULT: '#F0B232' },
        danger: { DEFAULT: '#DA373C' },
        background: '#FFFFFF',
        foreground: '#313338',
      },
    },
    dark: {
      colors: {
        primary: { DEFAULT: '#5F9EA0', foreground: '#FFFFFF' },
        secondary: { DEFAULT: '#4E5058', foreground: '#F2F3F5' },
        success: { DEFAULT: '#23A559' },
        warning: { DEFAULT: '#F0B232' },
        danger: { DEFAULT: '#DA373C' },
        background: '#2F3136',
        foreground: '#F2F3F5',
        content1: '#292B2F',
        content2: '#222426',
        content3: '#1E1F21',
        default: {
          50: '#3E4046',
          100: '#36393F',
          200: '#33363B',
          300: '#2D2F34',
          400: '#949BA4',
          500: '#B5BAC1',
          600: '#DBDEE1',
          700: '#E0E1E5',
          800: '#EBEBED',
          900: '#F2F3F5',
          foreground: '#F2F3F5',
          DEFAULT: '#4E5058',
        },
        divider: '#3E4046',
      },
    },
  },
})
