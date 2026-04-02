import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { type BanUserRequest, banMember } from '@/lib/api'
import { getApiErrorDetail } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

export function useBanMember(serverId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: BanUserRequest) => {
      const { data } = await banMember({
        path: { id: serverId },
        body: input,
        throwOnError: true,
      })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.members(serverId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.servers.bans(serverId) })
    },
    onError: (error) => {
      logger.error('Failed to ban member', {
        serverId,
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error(getApiErrorDetail(error, i18n.t('members:banFailed')))
    },
  })
}
