import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ProfileResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useCurrentProfile } from './use-current-profile'

vi.mock('@/lib/api', () => ({
  getMyProfile: vi.fn(),
}))

// WHY: Mock the auth store to control the session state.
// useCurrentProfile reads session from useAuthStore to gate the query.
vi.mock('../stores/auth-store', () => ({
  useAuthStore: vi.fn(),
}))

const { getMyProfile } = await import('@/lib/api')
const { useAuthStore } = await import('../stores/auth-store')

const mockProfile: ProfileResponse = {
  id: 'user-1',
  username: 'testuser',
  displayName: 'Test User',
  avatarUrl: null,
  customStatus: null,
  status: 'online',
  createdAt: '2026-03-16T00:00:00.000Z',
  updatedAt: '2026-03-16T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useCurrentProfile', () => {
  it('is disabled when session is null', () => {
    // WHY: useAuthStore is called with a selector (s) => s.session.
    // When session is null, enabled=false so the query never fires.
    vi.mocked(useAuthStore).mockImplementation((selector: unknown) =>
      (selector as (s: { session: null }) => null)({ session: null }),
    )

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useCurrentProfile(), { wrapper })

    expect(result.current.isFetching).toBe(false)
    expect(result.current.data).toBeUndefined()
    expect(getMyProfile).not.toHaveBeenCalled()
  })

  it('fetches profile when session exists', async () => {
    const fakeSession = { access_token: 'tok', user: { id: 'user-1' } }
    vi.mocked(useAuthStore).mockImplementation((selector: unknown) =>
      (selector as (s: { session: typeof fakeSession }) => typeof fakeSession)({
        session: fakeSession,
      }),
    )
    vi.mocked(getMyProfile).mockResolvedValueOnce({ data: mockProfile } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useCurrentProfile(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(getMyProfile).toHaveBeenCalledOnce()
    expect(getMyProfile).toHaveBeenCalledWith({ throwOnError: true })
    expect(result.current.data).toEqual(mockProfile)
  })
})
