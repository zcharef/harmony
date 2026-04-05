import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import { usePreferences } from '@/features/preferences'
import { useServerEvent } from '@/hooks/use-server-event'
import type { NotificationSettingsResponse } from '@/lib/api'
import { logger } from '@/lib/logger'
import { NAVIGATE_EVENT } from '@/lib/navigation-events'
import { isTauri } from '@/lib/platform'
import { queryKeys } from '@/lib/query-keys'

const MAX_BODY_LENGTH = 100
const COOLDOWN_MS = 5_000

// WHY: The official tauri-plugin-notification does not support onAction/click
// callbacks on desktop (mobile-only command). As a workaround, we track the
// last notification's navigation target and navigate on window focus within a
// short time window. macOS brings the app to foreground on notification click,
// so this captures the intent reliably. False positive: user Alt-Tabs/dock-clicks
// within the window — rare, and navigation is still to a new-message channel.
const NOTIFICATION_CLICK_WINDOW_MS = 3_000

interface NotificationTarget {
  serverId: string
  channelId: string
  sentAt: number
}

let lastNotificationTarget: NotificationTarget | null = null

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
    })
    lastNotificationTarget = {
      serverId: event.serverId,
      channelId: event.channelId,
      sentAt: Date.now(),
    }
  } catch (err: unknown) {
    lastNotificationTarget = null
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
 * On notification click: macOS focuses the app window (OS default). A
 * focus-based heuristic detects this and navigates to the notified channel
 * within a 3-second window (see module-level comment for tradeoff).
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

  // WHY: On notification click, macOS focuses the app window (OS default). We
  // detect this via the window 'focus' event and navigate to the channel if a
  // notification was sent recently. See module-level comment for tradeoff details.
  useEffect(() => {
    if (!isTauri()) return

    function handleFocus() {
      if (lastNotificationTarget === null) return
      if (Date.now() - lastNotificationTarget.sentAt > NOTIFICATION_CLICK_WINDOW_MS) {
        lastNotificationTarget = null
        return
      }

      const target = lastNotificationTarget
      lastNotificationTarget = null
      window.dispatchEvent(
        new CustomEvent(NAVIGATE_EVENT, {
          detail: { serverId: target.serverId, channelId: target.channelId },
        }),
      )
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      if (!isTauri()) return

      const parsed = notifEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('desktop_notification_parse_failed', { error: parsed.error.message })
        return
      }

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
