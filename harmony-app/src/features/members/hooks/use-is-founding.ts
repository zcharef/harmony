import { useMembers } from './use-members'

/**
 * WHY: The message author line needs a member's founding status, but the
 * message payload does not carry it (it stays on the profile/member response,
 * ticket §4). This reads the founding flag from the already-cached member list
 * for `serverId` — no extra fetch, and it rehydrates reactively when the list
 * loads or updates. Returns `false` outside a server context (DMs) or before
 * the member is in cache; the badge simply does not render until known.
 */
export function useIsFounding(userId: string, serverId: string | null): boolean {
  const { data } = useMembers(serverId)
  const member = data?.items.find((m) => m.userId === userId)
  return member?.isFounding === true
}
