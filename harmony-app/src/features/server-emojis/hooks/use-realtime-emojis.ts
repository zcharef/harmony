import { useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type { EmojiListResponse, EmojiResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { toast } from '@/lib/toast'

/**
 * WHY local schemas: the SSE layer already validated the full discriminated
 * union; these validate only the subset needed for the cache patch.
 */
const emojiCreatedSchema = z.object({
  serverId: z.string(),
  emoji: z.object({
    id: z.string(),
    serverId: z.string(),
    name: z.string(),
    url: z.string(),
    isAnimated: z.boolean(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
})

const emojiDeletedSchema = z.object({
  serverId: z.string(),
  emojiId: z.string(),
})

const emojiRejectedSchema = z.object({
  serverId: z.string(),
  emojiId: z.string(),
  name: z.string(),
})

/**
 * Keeps every server's emoji cache live: `emoji.created` appends, `emoji.deleted`
 * filters — so `:name:` tokens resolve (or degrade to text) without a refetch.
 *
 * MUST mount in MainLayout (never a sidebar) so updates survive view switches
 * (§4.6 hook-lifecycle rule). Keys on the event's `serverId`, so one mount
 * covers every server the user belongs to.
 */
export function useRealtimeEmojis() {
  const queryClient = useQueryClient()

  const handleCreated = useCallback(
    (payload: unknown) => {
      const parsed = emojiCreatedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed emoji.created SSE payload', { error: parsed.error.message })
        return
      }
      const emoji: EmojiResponse = parsed.data.emoji
      queryClient.setQueryData<EmojiListResponse>(
        queryKeys.servers.emojis(parsed.data.serverId),
        (old) => {
          if (old === undefined) return { items: [emoji], total: 1 }
          // WHY dedupe: the creator's own optimistic append + the SSE echo must
          // not double-insert.
          if (old.items.some((e) => e.id === emoji.id)) return old
          return { items: [...old.items, emoji], total: old.total + 1 }
        },
      )
    },
    [queryClient],
  )

  const handleDeleted = useCallback(
    (payload: unknown) => {
      const parsed = emojiDeletedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed emoji.deleted SSE payload', { error: parsed.error.message })
        return
      }
      queryClient.setQueryData<EmojiListResponse>(
        queryKeys.servers.emojis(parsed.data.serverId),
        (old) => {
          if (old === undefined) return old
          // WHY presence guard: the deleting admin already decremented `total`
          // optimistically (use-delete-emoji onMutate) and still receives their
          // own emoji.deleted echo (not self-suppressed). Without this the echo
          // decrements a second time, drifting total below items.length.
          if (!old.items.some((e) => e.id === parsed.data.emojiId)) return old
          return {
            items: old.items.filter((e) => e.id !== parsed.data.emojiId),
            total: Math.max(0, old.total - 1),
          }
        },
      )
    },
    [queryClient],
  )

  // Scan-before-reveal rejection: the creator's optimistic emoji (added on the
  // POST 201) must be dropped and a notice shown — the image did not pass review
  // and was never revealed to other members. Delivered ONLY to the creator.
  const handleRejected = useCallback(
    (payload: unknown) => {
      const parsed = emojiRejectedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed emoji.rejected SSE payload', { error: parsed.error.message })
        return
      }
      queryClient.setQueryData<EmojiListResponse>(
        queryKeys.servers.emojis(parsed.data.serverId),
        (old) => {
          if (old === undefined) return old
          if (!old.items.some((e) => e.id === parsed.data.emojiId)) return old
          return {
            items: old.items.filter((e) => e.id !== parsed.data.emojiId),
            total: Math.max(0, old.total - 1),
          }
        },
      )
      // Explicit user action (an upload) that failed review → visible notice
      // (ADR-045). i18n'd from the start.
      toast.error(i18n.t('server-emojis:rejectedTitle'), {
        description: i18n.t('server-emojis:rejectedBody', { name: parsed.data.name }),
      })
    },
    [queryClient],
  )

  useServerEvent('emoji.created', handleCreated)
  useServerEvent('emoji.deleted', handleDeleted)
  useServerEvent('emoji.rejected', handleRejected)
}
