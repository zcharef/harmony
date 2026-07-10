import { useQuery } from '@tanstack/react-query'
import { trendingGifs } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { queryKeys } from '@/lib/query-keys'

/**
 * Whether the GIF picker is available on this deployment.
 *
 * WHY a probe: the proxy returns `503` when `KLIPY_API_KEY` is unset. To avoid a
 * dead button on key-less self-hosts, we probe `trending` once (cached for the
 * whole session) and treat a `503` as "feature off". Any other outcome —
 * success, a transient 502, offline — keeps the button visible (fail-open: a
 * momentary upstream blip must not hide a configured feature). As of HEAD there
 * is no `/v1/capabilities` surface, so this 503-probe is the pattern.
 */
export function useGifCapability(): boolean {
  const { error, isError } = useQuery({
    queryKey: queryKeys.gifs.capability(),
    queryFn: async () => {
      const { data } = await trendingGifs({ query: { page: 1 }, throwOnError: true })
      return data
    },
    // WHY once-per-session: the capability of a deployment does not change at
    // runtime, so cache the probe forever and never retry a definitive 503.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

  if (isError && isProblemDetails(error) && error.status === 503) return false
  return true
}
