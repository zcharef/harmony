import { getInviteCodeFromPath } from './invite-path'

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
