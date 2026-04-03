import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import { usePreferences } from '@/features/preferences'
import { useServerEvent } from '@/hooks/use-server-event'
import type { NotificationSettingsResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { NAVIGATE_EVENT, navigateDetailSchema } from '@/lib/navigation-events'
import { isTauri } from '@/lib/platform'
import { queryKeys } from '@/lib/query-keys'

const MAX_BODY_LENGTH = 100
const COOLDOWN_MS = 5_000

const notifEventSchema = z.object({
  senderId: z.string(),
  serverId: z.string(),
  channelId: z.string(),
  message: z.object({
    authorUsername: z.string(),
    content: z.string(),
    messageType: z.string(),
    encrypted: z.boolean(),
  }),
})

type NotifEvent = z.infer<typeof notifEventSchema>

// ── Extracted helpers (keep handler under Biome cognitive complexity limit) ──

type PermissionStatus = 'granted' | 'denied' | 'unknown'

/**
 * WHY: Extracted to reduce handler cognitive complexity.
 * Checks and requests notification permission lazily on first trigger.
 * Caches the result in the provided ref so subsequent calls are synchronous.
 */
async function ensurePermission(ref: React.RefObject<PermissionStatus>): Promise<boolean> {
  if (ref.current === 'granted') return true
  if (ref.current === 'denied') return false

  try {
    const { isPermissionGranted, requestPermission } = await import(
      '@tauri-apps/plugin-notification'
    )
    const granted = await isPermissionGranted()
    if (granted) {
      ref.current = 'granted'
      return true
    }
    const result = await requestPermission()
    ref.current = result === 'granted' ? 'granted' : 'denied'
    return ref.current === 'granted'
  } catch (err: unknown) {
    logger.warn('notification_permission_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    ref.current = 'denied'
    return false
  }
}

/**
 * WHY: Extracted to reduce handler cognitive complexity.
 * Derives notification body: encrypted messages show a placeholder,
 * plaintext messages are truncated to MAX_BODY_LENGTH.
 */
function deriveNotificationBody(message: { encrypted: boolean; content: string }): string {
  if (message.encrypted) {
    return i18n.t('common:newEncryptedMessage')
  }
  if (message.content.length > MAX_BODY_LENGTH) {
    return `${message.content.slice(0, MAX_BODY_LENGTH)}...`
  }
  return message.content
}

/**
 * WHY: Extracted to reduce handler cognitive complexity.
 * Returns true if the notification should be suppressed (not sent).
 */
function shouldSuppressNotification(
  event: NotifEvent,
  activeChannelId: string | null,
  userId: string | null,
  queryClient: QueryClient,
  cooldownMap: Map<string, number>,
  dndEnabled: boolean,
): boolean {
  if (dndEnabled) return true

  const { senderId, channelId, message } = event

  if (message.messageType === 'system') return true
  if (userId !== null && senderId === userId) return true
  if (channelId === activeChannelId) return true
  if (document.hasFocus()) return true

  const settings = queryClient.getQueryData<NotificationSettingsResponse>(
    queryKeys.notificationSettings.byChannel(channelId),
  )
  if (settings?.level === 'none') return true

  const now = Date.now()
  const lastNotified = cooldownMap.get(channelId)
  if (lastNotified !== undefined && now - lastNotified < COOLDOWN_MS) return true
  cooldownMap.set(channelId, now)

  return false
}

/**
 * WHY: Extracted to reduce handler cognitive complexity.
 * Sends the notification after ensuring permission is granted.
 */
async function fireNotification(
  event: NotifEvent,
  permissionRef: React.RefObject<PermissionStatus>,
): Promise<void> {
  const granted = await ensurePermission(permissionRef)
  if (!granted) return

  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    const body = deriveNotificationBody(event.message)
    // TODO(notifications): filter by mentions when SSE payload includes mentionedUserIds
    sendNotification({
      title: event.message.authorUsername,
      body,
      extra: { serverId: event.serverId, channelId: event.channelId },
    })
  } catch (err: unknown) {
    logger.warn('notification_send_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Fires Tauri native desktop notifications on incoming messages.
 *
 * WHY: Desktop users need push notifications when the app is not focused.
 * Guards: isTauri(), system message filter, self-message filter, active
 * channel filter, document.hasFocus(), notification settings cache,
 * per-channel rate limiting (5s cooldown).
 *
 * On notification click: dispatches a CustomEvent on `window` to trigger
 * navigation in MainLayout, and focuses the Tauri window.
 */
export function useDesktopNotifications(
  activeChannelId: string | null,
  userId: string | null,
): void {
  const queryClient = useQueryClient()
  const preferences = usePreferences()
  const dndEnabled = preferences.data?.dndEnabled === true
  const permissionRef = useRef<PermissionStatus>('unknown')
  const cooldownMap = useRef(new Map<string, number>())

  // WHY: Register the onAction listener once to handle notification clicks.
  // Returns a PluginListener with unregister() for cleanup on unmount.
  useEffect(() => {
    if (!isTauri()) return

    let listener: { unregister: () => Promise<void> } | undefined

    async function setup() {
      try {
        const { onAction } = await import('@tauri-apps/plugin-notification')
        listener = await onAction((notification) => {
          const parsed = navigateDetailSchema.safeParse(notification.extra)
          if (!parsed.success) return

          window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: parsed.data }))

          import('@tauri-apps/api/window')
            .then(({ getCurrentWindow }) => {
              const win = getCurrentWindow()
              return win.unminimize().then(() => win.setFocus())
            })
            .catch((err: unknown) => {
              logger.warn('notification_focus_failed', {
                error: err instanceof Error ? err.message : String(err),
              })
            })
        })
      } catch (err: unknown) {
        logger.warn('notification_action_listener_setup_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    setup()
    return () => {
      listener?.unregister().catch((err: unknown) => {
        logger.warn('notification_listener_unregister_failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
  }, [])

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      if (!isTauri()) return

      const parsed = notifEventSchema.safeParse(payload)
      if (!parsed.success) return

      const event = parsed.data
      if (
        shouldSuppressNotification(
          event,
          activeChannelId,
          userId,
          queryClient,
          cooldownMap.current,
          dndEnabled,
        )
      )
        return

      void fireNotification(event, permissionRef)
    },
    [activeChannelId, userId, queryClient, dndEnabled],
  )

  useServerEvent('message.created', handleMessageCreated)
}
