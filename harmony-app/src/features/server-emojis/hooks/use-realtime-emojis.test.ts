import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { EmojiListResponse, EmojiResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useRealtimeEmojis } from './use-realtime-emojis'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  toastApiError: vi.fn(),
}))

// WHY interpolate: returning the key alone would not prove the emoji name reaches
// i18n, so the toast-payload assertion could not catch a dropped interpolation arg.
vi.mock('i18next', () => ({
  default: {
    t: vi.fn((key: string, opts?: { name?: string }) =>
      opts?.name === undefined ? key : `${key}:${opts.name}`,
    ),
  },
}))

const SERVER_ID = 'server-1'

// -- Helpers ------------------------------------------------------------------

function buildEmoji(id: string, name = id): EmojiResponse {
  return {
    id,
    serverId: SERVER_ID,
    name,
    url: `https://cdn.test/${id}.png`,
    isAnimated: false,
    createdBy: 'user-1',
    createdAt: '2026-03-16T00:00:00.000Z',
  }
}

function fireSSEEvent(eventName: string, payload: unknown) {
  window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload }))
}

function emojisInCache(
  queryClient: ReturnType<typeof createTestQueryClient>,
): EmojiListResponse | undefined {
  return queryClient.getQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID))
}

function renderEmojis(queryClient: ReturnType<typeof createTestQueryClient>) {
  renderHook(() => useRealtimeEmojis(), {
    wrapper: createQueryWrapper(queryClient),
  })
}

// -- Tests --------------------------------------------------------------------

describe('useRealtimeEmojis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('appends the emoji and increments total on emoji.created', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1')],
      total: 1,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.created', { serverId: SERVER_ID, emoji: buildEmoji('e2') })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(2)
    expect(cache?.items.map((e) => e.id)).toEqual(['e1', 'e2'])
  })

  it('seeds the cache when it is empty on emoji.created', () => {
    const queryClient = createTestQueryClient()
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.created', { serverId: SERVER_ID, emoji: buildEmoji('e1') })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e1'])
  })

  it('de-dupes an echo of an already-cached id (creator optimistic append)', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1')],
      total: 1,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.created', { serverId: SERVER_ID, emoji: buildEmoji('e1') })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items).toHaveLength(1)
  })

  it('filters the emoji and decrements total on emoji.deleted', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1'), buildEmoji('e2')],
      total: 2,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.deleted', { serverId: SERVER_ID, emojiId: 'e1' })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e2'])
  })

  it('does not decrement total when the deleted id is absent (idempotent self-echo)', () => {
    // The deleting admin already decremented `total` optimistically (onMutate),
    // so their own emoji.deleted echo must not decrement a second time.
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e2')],
      total: 1,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.deleted', { serverId: SERVER_ID, emojiId: 'e1' })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e2'])
  })

  it('clamps total at 0 on emoji.deleted', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1')],
      total: 0,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.deleted', { serverId: SERVER_ID, emojiId: 'e1' })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(0)
    expect(cache?.items).toHaveLength(0)
  })

  it('removes the rejected emoji and decrements total on emoji.rejected', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1'), buildEmoji('e2')],
      total: 2,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.rejected', { serverId: SERVER_ID, emojiId: 'e1', name: 'blob' })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e2'])
  })

  it('does not decrement total when the rejected id is absent (idempotent)', () => {
    // The creator's optimistic emoji may already be gone (e.g. a prior patch);
    // the rejection echo must not decrement a second time, mirroring emoji.deleted.
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e2')],
      total: 1,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.rejected', { serverId: SERVER_ID, emojiId: 'e1', name: 'blob' })
    })

    const cache = emojisInCache(queryClient)
    expect(cache?.total).toBe(1)
    expect(cache?.items.map((e) => e.id)).toEqual(['e2'])
  })

  it('shows a rejection toast to the creator on emoji.rejected', () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(SERVER_ID), {
      items: [buildEmoji('e1')],
      total: 1,
    })
    renderEmojis(queryClient)

    act(() => {
      fireSSEEvent('emoji.rejected', { serverId: SERVER_ID, emojiId: 'e1', name: 'blob' })
    })

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('server-emojis:rejectedTitle', {
      description: 'server-emojis:rejectedBody:blob',
    })
  })
})
