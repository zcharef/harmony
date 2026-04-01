import { useMutation } from '@tanstack/react-query'
import { leaveServer } from '@/lib/api'
import { logger } from '@/lib/logger'
import { toast } from '@/lib/toast'

/**
 * WHY no cache cleanup here: The backend emits ForceDisconnect(reason="left")
 * which the SSE stream delivers to the caller. useForceDisconnect (mounted in
 * MainLayout) handles cache invalidation + navigation on receipt.
 */
export function useLeaveServer() {
  return useMutation({
    mutationFn: async (serverId: string) => {
      await leaveServer({
        path: { id: serverId },
        throwOnError: true,
      })
    },
    onError: (error) => {
      logger.error('leave_server_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      toast.error('Failed to leave server')
    },
  })
}
