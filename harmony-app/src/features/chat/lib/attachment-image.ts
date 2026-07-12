/**
 * Canvas-based attachment preprocessing (DOM boundary) — attachments T1.3
 * part 2. Mirrors `features/auth/lib/avatar-image.ts`.
 *
 * WHY a dedicated module: composer-hook tests mock this file wholesale —
 * canvas and createImageBitmap don't exist in jsdom, and the hook logic
 * shouldn't depend on them being testable.
 *
 * WHY canvas downscale strips EXIF/GPS: re-encoding pixels through a canvas
 * never copies the source file's metadata blocks — orientation, GPS, camera
 * info are all dropped by construction (ticket decision, EXIF strip).
 */

/** Longest edge after downscale — attachments are viewed larger than avatars. */
export const ATTACHMENT_MAX_DIMENSION = 1600

const ATTACHMENT_WEBP_QUALITY = 0.85

export interface PreparedAttachment {
  blob: Blob
  contentType: string
  extension: string
  /** Pixel dimensions for images (undefined for non-images) — drives no-CLS render. */
  width?: number
  height?: number
}

/**
 * Decodes a GIF's intrinsic pixel dimensions without rasterizing it, so the
 * inline render reserves the correct box before the bytes load (kills the
 * 0→full layout jump that shifts every row below during the load window).
 *
 * WHY the bytes stay untouched: `createImageBitmap` only reads the header for
 * dimensions here — the original animated file is uploaded as-is, preserving
 * the animation. WHY the try/catch: a GIF that cannot be decoded (rare, but a
 * corrupt header is possible) still uploads; the render falls back to a
 * reserved min-height box corrected on load.
 */
async function prepareGifForUpload(file: File): Promise<PreparedAttachment> {
  try {
    const bitmap = await createImageBitmap(file)
    const width = bitmap.width
    const height = bitmap.height
    bitmap.close()
    return { blob: file, contentType: 'image/gif', extension: 'gif', width, height }
  } catch {
    return { blob: file, contentType: 'image/gif', extension: 'gif' }
  }
}

const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

const NON_IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
}

/**
 * Extension from the original filename, or a mime fallback, else "bin".
 *
 * WHY sanitize: the extension is interpolated into the Storage object key
 * (`{uid}/{uuid}.{ext}`). A crafted filename like `x./../../evil` must not
 * inject `/` or `.` into the path — strip to alphanumerics before use.
 */
function nonImageExtension(file: File): string {
  const dot = file.name.lastIndexOf('.')
  if (dot !== -1 && dot < file.name.length - 1) {
    const raw = file.name
      .slice(dot + 1)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    if (raw !== '') return raw
  }
  return NON_IMAGE_MIME_TO_EXTENSION[file.type] ?? 'bin'
}

/**
 * Prepares a validated attachment file for upload.
 *
 * - non-images (pdf/zip/video/audio/…): returned untouched, no dimensions.
 * - gif: bytes returned untouched — canvas would rasterize a single frame and
 *   kill the animation (same carve-out as avatars) — but the intrinsic
 *   dimensions are decoded so the render reserves the box before load (no CLS).
 * - other images: downscaled to max 1600px (aspect preserved), re-encoded as
 *   WebP via canvas (EXIF/GPS stripped), dimensions captured from the canvas.
 *
 * @throws Error when the image cannot be decoded or encoded.
 */
export async function prepareAttachmentForUpload(file: File): Promise<PreparedAttachment> {
  if (file.type.startsWith('image/') === false) {
    return { blob: file, contentType: file.type, extension: nonImageExtension(file) }
  }

  if (file.type === 'image/gif') {
    return prepareGifForUpload(file)
  }

  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, ATTACHMENT_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height))
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
      canvas.toBlob(resolve, 'image/webp', ATTACHMENT_WEBP_QUALITY)
    })
    if (blob === null) {
      throw new Error('canvas toBlob produced no image')
    }

    // WHY read the produced type back: Safari/WKWebView (Tauri on macOS) cannot
    // encode WebP — toBlob silently falls back to PNG. Deriving the extension/
    // contentType from the actual blob keeps them truthful.
    const extension = IMAGE_MIME_TO_EXTENSION[blob.type] ?? 'webp'
    return { blob, contentType: blob.type, extension, width, height }
  } finally {
    bitmap.close()
  }
}
