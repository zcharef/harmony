import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ProfileResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
// WHY direct Storage access: sanctioned exception (src/lib/supabase.ts) —
// banner uploads bypass the API's 2MB body cap; the API only stores the URL.
import { supabase } from '@/lib/supabase'
import { AvatarUploadError, parseAvatarStoragePath, validateBannerFile } from '../lib/avatar-file'
import { type PreparedAvatar, prepareBannerForUpload } from '../lib/avatar-image'
import { useAuthStore } from '../stores/auth-store'
import { useUpdateProfile } from './use-update-profile'

// WHY the same bucket: banners and avatars coexist in `avatars` at
// `{uid}/{uuid}.{ext}` — the RLS keys write access on the first path segment
// (auth.uid()), not on an avatar-vs-banner distinction (ticket §2.2).
const AVATARS_BUCKET = 'avatars'

/** Downscale/transcode, mapping any failure to a typed pipeline error. */
async function prepareOrThrow(file: File): Promise<PreparedAvatar> {
  try {
    return await prepareBannerForUpload(file)
  } catch (err: unknown) {
    logger.error('banner_processing_failed', {
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
    logger.error('banner_storage_upload_failed', { error: uploadError.message })
    throw new AvatarUploadError('uploadFailed')
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(AVATARS_BUCKET).getPublicUrl(objectPath)
  return publicUrl
}

/**
 * WHY best-effort: an orphaned object is cheap; failing the whole upload over
 * cleanup would be worse. Log-only on failure (mirrors use-upload-avatar).
 */
async function removePreviousObject(previousBannerUrl: string | null): Promise<void> {
  const previousPath = previousBannerUrl !== null ? parseAvatarStoragePath(previousBannerUrl) : null
  if (previousPath === null) return

  const { error: removeError } = await supabase.storage.from(AVATARS_BUCKET).remove([previousPath])
  if (removeError !== null) {
    logger.warn('banner_previous_remove_failed', {
      path: previousPath,
      error: removeError.message,
    })
  }
}

/**
 * Banner upload pipeline: validate → downscale to 1024w → upload to Supabase
 * Storage under `{uid}/{uuid}.{ext}` (same `avatars` bucket) → PATCH banner_url
 * via useUpdateProfile → best-effort removal of the previous object.
 *
 * Errors surface via the mutation's error state (rendered inline in the profile
 * settings modal — explicit user action, ADR-045). Reuses the `AvatarUploadError`
 * taxonomy (no parallel error type, ticket §5.5).
 */
export function useUploadBanner() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const updateProfile = useUpdateProfile()

  return useMutation({
    mutationFn: async (file: File) => {
      if (userId === null) {
        throw new AvatarUploadError('uploadFailed')
      }

      const validationError = validateBannerFile(file)
      if (validationError !== null) {
        throw new AvatarUploadError(validationError)
      }

      // WHY capture before the PATCH: the optimistic cache update replaces
      // bannerUrl — the previous object path must be read first for cleanup.
      const previousBannerUrl =
        queryClient.getQueryData<ProfileResponse>(queryKeys.profiles.me())?.bannerUrl ?? null

      const prepared = await prepareOrThrow(file)

      const objectPath = `${userId}/${crypto.randomUUID()}.${prepared.extension}`
      const publicUrl = await uploadToStorage(objectPath, prepared)

      await updateProfile.mutateAsync({ bannerUrl: publicUrl })
      await removePreviousObject(previousBannerUrl)

      return publicUrl
    },

    onError: (error) => {
      logger.error('banner_upload_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      // WHY no toast: rendered inline next to the banner controls in the
      // profile settings modal (ADR-045 feedback hierarchy).
    },
  })
}
