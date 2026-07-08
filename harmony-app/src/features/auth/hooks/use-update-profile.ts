import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProfileResponse, UpdateProfileRequest } from '@/lib/api'
import { updateMyProfile } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY: Wraps the updateMyProfile SDK in a mutation with optimistic cache
 * updates so profile edits (display name, custom status, avatar) reflect
 * instantly in the UI. Follows the useUpdateChannel reference pattern
 * (onMutate → onError rollback → onSettled invalidate).
 *
 * PATCH semantics: omitted field = unchanged, explicit `null` = cleared.
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient()
  const profileKey = queryKeys.profiles.me()

  return useMutation({
    mutationFn: async (input: UpdateProfileRequest) => {
      const { data } = await updateMyProfile({
        body: input,
        throwOnError: true,
      })
      return data
    },

    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: profileKey })

      const previous = queryClient.getQueryData<ProfileResponse>(profileKey)

      queryClient.setQueryData<ProfileResponse>(profileKey, (old) => {
        if (old === undefined) return undefined
        // WHY `!== undefined`: null is a meaningful value (clears the field),
        // only absent keys mean "unchanged" — mirror the API's patch contract.
        return {
          ...old,
          ...(input.displayName !== undefined && { displayName: input.displayName }),
          ...(input.customStatus !== undefined && { customStatus: input.customStatus }),
          ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
        }
      })

      return { previous }
    },

    onError: (error, _variables, context) => {
      // WHY rollback: restore the pre-mutation profile so the optimistic
      // change visually reverts on failure.
      if (context?.previous) {
        queryClient.setQueryData(profileKey, context.previous)
      }
      logger.error('update_profile_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // WHY no toast: the profile settings modal renders this mutation's
      // error inline next to the controls — the preferred feedback level
      // for an explicit user action (ADR-045 hierarchy: inline > toast).
    },

    onSettled: () => {
      // WHY invalidate: eventual consistency regardless of whether the
      // optimistic update matched what the server persisted.
      queryClient.invalidateQueries({ queryKey: profileKey })
    },
  })
}
