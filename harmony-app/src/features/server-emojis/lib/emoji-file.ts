/**
 * Custom-emoji file validation + storage path helpers (pure, no DOM).
 *
 * Mirrors `features/auth/lib/avatar-file.ts`: a typed error the settings tab
 * maps to a specific inline i18n message (ADR-045). Emoji are NOT downscaled —
 * they are small and GIFs must keep their animation.
 */

/** Mime types accepted for a custom emoji — mirrors the bucket's allowlist. */
const ALLOWED_EMOJI_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** Hard byte ceiling — the Creator-tier / bucket max (1 MB). */
export const EMOJI_MAX_BYTES = 1024 * 1024

/** Public URL marker for objects in the server-emojis bucket. */
export const EMOJI_PUBLIC_PATH_MARKER = '/storage/v1/object/public/server-emojis/'

export type EmojiUploadErrorCode =
  | 'invalidType'
  | 'tooLarge'
  | 'animatedNotAllowed'
  | 'limitReached'
  | 'uploadFailed'

/**
 * Typed error for the emoji upload pipeline so the settings tab can map each
 * failure to a specific i18n message (inline feedback, ADR-045).
 */
export class EmojiUploadError extends Error {
  readonly code: EmojiUploadErrorCode

  constructor(code: EmojiUploadErrorCode) {
    super(`emoji_upload_${code}`)
    this.name = 'EmojiUploadError'
    this.code = code
  }
}

/** Per-plan constraints the caller derives from the server's plan. */
export interface EmojiFileLimits {
  /** Max bytes for this plan (512 KB Supporter, 1 MB Creator). */
  maxBytes: number
  /** Whether animated (GIF) emoji are allowed on this plan. */
  animatedAllowed: boolean
}

/**
 * Validates a custom-emoji candidate file against the plan limits. Returns the
 * error code, or `null` when the file is acceptable.
 */
export function validateEmojiFile(
  file: File,
  limits: EmojiFileLimits,
): EmojiUploadErrorCode | null {
  if (ALLOWED_EMOJI_TYPES.includes(file.type) === false) return 'invalidType'
  // WHY min(planCap, hard ceiling): never exceed the bucket's 1 MB even if a
  // caller passes a larger cap by mistake.
  const cap = Math.min(limits.maxBytes, EMOJI_MAX_BYTES)
  if (file.size > cap) return 'tooLarge'
  if (file.type === 'image/gif' && limits.animatedAllowed === false) return 'animatedNotAllowed'
  return null
}

/** Whether a candidate file is an animated (GIF) emoji. */
export function isAnimatedEmoji(file: File): boolean {
  return file.type === 'image/gif'
}

/** File extension for the object path, derived from the mime type. */
export function emojiExtensionFor(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return 'png'
  }
}

/**
 * Extracts the storage object path (`{serverId}/{file}`) from a Supabase public
 * emoji URL. Returns `null` for URLs outside the emoji bucket (nothing to clean).
 */
export function parseEmojiStoragePath(url: string): string | null {
  const markerIndex = url.indexOf(EMOJI_PUBLIC_PATH_MARKER)
  if (markerIndex === -1) return null
  const rawPath = url.slice(markerIndex + EMOJI_PUBLIC_PATH_MARKER.length)
  const path = rawPath.split('?')[0] ?? ''
  return path === '' ? null : path
}
