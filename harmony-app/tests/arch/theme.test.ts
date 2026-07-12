import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { darkColors, lightColors } from '../../hero-tokens'

/**
 * Theme token regression guard — the repo's first color/type test.
 *
 * This is deliberately narrow: it pins the two token-level decisions from the
 * design-system pass so an accidental revert fails CI rather than silently
 * shipping the illegible purple or the old cramped type scale. It is NOT a
 * substitute for the manual visual pass, which remains the real gate.
 */

const CHAT_BG_DARK = '#272732' // bg-background (dark) — the chat surface
const WHITE = '#FFFFFF' // light-theme background
const OLD_MENTION_PURPLE = '#5A4EEA' // primary — the value that failed AA as text

/** Relative luminance per WCAG 2.1 (sRGB → linear). */
function luminance(hex: string): number {
  const n = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => {
    const c = Number.parseInt(n.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const [r, g, b] = channels as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio between two hex colors (1..21). */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('accent color token', () => {
  it('resolves to the intended hex in each theme', () => {
    expect(darkColors.accent.DEFAULT).toBe('#9B8CFF')
    expect(lightColors.accent.DEFAULT).toBe('#4F46E5')
  })

  it('leaves the brand primary untouched (no rebrand)', () => {
    expect(darkColors.primary.DEFAULT).toBe('#5A4EEA')
    expect(lightColors.primary.DEFAULT).toBe('#5A4EEA')
  })

  it('reads legibly as text on the dark chat surface (WCAG AA, >= 4.5:1)', () => {
    expect(contrast(darkColors.accent.DEFAULT, CHAT_BG_DARK)).toBeGreaterThanOrEqual(4.5)
  })

  it('reads legibly as text on the light background (WCAG AA, >= 4.5:1)', () => {
    expect(contrast(lightColors.accent.DEFAULT, WHITE)).toBeGreaterThanOrEqual(4.5)
  })

  it('documents WHY the accent exists: the old primary purple failed AA as text', () => {
    // Regression anchor — if someone repoints mentions back to `primary`, this
    // records that it is illegible on the chat surface (~2.6:1).
    expect(contrast(OLD_MENTION_PURPLE, CHAT_BG_DARK)).toBeLessThan(4.5)
  })
})

describe('modular type scale', () => {
  const css = readFileSync(path.resolve(__dirname, '../../src/App.css'), 'utf8')

  const tokenValue = (name: string): string => {
    const match = css.match(new RegExp(`${name}:\\s*([^;]+);`))
    if (match === null) throw new Error(`missing @theme token ${name}`)
    return match[1].trim()
  }

  it('pins the base and body sizes so the scale cannot silently drift', () => {
    expect(tokenValue('--text-base')).toBe('1rem') // 16px true base
    expect(tokenValue('--text-sm')).toBe('1rem') // 16px body (was 14)
    expect(tokenValue('--text-xs')).toBe('0.8125rem') // 13px metadata (was 12)
  })

  it('keeps the upper ladder on the ~1.125 modular steps', () => {
    expect(tokenValue('--text-lg')).toBe('1.125rem') // 18px
    expect(tokenValue('--text-xl')).toBe('1.25rem') // 20px
    expect(tokenValue('--text-2xl')).toBe('1.5rem') // 24px
    expect(tokenValue('--text-3xl')).toBe('1.875rem') // 30px
  })

  it('pairs every size with an explicit line-height (Tailwind v4 requirement)', () => {
    for (const size of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']) {
      expect(css).toContain(`--text-${size}--line-height:`)
    }
  })
})
