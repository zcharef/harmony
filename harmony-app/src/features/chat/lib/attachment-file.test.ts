import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ATTACHMENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  AttachmentUploadError,
  attachmentFilename,
  humanFileSize,
  isEmbeddableImageUrl,
  isImageMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  parseAttachmentStoragePath,
  validateAttachmentFile,
} from './attachment-file'

function makeFile(sizeBytes: number, type: string, name = 'f.png'): File {
  return new File([new Uint8Array(Math.min(sizeBytes, 8))], name, { type })
}

/** WHY size override: allocating 100MB in a test is wasteful — stub .size. */
function makeSizedFile(sizeBytes: number, type: string): File {
  const file = new File([new Uint8Array(8)], 'big.png', { type })
  Object.defineProperty(file, 'size', { value: sizeBytes })
  return file
}

const BUCKET_URL =
  'https://xyz.supabase.co/storage/v1/object/public/attachments/user-uuid/file-uuid.webp'

describe('parseAttachmentStoragePath', () => {
  it('extracts the {uid}/{file} path from a bucket public URL', () => {
    expect(parseAttachmentStoragePath(BUCKET_URL)).toBe('user-uuid/file-uuid.webp')
  })

  it('strips query params appended by getPublicUrl transforms', () => {
    expect(parseAttachmentStoragePath(`${BUCKET_URL}?width=100`)).toBe('user-uuid/file-uuid.webp')
  })

  it('returns null for external URLs (nothing to clean up)', () => {
    expect(parseAttachmentStoragePath('https://example.com/image.png')).toBeNull()
  })

  it('returns null for avatars-bucket URLs (different bucket)', () => {
    expect(
      parseAttachmentStoragePath(
        'https://xyz.supabase.co/storage/v1/object/public/avatars/uid/f.webp',
      ),
    ).toBeNull()
  })

  it('returns null when the marker has no trailing path', () => {
    expect(
      parseAttachmentStoragePath('https://xyz.supabase.co/storage/v1/object/public/attachments/'),
    ).toBeNull()
  })
})

describe('isImageMime', () => {
  it('accepts image mimes and rejects everything else', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/webp')).toBe(true)
    expect(isImageMime('application/pdf')).toBe(false)
    expect(isImageMime('video/mp4')).toBe(false)
    expect(isImageMime('')).toBe(false)
  })
})

describe('isEmbeddableImageUrl', () => {
  it('accepts http(s) URLs whose pathname ends in an image extension', () => {
    expect(isEmbeddableImageUrl('https://example.com/foo.png')).toBe(true)
    expect(isEmbeddableImageUrl('https://example.com/foo.JPEG')).toBe(true)
    expect(isEmbeddableImageUrl('http://cdn.example.com/a/b/c.gif')).toBe(true)
  })

  it('tolerates query strings (Klipy GIF URLs carry params)', () => {
    expect(isEmbeddableImageUrl('https://klipy.example.com/x.gif?key=abc')).toBe(true)
  })

  it('rejects non-image, non-http and malformed URLs', () => {
    expect(isEmbeddableImageUrl('https://example.com/doc.pdf')).toBe(false)
    expect(isEmbeddableImageUrl('https://example.com/page')).toBe(false)
    // Extension hidden in the query only — pathname decides.
    expect(isEmbeddableImageUrl('https://example.com/page?x=.png')).toBe(false)
    expect(isEmbeddableImageUrl('ftp://example.com/foo.png')).toBe(false)
    expect(isEmbeddableImageUrl('javascript:alert(1)//x.png')).toBe(false)
    expect(isEmbeddableImageUrl('not a url .png')).toBe(false)
  })
})

describe('attachmentFilename', () => {
  it('returns the decoded last path segment', () => {
    expect(attachmentFilename(BUCKET_URL)).toBe('file-uuid.webp')
    expect(attachmentFilename('https://x.co/a/My%20Report.pdf')).toBe('My Report.pdf')
  })

  it('falls back to "file" for pathless or malformed URLs', () => {
    expect(attachmentFilename('https://x.co/')).toBe('file')
    expect(attachmentFilename('not-a-url')).toBe('file')
  })
})

describe('humanFileSize', () => {
  it('formats bytes across unit boundaries', () => {
    expect(humanFileSize(824)).toBe('824 B')
    expect(humanFileSize(1024)).toBe('1 KB')
    expect(humanFileSize(1229)).toBe('1.2 KB')
    expect(humanFileSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(humanFileSize(104857600)).toBe('100 MB')
    expect(humanFileSize(1.1 * 1024 * 1024 * 1024)).toBe('1.1 GB')
  })
})

describe('validateAttachmentFile', () => {
  it('accepts an allowlisted image under the hard cap', () => {
    expect(validateAttachmentFile(makeFile(1024, 'image/png'))).toBeNull()
  })

  it('accepts an allowlisted non-image (pdf)', () => {
    expect(validateAttachmentFile(makeFile(1024, 'application/pdf', 'r.pdf'))).toBeNull()
  })

  it('rejects a non-allowlisted mime as invalidType', () => {
    expect(validateAttachmentFile(makeFile(1024, 'image/svg+xml', 'x.svg'))).toBe('invalidType')
  })

  it('rejects a file over the 100MB ceiling as tooLarge', () => {
    expect(validateAttachmentFile(makeSizedFile(ATTACHMENT_MAX_BYTES + 1, 'image/png'))).toBe(
      'tooLarge',
    )
  })
})

describe('AttachmentUploadError', () => {
  it('carries the code for inline i18n mapping', () => {
    const err = new AttachmentUploadError('processingFailed')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('processingFailed')
    expect(err.name).toBe('AttachmentUploadError')
  })
})

describe('constants', () => {
  it('mirrors the bucket hard cap (100 MB) and allowlist shape', () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(104857600)
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(10)
    // Every entry the render path special-cases is allowlisted.
    for (const mime of ['image/png', 'image/gif', 'application/pdf', 'application/zip']) {
      expect(ALLOWED_ATTACHMENT_TYPES).toContain(mime)
    }
  })
})
