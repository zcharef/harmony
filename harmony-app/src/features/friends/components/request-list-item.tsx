import { Avatar, Button } from '@heroui/react'
import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FriendRequestResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { useAcceptFriendRequest } from '../hooks/use-accept-friend-request'
import { useRemoveFriendRequest } from '../hooks/use-remove-friend-request'

interface RequestListItemProps {
  request: FriendRequestResponse
}

export function RequestListItem({ request }: RequestListItemProps) {
  const { t } = useTranslation('friends')
  const displayName = resolveDisplayName(request.user)
  const accept = useAcceptFriendRequest()
  const remove = useRemoveFriendRequest()
  const isIncoming = request.direction === 'incoming'

  return (
    <div
      data-test="friend-request-item"
      className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-default-100"
    >
      <Avatar
        name={displayName}
        src={request.user.avatarUrl ?? undefined}
        size="sm"
        showFallback
        classNames={{ base: 'h-9 w-9', name: 'text-xs' }}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
        <span className="truncate text-xs text-default-500">
          {isIncoming ? t('incoming') : t('outgoing')}
        </span>
      </div>

      <div className="flex items-center gap-1">
        {isIncoming && (
          <Button
            isIconOnly
            variant="flat"
            color="success"
            size="sm"
            aria-label={t('accept')}
            isLoading={accept.isPending}
            onPress={() => accept.mutate(request.user.id)}
            data-test="friend-request-accept"
          >
            <Check className="h-4 w-4" />
          </Button>
        )}
        <Button
          isIconOnly
          variant="flat"
          size="sm"
          aria-label={isIncoming ? t('decline') : t('cancelRequest')}
          isLoading={remove.isPending}
          onPress={() => remove.mutate(request.user.id)}
          data-test="friend-request-remove"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
