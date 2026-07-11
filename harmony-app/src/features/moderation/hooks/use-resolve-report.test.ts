import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReportListResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'

// WHY a local client with gcTime Infinity: the reports query is seeded via
// setQueryData with no active observer; the shared test client's gcTime:0 would
// garbage-collect it before the cache assertion runs.
function createCacheClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
}

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, resolveReport: vi.fn() }
})

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { resolveReport } = await import('@/lib/api')
const { useResolveReport } = await import('./use-resolve-report')

const SERVER_ID = 'server-1'

function seedReports(): ReportListResponse {
  return {
    items: [{ id: 'r1' } as never, { id: 'r2' } as never],
    openCount: 2,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useResolveReport', () => {
  it('optimistically drops the row and decrements openCount', async () => {
    vi.mocked(resolveReport).mockResolvedValueOnce({ data: { id: 'r1' } } as never)

    const queryClient = createCacheClient()
    queryClient.setQueryData(queryKeys.servers.reports(SERVER_ID), seedReports())
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useResolveReport(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ reportId: 'r1', status: 'resolved' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(resolveReport).toHaveBeenCalledWith({
      path: { id: SERVER_ID, report_id: 'r1' },
      body: { status: 'resolved' },
      throwOnError: true,
    })
    const cached = queryClient.getQueryData<ReportListResponse>(
      queryKeys.servers.reports(SERVER_ID),
    )
    expect(cached?.items.map((r) => r.id)).toEqual(['r2'])
    expect(cached?.openCount).toBe(1)
  })

  it('reverts the optimistic patch on error', async () => {
    vi.mocked(resolveReport).mockRejectedValueOnce(new Error('boom'))

    const queryClient = createCacheClient()
    queryClient.setQueryData(queryKeys.servers.reports(SERVER_ID), seedReports())
    const wrapper = createQueryWrapper(queryClient)
    const { result } = renderHook(() => useResolveReport(SERVER_ID), { wrapper })

    await act(async () => {
      result.current.mutate({ reportId: 'r1', status: 'dismissed' })
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    const cached = queryClient.getQueryData<ReportListResponse>(
      queryKeys.servers.reports(SERVER_ID),
    )
    expect(cached?.items.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(cached?.openCount).toBe(2)
  })
})
