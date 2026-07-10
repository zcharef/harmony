import { useQueryClient } from '@tanstack/react-query'
import i18n from 'i18next'
import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import { dmServerFlag } from '@/features/channels'
import { usePreferences } from '@/features/preferences'
import { useServerEvent } from '@/hooks/use-server-event'
import { logger } from '@/lib/logger'
import { NAVIGATE_EVENT } from '@/lib/navigation-events'
import { isTauri } from '@/lib/platform'
import { classifyEvent, shouldSuppress } from '../lib/notification-policy'
import { consumeRecentTauriTarget, sendPlatformNotification } from '../lib/notifications-adapter'
import { isAnyTabFocused } from '../lib/tab-coordination'
import { useNotificationSettingsMap } from './use-notification-settings-map'

const MAX_BODY_LENGTH = 100
const COOLDOWN_MS = 5_000

const notifEventSchema = z.object({
  senderId: z.string(),
  serverId: z.string(),
  channelId: z.string(),
  message: z.object({
    authorUsername: z.string(),
    // WHY optional: older API instances omit the field during rollout.
    authorDisplayName: z.string().optional().nullable(),
    content: z.string(),
    messageType: z.string(),
    encrypted: z.boolean(),
    // WHY optional: same rollout convention as event-types.ts.
    mentions: z.array(z.object({ userId: z.string() })).optional(),
  }),
})

type NotifEvent = z.infer<typeof notifEventSchema>

// ── Extracted helpers ────────────────────────────────────────────────────

type TauriPermissionStatus = 'granted' | 'denied' | 'unknown'

/**
 * Tauri-only lazy permission check on first notification (OS-level,
 * pre-granted in practice). WHY web does NOT do this: a permission prompt
 * appearing while the user is away is the definition of nagging — web
 * permission is requested ONLY from the settings tab / banner gestures.
 */
async function ensureTauriPermission(
  ref: React.RefObject<TauriPermissionStatus>,
): Promise<boolean> {
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
 * WHY: Extracted to keep processEvent under Biome's cognitive complexity
 * limit. Checks the platform-appropriate permission; web unavailability is
 * logged ONCE per session (observable but not spammy, ADR-027).
 */
async function hasNotificationPermission(
  tauriRef: React.RefObject<TauriPermissionStatus>,
  unavailableLoggedRef: React.RefObject<boolean>,
): Promise<boolean> {
  if (isTauri()) {
    return ensureTauriPermission(tauriRef)
  }

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    return true
  }

  if (!unavailableLoggedRef.current) {
    unavailableLoggedRef.current = true
    const state = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
    logger.info('notifications_unavailable', { state })
  }
  return false
}

/**
 * Derives notification body: encrypted messages show a placeholder (E2EE
 * privacy — never ciphertext or decrypted content in the OS notification
 * center), plaintext messages are truncated to MAX_BODY_LENGTH.
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

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Fires native desktop notifications on incoming messages — web (Notification
 * API) AND Tauri (plugin), branched inside the platform adapter.
 *
 * Suppression is delegated to the pure policy module (notification-policy.ts):
 * DND, master switch, system/self filters, cross-tab focus (Web Locks), the
 * per-event-type switches, the bulk per-channel level map, and a per-channel
 * 5s cooldown.
 *
 * On notification click: web navigates via a real onclick handler; Tauri uses
 * the focus heuristic (no click callback in the plugin — documented tradeoff).
 */
export function useDesktopNotifications(
  activeChannelId: string | null,
  userId: string | null,
): void {
  const queryClient = useQueryClient()
  const preferences = usePreferences()
  const { data: levelMap } = useNotificationSettingsMap()
  const tauriPermissionRef = useRef<TauriPermissionStatus>('unknown')
  // WHY once per session: graceful degradation when web permission is
  // denied/unsupported must be observable but not spammy (ADR-027).
  const unavailableLoggedRef = useRef(false)
  const cooldownMap = useRef(new Map<string, number>())

  // WHY: On notification click, macOS focuses the app window (OS default).
  // Tauri-only — web notifications carry a real onclick (adapter).
  useEffect(() => {
    if (!isTauri()) return

    function handleFocus() {
      const target = consumeRecentTauriTarget()
      if (target === null) return
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: target }))
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [])

  const prefs = preferences.data

  const processEvent = useCallback(
    async (event: NotifEvent) => {
      const { senderId, serverId, channelId, message } = event

      const eventClass = classifyEvent({
        serverIsDm: dmServerFlag(serverId, queryClient),
        mentionedUserIds: message.mentions?.map((m) => m.userId),
        currentUserId: userId ?? '',
      })

      const hasFocus = document.hasFocus()
      // WHY resolved here: the policy is pure/sync — the async cross-tab check
      // is short-circuited when this tab already has focus.
      const anyTabFocused = hasFocus ? true : await isAnyTabFocused()

      const now = Date.now()
      const lastNotified = cooldownMap.current.get(channelId)
      const cooldownHit = lastNotified !== undefined && now - lastNotified < COOLDOWN_MS

      const suppressed = shouldSuppress({
        kind: 'desktop',
        prefs,
        channelLevel: levelMap?.[channelId],
        eventClass,
        isSelf: userId !== null && senderId === userId,
        isSystem: message.messageType === 'system',
        isActiveChannel: channelId === activeChannelId,
        hasFocus,
        anyTabFocused,
        cooldownHit,
      })
      if (suppressed) return

      const granted = await hasNotificationPermission(tauriPermissionRef, unavailableLoggedRef)
      if (!granted) return

      cooldownMap.current.set(channelId, now)

      await sendPlatformNotification({
        // WHY display name first: identity render chain (display name falls
        // back to username).
        title: message.authorDisplayName ?? message.authorUsername,
        body: deriveNotificationBody(message),
        tag: `channel:${channelId}`,
        target: { serverId, channelId },
      })
    },
    [activeChannelId, userId, queryClient, prefs, levelMap],
  )

  const handleMessageCreated = useCallback(
    (payload: unknown) => {
      const parsed = notifEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('desktop_notification_parse_failed', { error: parsed.error.message })
        return
      }

      void processEvent(parsed.data)
    },
    [processEvent],
  )

  useServerEvent('message.created', handleMessageCreated)
}
