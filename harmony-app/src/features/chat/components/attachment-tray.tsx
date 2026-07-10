import { Button, CircularProgress } from '@heroui/react'
import { File, FileArchive, FileAudio, FileText, FileVideo, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PendingAttachment, PendingStatus } from '../hooks/use-composer-attachments'
import { humanFileSize } from '../lib/attachment-file'

/** Icon per mime family — mirrors the render-side chip in message-attachments. */
function chipIcon(mime: string) {
  if (mime === 'application/pdf' || mime === 'text/plain') return FileText
  if (mime === 'application/zip') return FileArchive
  if (mime.startsWith('video/')) return FileVideo
  if (mime.startsWith('audio/')) return FileAudio
  return File
}

/** aria-label announcing filename, size and upload state for screen readers. */
function tileLabel(item: PendingAttachment, statusText: string): string {
  return `${item.name}, ${humanFileSize(item.size)}, ${statusText}`
}

/** i18n key for a tile's upload status (a switch, not a nested ternary). */
function statusKey(status: PendingStatus): string {
  switch (status) {
    case 'uploading':
      return 'attachUploading'
    case 'error':
      return 'attachUploadFailed'
    default:
      return 'attachReady'
  }
}

function AttachmentTile({
  item,
  onRemove,
}: {
  item: PendingAttachment
  onRemove: (localId: string) => void
}) {
  const { t } = useTranslation('chat')
  const Icon = chipIcon(item.mime)
  const statusText = t(statusKey(item.status))

  return (
    <li
      aria-label={tileLabel(item, statusText)}
      data-test="attachment-tile"
      data-status={item.status}
      className={`relative flex h-20 w-20 shrink-0 list-none items-center justify-center overflow-hidden rounded-lg border ${
        item.status === 'error' ? 'border-danger bg-danger-50' : 'border-default-200 bg-default-100'
      }`}
    >
      {item.isImage === true && item.previewUrl !== null ? (
        <img src={item.previewUrl} alt={item.name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex flex-col items-center gap-1 px-1 text-center">
          <Icon className="h-6 w-6 text-default-500" />
          <span className="w-full truncate text-[10px] text-default-500">{item.name}</span>
        </div>
      )}

      {item.status === 'uploading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <CircularProgress
            size="sm"
            aria-label={t('attachUploading')}
            classNames={{ svg: 'h-6 w-6' }}
          />
        </div>
      )}

      <Button
        isIconOnly
        size="sm"
        radius="full"
        variant="solid"
        color="default"
        data-test="attachment-remove"
        aria-label={t('removeAttachment')}
        className="absolute right-0.5 top-0.5 h-5 w-5 min-w-0 bg-background/80"
        onPress={() => onRemove(item.localId)}
      >
        <X className="h-3 w-3" />
      </Button>
    </li>
  )
}

/**
 * Pending-attachment tray rendered above the composer textarea. Pure UI —
 * image tiles show the downscaled preview, everything else a file-type icon;
 * each tile carries an upload progress ring and a remove control.
 */
export function AttachmentTray({
  items,
  onRemove,
}: {
  items: PendingAttachment[]
  onRemove: (localId: string) => void
}) {
  const { t } = useTranslation('chat')

  if (items.length === 0) return null

  return (
    <ul
      aria-label={t('attachmentTray')}
      data-test="attachment-tray"
      className="mb-2 flex flex-wrap gap-2 px-1"
    >
      {items.map((item) => (
        <AttachmentTile key={item.localId} item={item} onRemove={onRemove} />
      ))}
    </ul>
  )
}
