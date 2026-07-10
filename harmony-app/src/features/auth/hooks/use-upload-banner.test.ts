import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ProfileResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { AvatarUploadError } from '../lib/avatar-file'
import { useUploadBanner } from './use-upload-banner'

vi.mock('@/lib/api', () => ({
  updateMyProfile: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// WHY module-edge mock: canvas/createImageBitmap don't exist in jsdom —
// the transcode boundary is covered by avatar-image.test.ts.
vi.mock('../lib/avatar-image', () => ({
  prepareBannerForUpload: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: vi.fn() } },
}))

vi.mock('../stores/auth-store', () => ({
  useAuthStore: vi.fn(),
}))

const { updateMyProfile } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { prepareBannerForUpload } = await import('../lib/avatar-image')
const { supabase } = await import('@/lib/supabase')
const { useAuthStore } = await import('../stores/auth-store')

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
    bannerUrl: null,
    status: 'online',
    customStatus: null,
    createdAt: '2026-03-16T00:00:00.000Z',
    updatedAt: '2026-03-16T00:00:00.000Z',
    ...overrides,
  }
}

function makeFile(sizeBytes: number, type: string, name = 'banner.png'): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

function errorCode(error: unknown): string | null {
  return error instanceof AvatarUploadError ? error.code : null
}

describe('useUploadBanner', () => {
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

    vi.mocked(prepareBannerForUpload).mockResolvedValue({
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
    const { result } = renderHook(() => useUploadBanner(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'text/plain', 'notes.txt'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('invalidType')
    expect(uploadMock).not.toHaveBeenCalled()
    expect(updateMyProfile).not.toHaveBeenCalled()
  })

  it('rejects files over the 2MB cap', async () => {
    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadBanner(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(2 * 1024 * 1024 + 1, 'image/png', 'big.png'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('tooLarge')
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('uploads the processed blob to {uid}/{uuid}.{ext} in the avatars bucket and PATCHes banner_url', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData(queryKeys.profiles.me(), buildProfile())
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadBanner(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // WHY same bucket: banners live alongside avatars, keyed by path (ticket §2.2).
    expect(supabase.storage.from).toHaveBeenCalledWith('avatars')
    const [path] = uploadMock.mock.calls[0] ?? []
    expect(path).toBe(`${USER_ID}/${FIXED_UUID}.webp`)

    expect(updateMyProfile).toHaveBeenCalledWith({
      body: { bannerUrl: `${SUPABASE_PUBLIC_BASE}/${USER_ID}/${FIXED_UUID}.webp` },
      throwOnError: true,
    })
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('best-effort removes the previous banner object after a successful PATCH', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData(
      queryKeys.profiles.me(),
      buildProfile({ bannerUrl: `${SUPABASE_PUBLIC_BASE}/${USER_ID}/old-banner.webp` }),
    )
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadBanner(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(removeMock).toHaveBeenCalledWith([`${USER_ID}/old-banner.webp`])
  })

  it('fails with uploadFailed when storage rejects the upload (no PATCH sent)', async () => {
    uploadMock.mockResolvedValue({ data: null, error: { message: 'denied' } })

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadBanner(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('uploadFailed')
    expect(updateMyProfile).not.toHaveBeenCalled()
  })

  it('fails with processingFailed when the canvas pipeline throws', async () => {
    vi.mocked(prepareBannerForUpload).mockRejectedValue(new Error('decode error'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useUploadBanner(), { wrapper })

    await act(async () => {
      result.current.mutate(makeFile(1024, 'image/png'))
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(errorCode(result.current.error)).toBe('processingFailed')
    expect(uploadMock).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })
})
