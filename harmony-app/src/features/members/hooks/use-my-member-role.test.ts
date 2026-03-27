import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { MemberListResponse, MemberResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useMyMemberRole } from './use-my-member-role'

vi.mock('@/lib/api', () => ({
  listMembers: vi.fn(),
}))

// WHY: useMyMemberRole depends on useAuthStore (for currentUserId) and
// useMembers (which calls listMembers). Mock both to control test state.
vi.mock('@/features/auth', () => ({
  useAuthStore: vi.fn(),
}))

const { listMembers } = await import('@/lib/api')
const { useAuthStore } = await import('@/features/auth')

const CURRENT_USER_ID = 'user-current'
const SERVER_ID = 'srv-1'

function buildMember(overrides: Partial<MemberResponse> = {}): MemberResponse {
  return {
    userId: 'user-other',
    role: 'member',
    joinedAt: '2026-03-16T00:00:00.000Z',
    nickname: null,
    avatarUrl: null,
    username: 'otheruser',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // WHY: useAuthStore is called with selector (s) => s.user?.id ?? ''.
  // Return current user's ID for all tests.
  vi.mocked(useAuthStore).mockImplementation((selector: unknown) =>
    (selector as (s: { user: { id: string } }) => string)({ user: { id: CURRENT_USER_ID } }),
  )
})

describe('useMyMemberRole', () => {
  it('returns "member" as default when data is loading', () => {
    // WHY: While listMembers is pending, useMembers returns undefined data.
    // useMyMemberRole defaults to 'member' with isLoading=true.
    vi.mocked(listMembers).mockImplementation(
      () => new Promise(() => {}) as never, // never resolves
    )

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    expect(result.current.role).toBe('member')
    expect(result.current.isLoading).toBe(true)
  })

  it('resolves owner role when current user is server owner', async () => {
    const members: MemberListResponse = {
      items: [
        buildMember({ userId: CURRENT_USER_ID, role: 'owner', username: 'me' }),
        buildMember({ userId: 'user-other', role: 'member' }),
      ],
      total: 2,
    }
    vi.mocked(listMembers).mockResolvedValueOnce({ data: members } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.role).toBe('owner')
    expect(result.current.isError).toBe(false)
  })

  it('resolves admin role when current user is admin', async () => {
    const members: MemberListResponse = {
      items: [buildMember({ userId: CURRENT_USER_ID, role: 'admin', username: 'me' })],
      total: 1,
    }
    vi.mocked(listMembers).mockResolvedValueOnce({ data: members } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.role).toBe('admin')
  })

  it('resolves moderator role when current user is moderator', async () => {
    const members: MemberListResponse = {
      items: [buildMember({ userId: CURRENT_USER_ID, role: 'moderator', username: 'me' })],
      total: 1,
    }
    vi.mocked(listMembers).mockResolvedValueOnce({ data: members } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.role).toBe('moderator')
  })

  it('defaults to "member" when current user is not in the members list', async () => {
    const members: MemberListResponse = {
      items: [buildMember({ userId: 'user-someone-else', role: 'owner' })],
      total: 1,
    }
    vi.mocked(listMembers).mockResolvedValueOnce({ data: members } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.role).toBe('member')
  })

  it('defaults to "member" when role string is unrecognized', async () => {
    // WHY: getMemberRole falls back to 'member' for unrecognized role strings.
    // The SDK types role as string, so the API could return a new role value.
    const members: MemberListResponse = {
      items: [buildMember({ userId: CURRENT_USER_ID, role: 'superadmin' })],
      total: 1,
    }
    vi.mocked(listMembers).mockResolvedValueOnce({ data: members } as never)

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.role).toBe('member')
  })

  it('returns isError=true when listMembers rejects', async () => {
    vi.mocked(listMembers).mockRejectedValueOnce(new Error('Network failure'))

    const queryClient = createTestQueryClient()
    const wrapper = createQueryWrapper(queryClient)

    const { result } = renderHook(() => useMyMemberRole(SERVER_ID), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))

    // WHY: Even on error, role defaults to 'member' (safe default).
    expect(result.current.role).toBe('member')
  })
})
