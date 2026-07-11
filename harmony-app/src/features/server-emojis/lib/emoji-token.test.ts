import { describe, expect, it } from 'vitest'
import type { EmojiResponse } from '@/lib/api'
import { buildCustomCategory, buildEmojiMap, parseEmojiToken, toEmojiToken } from './emoji-token'

function emoji(name: string, url = `https://x/server-emojis/s/${name}.png`): EmojiResponse {
  return {
    id: `id-${name}`,
    serverId: 's',
    name,
    url,
    isAnimated: false,
    createdBy: 'u',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('token round-trip', () => {
  it('wraps and parses `:name:`', () => {
    expect(toEmojiToken('fire')).toBe(':fire:')
    expect(parseEmojiToken(':fire:')).toBe('fire')
    expect(parseEmojiToken(toEmojiToken('party_100'))).toBe('party_100')
  })

  it('parses only a whole-string token', () => {
    expect(parseEmojiToken('hi :fire:')).toBeNull()
    expect(parseEmojiToken(':x:')).toBeNull() // too short (1 char)
    expect(parseEmojiToken('👍')).toBeNull()
  })
})

describe('buildEmojiMap', () => {
  it('keys emoji by name for O(1) lookup', () => {
    const map = buildEmojiMap([emoji('fire'), emoji('party')])
    expect(map.get('fire')?.name).toBe('fire')
    expect(map.get('nope')).toBeUndefined()
  })
})

describe('buildCustomCategory', () => {
  it('is empty when the server has no emoji (category hidden)', () => {
    expect(buildCustomCategory([])).toEqual([])
  })

  it('matches the emoji-mart custom-category contract', () => {
    const [category] = buildCustomCategory([emoji('fire')])
    expect(category?.id).toBe('server')
    expect(category?.emojis[0]).toEqual({
      id: 'fire',
      name: 'fire',
      keywords: ['fire'],
      skins: [{ src: 'https://x/server-emojis/s/fire.png' }],
    })
  })
})
