import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListNotificationSettingsResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  listNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  toastApiError: vi.fn(),
}))

vi.mock('i18next', () => ({
  default: { t: vi.fn((key: string) => key) },
}))

const { listNotificationSettings, updateNotificationSettings } = await import('@/lib/api')
const { toastApiError } = await import('@/lib/toast')
const { useNotificationSettingsMap } = await import('@/features/notifications')
const { useUpdateNotificationSettings } = await import('./use-update-notification-settings')

const CHANNEL_ID = 'channel-1'

function buildEnvelope(
  items: ListNotificationSettingsResponse['items'],
): ListNotificationSettingsResponse {
  return { items, total: items.length, nextCursor: null }
}

/**
 * Mounts the mutation together with the live bulk-map observer — asserting
 * what the notification policy and bell popover actually read (reactivity pin:
 * a bell change is honored by the next event, no refetch).
 */
function renderHooks(seed?: ListNotificationSettingsResponse) {
  const queryClient = createTestQueryClient()
  if (seed !== undefined) {
    queryClient.setQueryData(queryKeys.notificationSettings.mine(), seed)
  }

  const rendered = renderHook(
    () => ({
      update: useUpdateNotificationSettings(CHANNEL_ID),
      map: useNotificationSettingsMap(),
    }),
    { wrapper: createQueryWrapper(queryClient) },
  )

  return { queryClient, ...rendered }
}

describe('useUpdateNotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listNotificationSettings).mockReturnValue(new Promise(() => {}) as never)
  })

  it('sends the PATCH with throwOnError', async () => {
    vi.mocked(updateNotificationSettings).mockResolvedValueOnce({} as never)

    const { result } = renderHooks(buildEnvelope([]))

    await act(async () => {
      result.current.update.mutate('none')
    })
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true))

    expect(updateNotificationSettings).toHaveBeenCalledWith({
      path: { id: CHANNEL_ID },
      body: { level: 'none' },
      throwOnError: true,
    })
  })

  it('optimistically writes the level into the bulk map before the request resolves', async () => {
    vi.mocked(updateNotificationSettings).mockReturnValueOnce(new Promise(() => {}) as never)

    const { result } = renderHooks(buildEnvelope([{ channelId: 'channel-2', level: 'mentions' }]))

    await act(async () => {
      result.current.update.mutate('none')
    })

    await waitFor(() => expect(result.current.map.data?.[CHANNEL_ID]).toBe('none'))
    // Sibling overrides untouched.
    expect(result.current.map.data?.['channel-2']).toBe('mentions')
  })

  it('replaces an existing override for the same channel (no duplicates)', async () => {
    vi.mocked(updateNotificationSettings).mockReturnValueOnce(new Promise(() => {}) as never)

    const { result, queryClient } = renderHooks(
      buildEnvelope([{ channelId: CHANNEL_ID, level: 'mentions' }]),
    )

    await act(async () => {
      result.current.update.mutate('all')
    })

    await waitFor(() => expect(result.current.map.data?.[CHANNEL_ID]).toBe('all'))
    const raw = queryClient.getQueryData<ListNotificationSettingsResponse>(
      queryKeys.notificationSettings.mine(),
    )
    expect(raw?.items.filter((i) => i.channelId === CHANNEL_ID)).toHaveLength(1)
    expect(raw?.total).toBe(1)
  })

  it('rolls back the map on error and toasts', async () => {
    vi.mocked(updateNotificationSettings).mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHooks(buildEnvelope([{ channelId: CHANNEL_ID, level: 'all' }]))

    await act(async () => {
      result.current.update.mutate('none')
    })
    await waitFor(() => expect(result.current.update.isError).toBe(true))

    await waitFor(() => expect(result.current.map.data?.[CHANNEL_ID]).toBe('all'))
    expect(toastApiError).toHaveBeenCalledOnce()
  })
})
