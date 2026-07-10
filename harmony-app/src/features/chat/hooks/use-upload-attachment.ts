import { useCallback } from 'react'
import { useAuthStore } from '@/features/auth'
import type { NewAttachmentRequest } from '@/lib/api'
import { logger } from '@/lib/logger'
// WHY direct Storage access: sanctioned exception (src/lib/supabase.ts) —
// attachment uploads bypass the API's 2MB body cap; the API only stores the URL.
import { supabase } from '@/lib/supabase'
import { AttachmentUploadError, validateAttachmentFile } from '../lib/attachment-file'
import { type PreparedAttachment, prepareAttachmentForUpload } from '../lib/attachment-image'

const ATTACHMENTS_BUCKET = 'attachments'

/**
 * Uploaded-object metadata — the exact shape sent as one
 * `attachments[]` entry on a `SendMessageRequest`.
 */
export type UploadedAttachment = NewAttachmentRequest

/** Downscale/transcode, mapping any failure to a typed pipeline error. */
async function prepareOrThrow(file: File): Promise<PreparedAttachment> {
  try {
    return await prepareAttachmentForUpload(file)
  } catch (err: unknown) {
    logger.error('attachment_processing_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    throw new AttachmentUploadError('processingFailed')
  }
}

/** Uploads the prepared blob under `{uid}/{uuid}.{ext}` and returns its public URL. */
async function uploadToStorage(objectPath: string, prepared: PreparedAttachment): Promise<string> {
  const { error: uploadError } = await supabase.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(objectPath, prepared.blob, {
      contentType: prepared.contentType,
      cacheControl: '3600',
    })
  if (uploadError !== null) {
    logger.error('attachment_storage_upload_failed', { error: uploadError.message })
    throw new AttachmentUploadError('uploadFailed')
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(ATTACHMENTS_BUCKET).getPublicUrl(objectPath)
  return publicUrl
}

/**
 * Single-file attachment upload pipeline: validate → downscale/transcode
 * (EXIF stripped) → upload to the `attachments` Supabase Storage bucket under
 * `{uid}/{uuid}.{ext}` → return the object URL + metadata.
 *
 * Unlike the avatar pipeline, this touches no profile and no cache — the
 * pending-tray state (`use-composer-attachments`) owns per-file status. Errors
 * throw `AttachmentUploadError`; the caller renders them inline (ADR-045).
 */
export function useUploadAttachment() {
  const userId = useAuthStore((s) => s.user?.id ?? null)

  return useCallback(
    async (file: File): Promise<UploadedAttachment> => {
      if (userId === null) {
        throw new AttachmentUploadError('uploadFailed')
      }

      const validationError = validateAttachmentFile(file)
      if (validationError !== null) {
        throw new AttachmentUploadError(validationError)
      }

      const prepared = await prepareOrThrow(file)
      const objectPath = `${userId}/${crypto.randomUUID()}.${prepared.extension}`
      const url = await uploadToStorage(objectPath, prepared)

      return {
        url,
        mime: prepared.contentType,
        size: prepared.blob.size,
        // WHY conditional spread: omit width/height for non-images (the API
        // field is Optional; never send null pixel dims for a pdf/zip).
        ...(prepared.width !== undefined ? { width: prepared.width } : {}),
        ...(prepared.height !== undefined ? { height: prepared.height } : {}),
      }
    },
    [userId],
  )
}
