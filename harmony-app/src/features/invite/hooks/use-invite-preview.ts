import { useQuery } from '@tanstack/react-query'
import { previewInvite } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { queryKeys } from '@/lib/query-keys'

/** Whether an error from the preview endpoint means "invite dead or nonexistent". */
export function isInviteNotFound(error: unknown): boolean {
  return isProblemDetails(error) && error.status === 404
}

/**
 * Public invite preview for the /invite/:code landing page.
 *
 * Works unauthenticated — the endpoint is public by design (server context
 * BEFORE signup, invite-landing ticket).
 */
export function useInvitePreview(code: string) {
  return useQuery({
    queryKey: queryKeys.invites.preview(code),
    queryFn: async () => {
      const { data } = await previewInvite({
        path: { code },
        throwOnError: true,
      })
      return data
    },
    // WHY: a 404 is a definitive business answer (dead invite) — retrying only
    // delays the "invite expired" screen. Other failures keep the app's
    // standard 3-retry backoff.
    retry: (failureCount, error) => !isInviteNotFound(error) && failureCount < 3,
    // WHY: the viewer is (usually) unauthenticated — no SSE stream exists to
    // push member-count changes. A slow poll keeps the count honest while the
    // page is open, at negligible cost.
    refetchInterval: 30_000,
  })
}
