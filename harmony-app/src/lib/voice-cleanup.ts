/**
 * Best-effort voice session cleanup for page unload.
 *
 * WHY: This lives in `lib/` (not `features/`) because it uses raw `fetch()`
 * with `keepalive: true` — required for requests to complete after the page's
 * JS context is destroyed. The generated SDK cannot be used here because its
 * async interceptors don't run in the synchronous `beforeunload` callback.
 *
 * The heartbeat sweep cleans up stale sessions after ~45s regardless, so
 * failure here is acceptable.
 */

import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

export function fireAndForgetVoiceLeave(channelId: string, authToken: string): void {
  fetch(`${env.VITE_API_URL}/v1/channels/${encodeURIComponent(channelId)}/voice/leave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    keepalive: true,
  }).catch((err: unknown) => {
    // WHY: Best-effort — heartbeat sweep handles cleanup if this fails.
    // Log for observability per ADR-027.
    logger.warn('voice_leave_beacon_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  })
}
