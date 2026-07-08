/**
 * Canvas-based avatar preprocessing (DOM boundary).
 *
 * WHY a dedicated module: hook tests mock this file wholesale — canvas and
 * createImageBitmap don't exist in jsdom, and the hook logic shouldn't
 * depend on them being testable.
 */

/** Longest edge after downscale — plenty for a chat avatar, tiny on the wire. */
export const AVATAR_MAX_DIMENSION = 512

const AVATAR_WEBP_QUALITY = 0.85

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

  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, AVATAR_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
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
      canvas.toBlob(resolve, 'image/webp', AVATAR_WEBP_QUALITY)
    })
    if (blob === null) {
      throw new Error('canvas toBlob produced no image')
    }

    // WHY read the produced type back: Safari/WKWebView (Tauri on macOS)
    // cannot encode WebP — toBlob silently falls back to PNG. Deriving the
    // extension/contentType from the actual blob keeps them truthful.
    const extension = MIME_TO_EXTENSION[blob.type] ?? 'webp'
    return { blob, contentType: blob.type, extension }
  } finally {
    bitmap.close()
  }
}
