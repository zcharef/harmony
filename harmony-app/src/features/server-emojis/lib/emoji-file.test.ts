import { describe, expect, it } from 'vitest'
import {
  emojiExtensionFor,
  isAnimatedEmoji,
  parseEmojiStoragePath,
  validateEmojiFile,
} from './emoji-file'

function file(type: string, size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type })
  return new File([blob], `emoji.${type.split('/')[1]}`, { type })
}

const CREATOR = { maxBytes: 1024 * 1024, animatedAllowed: true }
const SUPPORTER = { maxBytes: 512 * 1024, animatedAllowed: true }
const FREE = { maxBytes: 0, animatedAllowed: false }

describe('validateEmojiFile', () => {
  it('accepts a small png on any allowing plan', () => {
    expect(validateEmojiFile(file('image/png', 1000), CREATOR)).toBeNull()
  })

  it('rejects a disallowed mime type', () => {
    expect(validateEmojiFile(file('image/svg+xml', 100), CREATOR)).toBe('invalidType')
  })

  it('rejects a file over the plan cap', () => {
    expect(validateEmojiFile(file('image/png', 600 * 1024), SUPPORTER)).toBe('tooLarge')
  })

  it('never exceeds the 1 MB hard ceiling even with a larger cap', () => {
    const overCeiling = { maxBytes: 10 * 1024 * 1024, animatedAllowed: true }
    expect(validateEmojiFile(file('image/png', 2 * 1024 * 1024), overCeiling)).toBe('tooLarge')
  })

  it('rejects an animated gif when the plan disallows animation', () => {
    // WHY size 0: on Free the byte cap is 0, but the animated gate is what we
    // assert here — a tiny gif still trips animatedNotAllowed.
    expect(validateEmojiFile(file('image/gif', 0), FREE)).toBe('animatedNotAllowed')
  })

  it('accepts an animated gif when the plan allows animation', () => {
    expect(validateEmojiFile(file('image/gif', 1000), CREATOR)).toBeNull()
  })
})

describe('isAnimatedEmoji', () => {
  it('is true only for gifs', () => {
    expect(isAnimatedEmoji(file('image/gif', 10))).toBe(true)
    expect(isAnimatedEmoji(file('image/png', 10))).toBe(false)
  })
})

describe('emojiExtensionFor', () => {
  it('maps mime types to extensions', () => {
    expect(emojiExtensionFor('image/png')).toBe('png')
    expect(emojiExtensionFor('image/jpeg')).toBe('jpg')
    expect(emojiExtensionFor('image/webp')).toBe('webp')
    expect(emojiExtensionFor('image/gif')).toBe('gif')
  })
})

describe('parseEmojiStoragePath', () => {
  it('extracts the object path from a bucket url', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/server-emojis/srv/abc.png'
    expect(parseEmojiStoragePath(url)).toBe('srv/abc.png')
  })

  it('strips a query string', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/server-emojis/srv/abc.png?t=1'
    expect(parseEmojiStoragePath(url)).toBe('srv/abc.png')
  })

  it('returns null for an off-bucket url', () => {
    expect(parseEmojiStoragePath('https://evil.example/x.png')).toBeNull()
  })
})
