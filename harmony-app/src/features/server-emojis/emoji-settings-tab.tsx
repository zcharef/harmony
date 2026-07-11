import { Button, Spinner } from '@heroui/react'
import { Smile, Trash2, Upload } from 'lucide-react'
import { type ChangeEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { useCreateEmoji } from './hooks/use-create-emoji'
import { useDeleteEmoji } from './hooks/use-delete-emoji'
import { useServerEmojis } from './hooks/use-server-emojis'
import { EMOJI_MAX_BYTES, EmojiUploadError } from './lib/emoji-file'

/** WHY zod (not `as`): reads the HTTP status off an unknown thrown error
 * without a type assertion (ADR-035). */
const errorStatusSchema = z.object({ status: z.number() })

interface EmojiSettingsTabProps {
  serverId: string
}

/** Strip the extension + lowercase so an uploaded `Party.PNG` seeds `party`. */
function defaultNameFromFile(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, '').toLowerCase()
  const cleaned = base.replace(/[^a-z0-9_]/g, '_').slice(0, 32)
  return cleaned.length >= 2 ? cleaned : 'emoji'
}

/** Map any create failure to an inline i18n key (ADR-045). */
function errorKeyFor(error: unknown): string {
  if (error instanceof EmojiUploadError) {
    switch (error.code) {
      case 'invalidType':
        return 'errorInvalidType'
      case 'tooLarge':
        return 'errorTooLarge'
      case 'animatedNotAllowed':
        return 'errorAnimatedNotAllowed'
      case 'limitReached':
        return 'limitReached'
      default:
        return 'errorUploadFailed'
    }
  }
  // Server RFC-9457 errors: 409 = duplicate name, 403 = plan limit / Free tier.
  const parsed = errorStatusSchema.safeParse(error)
  if (parsed.success && parsed.data.status === 409) return 'errorDuplicateName'
  if (parsed.success && parsed.data.status === 403) return 'limitReached'
  return 'errorUploadFailed'
}

/** View discriminant so the render avoids combined boolean negations (ADR-045). */
type EmojiViewState = 'loading' | 'error' | 'empty' | 'populated'

function viewStateOf(isPending: boolean, isError: boolean, count: number): EmojiViewState {
  if (isPending) return 'loading'
  if (isError) return 'error'
  if (count === 0) return 'empty'
  return 'populated'
}

export function EmojiSettingsTab({ serverId }: EmojiSettingsTabProps) {
  const { t } = useTranslation('server-emojis')
  const fileInputId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  const { data, isPending, isError, refetch } = useServerEmojis(serverId)
  const createEmoji = useCreateEmoji(serverId)
  const deleteEmoji = useDeleteEmoji(serverId)

  const emojis = data?.items ?? []
  const count = data?.total ?? emojis.length
  const viewState = viewStateOf(isPending, isError, emojis.length)

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // WHY reset value: re-selecting the same file must re-fire onChange.
    event.target.value = ''
    if (file === undefined) return

    setErrorKey(null)
    try {
      await createEmoji.mutateAsync({
        file,
        name: defaultNameFromFile(file),
        // WHY permissive client limits: the API does not expose the server's
        // plan, so the server is the authoritative gate (cap / animated / Free).
        limits: { maxBytes: EMOJI_MAX_BYTES, animatedAllowed: true },
      })
    } catch (error) {
      setErrorKey(errorKeyFor(error))
    }
  }

  function handleDelete(emojiId: string, url: string) {
    deleteEmoji.mutate(
      { emojiId, url },
      {
        onError: (error) => {
          logger.error('emoji_delete_tab_failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        },
      },
    )
  }

  return (
    <div className="mx-auto max-w-2xl" data-test="emoji-settings-tab">
      {/* Header: count is the quiet meta; Upload is the focal action. */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t('tabEmojis')}</h2>
          <p className="mt-0.5 text-xs text-default-500 tabular-nums" data-test="emoji-count">
            {t('count', { n: count })}
          </p>
        </div>
        <Button
          color="primary"
          size="sm"
          startContent={<Upload className="h-4 w-4" />}
          isLoading={createEmoji.isPending}
          onPress={() => fileInputRef.current?.click()}
          data-test="emoji-upload-button"
        >
          {t('uploadEmoji')}
        </Button>
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleFileChange}
          aria-label={t('uploadEmoji')}
        />
      </div>

      {errorKey !== null && (
        <p className="mb-3 text-xs text-danger" data-test="emoji-error">
          {t(errorKey, { count })}
        </p>
      )}

      {viewState === 'loading' && (
        <div className="flex justify-center py-10">
          <Spinner size="sm" />
        </div>
      )}

      {viewState === 'error' && (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-xs text-danger">{t('errorUploadFailed')}</p>
          <Button size="sm" variant="flat" onPress={() => refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {viewState === 'empty' && (
        <div
          className="flex flex-col items-center gap-2 rounded-large border border-dashed border-default-200 py-12 text-center"
          data-test="emoji-empty-state"
        >
          <Smile className="h-8 w-8 text-default-300" />
          <p className="text-sm text-default-500">{t('emptyState')}</p>
        </div>
      )}

      {viewState === 'populated' && (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
          {emojis.map((emoji) => (
            <li
              key={emoji.id}
              className="group relative flex flex-col items-center gap-1.5 rounded-large border border-default-200 bg-default-50 p-3 transition-colors hover:bg-default-100"
              data-test="emoji-card"
            >
              <img
                src={emoji.url}
                alt={`:${emoji.name}:`}
                className="h-10 w-10 object-contain"
                draggable={false}
              />
              <span className="w-full truncate text-center text-xs text-default-500">
                :{emoji.name}:
              </span>
              <Button
                isIconOnly
                size="sm"
                variant="light"
                color="danger"
                aria-label={t('deleteEmoji')}
                data-test="emoji-delete-button"
                className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100"
                onPress={() => handleDelete(emoji.id, emoji.url)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
