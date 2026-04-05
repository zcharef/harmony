/**
 * Renders voice participants beneath a voice channel in the sidebar.
 *
 * WHY separate component: Keeps ChannelSidebar's cognitive complexity low
 * and isolates voice-specific subscriptions (SSE + Zustand store) so they
 * only mount when the channel is visible.
 */

import { Avatar } from '@heroui/react'
import { MicOff } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useRealtimeVoice } from '../hooks/use-realtime-voice'
import { useVoiceParticipants } from '../hooks/use-voice-participants'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'

interface VoiceParticipantListProps {
  channelId: string
}

export function VoiceParticipantList({ channelId }: VoiceParticipantListProps) {
  const { data: participants } = useVoiceParticipants(channelId)
  const activeSpeakers = useVoiceConnectionStore((s) => s.activeSpeakers)

  // WHY: Keeps TanStack Query cache updated via SSE for this channel.
  useRealtimeVoice(channelId)

  if (participants === undefined || participants.length === 0) {
    return null
  }

  return (
    <ul className="flex flex-col gap-0.5 pb-1 pl-6 pr-2" data-test="voice-participant-list">
      {participants.map((participant) => {
        const isSpeaking = activeSpeakers.has(participant.userId)
        const displayName =
          participant.displayName.length > 0 ? participant.displayName : participant.userId

        return (
          <li
            key={participant.userId}
            data-test={`voice-participant-${participant.userId}`}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5"
          >
            <Avatar
              name={displayName}
              size="sm"
              showFallback
              classNames={{
                base: cn(
                  'h-6 w-6 shrink-0 transition-shadow duration-75',
                  isSpeaking && 'ring-2 ring-success ring-offset-1 ring-offset-default-100',
                ),
                name: 'text-[10px]',
              }}
            />
            <span className="min-w-0 flex-1 truncate text-xs text-default-500">{displayName}</span>
            {/* WHY: MicOff shown only when the local user is the participant and
                is muted. The API does not expose remote mute state — only the
                local connection store tracks isMuted. */}
            <LocalMuteIndicator participantUserId={participant.userId} />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * WHY extracted: Subscribing to isMuted + auth user per row would cause every
 * row to re-render when any slice changes. Extracting isolates the subscription
 * to only the row that matches the local user.
 */
function LocalMuteIndicator({ participantUserId }: { participantUserId: string }) {
  const isMuted = useVoiceConnectionStore((s) => s.isMuted)
  const currentChannelId = useVoiceConnectionStore((s) => s.currentChannelId)

  // WHY: Only show the mute icon for the locally connected user in their
  // active channel. We cannot know remote participants' mute state from
  // the current API shape.
  if (currentChannelId === null || !isMuted) return null

  // WHY: We check if the local user's identity matches this participant.
  // The store's room.localParticipant.identity holds the user ID.
  const room = useVoiceConnectionStore.getState().room
  if (room === null || room.localParticipant.identity !== participantUserId) return null

  return <MicOff className="h-3 w-3 shrink-0 text-default-400" data-test="mic-off-indicator" />
}
