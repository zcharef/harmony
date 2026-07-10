import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useMigrationProgress } from './use-migration-progress'

vi.mock('@/lib/api', () => ({
  getMigrationProgress: vi.fn(),
}))

const { getMigrationProgress } = await import('@/lib/api')

const SERVER_ID = 'srv-mig-1'
const mockProgress = {
  serverId: SERVER_ID,
  alive: {
    membersJoinedWeek1: 3,
    nonOwnerActiveWeek1: 1,
    messagesWeek1: 12,
    distinctSendersWeek1: 2,
    activeDaysWeek1: 1,
    thresholds: {
      membersJoined: 5,
      nonOwnerActive: 3,
      messages: 50,
      distinctSenders: 3,
      activeDays: 2,
    },
  },
  followThrough: {
    membersJoined: 8,
    membersActive: 2,
    membersSentMessage: 1,
    notYetActive: 6,
  },
  recommendedAction: 'seed_conversation',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useMigrationProgress', () => {
  it('returns data from getMigrationProgress', async () => {
    vi.mocked(getMigrationProgress).mockResolvedValue({ data: mockProgress } as never)

    const { result } = renderHookWithQueryClient(() => useMigrationProgress(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toEqual(mockProgress)
    expect(result.current.data?.followThrough.notYetActive).toBe(6)
  })

  it('calls getMigrationProgress with the correct path and throwOnError', async () => {
    vi.mocked(getMigrationProgress).mockResolvedValue({ data: mockProgress } as never)

    const { result } = renderHookWithQueryClient(() => useMigrationProgress(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(getMigrationProgress).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      throwOnError: true,
    })
  })

  it('is disabled and does not fetch when serverId is null', () => {
    const { result } = renderHookWithQueryClient(() => useMigrationProgress(null))

    expect(result.current.fetchStatus).toBe('idle')
    expect(getMigrationProgress).not.toHaveBeenCalled()
  })

  it('uses the correct query key based on serverId', async () => {
    vi.mocked(getMigrationProgress).mockResolvedValue({ data: mockProgress } as never)

    const { result, queryClient } = renderHookWithQueryClient(() => useMigrationProgress(SERVER_ID))

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    const cached = queryClient.getQueryData(queryKeys.servers.migrationProgress(SERVER_ID))
    expect(cached).toEqual(mockProgress)
  })
})
