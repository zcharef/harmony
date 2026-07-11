import { type InfiniteData, QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import { usePinMessage } from './use-pin-message'

// WHY a persistent client (gcTime: Infinity) rather than createTestQueryClient:
// the mutation's optimistic flip + rollback span async gaps, and the shared test
// client's gcTime:0 would GC the unobserved message cache mid-flight.
function createPersistentClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
}

vi.mock('@/lib/api', () => ({
  pinMessage: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  toastApiError: vi.fn(),
}))

vi.mock('i18next', () => ({
  default: { t: vi.fn((key: string) => key) },
}))

const { pinMessage } = await import('@/lib/api')
const { toast } = await import('@/lib/toast')

const CHANNEL_ID = 'channel-1'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    content: 'Hello',
    authorId: 'user-42',
    authorUsername: 'test-user',
    channelId: CHANNEL_ID,
    createdAt: '2026-01-01T00:00:00Z',
    encrypted: false,
    messageType: 'default',
    mentions: [],
    attachments: [],
    embeds: [],
    isPinned: false,
    ...overrides,
  }
}

function buildCacheData(messages: MessageResponse[]): InfiniteData<MessageListResponse> {
  return { pages: [{ items: messages, nextCursor: null }], pageParams: [undefined] }
}

describe('usePinMessage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('optimistically flips isPinned in the message cache before the request resolves', async () => {
    vi.mocked(pinMessage).mockResolvedValueOnce({ data: undefined } as never)
    const queryClient = createPersistentClient()
    const key = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(key, buildCacheData([buildMessage({ id: 'msg-1', isPinned: false })]))

    const { result } = renderHook(() => usePinMessage(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('msg-1')
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const data = queryClient.getQueryData<InfiniteData<MessageListResponse>>(key)
    expect(data?.pages[0]?.items[0]?.isPinned).toBe(true)
  })

  it('rolls back the optimistic flip and toasts the 409 cap message on error', async () => {
    vi.mocked(pinMessage).mockRejectedValueOnce({
      status: 409,
      detail: 'Channel pin limit (50) reached',
    })
    const queryClient = createPersistentClient()
    const key = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(key, buildCacheData([buildMessage({ id: 'msg-1', isPinned: false })]))

    const { result } = renderHook(() => usePinMessage(CHANNEL_ID), {
      wrapper: createQueryWrapper(queryClient),
    })

    await act(async () => {
      result.current.mutate('msg-1')
    })
    await waitFor(() => expect(result.current.isError).toBe(true))

    const data = queryClient.getQueryData<InfiniteData<MessageListResponse>>(key)
    expect(data?.pages[0]?.items[0]?.isPinned).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('chat:pinLimitReached')
  })
})
