import type { InfiniteData } from '@tanstack/react-query'
import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MessageListResponse, MessageResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import type { SendMessageEncryption } from './use-send-message'
import { useSendMessage } from './use-send-message'

vi.mock('@/lib/api', () => ({
  sendMessage: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
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
    messageType: 'default',
    mentions: [],
    attachments: [],
    isPinned: false,
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
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'hello' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith({
      path: { id: CHANNEL_ID },
      body: { content: 'hello' },
      throwOnError: true,
    })
  })

  it('never sends a mention field on the plaintext path (server re-parses authoritatively)', async () => {
    const serverMessage = buildMessage({ id: 'msg-plain', content: 'hello' })
    vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

    const queryClient = createMutationTestClient()
    queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({
        content: 'hi <@f47ac10b-58cc-4372-a567-0e02b2c3d479>',
        mentions: [
          {
            userId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            username: 'alice',
            displayName: 'Alice',
            nickname: null,
          },
        ],
      })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const body = vi.mocked(sendMessage).mock.calls[0]?.[0]?.body
    expect(body?.content).toBe('hi <@f47ac10b-58cc-4372-a567-0e02b2c3d479>')
    expect(Object.keys(body ?? {})).not.toContain('mentionedUserIds')
  })

  it('includes attachments in the request body and seeds the optimistic message for instant render', async () => {
    let resolveMutation!: (value: unknown) => void
    vi.mocked(sendMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        }) as never,
    )

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    const attachment = {
      url: 'https://cdn/storage/v1/object/public/attachments/user-1/pic.webp',
      mime: 'image/webp',
      size: 4096,
      width: 800,
      height: 600,
    }
    await act(async () => {
      result.current.mutate({ content: '', attachments: [attachment] })
    })

    // Body carries the attachment (image-only message allowed, D10).
    const body = vi.mocked(sendMessage).mock.calls[0]?.[0]?.body
    expect(body?.attachments).toEqual([attachment])

    // Optimistic message renders the sender's own image instantly (REACTIVITY).
    const optimistic =
      queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)?.pages[0]?.items[0]
    expect(optimistic?.attachments).toHaveLength(1)
    expect(optimistic?.attachments[0]?.url).toBe(attachment.url)
    expect(optimistic?.attachments[0]?.width).toBe(800)
    expect(optimistic?.attachments[0]?.id).toContain('temp-')

    resolveMutation({ data: buildMessage({ id: 'msg-real' }) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('OMITS the attachments key entirely when there are none (never [] or null)', async () => {
    const serverMessage = buildMessage({ id: 'msg-plain', content: 'hello' })
    vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

    const queryClient = createMutationTestClient()
    queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'hello' })
    })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const body = vi.mocked(sendMessage).mock.calls[0]?.[0]?.body
    expect(Object.keys(body ?? {})).not.toContain('attachments')
  })

  it('seeds the optimistic message mentions from the composer map for instant pills', async () => {
    let resolveMutation!: (value: unknown) => void
    vi.mocked(sendMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        }) as never,
    )

    const queryClient = createMutationTestClient()
    const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
    queryClient.setQueryData(messageKey, buildCacheData([]))

    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    const mention = {
      userId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      username: 'alice',
      displayName: 'Alice',
      nickname: null,
    }
    await act(async () => {
      result.current.mutate({
        content: 'hi <@f47ac10b-58cc-4372-a567-0e02b2c3d479>',
        mentions: [mention],
      })
    })

    const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
    expect(cacheData?.pages[0]?.items[0]?.mentions).toEqual([mention])

    resolveMutation({ data: buildMessage({ id: 'msg-real' }) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
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
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'optimistic text' })
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
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'hello' })
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
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'will fail' })
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
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'hello' })
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
    const { result } = renderHook(() => useSendMessage(CHANNEL_ID, USER_ID, 'testuser'), {
      wrapper,
    })

    await act(async () => {
      result.current.mutate({ content: 'will fail' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: messageKey })
  })

  describe('with encryption', () => {
    function buildEncryption(
      overrides: Partial<SendMessageEncryption> = {},
    ): SendMessageEncryption {
      return {
        encryptFn: vi.fn().mockResolvedValue({
          content: '{"message_type":0,"ciphertext":"abc"}',
          senderDeviceId: 'device-1',
        }),
        cachePlaintext: vi.fn(),
        ...overrides,
      }
    }

    it('sends encrypted content when encryptFn succeeds', async () => {
      const encryption = buildEncryption()
      const serverMessage = buildMessage({ id: 'msg-enc', encrypted: true })
      vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

      const queryClient = createMutationTestClient()
      queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({ content: 'secret hello' })
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(encryption.encryptFn).toHaveBeenCalledWith('secret hello')
      expect(sendMessage).toHaveBeenCalledWith({
        path: { id: CHANNEL_ID },
        body: {
          content: '{"message_type":0,"ciphertext":"abc"}',
          encrypted: true,
          senderDeviceId: 'device-1',
        },
        throwOnError: true,
      })
    })

    it('caches plaintext after successful encrypted send', async () => {
      const encryption = buildEncryption()
      const serverMessage = buildMessage({ id: 'msg-enc-2', encrypted: true })
      vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

      const queryClient = createMutationTestClient()
      queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({ content: 'cache me' })
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      expect(encryption.cachePlaintext).toHaveBeenCalledWith('msg-enc-2', CHANNEL_ID, 'cache me')
    })

    it('does NOT send plaintext and rejects the mutation when encryptFn throws', async () => {
      // WHY regression (privacy-critical): An encryption failure in an encrypted
      // context must never silently downgrade to a cleartext send. The mutation
      // must reject so onError surfaces feedback and nothing reaches the server
      // in plaintext. See use-send-message.ts mutationFn "fail-closed" comment.
      const encryption = buildEncryption({
        encryptFn: vi.fn().mockRejectedValue(new Error('No pre-keys available')),
      })

      const queryClient = createMutationTestClient()
      queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({ content: 'must not leak' })
      })

      await waitFor(() => expect(result.current.isError).toBe(true))

      // The message API must never be invoked once encryption fails: no plaintext
      // send, no ciphertext send — nothing is persisted server-side.
      expect(sendMessage).not.toHaveBeenCalled()
      // Nothing is cached as plaintext either (the message was not sent).
      expect(encryption.cachePlaintext).not.toHaveBeenCalled()
      // The rejection carries a user-meaningful message for the onError path.
      expect(result.current.error?.message).toBe(
        'Message not sent — could not encrypt it. Your recipient may not have encryption set up.',
      )
    })

    it('logs a warning breadcrumb when encryption fails', async () => {
      const encryption = buildEncryption({
        encryptFn: vi.fn().mockRejectedValue(new Error('No pre-keys available')),
      })

      const queryClient = createMutationTestClient()
      queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({ content: 'hello' })
      })

      await waitFor(() => expect(result.current.isError).toBe(true))

      expect(logger.warn).toHaveBeenCalledWith('dm_encryption_failed_message_not_sent', {
        channelId: CHANNEL_ID,
        error: 'No pre-keys available',
      })
    })

    it('includes mentionedUserIds in the encrypted request body when mentions are present', async () => {
      const encryption = buildEncryption()
      const serverMessage = buildMessage({ id: 'msg-enc-m', encrypted: true })
      vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

      const queryClient = createMutationTestClient()
      queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({
          content: 'hi <@f47ac10b-58cc-4372-a567-0e02b2c3d479>',
          mentions: [
            {
              userId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
              username: 'alice',
              displayName: 'Alice',
              nickname: null,
            },
          ],
        })
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      const body = vi.mocked(sendMessage).mock.calls[0]?.[0]?.body
      expect(body?.mentionedUserIds).toEqual(['f47ac10b-58cc-4372-a567-0e02b2c3d479'])
    })

    it('OMITS the mentionedUserIds key entirely when there are no mentions (never [] or null)', async () => {
      // WHY pinned: spec §3.1 house rule + §8 version skew — an old API instance
      // with deny_unknown_fields would 400 every encrypted send carrying the key.
      const encryption = buildEncryption()
      const serverMessage = buildMessage({ id: 'msg-enc-nm', encrypted: true })
      vi.mocked(sendMessage).mockResolvedValueOnce({ data: serverMessage } as never)

      const queryClient = createMutationTestClient()
      queryClient.setQueryData(queryKeys.messages.byChannel(CHANNEL_ID), buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({ content: 'no mentions here' })
      })

      await waitFor(() => expect(result.current.isSuccess).toBe(true))

      const body = vi.mocked(sendMessage).mock.calls[0]?.[0]?.body
      expect(body).toBeDefined()
      // Key-absence assertion — toHaveBeenCalledWith treats undefined values
      // as equal to missing keys, which would let a `mentionedUserIds: undefined`
      // regression slip through.
      expect(Object.keys(body ?? {})).not.toContain('mentionedUserIds')
    })

    it('optimistic message always has encrypted: false even with encryption param', async () => {
      const encryption = buildEncryption()
      let resolveMutation!: (value: unknown) => void
      vi.mocked(sendMessage).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMutation = resolve
          }) as never,
      )

      const queryClient = createMutationTestClient()
      const messageKey = queryKeys.messages.byChannel(CHANNEL_ID)
      queryClient.setQueryData(messageKey, buildCacheData([]))

      const wrapper = createQueryWrapper(queryClient)
      const { result } = renderHook(
        () => useSendMessage(CHANNEL_ID, USER_ID, 'testuser', encryption),
        { wrapper },
      )

      await act(async () => {
        result.current.mutate({ content: 'check optimistic' })
      })

      const cacheData = queryClient.getQueryData<InfiniteData<MessageListResponse>>(messageKey)
      const optimistic = cacheData?.pages[0]?.items[0]

      expect(optimistic?.encrypted).toBe(false)
      expect(optimistic?.content).toBe('check optimistic')

      resolveMutation({ data: buildMessage({ id: 'msg-real', encrypted: true }) })
      await waitFor(() => expect(result.current.isSuccess).toBe(true))
    })
  })
})
