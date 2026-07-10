import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { ChannelRoleAccessResponse, Role } from '@/lib/api'
import { setChannelRoleAccess } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY: Replaces the full grant set of a private channel (PUT replace-the-set
 * semantics — race-safe, matches the toggle UI). Optimistic on the role-access
 * cache so a toggle flips instantly; rollback + toast on error (ADR-045). The
 * SSE `channel.access_updated` broadcast reconciles other admins' open dialogs.
 */
export function useSetChannelRoleAccess(serverId: string, channelId: string) {
  const queryClient = useQueryClient()
  const roleAccessKey = queryKeys.channels.roleAccess(channelId)

  return useMutation({
    mutationFn: async (roles: Role[]) => {
      const { data } = await setChannelRoleAccess({
        path: { id: serverId, channel_id: channelId },
        body: { roles },
        throwOnError: true,
      })
      return data
    },

    // WHY optimistic: the switch reads from the query cache (no useState shadow,
    // ADR-045), so patching the cache here flips it without waiting on the API.
    onMutate: async (roles) => {
      await queryClient.cancelQueries({ queryKey: roleAccessKey })
      const previous = queryClient.getQueryData<ChannelRoleAccessResponse>(roleAccessKey)
      queryClient.setQueryData<ChannelRoleAccessResponse>(roleAccessKey, (old) => {
        if (old === undefined) return old
        return { ...old, roles }
      })
      return { previous }
    },

    onError: (error, _roles, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(roleAccessKey, context.previous)
      }
      logger.error('set_channel_role_access_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('settings:channelAccessSaveError')))
    },

    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: roleAccessKey })
    },
  })
}
