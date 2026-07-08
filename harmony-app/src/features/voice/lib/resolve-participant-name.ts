import type { MemberResponse, VoiceParticipantResponse } from '@/lib/api'
import { resolveDisplayName } from '@/lib/display-name'

/**
 * WHY: Users must never see a raw UUID in the UI. Resolution order:
 *   1. server member list — nickname ?? displayName ?? username (shared resolver)
 *   2. participant.displayName (the LiveKit/SSE token's server-resolved name)
 *   3. caller-supplied neutral placeholder (i18n "Unknown user")
 * The userId is NEVER used as a display value.
 *
 * WHY the member cache wins over participant.displayName: the member cache is
 * REACTIVE — use-realtime-profile patches it on profile.updated and
 * use-realtime-members on nickname changes — so preferring it makes voice show
 * the per-server nickname AND update live when the subject changes their name.
 * participant.displayName is a snapshot captured at join time (from the LiveKit
 * token or the voice SSE payload) and never changes, so it is only the fallback
 * for a participant not yet in the member roster (e.g. the optimistic
 * self-insert before the roster loads, or a cross-server voice room).
 */
export function resolveParticipantName(
  participant: Pick<VoiceParticipantResponse, 'userId' | 'displayName'>,
  members: MemberResponse[] | undefined,
  unknownLabel: string,
): string {
  const member = members?.find((m) => m.userId === participant.userId)
  if (member !== undefined) return resolveDisplayName(member)

  if (participant.displayName.length > 0) return participant.displayName

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
