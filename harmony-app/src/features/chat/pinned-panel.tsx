import { Avatar, Button, Spinner } from '@heroui/react'
import { Pin, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MessageResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { MentionText } from './components/mention-text'
import { usePins } from './hooks/use-pins'
import { useUnpinMessage } from './hooks/use-unpin-message'

interface PinnedPanelProps {
  channelId: string
  serverId: string | null
  /** Whether the current user may unpin (moderator+). The read view is open to all. */
  canModerate: boolean
  /** Only fetch while the popover is open (the query is `enabled` on this). */
  isOpen: boolean
  /** Jump the main list to a message, then close the popover. */
  onJumpToMessage: (messageId: string) => void
  onClose: () => void
}

// WHY locale-aware, no new i18n keys: Intl.RelativeTimeFormat renders "2h ago"
// in the user's locale from the raw timestamp.
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
function relativePinned(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return ''
  const diffSec = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second')
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour')
  return rtf.format(Math.round(diffSec / 86_400), 'day')
}

/**
 * Pinned-messages popover body. Opened from the channel-header pin button. Reads
 * `usePins` (only while open); pin/unpin/delete keep it live via `useRealtimePins`.
 *
 * Intent: a quiet reference drawer — the content snippet leads each row, author
 * and pinned-time are demoted metadata, one accent for the jump affordance.
 */
export function PinnedPanel({
  channelId,
  serverId,
  canModerate,
  isOpen,
  onJumpToMessage,
  onClose,
}: PinnedPanelProps) {
  const { t } = useTranslation('chat')
  const query = usePins(channelId, isOpen)
  const count = query.data?.total ?? 0

  return (
    <section className="flex max-h-[70vh] w-96 flex-col" aria-label={t('pinnedMessages')}>
      <div className="flex items-center gap-2 border-b border-divider px-3 py-2">
        <Pin className="h-4 w-4 text-default-500" />
        <span className="text-sm font-semibold text-foreground">{t('pinnedMessages')}</span>
        {count > 0 && <span className="text-xs text-default-400">{count}</span>}
      </div>

      <div className="overflow-y-auto">
        <PinnedPanelBody
          channelId={channelId}
          serverId={serverId}
          canModerate={canModerate}
          isOpen={isOpen}
          query={query}
          onJumpToMessage={onJumpToMessage}
          onClose={onClose}
        />
      </div>
    </section>
  )
}

// WHY extracted: keeps the state machine (loading / error / empty / list) as flat
// early returns instead of a nested ternary, holding cognitive complexity down.
function PinnedPanelBody({
  channelId,
  serverId,
  canModerate,
  isOpen,
  query,
  onJumpToMessage,
  onClose,
}: {
  channelId: string
  serverId: string | null
  canModerate: boolean
  isOpen: boolean
  query: ReturnType<typeof usePins>
  onJumpToMessage: (messageId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('chat')
  const unpin = useUnpinMessage(channelId)
  const { data, isPending, isError, refetch } = query

  if (isPending && isOpen) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="sm" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
        <p className="text-sm text-default-500">{t('pinsLoadError')}</p>
        <Button size="sm" variant="flat" onPress={() => void refetch()}>
          {t('common:tryAgain')}
        </Button>
      </div>
    )
  }

  const items = data?.items ?? []
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <Pin className="h-6 w-6 text-default-300" />
        <p className="text-sm text-default-400">{t('noPinnedMessages')}</p>
      </div>
    )
  }

  return (
    <ul className="flex flex-col py-1">
      {items.map((message) => (
        <PinnedRow
          key={message.id}
          message={message}
          serverId={serverId}
          canModerate={canModerate}
          isUnpinning={unpin.isPending && unpin.variables === message.id}
          onJump={() => {
            onJumpToMessage(message.id)
            onClose()
          }}
          onUnpin={() => unpin.mutate(message.id)}
        />
      ))}
    </ul>
  )
}

function PinnedRow({
  message,
  serverId,
  canModerate,
  isUnpinning,
  onJump,
  onUnpin,
}: {
  message: MessageResponse
  serverId: string | null
  canModerate: boolean
  isUnpinning: boolean
  onJump: () => void
  onUnpin: () => void
}) {
  const { t } = useTranslation('chat')
  const authorLabel = resolveDisplayName({
    displayName: message.authorDisplayName,
    username: message.authorUsername,
  })

  return (
    <li className="flex items-start gap-1 transition-colors hover:bg-default-100">
      {/* WHY a button (not a clickable div): keyboard + focus for free, and a
          separate hit area from the unpin control so clicks never overlap. */}
      <button
        type="button"
        onClick={onJump}
        data-test="pinned-row"
        className="flex min-w-0 flex-1 gap-2 px-3 py-2 text-left"
      >
        <Avatar
          name={authorLabel}
          src={message.authorAvatarUrl ?? undefined}
          color="primary"
          size="sm"
          showFallback
          classNames={{ base: 'h-7 w-7 shrink-0', name: 'text-xs' }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{authorLabel}</span>
            <span className="shrink-0 text-xs text-default-400">
              {relativePinned(message.pinnedAt)}
            </span>
          </div>
          <div className="line-clamp-2 text-sm text-default-600">
            {message.encrypted === true ? (
              <span className="italic text-default-400">{t('encryptedMessage')}</span>
            ) : (
              <MentionText
                content={message.content}
                mentions={message.mentions}
                serverId={serverId}
              />
            )}
          </div>
        </div>
      </button>
      {canModerate && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          isDisabled={isUnpinning}
          isLoading={isUnpinning}
          onPress={onUnpin}
          aria-label={t('unpinMessage')}
          data-test="pinned-row-unpin"
          className="mr-1 mt-1 shrink-0"
        >
          <X className="h-4 w-4 text-default-400" />
        </Button>
      )}
    </li>
  )
}
