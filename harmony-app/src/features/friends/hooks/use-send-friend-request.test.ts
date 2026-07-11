import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { addFriendErrorKey, useSendFriendRequest } from './use-send-friend-request'

vi.mock('@/lib/api', () => ({
  sendRequest: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { sendRequest } = await import('@/lib/api')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('addFriendErrorKey', () => {
  it('maps HTTP status codes to inline i18n keys', () => {
    expect(addFriendErrorKey({ status: 403, detail: 'x' })).toBe('friends:cannotAddUser')
    expect(addFriendErrorKey({ status: 404, detail: 'x' })).toBe('friends:userNotFound')
    expect(addFriendErrorKey({ status: 429, detail: 'x' })).toBe('friends:requestsRateLimited')
    expect(
      addFriendErrorKey({ status: 409, detail: 'You have too many pending friend requests' }),
    ).toBe('friends:pendingCap')
    expect(addFriendErrorKey({ status: 409, detail: 'Friends list is full' })).toBe(
      'friends:friendsCap',
    )
  })

  it('falls back to a generic key for non-ProblemDetails errors', () => {
    expect(addFriendErrorKey(new Error('boom'))).toBe('friends:addFriendFailed')
  })
})

describe('useSendFriendRequest', () => {
  it('invalidates the friends list on an autoAccepted result', async () => {
    vi.mocked(sendRequest).mockResolvedValueOnce({
      data: { state: 'autoAccepted', user: { id: 'u2', username: 'bob' }, createdAt: 'now' },
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useSendFriendRequest())
    const spy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ username: 'bob' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.friends.list() })
  })

  it('does not invalidate the friends list on a plain pending request', async () => {
    vi.mocked(sendRequest).mockResolvedValueOnce({
      data: { state: 'pendingOutgoing', user: { id: 'u2', username: 'bob' }, createdAt: 'now' },
    } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useSendFriendRequest())
    const spy = vi.spyOn(queryClient, 'invalidateQueries')

    result.current.mutate({ username: 'bob' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(spy).not.toHaveBeenCalledWith({ queryKey: queryKeys.friends.list() })
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.friends.requests('outgoing') })
  })
})
