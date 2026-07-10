import { logger } from '@/lib/logger'
import { NAVIGATE_EVENT, type NavigateDetail } from '@/lib/navigation-events'
import { isTauri } from '@/lib/platform'

/**
 * Platform adapter for sending native notifications (web Notification API vs
 * Tauri plugin). ONE branch point for the whole pipeline (D3).
 */

export interface OutgoingNotification {
  /** Author display name (falls back to username upstream). */
  title: string
  /** Derived body: encrypted placeholder / truncated plaintext. */
  body: string
  /**
   * WHY: `channel:${channelId}` — the OS coalesces same-tag notifications
   * (newest replaces), which is also the multi-tab visible dedup (D6).
   */
  tag: string
  target: NavigateDetail
}

interface RecentTarget extends NavigateDetail {
  sentAt: number
}

// WHY module state: the Tauri notification plugin has no desktop click
// callback — the focus heuristic (main hook) consumes the last-sent target
// within a short window after a window focus.
let lastTauriTarget: RecentTarget | null = null

/**
 * WHY: The official tauri-plugin-notification does not support onAction/click
 * callbacks on desktop (mobile-only command). macOS brings the app to the
 * foreground on notification click, so consuming the target within a short
 * focus window captures the intent reliably. False positive: user Alt-Tabs
 * within the window — rare, and navigation still lands on a new-message channel.
 */
export const TAURI_CLICK_WINDOW_MS = 3_000

/** Consume the recent Tauri notification target (focus-heuristic navigation). */
export function consumeRecentTauriTarget(): NavigateDetail | null {
  if (lastTauriTarget === null) return null
  const target = lastTauriTarget
  lastTauriTarget = null
  if (Date.now() - target.sentAt > TAURI_CLICK_WINDOW_MS) return null
  return { serverId: target.serverId, channelId: target.channelId }
}

function sendWebNotification(n: OutgoingNotification): void {
  // WHY re-check per fire: permission can be revoked mid-session from browser
  // site settings — the constructor path must stay safe.
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return

  try {
    // WHY silent: our own audio pipeline owns sound — prevents double audio
    // (OS chime + app ogg). Firefox ignores `silent` — accepted degradation.
    const notification = new Notification(n.title, {
      body: n.body,
      tag: n.tag,
      silent: true,
    })
    notification.onclick = () => {
      window.focus()
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: n.target }))
      notification.close()
    }
  } catch (err: unknown) {
    // WHY warn only: background operation — never a toast (ADR-028).
    logger.warn('notification_send_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function sendTauriNotification(n: OutgoingNotification): Promise<void> {
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    sendNotification({ title: n.title, body: n.body })
    lastTauriTarget = { ...n.target, sentAt: Date.now() }
  } catch (err: unknown) {
    lastTauriTarget = null
    logger.warn('notification_send_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Send a native notification via the platform-appropriate path. */
export async function sendPlatformNotification(n: OutgoingNotification): Promise<void> {
  if (isTauri()) {
    await sendTauriNotification(n)
  } else {
    sendWebNotification(n)
  }
}
