import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createServerEmoji, type EmojiListResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
// WHY direct Storage access: sanctioned exception (src/lib/supabase.ts) — the
// blob is uploaded straight to the bucket (admin-gated by RLS); the API only
// stores the resulting public URL. Mirrors the avatar pipeline.
import { supabase } from '@/lib/supabase'
import {
  type EmojiFileLimits,
  EmojiUploadError,
  emojiExtensionFor,
  isAnimatedEmoji,
  parseEmojiStoragePath,
  validateEmojiFile,
} from '../lib/emoji-file'

const EMOJIS_BUCKET = 'server-emojis'

export interface CreateEmojiInput {
  file: File
  /** Bare name (no colons) — validated + lowercased server-side. */
  name: string
  limits: EmojiFileLimits
}

/** Uploads the blob and returns its public URL + object path (for cleanup). */
async function uploadToStorage(
  serverId: string,
  file: File,
): Promise<{ publicUrl: string; objectPath: string }> {
  const objectPath = `${serverId}/${crypto.randomUUID()}.${emojiExtensionFor(file.type)}`
  const { error: uploadError } = await supabase.storage
    .from(EMOJIS_BUCKET)
    .upload(objectPath, file, {
      contentType: file.type,
      cacheControl: '3600',
    })
  if (uploadError !== null) {
    logger.error('emoji_storage_upload_failed', { error: uploadError.message })
    throw new EmojiUploadError('uploadFailed')
  }
  const {
    data: { publicUrl },
  } = supabase.storage.from(EMOJIS_BUCKET).getPublicUrl(objectPath)
  return { publicUrl, objectPath }
}

/** Best-effort orphan cleanup when the POST fails after a successful upload. */
async function removeObject(publicUrlOrPath: string): Promise<void> {
  const path = parseEmojiStoragePath(publicUrlOrPath) ?? publicUrlOrPath
  const { error } = await supabase.storage.from(EMOJIS_BUCKET).remove([path])
  if (error !== null) {
    logger.warn('emoji_orphan_remove_failed', { path, error: error.message })
  }
}

/**
 * Custom-emoji upload pipeline: validate → upload blob to Storage under
 * `{serverId}/{uuid}.{ext}` → POST `{name,url,isAnimated}` → append to cache.
 * On POST failure the uploaded object is best-effort removed (orphan cleanup).
 *
 * Errors surface via the mutation state, rendered inline in the settings tab
 * (explicit user action → inline, ADR-045). No toast.
 */
export function useCreateEmoji(serverId: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ file, name, limits }: CreateEmojiInput) => {
      if (serverId === null || serverId.length === 0) {
        throw new EmojiUploadError('uploadFailed')
      }

      const validationError = validateEmojiFile(file, limits)
      if (validationError !== null) {
        throw new EmojiUploadError(validationError)
      }

      const { publicUrl } = await uploadToStorage(serverId, file)

      try {
        const { data } = await createServerEmoji({
          path: { id: serverId },
          body: { name, url: publicUrl, isAnimated: isAnimatedEmoji(file) },
          throwOnError: true,
        })
        return data
      } catch (postError) {
        // WHY cleanup here (not in onError): only a *successful upload followed
        // by a failed POST* leaves an orphan; a validation failure never uploads.
        await removeObject(publicUrl)
        throw postError
      }
    },

    onSuccess: (created) => {
      if (serverId === null) return
      // WHY setQueryData (not invalidate): instant UI, no refetch (§5.4 rule).
      queryClient.setQueryData<EmojiListResponse>(queryKeys.servers.emojis(serverId), (old) => {
        if (old === undefined) return { items: [created], total: 1 }
        // WHY dedupe: the POST publishes emoji.created before returning 201 and
        // the echo is not self-suppressed, so handleCreated may insert this id
        // before onSuccess runs. Mirror its guard to avoid a double-insert.
        if (old.items.some((e) => e.id === created.id)) return old
        return { items: [...old.items, created], total: old.total + 1 }
      })
    },

    onError: (error) => {
      logger.error('emoji_upload_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // WHY no toast: surfaced inline next to the upload control (ADR-045).
    },
  })
}
