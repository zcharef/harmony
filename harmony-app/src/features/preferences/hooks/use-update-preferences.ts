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

      queryClient.setQueryData<UserPreferencesResponse>(queryKeys.preferences.me(), (old) => ({
        dndEnabled: patch.dndEnabled ?? old?.dndEnabled ?? false,
        hideProfanity: patch.hideProfanity ?? old?.hideProfanity ?? true,
        updatedAt: new Date().toISOString(),
      }))

      return { previousData }
    },
    onError: (error, _patch, context) => {
      // WHY: Rollback defaults to dndEnabled: false, hideProfanity: true when no previous cache entry
      // (first-ever toggle, no GET has resolved yet).
      queryClient.setQueryData<UserPreferencesResponse>(
        queryKeys.preferences.me(),
        context?.previousData ?? {
          dndEnabled: false,
          hideProfanity: true,
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
