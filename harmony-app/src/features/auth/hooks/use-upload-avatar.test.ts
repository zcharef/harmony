import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ProfileResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { AvatarUploadError } from '../lib/avatar-file'
import { useUploadAvatar } from './use-upload-avatar'

vi.mock('@/lib/api', () => ({
  updateMyProfile: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY module-edge mock: canvas/createImageBitmap don't exist in jsdom —
// the transcode boundary is covered by avatar-image.test.ts.
vi.mock('../lib/avatar-image', () => ({
  prepareAvatarForUpload: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: vi.fn() } },
}))

vi.mock('../stores/auth-store', () => ({
  useAuthStore: vi.fn(),
}))

const { updateMyProfile } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { prepareAvatarForUpload } = await import('../lib/avatar-image')
const { supabase } = await import('@/lib/supabase')
const { useAuthStore } = await import('../stores/auth-store')

/**
 * WHY not createTestQueryClient: it sets gcTime: 0, and optimistic update
 * tests set cache data without an active query observer — gcTime: Infinity
 * keeps the data alive through the full mutation lifecycle (same pattern as
 * use-send-message.test.ts).
 */
function createMutationTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
}

const USER_ID = 'user-1'
const FIXED_UUID = '00000000-0000-4000-8000-000000000000'
const SUPABASE_PUBLIC_BASE = 'http://127.0.0.1:64321/storage/v1/object/public/avatars'

const uploadMock = vi.fn()
const getPublicUrlMock = vi.fn()
const removeMock = vi.fn()

function buildProfile(overrides: Partial<ProfileResponse> = {}): ProfileResponse {
  return {
    id: USER_ID,
    username: 'alice',
    displayName: 'Alice',
    avatarUrl: null,
    status: 'online',
    customStatus: null,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
    ...overrides,
  }
}

function makeFile(sizeBytes: number, type: string, name = 'avatar.png'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

/** WHY: avoids `as AvatarUploadError` assertions (ADR-035). */
function errorCode(error: unknown): string | null {
  return error instanceof AvatarUploadError ? error.code : null
}

describe('useUploadAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(useAuthStore).mockImplementation(((
      selector: (state: { user: { id: string } }) => unknown,
    ) => selector({ user: { id: USER_ID } })) as never)

    vi.mocked(supabase.storage.from).mockReturnValue({
      upload: uploadMock,
      getPublicUrl: getPublicUrlMock,
      remove: removeMock,
    } as never)

    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_UUID)

    vi.mocked(prepareAvatarForUpload).mockResolvedValue({
      blob: new Blob(['webp-bytes'], { type: 'image/webp' }),
      contentType: 'image/webp',
      extension: 'webp',
    })
    uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null })
    getPublicUrlMock.mockReturnValue({
      data: { publicUrl: `${SUPABASE_PUBLIC_BASE}/${USER_ID}/${FIXED_UUID}.webp` },
    })
    removeMock.mockResolvedValue({ data: [], error: null })
    vi.mocked(updateMyProfile).mockResolvedValue({ data: buildProfile() } as never)
  })

  it('rejects invalid file types without touching storage', async () => {
    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'text/plain', 'notes.txt'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error).toBeInstanceOf(AvatarUploadError)
    expect(errorCode(result.current.error)).toBe('invalidType')
    expect(uploadMock).not.toHaveBeenCalled()
    expect(updateMyProfile).not.toHaveBeenCalled()
  })

  it('rejects gifs over the 2MB cap', async () => {
    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(2 * 1024 * 1024 + 1, 'image/gif', 'big.gif'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('gifTooLarge')
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('uploads the processed blob to {uid}/{uuid}.{ext} and PATCHes avatar_url', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData(queryKeys.profiles.me(), buildProfile())
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(supabase.storage.from).toHaveBeenCalledWith('avatars')
    expect(uploadMock).toHaveBeenCalledOnce()
    const [path, blob, options] = uploadMock.mock.calls[0] ?? []
    expect(path).toBe(`${USER_ID}/${FIXED_UUID}.webp`)
    expect(blob).toBeInstanceOf(Blob)
    expect(options).toEqual({ contentType: 'image/webp', cacheControl: '3600' })

    expect(updateMyProfile).toHaveBeenCalledWith({
      body: { avatarUrl: `${SUPABASE_PUBLIC_BASE}/${USER_ID}/${FIXED_UUID}.webp` },
      throwOnError: true,
    })
    // No previous avatar → nothing to remove.
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('best-effort removes the previous storage object after a successful PATCH', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData(
      queryKeys.profiles.me(),
      buildProfile({ avatarUrl: `${SUPABASE_PUBLIC_BASE}/${USER_ID}/old-object.webp` }),
    )
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(removeMock).toHaveBeenCalledWith([`${USER_ID}/old-object.webp`])
  })

  it('does not attempt removal for external previous avatar URLs', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData(
      queryKeys.profiles.me(),
      buildProfile({ avatarUrl: 'https://example.com/external.png' }),
    )
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(removeMock).not.toHaveBeenCalled()
  })

  it('only warns when previous-object removal fails (upload still succeeds)', async () => {
    removeMock.mockResolvedValue({ data: null, error: { message: 'boom' } })

    const queryClient = createMutationTestClient()
    queryClient.setQueryData(
      queryKeys.profiles.me(),
      buildProfile({ avatarUrl: `${SUPABASE_PUBLIC_BASE}/${USER_ID}/old-object.webp` }),
    )
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(logger.warn).toHaveBeenCalledWith('avatar_previous_remove_failed', {
      path: `${USER_ID}/old-object.webp`,
      error: 'boom',
    })
  })

  it('fails with uploadFailed when storage rejects the upload (no PATCH sent)', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'denied' } })

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('uploadFailed')
    expect(updateMyProfile).not.toHaveBeenCalled()
  })

  it('fails with processingFailed when the canvas pipeline throws', async () => {
    vi.mocked(prepareAvatarForUpload).mockRejectedValue(new Error('decode error'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadAvatar(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('processingFailed')
    expect(uploadMock).not.toHaveBeenCalled()
  })
})
