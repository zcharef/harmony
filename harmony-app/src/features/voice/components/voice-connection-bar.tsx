/**
 * Voice connection status bar — sits above the user control panel in the sidebar.
 *
 * WHY: Users need persistent, at-a-glance voice state (channel name, mute/deafen,
 * disconnect) without navigating away from the current channel. Mirrors the Discord
 * voice panel pattern.
 *
 * Shows only when the voice connection is not idle. Status-driven UI:
 * - connecting/reconnecting: spinner + status text
 * - connected: channel name + "Voice Connected"
 * - failed: error message + retry button
 * - disconnected: brief display before auto-transition to idle
 *
 * Pattern reference: connection-banner.tsx (AnimatePresence), audio-autoplay-prompt.tsx
 * (store selectors), channel-sidebar.tsx:L353-L362 (icon button styling).
 */

import { Button, Spinner, Tooltip } from '@heroui/react'
import { AudioWaveform, HeadphoneOff, Headphones, Mic, MicOff, PhoneOff } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useVoiceConnection } from '../hooks/use-voice-connection'
import {
  useVoiceConnectionStore,
  type VoiceConnectionStatus,
} from '../stores/voice-connection-store'

interface VoiceConnectionBarProps {
  /** WHY: Channel name is passed as a prop because the voice store only holds the
   * channelId. The parent (channel-sidebar) already has channel data in scope.
   * Follows the "pass IDs between features, not full objects" rule. */
  channelName: string | null
  onRetry: () => void
}

function StatusText({
  status,
  channelName,
  error,
}: {
  status: VoiceConnectionStatus
  channelName: string | null
  error: string | null
}) {
  switch (status) {
    case 'connecting':
      return <span className="text-xs font-medium text-warning">Connecting...</span>
    case 'reconnecting':
      return <span className="text-xs font-medium text-warning">Reconnecting...</span>
    case 'connected':
      return (
        <>
          <span className="text-xs font-semibold text-success">Voice Connected</span>
          {channelName !== null && (
            <span className="truncate text-xs text-default-500">{channelName}</span>
          )}
        </>
      )
    case 'failed':
      return (
        <span className="truncate text-xs font-medium text-danger">
          {error ?? 'Connection failed'}
        </span>
      )
    case 'disconnected':
      return <span className="text-xs text-default-500">Disconnected</span>
    default:
      return null
  }
}

export function VoiceConnectionBar({ channelName, onRetry }: VoiceConnectionBarProps) {
  const status = useVoiceConnectionStore((s) => s.status)
  const isMuted = useVoiceConnectionStore((s) => s.isMuted)
  const isDeafened = useVoiceConnectionStore((s) => s.isDeafened)
  const error = useVoiceConnectionStore((s) => s.error)
  const isKrispEnabled = useVoiceConnectionStore((s) => s.isKrispEnabled)
  const toggleMute = useVoiceConnectionStore((s) => s.toggleMute)
  const toggleDeafen = useVoiceConnectionStore((s) => s.toggleDeafen)
  const toggleKrisp = useVoiceConnectionStore((s) => s.toggleKrisp)
  // WHY: Use the hook's leaveVoice instead of store.disconnect so the API
  // DELETE /voice/leave is called. Without this, the server-side session
  // persists for up to 45s (until sweep), showing a "ghost" participant.
  const { leaveVoice } = useVoiceConnection()

  const isVisible = status !== 'idle'
  const showSpinner = status === 'connecting' || status === 'reconnecting'
  const showControls = status === 'connected' || status === 'reconnecting'

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="voice-connection-bar"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="overflow-hidden"
          data-test="voice-connection-bar"
        >
          <div className="border-t border-divider bg-content1 px-2 py-2">
            {/* Status text row */}
            <div className="mb-1 flex items-center gap-2 px-1">
              {showSpinner && (
                <Spinner size="sm" classNames={{ base: 'h-3 w-3', wrapper: 'h-3 w-3' }} />
              )}

              <div className="flex min-w-0 flex-1 flex-col">
                <StatusText status={status} channelName={channelName} error={error} />
              </div>

              {status === 'failed' && (
                <Button
                  size="sm"
                  variant="flat"
                  color="danger"
                  className="h-6 min-w-0 px-2 text-xs"
                  onPress={onRetry}
                  data-test="voice-retry-btn"
                >
                  Retry
                </Button>
              )}
            </div>

            {/* Control buttons row — only when connected or reconnecting */}
            {showControls && (
              <div className="flex items-center justify-center gap-1">
                <Tooltip content={isMuted ? 'Unmute' : 'Mute'} placement="top" delay={300}>
                  <Button
                    variant="light"
                    isIconOnly
                    size="sm"
                    className="h-8 w-8"
                    onPress={toggleMute}
                    data-test="voice-mute-btn"
                  >
                    {isMuted ? (
                      <MicOff className="h-4 w-4 text-danger" />
                    ) : (
                      <Mic className="h-4 w-4 text-default-500" />
                    )}
                  </Button>
                </Tooltip>

                <Tooltip content={isDeafened ? 'Undeafen' : 'Deafen'} placement="top" delay={300}>
                  <Button
                    variant="light"
                    isIconOnly
                    size="sm"
                    className="h-8 w-8"
                    onPress={toggleDeafen}
                    data-test="voice-deafen-btn"
                  >
                    {isDeafened ? (
                      <HeadphoneOff className="h-4 w-4 text-danger" />
                    ) : (
                      <Headphones className="h-4 w-4 text-default-500" />
                    )}
                  </Button>
                </Tooltip>

                <Tooltip
                  content={isKrispEnabled ? 'Noise Suppression: On' : 'Noise Suppression: Off'}
                  placement="top"
                  delay={300}
                >
                  <Button
                    variant="light"
                    isIconOnly
                    size="sm"
                    className="h-8 w-8"
                    onPress={toggleKrisp}
                    data-test="voice-krisp-btn"
                  >
                    <AudioWaveform
                      className={`h-4 w-4 ${isKrispEnabled ? 'text-success' : 'text-default-500'}`}
                    />
                  </Button>
                </Tooltip>

                <Tooltip content="Disconnect" placement="top" delay={300}>
                  <Button
                    variant="light"
                    isIconOnly
                    size="sm"
                    className="h-8 w-8"
                    onPress={() => {
                      void leaveVoice()
                    }}
                    data-test="voice-disconnect-btn"
                  >
                    <PhoneOff className="h-4 w-4 text-danger" />
                  </Button>
                </Tooltip>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
