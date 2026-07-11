import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { EmojiListResponse, EmojiResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import { EMOJI_PUBLIC_PATH_MARKER } from '../lib/emoji-file'
import { useDeleteEmoji } from './use-delete-emoji'

vi.mock('@/lib/api', () => ({
  deleteServerEmoji: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: vi.fn() } },
}))

const { deleteServerEmoji } = await import('@/lib/api')
const { supabase } = await import('@/lib/supabase')

const SERVER_ID = 'server-1'
const STORAGE_BASE = `http://127.0.0.1:64321${EMOJI_PUBLIC_PATH_MARKER}`

const removeMock = vi.fn()

/**
 * WHY not createTestQueryClient: it sets gcTime: 0, and optimistic update tests
 * set cache data without an active query observer — gcTime: Infinity keeps the
 * data alive through the full mutation lifecycle (mirrors use-upload-avatar.test).
 */
function createMutationTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
}

function buildEmoji(id: string): EmojiResponse {
  return {
    id,
    serverId: SERVER_ID,
    name: id,
    url: `${STORAGE_BASE}${SERVER_ID}/${id}.png`,
    isAnimated: false,
    createdBy: 'user-1',
    createdAt: '2026-03-16T00:00:00.000Z',
  }
}

function cacheOf(queryClient: QueryClient): EmojiListResponse | undefined {
  return queryClient.getQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID))
}

describe('useDeleteEmoji', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(supabase.storage.from).mockReturnValue({ remove: removeMock } as never)
    removeMock.mockResolvedValue({ data: [], error: null })
    vi.mocked(deleteServerEmoji).mockResolvedValue({ data: undefined } as never)
  })

  it('optimistically removes the emoji and decrements total on mutate', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1'), buildEmoji('e2')],
      total: 2,
    })
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteEmoji(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ emojiId: 'e1', url: buildEmoji('e1').url })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cache = cacheOf(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e2'])
  })

  it('restores the previous cache on error (rollback)', async () => {
    vi.mocked(deleteServerEmoji).mockRejectedValue(new Error('boom'))

    const queryClient = createMutationTestClient()
    const previous: EmojiListResponse = {
      items: [buildEmoji('e1'), buildEmoji('e2')],
      total: 2,
    }
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), previous)
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteEmoji(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ emojiId: 'e1', url: buildEmoji('e1').url })
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    const cache = cacheOf(queryClient)
    expect(cache?.total).toBe(2)
    expect(cache?.items.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('removes the storage object after a successful delete', async () => {
    const queryClient = createMutationTestClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1')],
      total: 1,
    })
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useDeleteEmoji(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ emojiId: 'e1', url: buildEmoji('e1').url })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(removeMock).toHaveBeenCalledWith([`${SERVER_ID}/e1.png`])
  })
})
