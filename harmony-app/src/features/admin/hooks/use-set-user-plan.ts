import { useMutation, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import type { Plan } from '@/lib/api'
import { setUserPlan } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast, toastApiError } from '@/lib/toast'

interface SetPlanInput {
  userId: string
  plan: Plan
}

/**
 * WHY: Founder-only plan change (PATCH /v1/admin/users/{id}/plan). This is an
 * explicit user action, so success and failure both get visible feedback
 * (ADR-045). On success it refreshes the quota + search caches so the panel
 * reflects the new plan live.
 */
export function useSetUserPlan() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ userId, plan }: SetPlanInput) => {
      const { data } = await setUserPlan({
        path: { id: userId },
        body: { plan },
        throwOnError: true,
      })
      return data
    },
    onSuccess: (updated) => {
      toast.success(i18n.t('admin:planUpdated', { plan: i18n.t(`admin:plan_${updated.plan}`) }))
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.userQuota(updated.id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.all })
    },
    onError: (error) => {
      logger.error('Failed to set user plan', {
        error: error instanceof Error ? error.message : String(error),
      })
      toastApiError(error, i18n.t('admin:planUpdateFailed'))
    },
  })
}
