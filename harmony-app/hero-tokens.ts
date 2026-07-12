/**
 * Semantic color SSoT for the HeroUI theme.
 *
 * WHY a standalone data module: these palettes are consumed by `hero.ts` (which
 * feeds them to the HeroUI Tailwind plugin) AND asserted directly by the theme
 * test. Keeping them as plain data — no React, no plugin call — lets the test
 * import the exact values in a Node environment without loading @heroui/react.
 */

export const lightColors = {
  primary: { DEFAULT: '#5A4EEA', foreground: '#FFFFFF' },
  // WHY: Dedicated legibility accent for @mentions + identity badges — the brand
  // purple (#5A4EEA) fails WCAG AA as text on the dark chat surface. A darker
  // indigo keeps the hue family while passing AA on white (#4F46E5 ≈ 6.3:1).
  accent: { DEFAULT: '#4F46E5', foreground: '#FFFFFF' },
  secondary: { DEFAULT: '#15D4C8', foreground: '#FFFFFF' },
  success: { DEFAULT: '#10B981' },
  warning: { DEFAULT: '#F0B232' },
  danger: { DEFAULT: '#EF4444' },
  background: '#FFFFFF',
  foreground: '#1A1A24',
} as const

export const darkColors = {
  // WHY: Brand purple from logo — primary actions, buttons, links.
  primary: { DEFAULT: '#5A4EEA', foreground: '#FFFFFF' },
  // WHY: Dedicated legibility accent for @mentions + identity badges. #5A4EEA as
  // TEXT on the chat background (#272732) measures ~2.6:1 and fails WCAG AA; this
  // lighter tint reads ~5.3:1 there and ~6.8:1 on content1 (#111118) while
  // leaving `primary` (and every button) untouched.
  accent: { DEFAULT: '#9B8CFF', foreground: '#111118' },
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
} as const
