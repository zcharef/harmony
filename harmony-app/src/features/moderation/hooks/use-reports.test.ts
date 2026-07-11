import { renderHook, waitFor } from '@testing-library/react'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, listReports: vi.fn() }
})

const { listReports } = await import('@/lib/api')
const { useReports } = await import('./use-reports')

const SERVER_ID = 'server-1'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useReports', () => {
  it('fetches open reports and exposes openCount', async () => {
    const payload = {
      items: [
        {
          id: 'report-1',
          serverId: SERVER_ID,
          channelId: 'chan-1',
          messageId: 'msg-1',
          reporterId: 'user-2',
          reporterUsername: 'reporter',
          reportedUserId: 'user-3',
          reportedUsername: 'badguy',
          reason: 'spam',
          status: 'open',
          message: { deleted: false, encrypted: false, snippet: 'buy now' },
          createdAt: '2026-07-01T00:00:00Z',
        },
      ],
      openCount: 4,
    }
    vi.mocked(listReports).mockResolvedValueOnce({ data: payload } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useReports(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(listReports).toHaveBeenCalledWith({
      path: { id: SERVER_ID },
      query: { status: 'open' },
      throwOnError: true,
    })
    expect(result.current.data?.openCount).toBe(4)
    expect(result.current.data?.items).toHaveLength(1)
  })

  it('does not fetch when disabled (below moderator)', () => {
    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)
    renderHook(() => useReports(SERVER_ID, false), { wrapper })

    expect(listReports).not.toHaveBeenCalled()
    const queries = queryClient.getQueryCache().findAll({
      queryKey: queryKeys.servers.reports(SERVER_ID),
    })
    // Registered but idle (enabled: false).
    expect(queries[0]?.state.fetchStatus).toBe('idle')
  })
})
