import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { AttachmentUploadError, MAX_ATTACHMENTS_PER_MESSAGE } from '../lib/attachment-file'
import { useComposerAttachments } from './use-composer-attachments'
import type { UploadedAttachment } from './use-upload-attachment'

const uploadAttachmentMock = vi.fn<(file: File) => Promise<UploadedAttachment>>()

vi.mock('./use-upload-attachment', () => ({
  useUploadAttachment: () => uploadAttachmentMock,
}))

const createObjectURLMock = vi.fn(() => 'blob:preview-url')
const revokeObjectURLMock = vi.fn()

function makeImage(name = 'shot.png', size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: 'image/png' })
}

function uploadedFor(name: string): UploadedAttachment {
  return { url: `https://cdn/${name}`, mime: 'image/png', size: 1024, width: 10, height: 10 }
}

/** WHY a hand-rolled FileList: jsdom has no DataTransfer to produce a real one. */
function fileListOf(...files: File[]): FileList {
  const list: FileList = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      yield* files
    },
  } as unknown as FileList
  files.forEach((file, i) => {
    ;(list as unknown as Record<number, File>)[i] = file
  })
  return list
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('URL', {
    createObjectURL: createObjectURLMock,
    revokeObjectURL: revokeObjectURLMock,
  })
  uploadAttachmentMock.mockImplementation((file) => Promise.resolve(uploadedFor(file.name)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useComposerAttachments', () => {
  it('enqueues a file from the picker/paste/drop path as a pending tile and uploads it', async () => {
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([makeImage()])
    })

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.status).toBe('uploading')
    expect(result.current.items[0]?.previewUrl).toBe('blob:preview-url')
    expect(uploadAttachmentMock).toHaveBeenCalledOnce()

    await waitFor(() => expect(result.current.items[0]?.status).toBe('done'))
    expect(result.current.items[0]?.uploaded?.url).toBe('https://cdn/shot.png')
  })

  it('accepts a FileList (paste/drop deliver a FileList, not an array)', () => {
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles(fileListOf(makeImage('pasted.png')))
    })

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]?.name).toBe('pasted.png')
  })

  it('caps at the Creator ceiling and surfaces the tooMany error inline (plan-cap mirror)', () => {
    const { result } = renderHook(() => useComposerAttachments())
    const files = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, i) =>
      makeImage(`f${i}.png`),
    )

    act(() => {
      result.current.enqueueFiles(files)
    })

    expect(result.current.items).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    expect(result.current.capError).toBe('tooMany')
  })

  it('rejects unsupported types inline without creating a tile', () => {
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([
        new File([new Uint8Array(8)], 'x.svg', { type: 'image/svg+xml' }),
      ])
    })

    expect(result.current.items).toHaveLength(0)
    expect(result.current.capError).toBe('unsupported')
  })

  it('dedupes an identical file (same name + size) across enqueues', () => {
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([makeImage('dup.png', 2048)])
    })
    act(() => {
      result.current.enqueueFiles([makeImage('dup.png', 2048)])
    })

    expect(result.current.items).toHaveLength(1)
  })

  it('removes a tile and revokes its objectURL preview', () => {
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([makeImage()])
    })
    const localId = result.current.items[0]?.localId ?? ''

    act(() => {
      result.current.removeAttachment(localId)
    })

    expect(result.current.items).toHaveLength(0)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:preview-url')
  })

  it('resolveUploaded awaits all in-flight uploads and returns the succeeded entries', async () => {
    let release: (() => void) | null = null
    uploadAttachmentMock.mockImplementation(
      (file) =>
        new Promise<UploadedAttachment>((resolve) => {
          release = () => resolve(uploadedFor(file.name))
        }),
    )

    const { result } = renderHook(() => useComposerAttachments())
    act(() => {
      result.current.enqueueFiles([makeImage('slow.png')])
    })
    expect(result.current.items[0]?.status).toBe('uploading')

    const resolvedPromise = result.current.resolveUploaded()
    await act(async () => {
      release?.()
      await resolvedPromise
    })

    const uploaded = await resolvedPromise
    expect(uploaded).toEqual([
      { url: 'https://cdn/slow.png', mime: 'image/png', size: 1024, width: 10, height: 10 },
    ])
  })

  it('resolveUploaded returns null when any tracked upload failed (blocks the send)', async () => {
    uploadAttachmentMock
      .mockResolvedValueOnce(uploadedFor('ok.png'))
      .mockRejectedValueOnce(new AttachmentUploadError('uploadFailed'))
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([makeImage('ok.png'), makeImage('bad.png')])
    })
    await waitFor(() => expect(result.current.hasFailedUpload).toBe(true))

    await expect(result.current.resolveUploaded()).resolves.toBeNull()
  })

  it('marks a tile as error and flags hasFailedUpload when its upload rejects', async () => {
    uploadAttachmentMock.mockRejectedValue(new AttachmentUploadError('uploadFailed'))
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([makeImage()])
    })

    await waitFor(() => expect(result.current.items[0]?.status).toBe('error'))
    expect(result.current.items[0]?.errorCode).toBe('uploadFailed')
    expect(result.current.hasFailedUpload).toBe(true)
  })

  it('clear() drops all tiles, revokes previews, and resets errors', () => {
    const { result } = renderHook(() => useComposerAttachments())

    act(() => {
      result.current.enqueueFiles([makeImage('a.png'), makeImage('b.png')])
      result.current.setSendError('boom')
    })
    act(() => {
      result.current.clear()
    })

    expect(result.current.items).toHaveLength(0)
    expect(result.current.sendError).toBeNull()
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(2)
  })
})
