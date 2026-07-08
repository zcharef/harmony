import {
  AVATAR_GIF_MAX_BYTES,
  AVATAR_MAX_BYTES,
  AvatarUploadError,
  parseAvatarStoragePath,
  validateAvatarFile,
} from './avatar-file'

function makeFile(sizeBytes: number, type: string, name = 'avatar'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

describe('validateAvatarFile', () => {
  it('accepts png, jpeg, webp and gif within limits', () => {
    expect(validateAvatarFile(makeFile(1024, 'image/png'))).toBeNull()
    expect(validateAvatarFile(makeFile(1024, 'image/jpeg'))).toBeNull()
    expect(validateAvatarFile(makeFile(1024, 'image/webp'))).toBeNull()
    expect(validateAvatarFile(makeFile(1024, 'image/gif'))).toBeNull()
  })

  it('rejects disallowed mime types', () => {
    expect(validateAvatarFile(makeFile(1024, 'image/svg+xml'))).toBe('invalidType')
    expect(validateAvatarFile(makeFile(1024, 'text/plain'))).toBe('invalidType')
    expect(validateAvatarFile(makeFile(1024, ''))).toBe('invalidType')
  })

  it('rejects files over 5MB', () => {
    expect(validateAvatarFile(makeFile(AVATAR_MAX_BYTES + 1, 'image/png'))).toBe('tooLarge')
  })

  it('accepts a file at exactly 5MB', () => {
    expect(validateAvatarFile(makeFile(AVATAR_MAX_BYTES, 'image/png'))).toBeNull()
  })

  it('rejects gifs over 2MB (transcode is skipped for gifs)', () => {
    expect(validateAvatarFile(makeFile(AVATAR_GIF_MAX_BYTES + 1, 'image/gif'))).toBe('gifTooLarge')
  })

  it('accepts a gif at exactly 2MB', () => {
    expect(validateAvatarFile(makeFile(AVATAR_GIF_MAX_BYTES, 'image/gif'))).toBeNull()
  })
})

describe('parseAvatarStoragePath', () => {
  it('extracts the object path from a Supabase public URL', () => {
    expect(
      parseAvatarStoragePath(
        'http://127.0.0.1:64321/storage/v1/object/public/avatars/user-1/abc.webp',
      ),
    ).toBe('user-1/abc.webp')
  })

  it('strips query strings', () => {
    expect(
      parseAvatarStoragePath(
        'https://proj.supabase.co/storage/v1/object/public/avatars/user-1/abc.webp?width=64',
      ),
    ).toBe('user-1/abc.webp')
  })

  it('returns null for external URLs (nothing to clean up)', () => {
    expect(parseAvatarStoragePath('https://example.com/avatar.png')).toBeNull()
  })

  it('returns null for a marker with no object path', () => {
    expect(
      parseAvatarStoragePath('https://proj.supabase.co/storage/v1/object/public/avatars/'),
    ).toBeNull()
  })
})

describe('AvatarUploadError', () => {
  it('carries the error code for i18n mapping', () => {
    const error = new AvatarUploadError('tooLarge')
    expect(error.code).toBe('tooLarge')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AvatarUploadError')
  })
})
