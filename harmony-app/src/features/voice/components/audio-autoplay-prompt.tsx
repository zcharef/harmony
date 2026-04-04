/**
 * Autoplay prompt — shown when the browser blocks audio playback until user interaction.
 *
 * WHY: Modern browsers (Chrome, Safari, Firefox) block audio autoplay until the user
 * has interacted with the page. LiveKit exposes this via room.canPlaybackAudio.
 * A single click anywhere on the overlay calls room.startAudio() to unlock playback.
 *
 * Pattern reference: connection-banner.tsx (AnimatePresence + fixed positioning).
 */

import { RoomEvent } from 'livekit-client'
import { Volume2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'

import { logger } from '@/lib/logger'
import { useVoiceConnectionStore } from '../stores/voice-connection-store'

export function AudioAutoplayPrompt() {
  const room = useVoiceConnectionStore((s) => s.room)
  const status = useVoiceConnectionStore((s) => s.status)
  const [needsPrompt, setNeedsPrompt] = useState(false)

  // WHY: Listen to AudioPlaybackStatusChanged to detect when the browser blocks
  // audio. The store logs this event but delegates UI to this component.
  useEffect(() => {
    if (room === null || status !== 'connected') {
      setNeedsPrompt(false)
      return
    }

    // WHY: Check initial state — audio may already be blocked when we mount.
    if (!room.canPlaybackAudio) {
      setNeedsPrompt(true)
    }

    function onPlaybackStatusChanged() {
      if (room === null) return
      setNeedsPrompt(!room.canPlaybackAudio)
    }

    room.on(RoomEvent.AudioPlaybackStatusChanged, onPlaybackStatusChanged)
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, onPlaybackStatusChanged)
    }
  }, [room, status])

  const handleClick = useCallback(() => {
    if (room === null) return

    room.startAudio().catch((err: unknown) => {
      logger.warn('voice_start_audio_failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    })

    setNeedsPrompt(false)
  }, [room])

  return (
    <AnimatePresence>
      {needsPrompt && (
        <motion.button
          key="audio-autoplay-prompt"
          type="button"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          onClick={handleClick}
          className="fixed inset-0 z-50 flex cursor-pointer items-center justify-center bg-black/60"
          data-test="audio-autoplay-prompt"
        >
          <div className="flex items-center gap-3 rounded-xl bg-default-100 px-6 py-4 shadow-lg">
            <Volume2 className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium text-foreground">
              Click anywhere to enable voice audio
            </span>
          </div>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
