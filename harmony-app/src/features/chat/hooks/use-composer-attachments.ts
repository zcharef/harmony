import { useCallback, useEffect, useRef, useState } from 'react'
import type { NewAttachmentRequest } from '@/lib/api'
import {
  AttachmentUploadError,
  type AttachmentUploadErrorCode,
  isImageMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  validateAttachmentFile,
} from '../lib/attachment-file'
import { type UploadedAttachment, useUploadAttachment } from './use-upload-attachment'

/** Per-file lifecycle in the pending tray. */
export type PendingStatus = 'uploading' | 'done' | 'error'

/** Reason a batch of files was rejected before ever entering the tray. */
export type ComposerCapError = 'tooMany' | 'tooLarge' | 'unsupported'

export interface PendingAttachment {
  /** Client-only id; the server assigns the real AttachmentId on echo. */
  localId: string
  name: string
  size: number
  mime: string
  isImage: boolean
  /** objectURL preview for images; null for non-images. Revoked on remove/unmount. */
  previewUrl: string | null
  status: PendingStatus
  errorCode: AttachmentUploadErrorCode | null
  /** Uploaded metadata once `status === 'done'`. */
  uploaded: UploadedAttachment | null
}

export interface ComposerAttachments {
  items: PendingAttachment[]
  /** Inline rejection reason for the last enqueue (cap/type/size). */
  capError: ComposerCapError | null
  /** Inline error from the send step (e.g. server plan-cap). Kept with the tray. */
  sendError: string | null
  isEmpty: boolean
  /** True when any tile failed to upload — send must be blocked. */
  hasFailedUpload: boolean
  enqueueFiles: (files: FileList | File[]) => void
  removeAttachment: (localId: string) => void
  clear: () => void
  setSendError: (message: string | null) => void
  /**
   * Awaits every in-flight upload. Returns the uploaded entries in order, or
   * `null` when ANY tracked upload failed — so a file that fails during the
   * await window blocks the send instead of being silently dropped (§6.2).
   */
  resolveUploaded: () => Promise<NewAttachmentRequest[] | null>
}

function makeLocalId(): string {
  return crypto.randomUUID()
}

/** A file accepted into the tray, paired with the source blob for uploading. */
interface AcceptedFile {
  item: PendingAttachment
  file: File
}

/**
 * Pure planning step: given the current tiles and a batch of incoming files,
 * decide which are accepted (deduped, validated, under the count cap) and the
 * first rejection reason to surface inline. Kept side-effect-free so the hook's
 * enqueue stays thin (previewURL creation is deferred to the caller).
 */
function planEnqueue(
  current: PendingAttachment[],
  incoming: File[],
): { accepted: AcceptedFile[]; capError: ComposerCapError | null } {
  const accepted: AcceptedFile[] = []
  let capError: ComposerCapError | null = null

  for (const file of incoming) {
    if (current.length + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      capError = 'tooMany'
      break
    }
    // WHY dedupe by name+size: re-picking the same file (or a paste + drop of
    // one screenshot) must not create a duplicate tile.
    const isDuplicate = [...current, ...accepted.map((a) => a.item)].some(
      (it) => it.name === file.name && it.size === file.size,
    )
    if (isDuplicate) continue

    const validationError = validateAttachmentFile(file)
    if (validationError === 'invalidType') {
      capError = 'unsupported'
      continue
    }
    if (validationError === 'tooLarge') {
      capError = 'tooLarge'
      continue
    }

    const isImage = isImageMime(file.type)
    accepted.push({
      file,
      item: {
        localId: makeLocalId(),
        name: file.name,
        size: file.size,
        mime: file.type,
        isImage,
        previewUrl: null,
        status: 'uploading',
        errorCode: null,
        uploaded: null,
      },
    })
  }

  return { accepted, capError }
}

/**
 * Owns the composer's pending-attachment tray: enqueue (from paste, drop, or
 * the picker — all three funnel here), per-file upload status, remove, and
 * `resolveUploaded` (awaited by the send path). Uploads fire on enqueue
 * (optimistic) so send is instant once they settle.
 *
 * Ephemeral composer state — `useState`/refs, no Zustand, no server-data
 * shadow (harmony-app CLAUDE.md §4.3, ADR-045).
 */
export function useComposerAttachments(): ComposerAttachments {
  const uploadAttachment = useUploadAttachment()
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [capError, setCapError] = useState<ComposerCapError | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  // WHY a ref mirror of items: StrictMode double-invokes setState updaters, so
  // the enqueue side effects (objectURL, upload) MUST run outside the updater.
  // The ref is the authoritative list; `commit` pushes it into render state.
  const itemsRef = useRef<PendingAttachment[]>([])
  // WHY a ref of promises: resolveUploaded must await uploads regardless of
  // React render timing; keying by localId lets remove/clear forget them.
  const uploadsRef = useRef<Map<string, Promise<UploadedAttachment>>>(new Map())
  const previewUrlsRef = useRef<Map<string, string>>(new Map())

  const commit = useCallback((next: PendingAttachment[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  const updateItem = useCallback(
    (localId: string, patch: Partial<PendingAttachment>) => {
      commit(itemsRef.current.map((it) => (it.localId === localId ? { ...it, ...patch } : it)))
    },
    [commit],
  )

  const startUpload = useCallback(
    (localId: string, file: File) => {
      const promise = uploadAttachment(file)
      uploadsRef.current.set(localId, promise)
      promise
        .then((uploaded) => {
          updateItem(localId, { status: 'done', uploaded })
        })
        .catch((err: unknown) => {
          const errorCode = err instanceof AttachmentUploadError ? err.code : 'uploadFailed'
          updateItem(localId, { status: 'error', errorCode })
        })
    },
    [uploadAttachment, updateItem],
  )

  const enqueueFiles = useCallback(
    (files: FileList | File[]) => {
      setSendError(null)
      setCapError(null)
      const incoming = Array.from(files)
      if (incoming.length === 0) return

      const { accepted, capError: rejection } = planEnqueue(itemsRef.current, incoming)
      if (rejection !== null) setCapError(rejection)

      const newItems = accepted.map(({ item, file }) => {
        const previewUrl = item.isImage ? URL.createObjectURL(file) : null
        if (previewUrl !== null) previewUrlsRef.current.set(item.localId, previewUrl)
        startUpload(item.localId, file)
        return { ...item, previewUrl }
      })
      if (newItems.length > 0) commit([...itemsRef.current, ...newItems])
    },
    [commit, startUpload],
  )

  const removeAttachment = useCallback(
    (localId: string) => {
      const previewUrl = previewUrlsRef.current.get(localId)
      if (previewUrl !== undefined) {
        URL.revokeObjectURL(previewUrl)
        previewUrlsRef.current.delete(localId)
      }
      uploadsRef.current.delete(localId)
      setSendError(null)
      commit(itemsRef.current.filter((it) => it.localId !== localId))
    },
    [commit],
  )

  const clear = useCallback(() => {
    for (const url of previewUrlsRef.current.values()) URL.revokeObjectURL(url)
    previewUrlsRef.current.clear()
    uploadsRef.current.clear()
    commit([])
    setCapError(null)
    setSendError(null)
  }, [commit])

  const resolveUploaded = useCallback(async (): Promise<NewAttachmentRequest[] | null> => {
    // WHY allSettled + null: await every tracked upload; if any rejected (even
    // one still in-flight at send time), return null so the caller blocks the
    // send rather than posting a message that references fewer files than the
    // user sees in the tray (§6.2 — no silent data loss).
    const settled = await Promise.allSettled([...uploadsRef.current.values()])
    const uploaded: NewAttachmentRequest[] = []
    for (const result of settled) {
      if (result.status === 'rejected') return null
      uploaded.push(result.value)
    }
    return uploaded
  }, [])

  // WHY unmount-only cleanup: revoke any objectURLs still alive when the
  // composer unmounts (channel switch) to avoid leaking blob handles.
  useEffect(() => {
    const previews = previewUrlsRef.current
    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url)
      previews.clear()
    }
  }, [])

  return {
    items,
    capError,
    sendError,
    isEmpty: items.length === 0,
    hasFailedUpload: items.some((it) => it.status === 'error'),
    enqueueFiles,
    removeAttachment,
    clear,
    setSendError,
    resolveUploaded,
  }
}
