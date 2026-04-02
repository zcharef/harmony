import { z } from 'zod'

/**
 * Schema for the `harmony:navigate` CustomEvent detail payload.
 *
 * WHY: Shared between the notification hook (producer, dispatches event on
 * notification click) and MainLayout (consumer, listens and navigates).
 * Single source of truth avoids schema drift.
 */
export const navigateDetailSchema = z.object({
  serverId: z.string(),
  channelId: z.string(),
})

export type NavigateDetail = z.infer<typeof navigateDetailSchema>

/** CustomEvent name for notification-triggered navigation. */
export const NAVIGATE_EVENT = 'harmony:navigate' as const
