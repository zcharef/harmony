import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { UpdateUserPreferencesRequest, UserPreferencesResponse } from '@/lib/api'
import { updatePreferences } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Optimistic mutation for PATCH /v1/preferences (204 response).
 * Sets cache immediately on mutate, rolls back on error.
 * No invalidateQueries in onSettled — optimistic update is final (no SSE sync in v1).
 */
export function useUpdatePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (patch: UpdateUserPreferencesRequest) => {
      await updatePreferences({
        body: patch,
        throwOnError: true,
      })
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.preferences.me() })

      const previousData = queryClient.getQueryData<UserPreferencesResponse>(
        queryKeys.preferences.me(),
      )

      // WHY every field: this literal rebuilds the whole cache entry — omitting
      // a field here would erase it on the next unrelated toggle (§5.7).
      queryClient.setQueryData<UserPreferencesResponse>(queryKeys.preferences.me(), (old) => ({
        dndEnabled: patch.dndEnabled ?? old?.dndEnabled ?? false,
        hideProfanity: patch.hideProfanity ?? old?.hideProfanity ?? true,
        onboardingCompleted: patch.onboardingCompleted ?? old?.onboardingCompleted ?? false,
        notificationsEnabled: patch.notificationsEnabled ?? old?.notificationsEnabled ?? true,
        notifyMessages: patch.notifyMessages ?? old?.notifyMessages ?? true,
        notifyDms: patch.notifyDms ?? old?.notifyDms ?? true,
        notifyMentions: patch.notifyMentions ?? old?.notifyMentions ?? true,
        notificationSoundsEnabled:
          patch.notificationSoundsEnabled ?? old?.notificationSoundsEnabled ?? true,
        updatedAt: new Date().toISOString(),
      }))

      return { previousData }
    },
    onError: (error, _patch, context) => {
      // WHY: Rollback defaults to the server-default object when no previous
      // cache entry exists (first-ever toggle, no GET has resolved yet).
      queryClient.setQueryData<UserPreferencesResponse>(
        queryKeys.preferences.me(),
        context?.previousData ?? {
          dndEnabled: false,
          hideProfanity: true,
          onboardingCompleted: false,
          notificationsEnabled: true,
          notifyMessages: true,
          notifyDms: true,
          notifyMentions: true,
          notificationSoundsEnabled: true,
          updatedAt: new Date().toISOString(),
        },
      )

      logger.error('update_preferences_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('preferences.updateFailed')))
    },
  })
}
