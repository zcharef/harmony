import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { ChannelResponse, UpdateChannelRequest } from '@/lib/api'
import { updateChannel } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Wraps updateChannel SDK in a mutation with optimistic cache
 * updates so toggles respond instantly — both for the local admin
 * and for remote admins receiving SSE channel.updated events.
 */
export function useUpdateChannel(serverId: string, channelId: string) {
  const queryClient = useQueryClient()
  const channelQueryKey = queryKeys.channels.byServer(serverId)

  return useMutation({
    mutationFn: async (input: UpdateChannelRequest) => {
      const { data } = await updateChannel({
        path: { id: serverId, channel_id: channelId },
        body: input,
        throwOnError: true,
      })
      return data
    },

    // WHY: Optimistic update — toggle responds instantly without waiting
    // for the API round-trip. Follows the useSendMessage pattern.
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: channelQueryKey })

      const previous = queryClient.getQueryData<ChannelResponse[]>(channelQueryKey)

      queryClient.setQueryData<ChannelResponse[]>(channelQueryKey, (old) => {
        if (!old) return undefined
        return old.map((c) => {
          if (c.id !== channelId) return c
          // WHY null-filter: UpdateChannelRequest fields are optional/nullable,
          // but ChannelResponse fields are non-nullable. Only spread defined values.
          return {
            ...c,
            ...(input.isPrivate != null && { isPrivate: input.isPrivate }),
            ...(input.isReadOnly != null && { isReadOnly: input.isReadOnly }),
            ...(input.encrypted != null && { encrypted: input.encrypted }),
            ...(input.name != null && { name: input.name }),
            ...(input.topic !== undefined && { topic: input.topic }),
          }
        })
      })

      return { previous }
    },

    onError: (error, _variables, context) => {
      // WHY rollback: Restore cache to pre-mutation state so the toggle
      // visually reverts on failure.
      if (context?.previous) {
        queryClient.setQueryData(channelQueryKey, context.previous)
      }
      logger.error('update_channel_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('channels:updateChannelFailed')))
    },

    onSettled: () => {
      // WHY invalidate: Ensures cache is eventually consistent regardless of
      // whether the optimistic update or SSE delivery worked correctly.
      // Matches the useSendMessage reconciliation pattern.
      queryClient.invalidateQueries({ queryKey: channelQueryKey })
    },
  })
}
