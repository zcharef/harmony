import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAttachmentForUpload } from './attachment-image'

/**
 * Canvas/createImageBitmap don't exist in jsdom — the WebP downscale path is
 * exercised through stubs that capture the arguments the browser would receive.
 * Mirrors avatar-image.test.ts.
 */

const bitmapClose = vi.fn()
const createImageBitmapMock = vi.fn()
const drawImageMock = vi.fn()

let capturedCanvas: { width: number; height: number } | null = null
let capturedMime: string | undefined
let capturedQuality: number | undefined
let toBlobResult: Blob | null = new Blob(['webp-bytes'], { type: 'image/webp' })

beforeEach(() => {
  vi.clearAllMocks()
  capturedCanvas = null
  capturedMime = undefined
  capturedQuality = undefined
  toBlobResult = new Blob(['webp-bytes'], { type: 'image/webp' })

  vi.stubGlobal('createImageBitmap', createImageBitmapMock)
  createImageBitmapMock.mockResolvedValue({ width: 3200, height: 1600, close: bitmapClose })

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: drawImageMock,
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    mime?: string,
    quality?: unknown,
  ) {
    capturedCanvas = { width: this.width, height: this.height }
    capturedMime = mime
    capturedQuality = typeof quality === 'number' ? quality : undefined
    callback(toBlobResult)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('prepareAttachmentForUpload', () => {
  it('downscales to max 1600px, encodes WebP, and captures dimensions (EXIF stripped)', async () => {
    const png = new File([new Uint8Array(64)], 'photo.png', { type: 'image/png' })

    const prepared = await prepareAttachmentForUpload(png)

    // 3200x1600 → longest edge 3200 → scale 0.5 → 1600x800.
    expect(capturedCanvas).toEqual({ width: 1600, height: 800 })
    expect(capturedMime).toBe('image/webp')
    expect(capturedQuality).toBe(0.85)
    expect(prepared.contentType).toBe('image/webp')
    expect(prepared.extension).toBe('webp')
    expect(prepared.width).toBe(1600)
    expect(prepared.height).toBe(800)
    // Re-encoding through canvas never copies the source metadata block.
    expect(drawImageMock).toHaveBeenCalledOnce()
    expect(bitmapClose).toHaveBeenCalledOnce()
  })

  it('does not upscale images already under 1600px', async () => {
    createImageBitmapMock.mockResolvedValue({ width: 800, height: 600, close: bitmapClose })
    const png = new File([new Uint8Array(64)], 'small.png', { type: 'image/png' })

    const prepared = await prepareAttachmentForUpload(png)

    expect(capturedCanvas).toEqual({ width: 800, height: 600 })
    expect(prepared.width).toBe(800)
    expect(prepared.height).toBe(600)
  })

  it('keeps gif bytes untouched but decodes intrinsic dimensions to reserve its box', async () => {
    createImageBitmapMock.mockResolvedValue({ width: 480, height: 320, close: bitmapClose })
    const gif = new File([new Uint8Array(64)], 'anim.gif', { type: 'image/gif' })

    const prepared = await prepareAttachmentForUpload(gif)

    // Bytes pass through unchanged (animation preserved) — the bitmap is only
    // read for dimensions, never re-encoded through a canvas.
    expect(prepared.blob).toBe(gif)
    expect(prepared.contentType).toBe('image/gif')
    expect(prepared.extension).toBe('gif')
    expect(prepared.width).toBe(480)
    expect(prepared.height).toBe(320)
    expect(drawImageMock).not.toHaveBeenCalled()
    expect(bitmapClose).toHaveBeenCalledOnce()
  })

  it('still uploads a gif whose dimensions cannot be decoded (no reserved dims)', async () => {
    createImageBitmapMock.mockRejectedValue(new Error('corrupt header'))
    const gif = new File([new Uint8Array(64)], 'broken.gif', { type: 'image/gif' })

    const prepared = await prepareAttachmentForUpload(gif)

    expect(prepared.blob).toBe(gif)
    expect(prepared.contentType).toBe('image/gif')
    expect(prepared.width).toBeUndefined()
    expect(prepared.height).toBeUndefined()
  })

  it('passes non-images (pdf) through untouched with the filename extension', async () => {
    const pdf = new File([new Uint8Array(64)], 'report.pdf', { type: 'application/pdf' })

    const prepared = await prepareAttachmentForUpload(pdf)

    expect(prepared.blob).toBe(pdf)
    expect(prepared.contentType).toBe('application/pdf')
    expect(prepared.extension).toBe('pdf')
    expect(prepared.width).toBeUndefined()
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('falls back to the produced mime when WebP encoding is unsupported (Safari/WKWebView)', async () => {
    toBlobResult = new Blob(['png-bytes'], { type: 'image/png' })
    const png = new File([new Uint8Array(64)], 'photo.png', { type: 'image/png' })

    const prepared = await prepareAttachmentForUpload(png)

    expect(prepared.contentType).toBe('image/png')
    expect(prepared.extension).toBe('png')
  })

  it('throws and still releases the bitmap when the canvas cannot encode', async () => {
    toBlobResult = null
    const png = new File([new Uint8Array(64)], 'broken.png', { type: 'image/png' })

    await expect(prepareAttachmentForUpload(png)).rejects.toThrow()
    expect(bitmapClose).toHaveBeenCalledOnce()
  })
})
