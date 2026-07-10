import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MemberListResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useIsFounding } from './use-is-founding'

const SERVER_ID = 'server-1'

function seed(items: Array<{ userId: string; isFounding: boolean }>) {
  const queryClient = createTestQueryClient()
  const data: MemberListResponse = {
    items: items.map((m) => ({
      userId: m.userId,
      username: 'u',
      nickname: null,
      role: 'member',
      isFounding: m.isFounding,
      joinedAt: '2026-01-01T00:00:00Z',
    })),
    nextCursor: null,
  }
  queryClient.setQueryData(queryKeys.servers.members(SERVER_ID), data)
  return queryClient
}

describe('useIsFounding', () => {
  it('returns true when the member is founding in the cached list', () => {
    const queryClient = seed([{ userId: 'user-1', isFounding: true }])
    const { result } = renderHook(() => useIsFounding('user-1', SERVER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })
    expect(result.current).toBe(true)
  })

  it('returns false when the member is not founding', () => {
    const queryClient = seed([{ userId: 'user-1', isFounding: false }])
    const { result } = renderHook(() => useIsFounding('user-1', SERVER_ID), {
      wrapper: createQueryWrapper(queryClient),
    })
    expect(result.current).toBe(false)
  })

  it('returns false with no server context (DMs) or before the member is cached', () => {
    const noServer = renderHook(() => useIsFounding('user-1', null), {
      wrapper: createQueryWrapper(createTestQueryClient()),
    })
    expect(noServer.result.current).toBe(false)

    const notCached = renderHook(() => useIsFounding('ghost', SERVER_ID), {
      wrapper: createQueryWrapper(seed([{ userId: 'user-1', isFounding: true }])),
    })
    expect(notCached.result.current).toBe(false)
  })
})
