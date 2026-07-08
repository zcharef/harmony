import type { MemberResponse, VoiceParticipantResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'

/**
 * WHY: Users must never see a raw UUID in the UI. A voice participant's
 * displayName can arrive empty (LiveKit token without a name grant for the
 * optimistic self-insert, or an SSE payload for a user whose profile lookup
 * failed server-side). Resolution order:
 *   1. participant.displayName (server-resolved nickname or username)
 *   2. server member list — nickname ?? displayName ?? username (shared resolver)
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
  if (member !== undefined) return resolveDisplayName(member)

  return unknownLabel
}

/**
 * WHY: VoiceParticipantResponse carries no avatar URL (the LiveKit session only
 * stores userId + a resolved display name). We resolve the avatar from the
 * shared member cache — the same source the name falls back to. Returns
 * undefined when the participant is not in the member cache (e.g. the optimistic
 * self-insert before the roster loads) so the Avatar shows initials.
 */
export function resolveParticipantAvatarUrl(
  participant: Pick<VoiceParticipantResponse, 'userId'>,
  members: MemberResponse[] | undefined,
): string | undefined {
  const member = members?.find((m) => m.userId === participant.userId)
  return member?.avatarUrl ?? undefined
}
