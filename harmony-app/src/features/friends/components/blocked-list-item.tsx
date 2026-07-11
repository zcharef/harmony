import { Avatar, Button } from '@heroui/react'
import { useTranslation } from 'react-i18next'
import type { BlockedUserResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { useUnblockUser } from '../hooks/use-unblock-user'

interface BlockedListItemProps {
  blocked: BlockedUserResponse
}

export function BlockedListItem({ blocked }: BlockedListItemProps) {
  const { t } = useTranslation('friends')
  const displayName = resolveDisplayName(blocked.user)
  const unblock = useUnblockUser()

  return (
    <div
      data-test="blocked-list-item"
      className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-default-100"
    >
      <Avatar
        name={displayName}
        src={blocked.user.avatarUrl ?? undefined}
        size="sm"
        showFallback
        classNames={{ base: 'h-9 w-9', name: 'text-xs' }}
      />
      <span className="flex-1 truncate text-sm font-medium text-foreground">{displayName}</span>
      <Button
        variant="flat"
        size="sm"
        isLoading={unblock.isPending}
        onPress={() => unblock.mutate(blocked.user.id)}
        data-test="blocked-unblock-button"
      >
        {t('unblock')}
      </Button>
    </div>
  )
}
