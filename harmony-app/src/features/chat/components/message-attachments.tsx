import { EyeOff, File, FileArchive, FileText, ImageOff, Loader2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLinkWarning } from '@/components/shared/external-link-warning'
import type { AttachmentResponse } from '@/lib/api'
import { attachmentFilename, humanFileSize, isImageMime } from '../lib/attachment-file'

/**
 * Content-moderation verdict driving the render (mirrors the Rust
 * `AttachmentModerationStatus` enum). The fail-closed `pending` default for an
 * older instance's payload is applied where the cache is written
 * (`chatMessageFromPayload`, the optimistic echo), so the field is always
 * present here.
 */
type ModerationStatus = AttachmentResponse['moderationStatus']

/** Shared placeholder box sizing (fixed, Tailwind-only — no inline style). */
const PLACEHOLDER_BOX = 'aspect-video w-60 max-w-full'

/**
 * Inline image render, shared by structured attachments and the markdown
 * `img` override (content-URL auto-embed, the T1.4/Klipy path).
 *
 * WHY intrinsic width/height: known dims reserve the box before the bytes
 * arrive — zero layout shift while lazy-loading.
 * WHY onError fallback: a deleted/expired object renders a muted
 * "Image unavailable" chip, never the broken-image glyph.
 */
export function EmbeddedImage({
  src,
  alt,
  width,
  height,
  onOpen,
}: {
  src: string
  alt: string
  width?: number
  height?: number
  onOpen: (url: string) => void
}) {
  const { t } = useTranslation('messages')
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span
        data-test="attachment-unavailable"
        className="inline-flex items-center gap-1.5 rounded-lg bg-default-100 px-3 py-2 text-sm italic text-default-400"
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        {t('attachmentUnavailable')}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(src)}
      data-test="attachment-image"
      aria-label={alt === '' ? t('imageAttachment') : alt}
      className="block cursor-pointer"
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        width={width}
        height={height}
        onError={() => setFailed(true)}
        className="max-h-80 max-w-full rounded-lg bg-default-100 object-contain"
      />
    </button>
  )
}

/** Blurred skeleton shown while an image is still being scanned (`pending`). */
function ScanningPlaceholder() {
  const { t } = useTranslation('messages')
  return (
    <div
      data-test="attachment-scanning"
      className={`flex flex-col items-center justify-center gap-1.5 rounded-lg bg-default-100 text-default-400 ${PLACEHOLDER_BOX}`}
    >
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-xs">{t('attachmentScanning')}</span>
    </div>
  )
}

/**
 * Spoiler overlay for adult-NSFW imagery in a non-permitted context (`gated`).
 * The bytes are NOT fetched until the viewer clicks reveal (per-viewer,
 * session-only). Once revealed, renders the normal inline image.
 */
function GatedImage({
  attachment,
  onOpen,
}: {
  attachment: AttachmentResponse
  onOpen: (url: string) => void
}) {
  const { t } = useTranslation('messages')
  const [revealed, setRevealed] = useState(false)

  if (revealed) {
    return (
      <EmbeddedImage
        src={attachment.url}
        alt={attachmentFilename(attachment.url)}
        width={attachment.width ?? undefined}
        height={attachment.height ?? undefined}
        onOpen={onOpen}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setRevealed(true)}
      data-test="attachment-gated"
      className={`flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg bg-default-200 text-default-500 transition-colors hover:bg-default-300 ${PLACEHOLDER_BOX}`}
    >
      <EyeOff className="h-5 w-5" />
      <span className="text-xs font-medium">{t('attachmentNsfw')}</span>
      <span className="rounded-full bg-default-100 px-2 py-0.5 text-xs">
        {t('attachmentReveal')}
      </span>
    </button>
  )
}

/** Removed placeholder for a `blocked`/`quarantined` attachment. No reveal. */
function RemovedPlaceholder() {
  const { t } = useTranslation('messages')
  return (
    <span
      data-test="attachment-removed"
      className="inline-flex items-center gap-1.5 rounded-lg bg-default-100 px-3 py-2 text-sm italic text-default-400"
    >
      <ImageOff className="h-4 w-4 shrink-0" />
      {t('attachmentRemoved')}
    </span>
  )
}

/** Icon per mime family — FileText for documents, FileArchive for zips. */
function chipIcon(mime: string) {
  if (mime === 'application/pdf' || mime === 'text/plain') return FileText
  if (mime === 'application/zip') return FileArchive
  return File
}

function AttachmentFileChip({
  attachment,
  onOpen,
}: {
  attachment: AttachmentResponse
  onOpen: (url: string) => void
}) {
  const { t } = useTranslation('messages')
  const Icon = chipIcon(attachment.mime)
  const filename = attachmentFilename(attachment.url)

  return (
    <button
      type="button"
      onClick={() => onOpen(attachment.url)}
      data-test="attachment-file-chip"
      aria-label={t('downloadAttachment', { filename })}
      className="flex w-fit max-w-full cursor-pointer items-center gap-2 rounded-lg border border-default-200 bg-default-50 px-3 py-2 text-sm transition-colors hover:bg-default-100"
    >
      <Icon className="h-5 w-5 shrink-0 text-default-500" />
      <span className="truncate font-medium text-foreground/90">{filename}</span>
      <span className="shrink-0 text-xs text-default-400">{humanFileSize(attachment.size)}</span>
    </button>
  )
}

/** Render one image attachment switched on its moderation status (§c.4). */
function ModeratedImage({
  attachment,
  onOpen,
}: {
  attachment: AttachmentResponse
  onOpen: (url: string) => void
}) {
  const status: ModerationStatus = attachment.moderationStatus
  if (status === 'blocked' || status === 'quarantined') return <RemovedPlaceholder />
  if (status === 'pending') return <ScanningPlaceholder />
  if (status === 'gated') return <GatedImage attachment={attachment} onOpen={onOpen} />
  return (
    <EmbeddedImage
      src={attachment.url}
      alt={attachmentFilename(attachment.url)}
      width={attachment.width ?? undefined}
      height={attachment.height ?? undefined}
      onOpen={onOpen}
    />
  )
}

/**
 * Discord-style attachment block below the message text: images render
 * inline (2-col grid when multiple), everything else as a download chip.
 * Each attachment's render is gated on its content-moderation status
 * (blurred while `pending`, spoiler-gated when `gated`, removed when
 * `blocked`/`quarantined`). Opening an attachment is gated by the existing
 * ExternalLinkWarning flow.
 */
export function MessageAttachments({ attachments }: { attachments: AttachmentResponse[] }) {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)

  const handleOpen = useCallback((url: string) => setPendingUrl(url), [])
  const handleContinue = useCallback(() => {
    if (pendingUrl === null) return
    window.open(pendingUrl, '_blank', 'noopener,noreferrer')
    setPendingUrl(null)
  }, [pendingUrl])

  if (attachments.length === 0) return null

  // WHY partition (not a silent drop): every attachment renders — images as
  // (moderation-gated) inline embeds, the rest as download chips.
  const images = attachments.filter((a) => isImageMime(a.mime) === true)
  const files = attachments.filter((a) => isImageMime(a.mime) === false)

  return (
    <div data-test="message-attachments" className="mt-1 flex flex-col items-start gap-1">
      {images.length > 0 && (
        <div className={images.length > 1 ? 'grid max-w-lg grid-cols-2 gap-1' : 'max-w-lg'}>
          {images.map((a) => (
            <ModeratedImage key={a.id} attachment={a} onOpen={handleOpen} />
          ))}
        </div>
      )}
      {files.map((a) =>
        a.moderationStatus === 'blocked' || a.moderationStatus === 'quarantined' ? (
          <RemovedPlaceholder key={a.id} />
        ) : (
          <AttachmentFileChip key={a.id} attachment={a} onOpen={handleOpen} />
        ),
      )}
      <ExternalLinkWarning
        isOpen={pendingUrl !== null}
        url={pendingUrl ?? ''}
        onClose={() => setPendingUrl(null)}
        onContinue={handleContinue}
      />
    </div>
  )
}
