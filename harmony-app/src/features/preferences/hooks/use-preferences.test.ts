import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { UserPreferencesResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { usePreferences } from './use-preferences'

vi.mock('@/lib/api', () => ({
  getPreferences: vi.fn(),
}))

const { getPreferences } = await import('@/lib/api')

describe('usePreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // WHY this matters: "DND persists across reload" — a fresh app boot has no
  // cache, so the hook must fetch the server-persisted row (SSoT) on mount.
  it('fetches server-persisted preferences with throwOnError on mount', async () => {
    const serverPreferences: UserPreferencesResponse = {
      dndEnabled: true,
      hideProfanity: false,
      onboardingCompleted: true,
      notificationsEnabled: true,
      notifyMessages: true,
      notifyDms: true,
      notifyMentions: true,
      notificationSoundsEnabled: true,
      updatedAt: '2026-04-02T00:00:00.000Z',
    }
    vi.mocked(getPreferences).mockResolvedValueOnce({ data: serverPreferences } as never)

    const queryClient = createTestQueryClient()
    const { result } = renderHook(() => usePreferences(), {
      wrapper: createQueryWrapper(queryClient),
    })

    expect(result.current.isPending).toBe(true)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(getPreferences).toHaveBeenCalledWith({ throwOnError: true })
    expect(result.current.data).toEqual(serverPreferences)
  })
})
