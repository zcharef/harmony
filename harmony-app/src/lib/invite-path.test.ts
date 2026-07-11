import { getInviteCodeFromInput, getInviteCodeFromPath } from './invite-path'

describe('getInviteCodeFromInput', () => {
  it('keeps a raw invite code unchanged', () => {
    expect(getInviteCodeFromInput('abc123XY')).toBe('abc123XY')
  })

  it('extracts the invite code when a user pastes a Harmony invite URL', () => {
    expect(getInviteCodeFromInput('https://joinharmony.app/invite/abc123XY')).toBe('abc123XY')
    expect(getInviteCodeFromInput('https://app.joinharmony.app/invite/abc123XY/')).toBe('abc123XY')
  })

  it('trims whitespace around pasted invite codes or URLs', () => {
    expect(getInviteCodeFromInput('  abc123XY  ')).toBe('abc123XY')
    expect(getInviteCodeFromInput('\nhttps://joinharmony.app/invite/abc123XY\t')).toBe('abc123XY')
  })

  it('returns invalid input unchanged so existing validation/API errors still surface', () => {
    expect(getInviteCodeFromInput('https://example.com/not-an-invite')).toBe(
      'https://example.com/not-an-invite',
    )
  })
})

describe('getInviteCodeFromPath', () => {
  it('extracts a valid alphanumeric code', () => {
    expect(getInviteCodeFromPath('/invite/abc123XY')).toBe('abc123XY')
  })

  it('accepts a trailing slash', () => {
    expect(getInviteCodeFromPath('/invite/abc123XY/')).toBe('abc123XY')
  })

  it('accepts single-char and 32-char codes (API bounds)', () => {
    expect(getInviteCodeFromPath('/invite/a')).toBe('a')
    expect(getInviteCodeFromPath(`/invite/${'a'.repeat(32)}`)).toBe('a'.repeat(32))
  })

  it('rejects codes longer than 32 chars', () => {
    expect(getInviteCodeFromPath(`/invite/${'a'.repeat(33)}`)).toBeNull()
  })

  it('rejects non-alphanumeric codes', () => {
    expect(getInviteCodeFromPath('/invite/abc-123')).toBeNull()
    expect(getInviteCodeFromPath('/invite/abc%20123')).toBeNull()
    expect(getInviteCodeFromPath('/invite/abc.123')).toBeNull()
  })

  it('rejects non-invite paths', () => {
    expect(getInviteCodeFromPath('/')).toBeNull()
    expect(getInviteCodeFromPath('/invite')).toBeNull()
    expect(getInviteCodeFromPath('/invite/')).toBeNull()
    expect(getInviteCodeFromPath('/servers/abc')).toBeNull()
    expect(getInviteCodeFromPath('/invite/abc/extra')).toBeNull()
  })
})
