/**
 * WHY: The generated OpenAPI types do not yet include `is_private`/`is_read_only`
 * on channel responses or requests. We define extended types here until
 * `just gen-api` regenerates the SDK with the new fields.
 */

import type { ChannelResponse } from '@/lib/api'

/** Channel with permission fields the API now supports but the SDK hasn't regenerated for. */
export type ChannelWithPerms = ChannelResponse & {
  isPrivate?: boolean
  isReadOnly?: boolean
}

/**
 * WHY: Safe runtime accessor for channel permission fields that the generated SDK
 * doesn't include yet. Avoids `as Type` assertions flagged by ADR-035.
 */
export function getChannelPerms(channel: ChannelResponse): {
  isPrivate: boolean
  isReadOnly: boolean
} {
  const raw = channel as unknown as Record<string, unknown>
  return {
    isPrivate: raw.isPrivate === true,
    isReadOnly: raw.isReadOnly === true,
  }
}
