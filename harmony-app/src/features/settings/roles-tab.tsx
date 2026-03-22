import {
  Avatar,
  Button,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Spinner,
} from '@heroui/react'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/features/auth'
import {
  getMemberRole,
  type MemberRole,
  ROLE_HIERARCHY,
  RoleBadge,
  useChangeRole,
  useMembers,
} from '@/features/members'
import type { MemberResponse } from '@/lib/api'
import { useTransferOwnership } from './hooks/use-transfer-ownership'

/** WHY: Static map avoids dynamic i18n key construction (no `as Type` needed). */
const ROLE_LABEL_KEY: Record<
  MemberRole,
  'members:roleOwner' | 'members:roleAdmin' | 'members:roleModerator' | 'members:roleMember'
> = {
  owner: 'members:roleOwner',
  admin: 'members:roleAdmin',
  moderator: 'members:roleModerator',
  member: 'members:roleMember',
}

/** WHY: Determines which roles a caller can assign based on their own role. */
function getAssignableRoles(callerRole: MemberRole): MemberRole[] {
  if (callerRole === 'owner') return ['admin', 'moderator', 'member']
  if (callerRole === 'admin') return ['moderator', 'member']
  return []
}

const ROLE_COLOR: Record<MemberRole, 'warning' | 'danger' | 'primary' | 'default'> = {
  owner: 'warning',
  admin: 'danger',
  moderator: 'primary',
  member: 'default',
}

function MemberRoleRow({
  member,
  role,
  callerRole,
  serverId,
  isSelf,
}: {
  member: MemberResponse
  role: MemberRole
  callerRole: MemberRole
  serverId: string
  isSelf: boolean
}) {
  const { t } = useTranslation('settings')
  const changeRole = useChangeRole(serverId)
  const assignableRoles = getAssignableRoles(callerRole)
  const displayName = member.nickname ?? member.username

  /** WHY: Cannot change own role, cannot change role of someone at or above your rank. */
  const canChangeRole =
    !isSelf && ROLE_HIERARCHY[callerRole] > ROLE_HIERARCHY[role] && assignableRoles.length > 0

  function handleRoleChange(selection: 'all' | Set<string | number>) {
    if (selection === 'all') return
    const newRole = Array.from(selection)[0]
    if (typeof newRole !== 'string') return
    if (newRole === role) return
    if (newRole !== 'admin' && newRole !== 'moderator' && newRole !== 'member') return
    changeRole.mutate({ userId: member.userId, role: newRole })
  }

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-default-100"
      data-test="roles-member-row"
      data-user-id={member.userId}
    >
      <Avatar
        name={displayName}
        src={member.avatarUrl ?? undefined}
        size="sm"
        showFallback
        classNames={{ base: 'h-8 w-8 shrink-0', name: 'text-xs' }}
      />
      <div className="flex-1 overflow-hidden">
        <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
        {isSelf && <span className="ml-1 text-xs text-default-400">({t('you')})</span>}
      </div>
      {canChangeRole ? (
        <Select
          aria-label={t('members:changeRole')}
          size="sm"
          className="w-36"
          selectedKeys={new Set([role])}
          onSelectionChange={handleRoleChange}
          isLoading={changeRole.isPending}
          data-test="role-select"
        >
          {assignableRoles.map((r) => (
            <SelectItem key={r}>{t(ROLE_LABEL_KEY[r])}</SelectItem>
          ))}
        </Select>
      ) : (
        <Chip
          size="sm"
          variant="flat"
          color={ROLE_COLOR[role]}
          startContent={<RoleBadge role={role} />}
        >
          {t(ROLE_LABEL_KEY[role])}
        </Chip>
      )}
    </div>
  )
}

function TransferOwnershipModal({
  isOpen,
  onClose,
  serverId,
  members,
  currentUserId,
}: {
  isOpen: boolean
  onClose: () => void
  serverId: string
  members: MemberResponse[]
  currentUserId: string
}) {
  const { t } = useTranslation('settings')
  const transfer = useTransferOwnership(serverId)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)

  /** WHY: Only non-self members can receive ownership. */
  const candidates = members.filter((m) => m.userId !== currentUserId)

  function handleTransfer() {
    if (selectedUserId === null) return
    transfer.mutate(selectedUserId, {
      onSuccess: () => {
        onClose()
      },
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" data-test="transfer-ownership-modal">
      <ModalContent>
        <ModalHeader>{t('transferOwnership')}</ModalHeader>
        <ModalBody>
          <p className="text-sm text-default-500">{t('transferOwnershipWarning')}</p>
          <Select
            label={t('selectNewOwner')}
            className="mt-3"
            selectedKeys={selectedUserId !== null ? new Set([selectedUserId]) : new Set<string>()}
            onSelectionChange={(selection) => {
              if (selection === 'all') return
              const first = Array.from(selection)[0]
              setSelectedUserId(typeof first === 'string' ? first : null)
            }}
            data-test="transfer-owner-select"
          >
            {candidates.map((m) => (
              <SelectItem key={m.userId}>{m.nickname ?? m.username}</SelectItem>
            ))}
          </Select>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            color="danger"
            isDisabled={selectedUserId === null}
            isLoading={transfer.isPending}
            onPress={handleTransfer}
            data-test="confirm-transfer-button"
          >
            {t('confirmTransfer')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

const ROLE_SECTIONS: MemberRole[] = ['owner', 'admin', 'moderator', 'member']

interface RolesTabProps {
  serverId: string
  callerRole: MemberRole
}

export function RolesTab({ serverId, callerRole }: RolesTabProps) {
  const { t } = useTranslation('settings')
  const currentUserId = useAuthStore((s) => s.user?.id ?? '')
  const { data, isPending } = useMembers(serverId)
  const members = data?.items ?? []
  const [search, setSearch] = useState('')
  const [isTransferOpen, setIsTransferOpen] = useState(false)

  const filtered = useMemo(() => {
    if (search.trim().length === 0) return members
    const lower = search.toLowerCase()
    return members.filter((m) => {
      const name = (m.nickname ?? m.username).toLowerCase()
      return name.includes(lower)
    })
  }, [members, search])

  /** WHY: Group filtered members by role for section display. */
  const grouped = useMemo(() => {
    const groups: Record<MemberRole, MemberResponse[]> = {
      owner: [],
      admin: [],
      moderator: [],
      member: [],
    }
    for (const member of filtered) {
      const role = getMemberRole(member)
      groups[role].push(member)
    }
    return groups
  }, [filtered])

  if (isPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner size="md" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{t('rolesTitle')}</h2>
          <p className="mt-1 text-sm text-default-500">{t('rolesDescription')}</p>
        </div>
        {callerRole === 'owner' && (
          <Button
            color="warning"
            variant="flat"
            onPress={() => setIsTransferOpen(true)}
            data-test="transfer-ownership-button"
          >
            {t('transferOwnership')}
          </Button>
        )}
      </div>

      <Input
        placeholder={t('searchMembers')}
        startContent={<Search className="h-4 w-4 text-default-400" />}
        value={search}
        onValueChange={setSearch}
        className="max-w-sm"
        data-test="roles-search-input"
      />

      <div data-test="settings-role-list" className="space-y-4">
        {ROLE_SECTIONS.map((role) => {
          const sectionMembers = grouped[role]
          if (sectionMembers.length === 0) return null

          return (
            <div key={role}>
              <div className="px-1 pb-1">
                <span className="text-xs font-semibold uppercase text-default-500">
                  {t(`members:roleSection_${role}`, { count: sectionMembers.length })}
                </span>
              </div>
              {sectionMembers.map((member) => (
                <MemberRoleRow
                  key={member.userId}
                  member={member}
                  role={getMemberRole(member)}
                  callerRole={callerRole}
                  serverId={serverId}
                  isSelf={member.userId === currentUserId}
                />
              ))}
            </div>
          )
        })}
      </div>

      <TransferOwnershipModal
        isOpen={isTransferOpen}
        onClose={() => setIsTransferOpen(false)}
        serverId={serverId}
        members={members}
        currentUserId={currentUserId}
      />
    </div>
  )
}
