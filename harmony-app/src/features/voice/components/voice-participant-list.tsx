/**
 * Renders voice participants beneath a voice channel in the sidebar.
 *
 * WHY separate component: Keeps ChannelSidebar's cognitive complexity low
 * and isolates voice-specific subscriptions (SSE + Zustand store) so they
 * only mount when the channel is visible.
 */

import { Avatar } from '@heroui/react'
import { HeadphoneOff, MicOff } from 'lucide-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

import { useMembers } from '@/features/members'
import type { VoiceParticipantResponse } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useRealtimeVoice } from '../hooks/use-realtime-voice'
import { useVoiceParticipants } from '../hooks/use-voice-participants'
import {
  resolveParticipantAvatarUrl,
  resolveParticipantName,
} from '../lib/resolve-participant-name'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'

interface VoiceParticipantListProps {
  channelId: string
  /** WHY: Needed to resolve empty displayNames from the server member cache. */
  serverId: string | null
}

export function VoiceParticipantList({ channelId, serverId }: VoiceParticipantListProps) {
  const { t } = useTranslation('voice')
  const { data: participants } = useVoiceParticipants(channelId)
  // WHY: Shares the query key with MemberList — cache hit, no extra request
  // in the common case. Used to resolve names when displayName arrives empty.
  const { data: membersData } = useMembers(serverId)
  const activeSpeakers = useVoiceConnectionStore((s) => s.activeSpeakers)

  // WHY: Keeps TanStack Query cache updated via SSE for this channel.
  useRealtimeVoice(channelId)

  if (participants === undefined || participants.length === 0) {
    return null
  }

  return (
    <ul className="flex flex-col gap-0.5 pb-1 pl-6 pr-2" data-test="voice-participant-list">
      {participants.map((participant) => (
        <VoiceParticipantRow
          key={participant.userId}
          participant={participant}
          displayName={resolveParticipantName(
            participant,
            membersData?.items,
            t('unknownParticipant'),
          )}
          avatarUrl={resolveParticipantAvatarUrl(participant, membersData?.items)}
          isSpeaking={activeSpeakers.has(participant.userId)}
        />
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// H2: React.memo participant row — skips re-render when isSpeaking unchanged.
// WHY: The client-side speaking detector fires onChange at ~50ms intervals.
// Without memo, ALL rows re-render on every event even though only 1-2
// participants' isSpeaking actually changes.
// ---------------------------------------------------------------------------

interface VoiceParticipantRowProps {
  participant: VoiceParticipantResponse
  /** WHY: Pre-resolved by the parent (member cache + i18n fallback) — never a raw UUID. */
  displayName: string
  /** WHY: Resolved from the member cache by the parent; undefined → initials fallback. */
  avatarUrl: string | undefined
  isSpeaking: boolean
}

const VoiceParticipantRow = memo(function VoiceParticipantRow({
  participant,
  displayName,
  avatarUrl,
  isSpeaking,
}: VoiceParticipantRowProps) {
  return (
    <li
      data-test={`voice-participant-${participant.userId}`}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5"
    >
      <Avatar
        name={displayName}
        src={avatarUrl}
        size="sm"
        showFallback
        classNames={{
          base: cn(
            'h-6 w-6 shrink-0 transition-shadow',
            isSpeaking
              ? 'duration-0 ring-2 ring-success ring-offset-1 ring-offset-default-100'
              : 'duration-150',
          ),
          name: 'text-[10px]',
        }}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-default-500">{displayName}</span>
      <MuteDeafIndicator participant={participant} />
    </li>
  )
})

/**
 * WHY extracted: Subscribing to isMuted/isDeafened per row would cause every
 * row to re-render when any slice changes. Extracting isolates the Zustand
 * subscription to only the row that matches the local user.
 *
 * For the local user: prefers Zustand store (instant toggle feedback) over
 * the participant cache (SSE-delayed by ~500ms debounce).
 * For remote users: reads from the participant cache (SSE-driven).
 */
function MuteDeafIndicator({ participant }: { participant: VoiceParticipantResponse }) {
  const localMuted = useVoiceConnectionStore((s) => s.isMuted)
  const localDeafened = useVoiceConnectionStore((s) => s.isDeafened)
  // WHY reactive selector instead of getState(): If room changes (e.g. on
  // reconnect), this selector re-evaluates automatically. getState() is a
  // point-in-time read that would go stale.
  const localIdentity = useVoiceConnectionStore((s) => s.room?.localParticipant.identity ?? null)
  const isLocal = localIdentity === participant.userId

  const isMuted = isLocal ? localMuted : participant.isMuted
  const isDeafened = isLocal ? localDeafened : participant.isDeafened

  if (isDeafened)
    return <HeadphoneOff className="h-3 w-3 shrink-0 text-default-400" data-test="deaf-indicator" />
  if (isMuted)
    return <MicOff className="h-3 w-3 shrink-0 text-default-400" data-test="mic-off-indicator" />
  return null
}
