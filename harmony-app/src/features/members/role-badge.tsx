import { Crown, Shield, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MemberRole } from './moderation-types'

/** WHY: Semantic HeroUI tokens instead of hardcoded Tailwind colors (ADR-044). */
const ROLE_ICON_CLASS: Record<MemberRole, string> = {
  owner: 'text-warning',
  admin: 'text-danger',
  moderator: 'text-primary',
  member: '',
}

/**
 * WHY: Role badge icon displayed next to member names. Extracted as a shared
 * component to avoid duplication between member-list and roles-tab.
 */
export function RoleBadge({ role }: { role: MemberRole }) {
  const { t } = useTranslation('members')

  switch (role) {
    case 'owner':
      return (
        <Crown
          className={`h-3.5 w-3.5 shrink-0 ${ROLE_ICON_CLASS.owner}`}
          aria-label={t('roleOwner')}
        />
      )
    case 'admin':
      return (
        <Shield
          className={`h-3.5 w-3.5 shrink-0 ${ROLE_ICON_CLASS.admin}`}
          aria-label={t('roleAdmin')}
        />
      )
    case 'moderator':
      return (
        <Star
          className={`h-3.5 w-3.5 shrink-0 ${ROLE_ICON_CLASS.moderator}`}
          aria-label={t('roleModerator')}
        />
      )
    case 'member':
      return null
  }
}
