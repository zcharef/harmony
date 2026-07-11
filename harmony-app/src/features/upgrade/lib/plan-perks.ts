/**
 * Plan tiers, perks, and per-resource limits — the paywall's ONLY data file.
 *
 * WHY one file: when Stripe checkout replaces the mailto CTA, pricing and
 * tier data wiring changes here and nowhere else. All numbers mirror the
 * API's PlanLimits constants (harmony-api plan.rs) — never invent values.
 */

import type { Plan } from '@/lib/api'

export const PLAN_ORDER = ['free', 'supporter', 'creator'] as const satisfies readonly Plan[]

/** Contact point for manual upgrades until Stripe checkout exists. */
export const UPGRADE_EMAIL = 'upgrade@joinharmony.app'

/** One perk line on a tier card: an i18n key in the `upgrade` namespace + values. */
export interface PlanPerk {
  key: string
  values?: Record<string, string | number>
}

/**
 * Headline perks per tier (4-6 each, real PlanLimits numbers).
 * Keys resolve under `upgrade:perks.*`.
 */
export const PLAN_PERKS: Record<Plan, PlanPerk[]> = {
  free: [
    { key: 'ownedServers', values: { count: 3 } },
    { key: 'members', values: { count: '500' } },
    { key: 'uploads', values: { size: '8 MB' } },
    { key: 'activeInvites', values: { count: 5 } },
    { key: 'voice', values: { count: 5 } },
  ],
  supporter: [
    { key: 'ownedServers', values: { count: 10 } },
    { key: 'members', values: { count: '500K' } },
    { key: 'uploads', values: { size: '50 MB' } },
    { key: 'customEmoji', values: { count: 100 } },
    { key: 'activeInvites', values: { count: 25 } },
    { key: 'voice', values: { count: 100 } },
  ],
  creator: [
    { key: 'ownedServers', values: { count: 25 } },
    { key: 'members', values: { count: '500K' } },
    { key: 'uploads', values: { size: '100 MB' } },
    { key: 'customEmoji', values: { count: 500 } },
    { key: 'activeInvites', values: { count: 100 } },
    { key: 'voice', values: { count: 500 } },
  ],
}

/**
 * Per-tier limits for every plan-gated resource key the API can reject
 * with (ResourceKind::key values). Drives the context row on each tier
 * card: the blocked resource's value across tiers.
 */
export const RESOURCE_LIMITS: Record<string, Record<Plan, number>> = {
  owned_servers: { free: 3, supporter: 10, creator: 25 },
  joined_servers: { free: 20, supporter: 100, creator: 500 },
  members: { free: 500, supporter: 500_000, creator: 500_000 },
  channels: { free: 10_000, supporter: 10_000, creator: 10_000 },
  categories: { free: 50, supporter: 50, creator: 100 },
  roles: { free: 20, supporter: 250, creator: 500 },
  voice_concurrent: { free: 5, supporter: 100, creator: 500 },
  active_invites: { free: 5, supporter: 25, creator: 100 },
  open_dms: { free: 20, supporter: 100, creator: 500 },
  attachments_per_message: { free: 1, supporter: 5, creator: 10 },
  attachment_size: { free: 8_388_608, supporter: 52_428_800, creator: 104_857_600 },
  custom_emoji: { free: 0, supporter: 100, creator: 500 },
}

/** Resource keys whose limits are byte sizes (formatted as MB, not counts). */
export const BYTE_RESOURCES = new Set(['attachment_size'])

/** Formats a resource limit for display: byte resources as MB, counts compacted. */
export function formatResourceLimit(resource: string, limit: number): string {
  if (BYTE_RESOURCES.has(resource)) {
    return `${Math.round(limit / 1_048_576)} MB`
  }
  if (limit >= 1_000_000) {
    return `${limit / 1_000_000}M`
  }
  if (limit >= 10_000) {
    return `${limit / 1_000}K`
  }
  return String(limit)
}
