/**
 * Canvas-based avatar preprocessing (DOM boundary).
 *
 * WHY a dedicated module: hook tests mock this file wholesale — canvas and
 * createImageBitmap don't exist in jsdom, and the hook logic shouldn't
 * depend on them being testable.
 */

/** Longest edge after downscale — plenty for a chat avatar, tiny on the wire. */
export const AVATAR_MAX_DIMENSION = 512

/** Banner width cap — crisp at popover scale, small on the wire (ticket §5.5). */
export const BANNER_MAX_WIDTH = 1024

const WEBP_QUALITY = 0.85

export interface PreparedAvatar {
  blob: Blob
  contentType: string
  extension: string
}

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
}

/**
 * Downscales a validated image to a canvas-derived WebP blob using the
 * caller's scale rule, then reads the produced type back.
 *
 * WHY read the produced type back: Safari/WKWebView (Tauri on macOS) cannot
 * encode WebP — toBlob silently falls back to PNG. Deriving the
 * extension/contentType from the actual blob keeps them truthful.
 *
 * @param computeScale maps the source dimensions to a downscale factor (<=1).
 * @throws Error when the image cannot be decoded or encoded.
 */
async function downscaleToWebp(
  file: File,
  computeScale: (width: number, height: number) => number,
): Promise<PreparedAvatar> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = computeScale(bitmap.width, bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) {
      throw new Error('canvas 2d context unavailable')
    }
    context.drawImage(bitmap, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY)
    })
    if (blob === null) {
      throw new Error('canvas toBlob produced no image')
    }

    const extension = MIME_TO_EXTENSION[blob.type] ?? 'webp'
    return { blob, contentType: blob.type, extension }
  } finally {
    bitmap.close()
  }
}

/**
 * Prepares a validated avatar file for upload.
 *
 * - gif: returned untouched — canvas rasterizes a single frame, which would
 *   destroy the animation. Size is already capped at 2MB by validation.
 * - everything else: downscaled to max 512px (aspect preserved) and encoded
 *   as WebP at ~0.85 quality via canvas.
 *
 * @throws Error when the image cannot be decoded or encoded.
 */
export async function prepareAvatarForUpload(file: File): Promise<PreparedAvatar> {
  if (file.type === 'image/gif') {
    return { blob: file, contentType: 'image/gif', extension: 'gif' }
  }
  // Longest-edge bound: shrink so max(w, h) <= 512.
  return downscaleToWebp(file, (w, h) => Math.min(1, AVATAR_MAX_DIMENSION / Math.max(w, h)))
}

/**
 * Prepares a validated banner file for upload.
 *
 * - gif: returned untouched (same reason as avatars).
 * - everything else: width-bound downscale to 1024w (aspect preserved), WebP.
 *
 * @throws Error when the image cannot be decoded or encoded.
 */
export async function prepareBannerForUpload(file: File): Promise<PreparedAvatar> {
  if (file.type === 'image/gif') {
    return { blob: file, contentType: 'image/gif', extension: 'gif' }
  }
  // Width bound: shrink so width <= 1024 (banners are wide, height follows).
  return downscaleToWebp(file, (w) => Math.min(1, BANNER_MAX_WIDTH / w))
}
