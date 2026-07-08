import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareAvatarForUpload } from './avatar-image'

/**
 * Canvas/createImageBitmap don't exist in jsdom — the WebP path is exercised
 * through stubs that capture the arguments the browser would receive.
 */

const bitmapClose = vi.fn()
const createImageBitmapMock = vi.fn()
const drawImageMock = vi.fn()

/** Captured by the toBlob stub so tests can assert the encode parameters. */
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
  createImageBitmapMock.mockResolvedValue({ width: 1024, height: 512, close: bitmapClose })

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

describe('prepareAvatarForUpload', () => {
  it('returns gifs untouched to preserve animation (no canvas involved)', async () => {
    const gif = new File([new Uint8Array(64)], 'anim.gif', { type: 'image/gif' })

    const prepared = await prepareAvatarForUpload(gif)

    expect(prepared.blob).toBe(gif)
    expect(prepared.contentType).toBe('image/gif')
    expect(prepared.extension).toBe('gif')
    expect(createImageBitmapMock).not.toHaveBeenCalled()
  })

  it('downscales to max 512px keeping aspect ratio and encodes WebP at 0.85', async () => {
    const png = new File([new Uint8Array(64)], 'big.png', { type: 'image/png' })

    const prepared = await prepareAvatarForUpload(png)

    // 1024x512 → longest edge 1024 → scale 0.5 → 512x256
    expect(capturedCanvas).toEqual({ width: 512, height: 256 })
    expect(capturedMime).toBe('image/webp')
    expect(capturedQuality).toBe(0.85)
    expect(prepared.contentType).toBe('image/webp')
    expect(prepared.extension).toBe('webp')
    expect(drawImageMock).toHaveBeenCalledOnce()
    expect(bitmapClose).toHaveBeenCalledOnce()
  })

  it('does not upscale images already under 512px', async () => {
    createImageBitmapMock.mockResolvedValue({ width: 100, height: 60, close: bitmapClose })
    const png = new File([new Uint8Array(64)], 'small.png', { type: 'image/png' })

    await prepareAvatarForUpload(png)

    expect(capturedCanvas).toEqual({ width: 100, height: 60 })
  })

  it('falls back to the produced mime when WebP encoding is unsupported (Safari/WKWebView)', async () => {
    toBlobResult = new Blob(['png-bytes'], { type: 'image/png' })
    const png = new File([new Uint8Array(64)], 'photo.png', { type: 'image/png' })

    const prepared = await prepareAvatarForUpload(png)

    expect(prepared.contentType).toBe('image/png')
    expect(prepared.extension).toBe('png')
  })

  it('throws when the canvas cannot encode the image', async () => {
    toBlobResult = null
    const png = new File([new Uint8Array(64)], 'broken.png', { type: 'image/png' })

    await expect(prepareAvatarForUpload(png)).rejects.toThrow()
    // WHY: the bitmap must be released even on failure.
    expect(bitmapClose).toHaveBeenCalledOnce()
  })
})
