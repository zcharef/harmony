/**
 * Avatar file validation + storage path helpers (pure, no DOM).
 *
 * WHY separate from avatar-image.ts: these are pure functions unit-tested
 * directly; the canvas transcoding lives in avatar-image.ts so hook tests
 * can mock it at the module edge.
 */

/** Mime types accepted for avatar upload — mirrors the bucket's allowed_mime_types. */
export const ALLOWED_AVATAR_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** Hard cap for any avatar file — mirrors the bucket's file_size_limit. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

/**
 * WHY a lower gif cap: gifs skip the canvas downscale (transcoding would
 * destroy the animation), so the original bytes are stored as-is.
 */
export const AVATAR_GIF_MAX_BYTES = 2 * 1024 * 1024

/**
 * Hard cap for any banner file (roadmap: banner <=2MB). A single flat cap (no
 * separate gif tier) — banners are downscaled to 1024w, and a gif that large is
 * rejected outright rather than stored animated.
 */
export const BANNER_MAX_BYTES = 2 * 1024 * 1024

export type AvatarUploadErrorCode =
  | 'invalidType'
  | 'tooLarge'
  | 'gifTooLarge'
  | 'processingFailed'
  | 'uploadFailed'

/**
 * Typed error for the avatar upload pipeline so the settings modal can map
 * each failure to a specific i18n message (inline feedback, ADR-045).
 */
export class AvatarUploadError extends Error {
  readonly code: AvatarUploadErrorCode

  constructor(code: AvatarUploadErrorCode) {
    super(`avatar_upload_${code}`)
    this.name = 'AvatarUploadError'
    this.code = code
  }
}

/**
 * Validates an avatar candidate file. Returns the error code, or `null`
 * when the file is acceptable.
 */
export function validateAvatarFile(file: File): AvatarUploadErrorCode | null {
  if (ALLOWED_AVATAR_TYPES.includes(file.type) === false) return 'invalidType'
  if (file.size > AVATAR_MAX_BYTES) return 'tooLarge'
  if (file.type === 'image/gif' && file.size > AVATAR_GIF_MAX_BYTES) return 'gifTooLarge'
  return null
}

/**
 * Validates a banner candidate file. Same mime allowlist as avatars, single
 * 2MB cap. Returns the error code, or `null` when the file is acceptable.
 */
export function validateBannerFile(file: File): AvatarUploadErrorCode | null {
  if (ALLOWED_AVATAR_TYPES.includes(file.type) === false) return 'invalidType'
  if (file.size > BANNER_MAX_BYTES) return 'tooLarge'
  return null
}

/** Public URL marker for objects in the avatars bucket. */
const AVATAR_PUBLIC_PATH_MARKER = '/storage/v1/object/public/avatars/'

/**
 * Extracts the storage object path (`{uid}/{file}`) from a Supabase public
 * avatar URL. Returns `null` for external URLs (nothing to clean up).
 */
export function parseAvatarStoragePath(avatarUrl: string): string | null {
  const markerIndex = avatarUrl.indexOf(AVATAR_PUBLIC_PATH_MARKER)
  if (markerIndex === -1) return null
  const rawPath = avatarUrl.slice(markerIndex + AVATAR_PUBLIC_PATH_MARKER.length)
  // WHY strip the query string: getPublicUrl can append transform params.
  const path = rawPath.split('?')[0] ?? ''
  return path === '' ? null : path
}
