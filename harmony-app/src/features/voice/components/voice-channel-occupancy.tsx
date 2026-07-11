/**
 * Small participant-count chip shown on a voice channel row in the sidebar.
 *
 * WHY: The avatar list below the channel already shows WHO is in voice; the
 * count on the row itself makes occupancy scannable at a glance even when the
 * row is collapsed visually among many channels. Shares the participants query
 * key with VoiceParticipantList (cache hit, no extra request) and stays live
 * through the same SSE-driven cache updates.
 */

import { Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useVoiceParticipants } from '../hooks/use-voice-participants'

export function VoiceChannelOccupancy({ channelId }: { channelId: string }) {
  const { t } = useTranslation('voice')
  const { data: participants } = useVoiceParticipants(channelId)
  const count = participants?.length ?? 0

  if (count === 0) return null

  return (
    <span
      data-test="voice-channel-occupancy"
      className="ml-auto flex shrink-0 items-center gap-0.5 text-xs text-default-400"
    >
      <Users className="h-3 w-3" aria-hidden="true" />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t('participantCount', { count })}</span>
    </span>
  )
}
