import { heroui } from '@heroui/react'
import { darkColors, lightColors } from './hero-tokens'

export default heroui({
  defaultTheme: 'dark',
  themes: {
    light: { colors: lightColors },
    dark: { colors: darkColors },
  },
})
