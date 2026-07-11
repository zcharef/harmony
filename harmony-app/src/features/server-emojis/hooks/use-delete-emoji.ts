import { useMutation, useQueryClient } from '@tanstack/react-query'
import { deleteServerEmoji, type EmojiListResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { supabase } from '@/lib/supabase'
import { parseEmojiStoragePath } from '../lib/emoji-file'

const EMOJIS_BUCKET = 'server-emojis'

export interface DeleteEmojiInput {
  emojiId: string
  /** The emoji's public URL — parsed to the object path for storage cleanup. */
  url: string
}

interface DeleteContext {
  previous: EmojiListResponse | undefined
}

/**
 * Deletes a custom emoji with an optimistic cache removal + rollback, then a
 * best-effort Storage object cleanup. Errors surface inline in the settings tab
 * (explicit user action, ADR-045).
 */
export function useDeleteEmoji(serverId: string | null) {
  const queryClient = useQueryClient()
  const key = queryKeys.servers.emojis(serverId ?? '')

  return useMutation({
    mutationFn: async ({ emojiId }: DeleteEmojiInput) => {
      if (serverId === null || serverId.length === 0) {
        throw new Error('missing server id')
      }
      await deleteServerEmoji({
        path: { id: serverId, emoji_id: emojiId },
        throwOnError: true,
      })
    },

    onMutate: async ({ emojiId }): Promise<DeleteContext> => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<EmojiListResponse>(key)
      queryClient.setQueryData<EmojiListResponse>(key, (old) =>
        old === undefined
          ? old
          : {
              items: old.items.filter((e) => e.id !== emojiId),
              total: Math.max(0, old.total - 1),
            },
      )
      return { previous }
    },

    onError: (error, _input, context) => {
      // WHY rollback: the optimistic removal must not stick on failure.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(key, context.previous)
      }
      logger.error('emoji_delete_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },

    onSuccess: async (_data, { url }) => {
      // WHY best-effort: an orphaned object is cheap; failing the delete over
      // cleanup would be worse (mirrors avatar cleanup rationale).
      const path = parseEmojiStoragePath(url)
      if (path === null) return
      const { error } = await supabase.storage.from(EMOJIS_BUCKET).remove([path])
      if (error !== null) {
        logger.warn('emoji_object_remove_failed', { path, error: error.message })
      }
    },
  })
}
