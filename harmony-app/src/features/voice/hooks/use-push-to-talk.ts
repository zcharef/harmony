/**
 * Push-to-talk via Tauri global hotkey — desktop only.
 *
 * WHY: PTT requires intercepting global key events even when the app is not focused.
 * The tauri-plugin-global-shortcut JS API provides both Pressed and Released states,
 * so the entire flow is driven from the frontend — no custom Rust commands needed.
 *
 * Pattern reference: desktop-auth.ts (dynamic import behind isTauri guard),
 * auth-provider.tsx:L114-L138 (cleanup via unlisten function).
 */

import { useCallback, useEffect, useRef } from 'react'

import { logger } from '@/lib/logger'
import { isTauri } from '@/lib/platform'

import { useVoiceConnectionStore } from '../stores/voice-connection-store'

// TODO(e2ee): PTT key handling may need to be E2EE-aware

/**
 * Registers a global hotkey for push-to-talk. Desktop-only (no-op on web).
 *
 * - On key down (Pressed): enables microphone via setPttMicEnabled(true)
 * - On key up (Released): disables microphone via setPttMicEnabled(false)
 * - Default: no shortcut registered (user must configure via settings)
 *
 * @param shortcut - A Tauri shortcut string (e.g. "F13", "Alt+T"), or null to disable.
 */
export function usePushToTalk(shortcut: string | null) {
  const status = useVoiceConnectionStore((s) => s.status)
  const setPttMicEnabled = useVoiceConnectionStore((s) => s.setPttMicEnabled)

  // WHY: Refs let the shortcut handler read latest values without re-registering
  // the global shortcut on every status/function reference change.
  const statusRef = useRef(status)
  statusRef.current = status

  const setPttMicEnabledRef = useRef(setPttMicEnabled)
  setPttMicEnabledRef.current = setPttMicEnabled

  const unregisterRef = useRef<(() => Promise<void>) | null>(null)

  const registerShortcut = useCallback(async (key: string) => {
    if (!isTauri()) return

    try {
      const { register } = await import('@tauri-apps/plugin-global-shortcut')

      await register(key, (event) => {
        if (statusRef.current !== 'connected') return

        if (event.state === 'Pressed') {
          setPttMicEnabledRef.current(true)
        } else if (event.state === 'Released') {
          setPttMicEnabledRef.current(false)
        }
      })

      logger.info('ptt_shortcut_registered', { shortcut: key })

      // WHY: Capture the unregister function so cleanup can remove this exact shortcut.
      unregisterRef.current = async () => {
        const { unregister } = await import('@tauri-apps/plugin-global-shortcut')
        await unregister(key)
      }
    } catch (err: unknown) {
      logger.error('ptt_shortcut_register_failed', {
        error: err instanceof Error ? err.message : String(err),
        shortcut: key,
      })
    }
  }, [])

  const unregisterShortcut = useCallback(async () => {
    if (unregisterRef.current !== null) {
      try {
        await unregisterRef.current()
        logger.info('ptt_shortcut_unregistered')
      } catch (err: unknown) {
        logger.warn('ptt_shortcut_unregister_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      unregisterRef.current = null
    }
  }, [])

  useEffect(() => {
    if (shortcut === null || !isTauri()) return

    void registerShortcut(shortcut)

    return () => {
      void unregisterShortcut()
    }
  }, [shortcut, registerShortcut, unregisterShortcut])
}
