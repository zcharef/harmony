import { File, FileArchive, FileText, ImageOff } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLinkWarning } from '@/components/shared/external-link-warning'
import type { AttachmentResponse } from '@/lib/api'
import { attachmentFilename, humanFileSize, isImageMime } from '../lib/attachment-file'

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

/**
 * Discord-style attachment block below the message text: images render
 * inline (2-col grid when multiple), everything else as a download chip.
 * Opening any attachment is gated by the existing ExternalLinkWarning flow.
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
  // inline embeds, the rest as download chips.
  const images = attachments.filter((a) => isImageMime(a.mime) === true)
  const files = attachments.filter((a) => isImageMime(a.mime) === false)

  return (
    <div data-test="message-attachments" className="mt-1 flex flex-col items-start gap-1">
      {images.length > 0 && (
        <div className={images.length > 1 ? 'grid max-w-lg grid-cols-2 gap-1' : 'max-w-lg'}>
          {images.map((a) => (
            <EmbeddedImage
              key={a.id}
              src={a.url}
              alt={attachmentFilename(a.url)}
              width={a.width ?? undefined}
              height={a.height ?? undefined}
              onOpen={handleOpen}
            />
          ))}
        </div>
      )}
      {files.map((a) => (
        <AttachmentFileChip key={a.id} attachment={a} onOpen={handleOpen} />
      ))}
      <ExternalLinkWarning
        isOpen={pendingUrl !== null}
        url={pendingUrl ?? ''}
        onClose={() => setPendingUrl(null)}
        onContinue={handleContinue}
      />
    </div>
  )
}
