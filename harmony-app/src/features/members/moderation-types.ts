/**
 * WHY: Re-exports and helpers that bridge SDK types with app-level concerns.
 * `MemberRole` is an alias for the SDK's `Role` to keep a stable name across
 * the feature. `getMemberRole()` narrows `MemberResponse.role` (typed as
 * `string` in the SDK) to the discriminated `Role` union.
 *
 * `ROLE_HIERARCHY` is custom app logic not present in the SDK.
 */

import type { MemberResponse, Role } from '@/lib/api'

/** WHY: Alias keeps every consumer importing `MemberRole` stable. */
export type MemberRole = Role

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

/**
 * WHY: Type guard narrows `string` to `MemberRole` without `as` casts (ADR-035).
 * The SDK types `MemberResponse.role` as `string` because the OpenAPI spec uses
 * a plain string field — this guard bridges that gap at runtime.
 */
function isMemberRole(value: string): value is MemberRole {
  return value === 'owner' || value === 'admin' || value === 'moderator' || value === 'member'
}

/**
 * WHY: Single source of truth for narrowing `MemberResponse.role` (`string`)
 * to the discriminated `Role` union. Used by member-list, roles-tab, and
 * use-my-member-role.
 */
export function getMemberRole(member: MemberResponse): MemberRole {
  if (isMemberRole(member.role)) {
    return member.role
  }
  return 'member'
}
