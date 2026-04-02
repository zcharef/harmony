import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { DmListItem, DmListResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useDms } from './use-dms'

vi.mock('@/lib/api', () => ({
  listDms: vi.fn(),
}))

const { listDms } = await import('@/lib/api')

function buildDmItem(overrides: Partial<DmListItem> = {}): DmListItem {
  return {
    serverId: 'srv-dm-1',
    channelId: 'ch-dm-1',
    recipient: {
      id: 'user-2',
      username: 'alice',
      avatarUrl: null,
      displayName: null,
    },
    lastMessage: null,
    ...overrides,
  }
}

describe('useDms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches DM list with throwOnError and returns items', async () => {
    const items = [buildDmItem(), buildDmItem({ serverId: 'srv-dm-2', channelId: 'ch-dm-2' })]
    const response: DmListResponse = { items, nextCursor: null }
    vi.mocked(listDms).mockResolvedValueOnce({ data: response } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useDms(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(listDms).toHaveBeenCalledOnce()
    expect(listDms).toHaveBeenCalledWith({ throwOnError: true })
    expect(result.current.data).toHaveLength(2)
    expect(result.current.data?.[0]?.serverId).toBe('srv-dm-1')
  })

  it('returns empty array when user has no DMs', async () => {
    const response: DmListResponse = { items: [], nextCursor: null }
    vi.mocked(listDms).mockResolvedValueOnce({ data: response } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useDms(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual([])
  })
})
