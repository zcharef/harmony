import { describe, expect, it } from 'vitest'
import { resolveDisplayName } from './display-name'

describe('resolveDisplayName', () => {
  it('prefers nickname over displayName and username', () => {
    expect(resolveDisplayName({ nickname: 'Nick', displayName: 'Display', username: 'user' })).toBe(
      'Nick',
    )
  })

  it('falls back to displayName when nickname is absent', () => {
    expect(resolveDisplayName({ displayName: 'Display', username: 'user' })).toBe('Display')
  })

  it('falls back to username when nickname and displayName are absent', () => {
    expect(resolveDisplayName({ username: 'user' })).toBe('user')
  })

  describe('empty / whitespace tiers are treated as absent', () => {
    it('skips an empty-string nickname and falls through to displayName', () => {
      expect(resolveDisplayName({ nickname: '', displayName: 'Display', username: 'user' })).toBe(
        'Display',
      )
    })

    it('skips an empty-string displayName and falls through to username', () => {
      expect(resolveDisplayName({ nickname: '', displayName: '', username: 'user' })).toBe('user')
    })

    it('skips a whitespace-only nickname and falls through', () => {
      expect(
        resolveDisplayName({ nickname: '   ', displayName: 'Display', username: 'user' }),
      ).toBe('Display')
    })

    it('skips a whitespace-only displayName and falls through to username', () => {
      expect(resolveDisplayName({ displayName: '  \t ', username: 'user' })).toBe('user')
    })
  })

  describe('null vs undefined tiers are treated as absent', () => {
    it('skips a null nickname', () => {
      expect(resolveDisplayName({ nickname: null, displayName: 'Display', username: 'user' })).toBe(
        'Display',
      )
    })

    it('skips a null displayName', () => {
      expect(resolveDisplayName({ nickname: null, displayName: null, username: 'user' })).toBe(
        'user',
      )
    })

    it('skips an undefined displayName', () => {
      expect(resolveDisplayName({ displayName: undefined, username: 'user' })).toBe('user')
    })
  })

  it('trims the returned label so stray padding never renders', () => {
    // WHY: display names aren't trimmed on save; a stored " Bob " must render
    // as "Bob", not with padding. Usernames can't contain whitespace.
    expect(resolveDisplayName({ displayName: ' Bob ', username: 'user' })).toBe('Bob')
  })
})
