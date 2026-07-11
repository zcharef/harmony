import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { EmojiListResponse, EmojiResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import { EMOJI_PUBLIC_PATH_MARKER } from '../lib/emoji-file'
import { useCreateEmoji } from './use-create-emoji'

vi.mock('@/lib/api', () => ({
  createServerEmoji: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: vi.fn() } },
}))

const { createServerEmoji } = await import('@/lib/api')
const { supabase } = await import('@/lib/supabase')

const SERVER_ID = 'server-1'
const FIXED_UUID = '00000000-0000-4000-8000-000000000000'
const STORAGE_BASE = `http://127.0.0.1:64321${EMOJI_PUBLIC_PATH_MARKER}`
const PUBLIC_URL = `${STORAGE_BASE}${SERVER_ID}/${FIXED_UUID}.png`

const LIMITS = { maxBytes: 1024 * 1024, animatedAllowed: true }

const uploadMock = vi.fn()
const getPublicUrlMock = vi.fn()
const removeMock = vi.fn()

/** WHY gcTime: Infinity: optimistic cache set without an observer must survive. */
function createMutationTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
}

function makeFile(): File {
  return new File([new Uint8Array(64)], 'party.png', { type: 'image/png' })
}

function buildEmoji(id: string): EmojiResponse {
  return {
    id,
    serverId: SERVER_ID,
    name: 'party',
    url: PUBLIC_URL,
    isAnimated: false,
    createdBy: 'user-1',
    createdAt: '2026-03-16T00:00:00.000Z',
  }
}

function cacheOf(queryClient: QueryClient): EmojiListResponse | undefined {
  return queryClient.getQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID))
}

describe('useCreateEmoji', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(supabase.storage.from).mockReturnValue({
      upload: uploadMock,
      getPublicUrl: getPublicUrlMock,
      remove: removeMock,
    } as never)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_UUID)
    uploadMock.mockResolvedValue({ data: { path: 'x' }, error: null })
    getPublicUrlMock.mockReturnValue({ data: { publicUrl: PUBLIC_URL } })
    removeMock.mockResolvedValue({ data: [], error: null })
    vi.mocked(createServerEmoji).mockResolvedValue({ data: buildEmoji('e1') } as never)
  })

  it('appends the created emoji to the cache on success', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [],
      total: 0,
    })
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useCreateEmoji(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ file: makeFile(), name: 'party', limits: LIMITS })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cache = cacheOf(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e1'])
    expect(uploadMock).toHaveBeenCalledOnce()
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('does not double-insert when the SSE echo already cached the id', async () => {
    // handleCreated (use-realtime-emojis) may insert the id before onSuccess runs.
    const queryClient = createMutationTestClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1')],
      total: 1,
    })
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useCreateEmoji(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ file: makeFile(), name: 'party', limits: LIMITS })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cache = cacheOf(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items).toHaveLength(1)
  })

  it('removes the uploaded object when the POST fails (orphan cleanup)', async () => {
    vi.mocked(createServerEmoji).mockRejectedValue(new Error('server rejected'))

    const queryClient = createMutationTestClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useCreateEmoji(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ file: makeFile(), name: 'party', limits: LIMITS })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(uploadMock).toHaveBeenCalledOnce()
    expect(removeMock).toHaveBeenCalledWith([`${SERVER_ID}/${FIXED_UUID}.png`])
  })

  it('rejects an invalid file type without touching storage', async () => {
    const queryClient = createMutationTestClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useCreateEmoji(SERVER_ID), { wrapper })

    const badFile = new File([new Uint8Array(8)], 'notes.txt', { type: 'text/plain' })
    await act(async () => {
      result.current.mutate({ file: badFile, name: 'party', limits: LIMITS })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(uploadMock).not.toHaveBeenCalled()
    expect(createServerEmoji).not.toHaveBeenCalled()
  })
})
