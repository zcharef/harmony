import { renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { AttachmentUploadError } from '../lib/attachment-file'
import { useUploadAttachment } from './use-upload-attachment'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY module-edge mock: canvas/createImageBitmap don't exist in jsdom — the
// transcode boundary is covered by attachment-image.test.ts.
vi.mock('../lib/attachment-image', () => ({
  prepareAttachmentForUpload: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: vi.fn() } },
}))

vi.mock('@/features/auth', () => ({
  useAuthStore: vi.fn(),
}))

const { prepareAttachmentForUpload } = await import('../lib/attachment-image')
const { supabase } = await import('@/lib/supabase')
const { useAuthStore } = await import('@/features/auth')

const USER_ID = 'user-1'
const FIXED_UUID = '00000000-0000-4000-8000-000000000000'
const PUBLIC_BASE = 'http://127.0.0.1:64321/storage/v1/object/public/attachments'

const uploadMock = vi.fn()
const getPublicUrlMock = vi.fn()

function makeFile(sizeBytes: number, type: string, name = 'photo.png'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

function errorCode(error: unknown): string | null {
  return error instanceof AttachmentUploadError ? error.code : null
}

describe('useUploadAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(useAuthStore).mockImplementation(((
      selector: (state: { user: { id: string } }) => unknown,
    ) => selector({ user: { id: USER_ID } })) as never)

    vi.mocked(supabase.storage.from).mockReturnValue({
      upload: uploadMock,
      getPublicUrl: getPublicUrlMock,
    } as never)

    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_UUID)

    vi.mocked(prepareAttachmentForUpload).mockResolvedValue({
      blob: new Blob(['webp-bytes'], { type: 'image/webp' }),
      contentType: 'image/webp',
      extension: 'webp',
      width: 1600,
      height: 800,
    })
    uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null })
    getPublicUrlMock.mockReturnValue({
      data: { publicUrl: `${PUBLIC_BASE}/${USER_ID}/${FIXED_UUID}.webp` },
    })
  })

  it('validates, downscales, uploads to {uid}/{uuid}.{ext}, and returns url + dims', async () => {
    const { result } = renderHook(() => useUploadAttachment())

    const uploaded = await result.current(makeFile(1024, 'image/png'))

    expect(supabase.storage.from).toHaveBeenCalledWith('attachments')
    const [path, blob, options] = uploadMock.mock.calls[0] ?? []
    expect(path).toBe(`${USER_ID}/${FIXED_UUID}.webp`)
    expect(blob).toBeInstanceOf(Blob)
    expect(options).toEqual({ contentType: 'image/webp', cacheControl: '3600' })

    expect(uploaded).toEqual({
      url: `${PUBLIC_BASE}/${USER_ID}/${FIXED_UUID}.webp`,
      mime: 'image/webp',
      size: expect.any(Number),
      width: 1600,
      height: 800,
    })
  })

  it('omits width/height for non-image attachments', async () => {
    vi.mocked(prepareAttachmentForUpload).mockResolvedValue({
      blob: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
      contentType: 'application/pdf',
      extension: 'pdf',
    })
    getPublicUrlMock.mockReturnValue({
      data: { publicUrl: `${PUBLIC_BASE}/${USER_ID}/${FIXED_UUID}.pdf` },
    })
    const { result } = renderHook(() => useUploadAttachment())

    const uploaded = await result.current(makeFile(2048, 'application/pdf', 'report.pdf'))

    expect(uploaded).not.toHaveProperty('width')
    expect(uploaded).not.toHaveProperty('height')
    expect(uploaded.mime).toBe('application/pdf')
  })

  /** Resolves the thrown error code, or throws if the call unexpectedly succeeds. */
  async function expectRejectCode(promise: Promise<unknown>): Promise<string | null> {
    try {
      await promise
    } catch (error) {
      return errorCode(error)
    }
    throw new Error('expected upload to reject')
  }

  it('rejects invalid file types without touching storage', async () => {
    const { result } = renderHook(() => useUploadAttachment())

    const code = await expectRejectCode(result.current(makeFile(1024, 'image/svg+xml', 'x.svg')))

    expect(code).toBe('invalidType')
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('maps a storage failure to uploadFailed', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'denied' } })
    const { result } = renderHook(() => useUploadAttachment())

    const code = await expectRejectCode(result.current(makeFile(1024, 'image/png')))

    expect(code).toBe('uploadFailed')
  })

  it('maps a canvas pipeline failure to processingFailed', async () => {
    vi.mocked(prepareAttachmentForUpload).mockRejectedValue(new Error('decode error'))
    const { result } = renderHook(() => useUploadAttachment())

    const code = await expectRejectCode(result.current(makeFile(1024, 'image/png')))

    expect(code).toBe('processingFailed')
    expect(uploadMock).not.toHaveBeenCalled()
  })
})
