import { useQueryClient } from '@tanstack/react-query'
import type { Virtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listMessages } from '@/lib/api'
import { isProblemDetails } from '@/lib/api-error'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'
import type { VirtualItem } from '../lib/build-virtual-items'

const AROUND_LIMIT = 50
const FLASH_DURATION_MS = 1500

interface UseJumpToMessageParams {
  channelId: string | null
  virtualItems: VirtualItem[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

/**
 * Jump-to-message (unread-divider ticket §5.9). Scrolls the virtualized list to
 * a target message and flash-highlights it. When the target is not in the
 * loaded window, fetches the page AROUND it, resets the infinite-query cache to
 * that single page (merging discontiguous windows would create virtualizer
 * gaps/dupes), then scrolls once the list re-renders.
 *
 * This is an EXPLICIT user action, so failures surface a proportional toast
 * (ADR-028): a lost/deleted target or lost access → `jumpTargetGone`; a network
 * failure → `networkError`. The current view is never mutated on failure.
 */
export function useJumpToMessage({ channelId, virtualItems, virtualizer }: UseJumpToMessageParams) {
  const queryClient = useQueryClient()
  const { t } = useTranslation(['chat', 'common'])
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  // WHY a ref, not state: the around-fetch replaces the cache asynchronously;
  // the pending target is consumed by the effect below once virtualItems (which
  // recompute on the next render) contain the row. A ref avoids an extra render.
  const pendingJumpRef = useRef<string | null>(null)

  useEffect(() => {
    if (flashMessageId === null) return
    const timer = setTimeout(() => setFlashMessageId(null), FLASH_DURATION_MS)
    return () => clearTimeout(timer)
  }, [flashMessageId])

  const scrollToLoaded = useCallback(
    (messageId: string): boolean => {
      const idx = virtualItems.findIndex(
        (item) => item.type === 'message' && item.msg.id === messageId,
      )
      if (idx === -1) return false
      virtualizer.scrollToIndex(idx, { align: 'center' })
      setFlashMessageId(messageId)
      return true
    },
    [virtualItems, virtualizer],
  )

  // WHY: after an around-fetch swaps the cache, the list re-renders with the
  // target present — scroll to it then. Runs on every virtualItems change until
  // the pending target lands (guards against the row not being measured yet).
  useEffect(() => {
    const pending = pendingJumpRef.current
    if (pending === null) return
    if (scrollToLoaded(pending)) pendingJumpRef.current = null
  }, [scrollToLoaded])

  const jumpToMessage = useCallback(
    async (messageId: string) => {
      if (scrollToLoaded(messageId)) return
      if (channelId === null) return
      // WHY guard: a second jump while an around-fetch is in flight would
      // overwrite the pending target and silently drop the first jump. Ignore
      // repeat triggers until the current one lands.
      if (pendingJumpRef.current !== null) return

      try {
        const { data } = await listMessages({
          path: { id: channelId },
          query: { around: messageId, limit: AROUND_LIMIT },
          throwOnError: true,
        })
        pendingJumpRef.current = messageId
        // WHY reset (not merge): a clean single-page window guarantees the target
        // is present and the virtualizer stays contiguous. Scrolling up re-arms
        // useMessages via the around page's nextCursor.
        queryClient.setQueryData(queryKeys.messages.byChannel(channelId), {
          pages: [data],
          pageParams: [undefined],
        })
      } catch (error) {
        pendingJumpRef.current = null
        // 403 (lost access) / 404 (gone) → target-gone UX; anything else (network,
        // 5xx) → generic network error. Never mutate the cache on failure.
        const gone = isProblemDetails(error) && (error.status === 404 || error.status === 403)
        if (gone) {
          logger.warn('jump_target_gone', { messageId })
          toast.error(t('chat:jumpTargetGone'))
        } else {
          toast.error(t('common:networkError'))
        }
      }
    },
    [channelId, scrollToLoaded, queryClient, t],
  )

  return { jumpToMessage, flashMessageId }
}
