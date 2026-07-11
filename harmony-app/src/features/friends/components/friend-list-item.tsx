import {
  Avatar,
  Button,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure,
} from '@heroui/react'
import { MessageSquare, MoreVertical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCreateDm } from '@/features/dms'
import { StatusIndicator, useUserStatus } from '@/features/presence'
import type { FriendResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { useBlockUser } from '../hooks/use-block-user'
import { useUnfriend } from '../hooks/use-unfriend'

interface FriendListItemProps {
  friend: FriendResponse
  onNavigateDm: (serverId: string, channelId: string) => void
}

const STATUS_LABEL_KEY = {
  online: 'friends:statusOnline',
  idle: 'friends:statusIdle',
  dnd: 'friends:statusDnd',
  offline: 'friends:statusOffline',
} as const

export function FriendListItem({ friend, onNavigateDm }: FriendListItemProps) {
  const { t } = useTranslation('friends')
  const displayName = resolveDisplayName(friend.user)
  const status = useUserStatus(friend.user.id)
  const createDm = useCreateDm()
  const unfriend = useUnfriend()
  const blockUser = useBlockUser()
  const blockConfirm = useDisclosure()

  function handleMessage() {
    createDm.mutate(friend.user.id, {
      onSuccess: (data) => onNavigateDm(data.serverId, data.channelId),
    })
  }

  return (
    <div
      data-test="friend-list-item"
      className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-default-100"
    >
      <div className="relative shrink-0">
        <Avatar
          name={displayName}
          src={friend.user.avatarUrl ?? undefined}
          size="sm"
          showFallback
          classNames={{ base: 'h-9 w-9', name: 'text-xs' }}
        />
        <div className="absolute -bottom-0.5 -right-0.5">
          <StatusIndicator status={status} size="sm" />
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
        {/* WHY: label text conveys status, not color alone (a11y §5.5). */}
        <span className="truncate text-xs text-default-500">{t(STATUS_LABEL_KEY[status])}</span>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
        <Button
          isIconOnly
          variant="flat"
          size="sm"
          aria-label={t('message')}
          onPress={handleMessage}
          isLoading={createDm.isPending}
          data-test="friend-message-button"
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
        <Dropdown placement="bottom-end">
          <DropdownTrigger>
            <Button
              isIconOnly
              variant="light"
              size="sm"
              aria-label={t('moreActions', { name: displayName })}
              data-test="friend-more-button"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownTrigger>
          <DropdownMenu aria-label={t('moreActions', { name: displayName })}>
            <DropdownItem
              key="remove"
              onPress={() => unfriend.mutate(friend.user.id)}
              data-test="friend-remove-item"
            >
              {t('removeFriend')}
            </DropdownItem>
            <DropdownItem
              key="block"
              className="text-danger"
              color="danger"
              onPress={blockConfirm.onOpen}
              data-test="friend-block-item"
            >
              {t('blockUser')}
            </DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>

      <Modal isOpen={blockConfirm.isOpen} onOpenChange={blockConfirm.onOpenChange} size="sm">
        <ModalContent data-test="block-confirm-modal">
          {(onClose) => (
            <>
              <ModalHeader>{t('blockConfirmTitle')}</ModalHeader>
              <ModalBody>
                <p className="text-sm text-default-600">
                  {t('blockConfirmBody', { name: displayName })}
                </p>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>
                  {t('cancel')}
                </Button>
                <Button
                  color="danger"
                  isLoading={blockUser.isPending}
                  onPress={() => {
                    blockUser.mutate(friend.user.id, { onSuccess: onClose })
                  }}
                  data-test="block-confirm-button"
                >
                  {t('blockUser')}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  )
}
