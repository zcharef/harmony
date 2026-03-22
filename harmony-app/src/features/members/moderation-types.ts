/**
 * WHY: The generated OpenAPI types do not yet include the `role` field on
 * MemberResponse or the moderation endpoint types (ban, kick, role change).
 * Rather than editing auto-generated files, we define the extended types here.
 *
 * Once the Rust API OpenAPI spec is regenerated with `just gen-api`, these
 * types should be replaced by imports from `@/lib/api`.
 */

import type { MemberResponse } from '@/lib/api'

/** Role values returned by the API on member responses. */
export type MemberRole = 'owner' | 'admin' | 'moderator' | 'member'

/**
 * WHY: Numeric hierarchy enables simple comparison operators for permission
 * checks (e.g., callerRank > targetRank). Matches the API's enforcement.
 */
export const ROLE_HIERARCHY: Record<MemberRole, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  member: 1,
} as const

/** Extended member response that includes the role field. */
export type MemberWithRole = MemberResponse & {
  role: MemberRole
}

/**
 * WHY: The API may return members without a `role` field if the generated types
 * haven't been regenerated yet. Safely reads the runtime value and defaults to 'member'.
 * Single source of truth — used by member-list, roles-tab, and use-my-member-role.
 */
export function getMemberRole(member: MemberResponse): MemberRole {
  const raw = (member as unknown as Record<string, unknown>).role
  if (raw === 'owner' || raw === 'admin' || raw === 'moderator' || raw === 'member') {
    return raw
  }
  return 'member'
}

/** Request body for PATCH /v1/servers/{server_id}/members/{user_id}/role */
export interface ChangeRoleRequest {
  role: 'admin' | 'moderator' | 'member'
}

/** Request body for POST /v1/servers/{server_id}/bans */
export interface CreateBanRequest {
  user_id: string
  reason?: string
}
