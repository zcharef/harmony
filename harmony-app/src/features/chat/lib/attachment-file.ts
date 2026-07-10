/**
 * Attachment file helpers (pure, no DOM) — attachments T1.3 part 1.
 *
 * Mirrors the avatar helpers (`features/auth/lib/avatar-file.ts`) for the
 * `attachments` storage bucket. The upload pipeline (composer side) lands in
 * part 2 — these helpers already cover both directions: validation constants
 * for the uploader and render-side URL/mime utilities for message display.
 */

/**
 * Mime types accepted for attachments — mirrors the bucket's
 * `allowed_mime_types` (migration 20260711100000) and the API allowlist
 * (`ALLOWED_ATTACHMENT_MIME` in harmony-api). Keep the three in sync.
 */
export const ALLOWED_ATTACHMENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/pdf',
  'text/plain',
  'application/zip',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
]

/**
 * Hard local cap for any attachment — the bucket's `file_size_limit`
 * (Creator ceiling). Per-plan caps (Free 8MB / Supporter 50MB) are enforced
 * by the API at send time; the client rejects only what the bucket would
 * reject anyway.
 */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024

/** Public URL marker for objects in the attachments bucket. */
const ATTACHMENT_PUBLIC_PATH_MARKER = '/storage/v1/object/public/attachments/'

/**
 * Extracts the storage object path (`{uid}/{file}`) from a Supabase public
 * attachment URL. Returns `null` for external URLs (nothing to clean up).
 * Mirrors `parseAvatarStoragePath`.
 */
export function parseAttachmentStoragePath(attachmentUrl: string): string | null {
  const markerIndex = attachmentUrl.indexOf(ATTACHMENT_PUBLIC_PATH_MARKER)
  if (markerIndex === -1) return null
  const rawPath = attachmentUrl.slice(markerIndex + ATTACHMENT_PUBLIC_PATH_MARKER.length)
  // WHY strip the query string: getPublicUrl can append transform params.
  const path = rawPath.split('?')[0] ?? ''
  return path === '' ? null : path
}

/** True when the mime denotes an image renderable inline via `<img>`. */
export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

/**
 * True when a URL in message CONTENT should auto-embed as an inline image
 * (the T1.4/Klipy path): http(s) URL whose pathname ends in an image
 * extension. Query strings are tolerated (Klipy GIF URLs carry params).
 */
const IMAGE_URL_RE = /\.(png|jpe?g|gif|webp|avif)$/i

export function isEmbeddableImageUrl(url: string): boolean {
  if (!url.startsWith('https://') && !url.startsWith('http://')) return false
  try {
    return IMAGE_URL_RE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/** Filename of an attachment, derived from the URL's last path segment. */
export function attachmentFilename(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/')
    const last = segments[segments.length - 1] ?? ''
    return last === '' ? 'file' : decodeURIComponent(last)
  } catch {
    return 'file'
  }
}

/** Human-readable file size ("824 B", "1.2 KB", "3.4 MB", "1.1 GB"). */
export function humanFileSize(bytes: number): string {
  // WHY clamp: a corrupt/negative size must never render "-500 B".
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes
  let unit: (typeof units)[number] = 'KB'
  for (const next of units) {
    value = value / 1024
    unit = next
    if (value < 1024) break
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`
}
