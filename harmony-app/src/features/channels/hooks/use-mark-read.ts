import { useMutation } from '@tanstack/react-query'
import { markChannelRead } from '@/lib/api'
import { logger } from '@/lib/logger'
import { useUnreadStore } from '../stores/unread-store'

export function useMarkRead() {
  const clear = useUnreadStore((s) => s.clear)

  return useMutation({
    mutationFn: async ({
      channelId,
      lastMessageId,
    }: {
      channelId: string
      lastMessageId: string
    }) => {
      await markChannelRead({
        path: { id: channelId },
        body: { lastMessageId },
        throwOnError: true,
      })
    },
    onSuccess: (_, { channelId }) => {
      clear(channelId)
    },
    onError: (error) => {
      logger.error('mark_read_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
}
