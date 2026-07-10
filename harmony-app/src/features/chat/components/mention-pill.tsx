import { skipToken, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemberListResponse, MentionedUserResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'
import { queryKeys } from '@/lib/query-keys'

interface MentionPillProps {
  userId: string
  /** Server-resolved mention objects riding the message — the primary label source. */
  mentions: MentionedUserResponse[] | undefined
  /** WHY nullable: DMs have no member list; the cache fallback simply never resolves. */
  serverId: string | null
}

/**
 * Renders a `<@uuid>` marker as an `@DisplayName` pill.
 *
 * Label resolution chain (spec §1, in order):
 * 1. `message.mentions` — rides the message, works in DMs and >50-member servers.
 * 2. Members cache — covers optimistic messages and stale-mentions edges.
 * 3. Muted `@unknown-user` — deleted accounts / markers the server never registered.
 */
export function MentionPill({ userId, mentions, serverId }: MentionPillProps) {
  const { t } = useTranslation('messages')

  // WHY skipToken: subscribe to the members cache reactively WITHOUT owning the
  // fetch (useMembers does) — a later cache fill re-renders the pill live, with
  // no useState shadow of server data (ADR-045).
  const { data: memberList } = useQuery<MemberListResponse>({
    queryKey: queryKeys.servers.members(serverId ?? ''),
    queryFn: skipToken,
  })

  const fromMessage = mentions?.find((m) => m.userId === userId)
  const fromCache = memberList?.items.find((m) => m.userId === userId)
  const resolved = fromMessage ?? fromCache

  // WHY no aria-label: role-less spans do not support ARIA naming
  // (lint/a11y/useAriaPropsSupportedByRole) — the visible `@Label` text IS the
  // accessible name.
  if (resolved === undefined) {
    return (
      <span
        data-test="mention-pill"
        data-test-unknown="true"
        className="cursor-default rounded bg-default-100 px-1 text-default-500"
      >
        @{t('unknownMention')}
      </span>
    )
  }

  return (
    <span
      data-test="mention-pill"
      data-mention-user-id={userId}
      className="cursor-default rounded bg-primary/10 px-1 font-medium text-primary"
    >
      @{resolveDisplayName(resolved)}
    </span>
  )
}
