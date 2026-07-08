import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProfileResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
// WHY direct Storage access: sanctioned exception (src/lib/supabase.ts) —
// avatar uploads bypass the API's 2MB body cap; the API only stores the URL.
import { supabase } from '@/lib/supabase'
import { AvatarUploadError, parseAvatarStoragePath, validateAvatarFile } from '../lib/avatar-file'
import { type PreparedAvatar, prepareAvatarForUpload } from '../lib/avatar-image'
import { useAuthStore } from '../stores/auth-store'
import { useUpdateProfile } from './use-update-profile'

const AVATARS_BUCKET = 'avatars'

/** Downscale/transcode, mapping any failure to a typed pipeline error. */
async function prepareOrThrow(file: File): Promise<PreparedAvatar> {
  try {
    return await prepareAvatarForUpload(file)
  } catch (err: unknown) {
    logger.error('avatar_processing_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    throw new AvatarUploadError('processingFailed')
  }
}

/** Uploads the prepared blob and returns its public URL. */
async function uploadToStorage(objectPath: string, prepared: PreparedAvatar): Promise<string> {
  const { error: uploadError } = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(objectPath, prepared.blob, {
      contentType: prepared.contentType,
      cacheControl: '3600',
    })
  if (uploadError !== null) {
    logger.error('avatar_storage_upload_failed', { error: uploadError.message })
    throw new AvatarUploadError('uploadFailed')
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(objectPath)
  return publicUrl
}

/**
 * WHY best-effort: an orphaned object is cheap; failing the whole upload
 * over cleanup would be worse. Log-only on failure (plan P2.3).
 */
async function removePreviousObject(previousAvatarUrl: string | null): Promise<void> {
  const previousPath = previousAvatarUrl !== null ? parseAvatarStoragePath(previousAvatarUrl) : null
  if (previousPath === null) return

  const { error: removeError } = await supabase.storage.from(AVATARS_BUCKET).remove([previousPath])
  if (removeError !== null) {
    logger.warn('avatar_previous_remove_failed', {
      path: previousPath,
      error: removeError.message,
    })
  }
}

/**
 * Avatar upload pipeline: validate → downscale/transcode → upload to
 * Supabase Storage under `{uid}/{uuid}.{ext}` → PATCH avatar_url via
 * useUpdateProfile → best-effort removal of the previous object.
 *
 * Errors surface via the mutation's error state (rendered inline in the
 * profile settings modal — explicit user action, ADR-045).
 */
export function useUploadAvatar() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const updateProfile = useUpdateProfile()

  return useMutation({
    mutationFn: async (file: File) => {
      if (userId === null) {
        throw new AvatarUploadError('uploadFailed')
      }

      const validationError = validateAvatarFile(file)
      if (validationError !== null) {
        throw new AvatarUploadError(validationError)
      }

      // WHY capture before the PATCH: the optimistic cache update replaces
      // avatarUrl — the previous object path must be read first for cleanup.
      const previousAvatarUrl =
        queryClient.getQueryData<ProfileResponse>(queryKeys.profiles.me())?.avatarUrl ?? null

      const prepared = await prepareOrThrow(file)

      // WHY a random object name: unique path per upload = natural CDN
      // cache-bust — the old URL keeps serving until the profile row points
      // to the new one.
      const objectPath = `${userId}/${crypto.randomUUID()}.${prepared.extension}`
      const publicUrl = await uploadToStorage(objectPath, prepared)

      await updateProfile.mutateAsync({ avatarUrl: publicUrl })
      await removePreviousObject(previousAvatarUrl)

      return publicUrl
    },

    onError: (error) => {
      logger.error('avatar_upload_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // WHY no toast: rendered inline next to the avatar controls in the
      // profile settings modal (ADR-045 feedback hierarchy).
    },
  })
}
