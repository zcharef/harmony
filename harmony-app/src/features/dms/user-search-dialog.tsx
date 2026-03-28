import {
  Avatar,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Spinner,
} from '@heroui/react'
import { useQueries } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/features/auth'
import { useServers } from '@/features/server-nav'
import type { MemberResponse } from '@/lib/api'
import { listMembers } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useCreateDm } from './hooks/use-create-dm'

/**
 * WHY: useQueries is the TanStack Query pattern for a dynamic number of
 * parallel queries. This avoids calling useQuery in a loop (hooks rule
 * violation). Each server's member list is fetched independently and cached.
 */
function useKnownUsers(serverIds: string[]) {
  const results = useQueries({
    queries: serverIds.map((serverId) => ({
      queryKey: queryKeys.servers.members(serverId),
      queryFn: async () => {
        const { data } = await listMembers({
          path: { id: serverId },
          throwOnError: true,
        })
        return data
      },
    })),
  })

  const isPending = results.some((q) => q.isPending)
  const isError = results.every((q) => q.isError) && serverIds.length > 0

  const users = useMemo(() => {
    const seen = new Set<string>()
    const deduped: MemberResponse[] = []

    for (const query of results) {
      const members = query.data?.items ?? []
      for (const member of members) {
        if (!seen.has(member.userId)) {
          seen.add(member.userId)
          deduped.push(member)
        }
      }
    }

    // WHY: Sort alphabetically by username for predictable display order
    return deduped.sort((a, b) => a.username.localeCompare(b.username))
  }, [results])

  return { users, isPending, isError }
}

interface UserSearchDialogProps {
  isOpen: boolean
  onClose: () => void
  onDmCreated: (serverId: string, channelId: string) => void
}

export function UserSearchDialog({ isOpen, onClose, onDmCreated }: UserSearchDialogProps) {
  const { t } = useTranslation('dms')
  const [searchQuery, setSearchQuery] = useState('')
  const createDm = useCreateDm()
  const currentUserId = useAuthStore((s) => s.user?.id ?? '')

  // WHY: Get all servers (non-DM) the user is in, then aggregate their members
  const { data: servers } = useServers()
  const regularServerIds = useMemo(
    () => servers?.filter((s) => !s.isDm).map((s) => s.id) ?? [],
    [servers],
  )
  const { users, isPending, isError } = useKnownUsers(regularServerIds)

  // WHY: Filter out current user and apply search query
  const filteredUsers = useMemo(() => {
    const filtered = users.filter((u) => u.userId !== currentUserId)
    if (searchQuery.trim().length === 0) return filtered
    const query = searchQuery.toLowerCase()
    return filtered.filter(
      (u) => u.username.toLowerCase().includes(query) || u.nickname?.toLowerCase().includes(query),
    )
  }, [users, currentUserId, searchQuery])

  function handleSelectUser(userId: string) {
    createDm.mutate(userId, {
      onSuccess: (data) => {
        setSearchQuery('')
        onDmCreated(data.serverId, data.channelId)
      },
    })
  }

  function handleClose() {
    setSearchQuery('')
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="md" data-test="user-search-dialog">
      <ModalContent>
        <ModalHeader>{t('newMessage')}</ModalHeader>
        <ModalBody className="pb-4">
          <Input
            placeholder={t('searchUsersPlaceholder')}
            value={searchQuery}
            onValueChange={setSearchQuery}
            startContent={<Search className="h-4 w-4 text-default-400" />}
            autoFocus
            data-test="user-search-input"
          />

          <div className="max-h-64 overflow-y-auto">
            {isPending && (
              <div className="flex justify-center py-4">
                <Spinner size="sm" />
              </div>
            )}

            {isError && (
              <p className="px-2 py-4 text-center text-xs text-danger">{t('failedToLoadUsers')}</p>
            )}

            {isPending === false && isError === false && filteredUsers.length === 0 && (
              <p className="px-2 py-4 text-center text-sm text-default-500">{t('noUsersFound')}</p>
            )}

            {filteredUsers.map((user) => {
              const displayName = user.nickname ?? user.username
              return (
                <Button
                  key={user.userId}
                  variant="light"
                  className="w-full justify-start gap-2 px-2 py-1.5"
                  isLoading={createDm.isPending && createDm.variables === user.userId}
                  onPress={() => handleSelectUser(user.userId)}
                  data-test="user-search-result"
                  data-user-id={user.userId}
                >
                  <Avatar
                    name={displayName}
                    src={user.avatarUrl ?? undefined}
                    size="sm"
                    showFallback
                    classNames={{ base: 'h-8 w-8', name: 'text-xs' }}
                  />
                  <div className="flex flex-col items-start overflow-hidden">
                    <span className="truncate text-sm text-foreground">{displayName}</span>
                    {user.nickname !== undefined && user.nickname !== null && (
                      <span className="truncate text-xs text-default-500">{user.username}</span>
                    )}
                  </div>
                </Button>
              )
            })}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
