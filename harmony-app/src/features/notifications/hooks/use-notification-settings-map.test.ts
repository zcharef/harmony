import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListNotificationSettingsResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'

vi.mock('@/lib/api', () => ({
  listNotificationSettings: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { listNotificationSettings } = await import('@/lib/api')
const { logger } = await import('@/lib/logger')
const { useNotificationSettingsMap } = await import('./use-notification-settings-map')
const { useChannelNotificationLevel } = await import('./use-channel-notification-level')

const ENVELOPE: ListNotificationSettingsResponse = {
  items: [
    { channelId: 'channel-1', level: 'none' },
    { channelId: 'channel-2', level: 'mentions' },
  ],
  total: 2,
  nextCursor: null,
}

describe('useNotificationSettingsMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('folds the bulk envelope into a channelId → level map', async () => {
    vi.mocked(listNotificationSettings).mockResolvedValueOnce({ data: ENVELOPE } as never)

    const { result } = renderHook(() => useNotificationSettingsMap(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ 'channel-1': 'none', 'channel-2': 'mentions' })
    expect(listNotificationSettings).toHaveBeenCalledWith({ throwOnError: true })
  })

  it('logs a warning on fetch failure (fail-open: map stays undefined)', async () => {
    vi.mocked(listNotificationSettings).mockRejectedValueOnce(new Error('boom'))

    const { result } = renderHook(() => useNotificationSettingsMap(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'notification_settings_bulk_fetch_failed',
      expect.objectContaining({ error: 'boom' }),
    )
  })
})

describe('useChannelNotificationLevel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listNotificationSettings).mockReturnValue(new Promise(() => {}) as never)
  })

  it("selects the channel's override from the shared cache", () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.notificationSettings.mine(), ENVELOPE)

    const { result } = renderHook(() => useChannelNotificationLevel('channel-2'), {
      wrapper: createQueryWrapper(queryClient),
    })

    expect(result.current).toBe('mentions')
  })

  it("defaults to 'all' when no override or no channel is selected", () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.notificationSettings.mine(), ENVELOPE)

    const { result: noOverride } = renderHook(() => useChannelNotificationLevel('channel-99'), {
      wrapper: createQueryWrapper(queryClient),
    })
    expect(noOverride.current).toBe('all')

    const { result: noChannel } = renderHook(() => useChannelNotificationLevel(null), {
      wrapper: createQueryWrapper(queryClient),
    })
    expect(noChannel.current).toBe('all')
  })
})
