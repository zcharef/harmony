import { waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { ChannelRoleAccessResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { renderHookWithQueryClient } from '@/tests/test-utils'
import { useSetChannelRoleAccess } from './use-set-channel-role-access'

vi.mock('@/lib/api', () => ({
  setChannelRoleAccess: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const { setChannelRoleAccess } = await import('@/lib/api')
const { toast } = await import('@/lib/toast')

const SERVER_ID = 'srv-1'
const CHANNEL_ID = 'ch-1'
const roleAccessKey = queryKeys.channels.roleAccess(CHANNEL_ID)

function seed(roles: ChannelRoleAccessResponse['roles']): ChannelRoleAccessResponse {
  return { channelId: CHANNEL_ID, roles }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useSetChannelRoleAccess', () => {
  it('sends the desired role set with the correct path and throwOnError', async () => {
    vi.mocked(setChannelRoleAccess).mockResolvedValueOnce({ data: seed(['member']) } as never)

    const { result } = renderHookWithQueryClient(() =>
      useSetChannelRoleAccess(SERVER_ID, CHANNEL_ID),
    )

    result.current.mutate(['member'])

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(setChannelRoleAccess).toHaveBeenCalledWith({
      path: { id: SERVER_ID, channel_id: CHANNEL_ID },
      body: { roles: ['member'] },
      throwOnError: true,
    })
  })

  it('optimistically patches the role-access cache in onMutate', async () => {
    // WHY spy (not read-back): the test client has gcTime 0, so an observer-less
    // cache entry is collected after the mutation settles. Asserting the
    // setQueryData updater proves the optimistic patch deterministically.
    let resolve: ((v: unknown) => void) | undefined
    vi.mocked(setChannelRoleAccess).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      }) as never,
    )

    const { result, queryClient } = renderHookWithQueryClient(() =>
      useSetChannelRoleAccess(SERVER_ID, CHANNEL_ID),
    )
    const setSpy = vi.spyOn(queryClient, 'setQueryData')

    result.current.mutate(['moderator'])

    await waitFor(() => expect(setSpy).toHaveBeenCalled())
    const call = setSpy.mock.calls.find(
      ([key]) => JSON.stringify(key) === JSON.stringify(roleAccessKey),
    )
    expect(call).toBeDefined()
    const updater = call?.[1] as (old: ChannelRoleAccessResponse) => ChannelRoleAccessResponse
    expect(updater(seed([])).roles).toEqual(['moderator'])

    resolve?.({ data: seed(['moderator']) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
  })

  it('rolls back to the previous set and toasts on error', async () => {
    vi.mocked(setChannelRoleAccess).mockRejectedValueOnce(new Error('nope'))

    const { result, queryClient } = renderHookWithQueryClient(() =>
      useSetChannelRoleAccess(SERVER_ID, CHANNEL_ID),
    )
    const previous = seed(['member'])
    queryClient.setQueryData<ChannelRoleAccessResponse>(roleAccessKey, previous)
    const setSpy = vi.spyOn(queryClient, 'setQueryData')

    result.current.mutate([])

    await waitFor(() => expect(result.current.isError).toBe(true))

    // onError restores the captured pre-mutation snapshot verbatim.
    const rollback = setSpy.mock.calls.find(
      ([key, value]) => JSON.stringify(key) === JSON.stringify(roleAccessKey) && value === previous,
    )
    expect(rollback).toBeDefined()
    expect(toast.error).toHaveBeenCalledOnce()
  })
})
