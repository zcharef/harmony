import type { MemberResponse, VoiceParticipantResponse } from '@/lib/api'

/**
 * WHY: Users must never see a raw UUID in the UI. A voice participant's
 * displayName can arrive empty (LiveKit token without a name grant for the
 * optimistic self-insert, or an SSE payload for a user whose profile lookup
 * failed server-side). Resolution order:
 *   1. participant.displayName (server-resolved nickname or username)
 *   2. server member list — nickname ?? username (same precedence as member-list.tsx)
 *   3. caller-supplied neutral placeholder (i18n "Unknown user")
 * The userId is NEVER used as a display value.
 */
export function resolveParticipantName(
  participant: Pick<VoiceParticipantResponse, 'userId' | 'displayName'>,
  members: MemberResponse[] | undefined,
  unknownLabel: string,
): string {
  if (participant.displayName.length > 0) return participant.displayName

  const member = members?.find((m) => m.userId === participant.userId)
  if (member !== undefined) return member.nickname ?? member.username

  return unknownLabel
}
