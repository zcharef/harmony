import { EyeOff, File, FileArchive, FileText, ImageOff, Loader2 } from 'lucide-react'
import { useCallback, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLinkWarning } from '@/components/shared/external-link-warning'
import type { AttachmentResponse } from '@/lib/api'
import { attachmentFilename, humanFileSize, isImageMime } from '../lib/attachment-file'
import { MeasureRowContext } from '../lib/measure-row-context'
import { MediaLightbox } from './media-lightbox'

/** True when the mime denotes a video renderable inline via `<video>`. */
function isVideoMime(mime: string): boolean {
  return mime.startsWith('video/')
}

/** Muted "media unavailable" chip for a deleted/expired object. */
function UnavailableChip() {
  const { t } = useTranslation('messages')
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
 * WHY intrinsic width/height: known dims (structured images + GIFs) let the
 * browser reserve the box from the aspect ratio before the bytes arrive — zero
 * layout shift while lazy-loading.
 * WHY the reserved min-height when dims are unknown (markdown images, bare
 * content-URL embeds): the box has NO intrinsic size until load, so without a
 * reserve the row is 0px tall and every row below keeps a stale virtual offset
 * during the load window (overlap + gaps). The reserve stabilizes the height
 * from first paint; `onLoad` then re-measures the virtual row to the real
 * height (see MeasureRowContext).
 * WHY onError fallback: a deleted/expired object renders a muted
 * "Image unavailable" chip, never the broken-image glyph.
 *
 * WHY primary click opens the lightbox (not `onOpen`): clicking an image now
 * enlarges it in a centered dark-backdrop preview. `onOpen` is retained as the
 * lightbox's *secondary* "open original in new tab" action, preserving the
 * `ExternalLinkWarning` gate for arbitrary content URLs.
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
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const measureRow = useContext(MeasureRowContext)
  const hasIntrinsicDims = typeof width === 'number' && typeof height === 'number'

  // WHY: correct the virtual row's cached height the instant the real image
  // dimensions land. The row's ResizeObserver would catch this a frame later;
  // re-measuring on load closes that window so offsets never drift visibly.
  const handleLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      if (measureRow === null) return
      const row = e.currentTarget.closest('[data-index]')
      if (row !== null) measureRow(row)
    },
    [measureRow],
  )

  if (failed) return <UnavailableChip />

  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
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
          onLoad={handleLoad}
          onError={() => setFailed(true)}
          className={`max-h-80 max-w-full rounded-lg bg-default-100 object-contain${hasIntrinsicDims ? '' : ' min-h-48 w-auto'}`}
        />
      </button>
      <MediaLightbox
        kind="image"
        src={src}
        alt={alt}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onOpenOriginal={() => onOpen(src)}
      />
    </>
  )
}

/**
 * Inline video render (parallel to `EmbeddedImage`): a muted, controls-less
 * poster wrapped in a button. Primary click opens the video in the lightbox
 * with native controls; `onOpen` is the lightbox's secondary "open original".
 * WHY no inline controls: the inline element is a click target — controls
 * belong in the lightbox where scrubbing won't fight the open gesture.
 */
function EmbeddedVideo({
  src,
  alt,
  onOpen,
}: {
  src: string
  alt: string
  onOpen: (url: string) => void
}) {
  const { t } = useTranslation('messages')
  const [failed, setFailed] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const measureRow = useContext(MeasureRowContext)

  // WHY: like EmbeddedImage.handleLoad — a video carries no intrinsic dims from
  // the API, so its poster box has no size until `loadedmetadata`. Re-measure
  // the owning virtual row then so the virtualizer's cached height stops drifting.
  const handleLoadedMetadata = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      if (measureRow === null) return
      const row = e.currentTarget.closest('[data-index]')
      if (row !== null) measureRow(row)
    },
    [measureRow],
  )

  if (failed) return <UnavailableChip />

  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        data-test="attachment-video"
        aria-label={alt === '' ? t('videoAttachment') : alt}
        className="block cursor-pointer"
      >
        <video
          src={src}
          muted
          preload="metadata"
          onLoadedMetadata={handleLoadedMetadata}
          onError={() => setFailed(true)}
          // WHY min-h-48: reserve the row height before metadata arrives so the
          // virtual list does not collapse to 0px then jump (matches images).
          className="max-h-80 min-h-48 max-w-full rounded-lg bg-default-100 object-contain"
        />
      </button>
      <MediaLightbox
        kind="video"
        src={src}
        alt={alt}
        isOpen={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onOpenOriginal={() => onOpen(src)}
      />
    </>
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
 * Spoiler overlay for adult-NSFW video in a non-permitted context (`gated`).
 * Parallel to `GatedImage`: bytes are not fetched until the viewer reveals.
 */
function GatedVideo({
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
      <EmbeddedVideo
        src={attachment.url}
        alt={attachmentFilename(attachment.url)}
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

/** Render one video attachment switched on its moderation status (mirrors ModeratedImage). */
function ModeratedVideo({
  attachment,
  onOpen,
}: {
  attachment: AttachmentResponse
  onOpen: (url: string) => void
}) {
  const status: ModerationStatus = attachment.moderationStatus
  if (status === 'blocked' || status === 'quarantined') return <RemovedPlaceholder />
  if (status === 'pending') return <ScanningPlaceholder />
  if (status === 'gated') return <GatedVideo attachment={attachment} onOpen={onOpen} />
  return (
    <EmbeddedVideo src={attachment.url} alt={attachmentFilename(attachment.url)} onOpen={onOpen} />
  )
}

/**
 * Discord-style attachment block below the message text: images and videos
 * render inline (2-col grid when multiple images), everything else as a
 * download chip. Each attachment's render is gated on its content-moderation
 * status (blurred while `pending`, spoiler-gated when `gated`, removed when
 * `blocked`/`quarantined`). Clicking an image/video enlarges it in the
 * lightbox; opening the original in a new tab stays gated by the existing
 * ExternalLinkWarning flow, as does opening a non-media file chip.
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

  // WHY partition (not a silent drop): every attachment renders — images and
  // videos as (moderation-gated) inline embeds, the rest as download chips.
  const images = attachments.filter((a) => isImageMime(a.mime) === true)
  const videos = attachments.filter((a) => isVideoMime(a.mime) === true)
  const files = attachments.filter(
    (a) => isImageMime(a.mime) === false && isVideoMime(a.mime) === false,
  )

  return (
    <div data-test="message-attachments" className="mt-1 flex flex-col items-start gap-1">
      {images.length > 0 && (
        <div className={images.length > 1 ? 'grid max-w-lg grid-cols-2 gap-1' : 'max-w-lg'}>
          {images.map((a) => (
            <ModeratedImage key={a.id} attachment={a} onOpen={handleOpen} />
          ))}
        </div>
      )}
      {videos.map((a) => (
        <div key={a.id} className="max-w-lg">
          <ModeratedVideo attachment={a} onOpen={handleOpen} />
        </div>
      ))}
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
