import type { InfiniteData } from '@tanstack/react-query'
import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import { useSendMessage } from './use-send-message'

vi.mock('@/lib/api', () => ({
  sendMessage: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

// Imports after vi.mock so we get the mocked versions
const { sendMessage } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')

const CHANNEL_ID = 'channel-1'
const USER_ID = 'user-1'

/**
 * WHY custom client: The shared createTestQueryClient uses gcTime: 0 which
 * garbage-collects inactive query data immediately. Optimistic update tests
 * set cache data without an active query observer, so we need gcTime: Infinity
 * to keep the data alive through the full mutation lifecycle.
 */
function createMutationTestClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
}

function buildCacheData(messages: MessageResponse[]): InfiniteData<MessageListResponse> {
  return {
    pages: [{ items: messages, nextCursor: null }],
    pageParams: [undefined],
  }
}

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
  return {
    id: 'msg-1',
    channelId: CHANNEL_ID,
    authorId: 'user-99',
    authorUsername: 'testuser',
    content: 'existing message',
    createdAt: '2026-03-16T00:00:00.000Z',
    encrypted: false,
    ...overrides,
  }
}

describe('useSendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Stable UUID for optimistic message ID
    vi.stubGlobal('crypto', {
      ...crypto,
      randomUUID: () => '00000000-0000-0000-0000-000000000000',
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls sendMessage with correct path, body, and throwOnError', async () => {
    const serverMessage = buildMessage({ id: 'msg-real', content: 'hello' })
    vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), { wrapper })

    await act(async () => {
      result.current.mutate('hello')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith({
      path: { id: CHANNEL_ID },
      body: { content: 'hello' },
      throwOnError: true,
    })
  })

  it('adds an optimistic message to page 0 of the cache during onMutate', async () => {
    const existingMsg = buildMessage({ id: 'existing-1' })
    // Hold the mutation in-flight so we can inspect the optimistic state
    let resolveMutation!: (value: unknown) => void
    vi.mocked(sendMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        }) as never,
    )

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), { wrapper })

    await act(async () => {
      result.current.mutate('optimistic text')
    })

    // While the mutation is in-flight, check the cache for the optimistic entry
    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const firstPageItems = cacheData?.pages[0]?.items ?? []

    expect(firstPageItems).toHaveLength(2)
    expect(firstPageItems[0]).toMatchObject({
      id: 'temp-00000000-0000-0000-0000-000000000000',
      channelId: CHANNEL_ID,
      authorId: USER_ID,
      content: 'optimistic text',
    })
    expect(firstPageItems[1]?.id).toBe('existing-1')

    // Resolve to clean up
    resolveMutation({ data: buildMessage({ id: 'msg-real', content: 'optimistic text' }) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('replaces the optimistic message with the real message on success', async () => {
    const realMessage = buildMessage({
      id: 'msg-server-123',
      authorId: USER_ID,
      content: 'hello',
    })
    vi.mocked(sendMessage).mockResolvedValueOnce({ data: realMessage } as never)

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), { wrapper })

    await act(async () => {
      result.current.mutate('hello')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const firstPageItems = cacheData?.pages[0]?.items ?? []

    // The optimistic temp message should be replaced with the real one
    expect(firstPageItems).toHaveLength(1)
    expect(firstPageItems[0]?.id).toBe('msg-server-123')
  })

  it('rolls back cache and calls logger.error on error', async () => {
    const existingMsg = buildMessage({ id: 'existing-1' })
    const apiError = new Error('Network failure')
    vi.mocked(sendMessage).mockRejectedValueOnce(apiError)

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([existingMsg]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), { wrapper })

    await act(async () => {
      result.current.mutate('will fail')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    // Cache should be rolled back to the original data
    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    const firstPageItems = cacheData?.pages[0]?.items ?? []
    expect(firstPageItems).toHaveLength(1)
    expect(firstPageItems[0]?.id).toBe('existing-1')

    expect(logger.error).toHaveBeenCalledOnce()
    expect(logger.error).toHaveBeenCalledWith('Failed to send message', {
      channelId: CHANNEL_ID,
      error: 'Network failure',
    })
  })

  it('invalidates the message query on settled (success)', async () => {
    const realMessage = buildMessage({ id: 'msg-real', content: 'hello' })
    vi.mocked(sendMessage).mockResolvedValueOnce({ data: realMessage } as never)

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), { wrapper })

    await act(async () => {
      result.current.mutate('hello')
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: messageKey })
  })

  it('invalidates the message query on settled (error)', async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error('fail'))

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), { wrapper })

    await act(async () => {
      result.current.mutate('will fail')
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: messageKey })
  })
})
