import { useCallback, useEffect, useState } from 'react'
import { logger } from '@/lib/logger'

/**
 * Launch-at-login toggle backed by tauri-plugin-autostart.
 *
 * WHY no localStorage mirror: the OS launch-agent registry is the source of
 * truth — isEnabled() reads it on mount, enable()/disable() write it. A
 * cached copy could disagree with what the OS will actually do at login.
 *
 * Pattern reference: use-notification-permission.ts (platform capability
 * read into local state + user-gesture mutation).
 */
export function useAutostart(): {
  isEnabled: boolean
  isPending: boolean
  hasError: boolean
  toggle: (enabled: boolean) => void
} {
  const [isEnabled, setIsEnabled] = useState(false)
  const [isPending, setIsPending] = useState(true)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    let cancelled = false
    import('@tauri-apps/plugin-autostart')
      .then((autostart) => autostart.isEnabled())
      .then((enabled) => {
        if (cancelled) return
        setIsEnabled(enabled)
        setIsPending(false)
      })
      .catch((err: unknown) => {
        logger.warn('autostart_read_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        if (cancelled) return
        setIsPending(false)
        setHasError(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = useCallback((enabled: boolean) => {
    // WHY optimistic + rollback: the plugin call is near-instant on success;
    // on failure the switch snaps back and an inline error explains why
    // (user-initiated action → visible feedback, ADR-028).
    // WHY isPending during the call: the switch disables, so overlapping
    // enable()/disable() calls cannot race each other.
    setIsEnabled(enabled)
    setIsPending(true)
    setHasError(false)
    import('@tauri-apps/plugin-autostart')
      .then((autostart) => (enabled ? autostart.enable() : autostart.disable()))
      .catch((err: unknown) => {
        logger.error('autostart_toggle_failed', {
          error: err instanceof Error ? err.message : String(err),
          enabled,
        })
        setIsEnabled(!enabled)
        setHasError(true)
      })
      .finally(() => {
        setIsPending(false)
      })
  }, [])

  return { isEnabled, isPending, hasError, toggle }
}
