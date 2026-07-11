import { Tooltip } from '@heroui/react'
import { X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLinkWarning } from '@/components/shared/external-link-warning'
import type { MessageEmbedResponse } from '@/lib/api'
import { useRemoveEmbed } from '../hooks/use-remove-embed'

/**
 * Host label fallback when the page had no `og:site_name`.
 * Returns null for unparseable URLs (the row then renders without a site line).
 */
function siteLabel(embed: MessageEmbedResponse): string | null {
  if (embed.siteName !== undefined && embed.siteName !== null && embed.siteName !== '') {
    return embed.siteName
  }
  try {
    return new URL(embed.url).host
  } catch {
    return null
  }
}

/**
 * One link-preview card. ALL metadata renders as text nodes — the server
 * stores plain text, and nothing here injects HTML.
 *
 * WHY referrerPolicy="no-referrer" on the thumbnail: the remote image is
 * loaded directly (no proxy in v1), so at least the channel URL never leaks
 * to the third-party host via the Referer header.
 */
function EmbedCard({
  embed,
  canRemove,
  isRemoving,
  onOpen,
  onRemove,
}: {
  embed: MessageEmbedResponse
  canRemove: boolean
  isRemoving: boolean
  onOpen: (url: string) => void
  onRemove: (embedId: string) => void
}) {
  const { t } = useTranslation('chat')
  const [imageFailed, setImageFailed] = useState(false)
  const site = siteLabel(embed)

  return (
    <div
      data-test="message-embed"
      className="group/embed relative flex w-fit max-w-lg gap-3 rounded-lg border-default-300 border-l-4 bg-default-100 p-3"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {site !== null && (
          <span data-test="embed-site" className="text-default-500 text-xs">
            {site}
          </span>
        )}
        <button
          type="button"
          data-test="embed-title"
          onClick={() => onOpen(embed.url)}
          className="w-fit cursor-pointer text-left font-medium text-primary text-sm hover:underline"
        >
          {embed.title ?? embed.url}
        </button>
        {embed.description !== undefined && embed.description !== null && (
          <p data-test="embed-description" className="line-clamp-3 text-foreground/80 text-sm">
            {embed.description}
          </p>
        )}
      </div>
      {embed.imageUrl !== undefined && embed.imageUrl !== null && imageFailed === false && (
        <img
          src={embed.imageUrl}
          alt=""
          data-test="embed-thumbnail"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          className="h-20 w-20 shrink-0 self-start rounded-md bg-default-200 object-cover"
        />
      )}
      {canRemove && (
        <Tooltip content={t('removePreview')} size="sm" placement="top">
          <button
            type="button"
            data-test="embed-remove-button"
            aria-label={t('removePreview')}
            disabled={isRemoving}
            onClick={() => onRemove(embed.id)}
            className="absolute top-1 right-1 hidden cursor-pointer rounded p-0.5 text-default-400 transition-colors hover:bg-default-200 hover:text-default-600 disabled:opacity-50 group-hover/embed:block"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * Link-preview block below the message body (Discord-style unfurl cards).
 * Previews arrive asynchronously via message.updated after send; the author
 * (or a moderator) can remove one — persisted server-side, live for everyone.
 * Opening the link stays gated by the shared ExternalLinkWarning flow.
 */
export function MessageEmbeds({
  messageId,
  channelId,
  embeds,
  canRemove,
}: {
  messageId: string
  channelId: string
  embeds: MessageEmbedResponse[]
  canRemove: boolean
}) {
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const removeEmbed = useRemoveEmbed(channelId)

  const handleOpen = useCallback((url: string) => setPendingUrl(url), [])
  const handleContinue = useCallback(() => {
    if (pendingUrl === null) return
    window.open(pendingUrl, '_blank', 'noopener,noreferrer')
    setPendingUrl(null)
  }, [pendingUrl])
  const handleRemove = useCallback(
    (embedId: string) => {
      removeEmbed.mutate({ messageId, embedId })
    },
    [messageId, removeEmbed],
  )

  if (embeds.length === 0) return null

  return (
    <div data-test="message-embeds" className="mt-1 flex flex-col items-start gap-1">
      {embeds.map((embed) => (
        <EmbedCard
          key={embed.id}
          embed={embed}
          canRemove={canRemove}
          isRemoving={removeEmbed.isPending}
          onOpen={handleOpen}
          onRemove={handleRemove}
        />
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
