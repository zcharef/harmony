import type { NotificationLevel, UserPreferencesResponse } from '@/lib/api'

/**
 * Pure notification suppression policy — ONE module consumed by both the
 * desktop-notification and sound pipelines.
 *
 * WHY: the suppression logic used to be duplicated across the two pipelines
 * and drifted (different gates, contradictory WHY comments). Every new gate
 * (event-type switches, per-channel levels, future blocking) has exactly one
 * insertion point here, and the gate table below IS the unit-test matrix.
 */

export type NotificationEventClass = 'dm' | 'mention' | 'channel' | 'unknown'

/**
 * WHY true: the mentions feature is live (backend parses/resolves mentions and
 * `message.created` carries a `mentions` payload; badges shipped in #78), so
 * the per-channel `mentions` level and the `notifyMentions` preference are
 * enforced. Flipping to false reverts `mentions` to behave as `all`.
 */
export const MENTIONS_FEATURE_LIVE = true

export function classifyEvent(input: {
  /** DM flag from the shared classifier; `undefined` = server not in cache (race). */
  serverIsDm: boolean | undefined
  /** User IDs mentioned by the message (absent = no mentions). */
  mentionedUserIds?: string[]
  currentUserId: string
}): NotificationEventClass {
  // WHY dm wins over mention: a DM is a DM (Discord semantics).
  if (input.serverIsDm === true) return 'dm'
  if (input.mentionedUserIds?.includes(input.currentUserId) === true) return 'mention'
  // WHY 'unknown': cache race (e.g. dm.created refetch not yet resolved).
  // Fail-open — better a mis-classed notification than a missed one.
  if (input.serverIsDm === undefined) return 'unknown'
  return 'channel'
}

export interface NotificationPolicyContext {
  kind: 'desktop' | 'sound'
  /**
   * `undefined` = preferences still loading → treat as defaults (do NOT
   * suppress; matches the DND "loading ≠ suppress" rule).
   */
  prefs:
    | Pick<
        UserPreferencesResponse,
        | 'dndEnabled'
        | 'notificationsEnabled'
        | 'notifyMessages'
        | 'notifyDms'
        | 'notifyMentions'
        | 'notificationSoundsEnabled'
      >
    | undefined
  /** From the bulk overrides map; `undefined` = no override = 'all'. */
  channelLevel: NotificationLevel | undefined
  eventClass: NotificationEventClass
  isSelf: boolean
  isSystem: boolean
  isActiveChannel: boolean
  /** THIS tab: document.hasFocus(). */
  hasFocus: boolean
  /**
   * Desktop pipeline only: this tab focused OR any same-origin tab holds the
   * focus lock. Resolved by the caller (the policy stays pure/sync).
   */
  anyTabFocused: boolean
  cooldownHit: boolean
}

/**
 * Deterministic gate order (first hit wins) — mirrors the spec §5.2 table:
 *
 * 1. DND            — both pipelines
 * 2. Master switch  — per pipeline
 * 3. System message — both
 * 4. Self message   — both
 * 5. Seen           — sound only: active channel AND focused (on screen NOW)
 * 6. Focus          — desktop only: any same-origin tab focused
 * 7. Event-type     — per-class preference switch ('unknown' skips: fail-open)
 * 8. Channel level  — 'none' always; 'mentions' suppresses only 'channel'
 * 9. Cooldown       — per pipeline (caller-managed maps)
 */
/** Gate 2 — master switch per pipeline. */
function masterSwitchSuppresses(ctx: NotificationPolicyContext): boolean {
  if (ctx.kind === 'desktop') return ctx.prefs?.notificationsEnabled === false
  return ctx.prefs?.notificationSoundsEnabled === false
}

/** Gate 7 — event-type switches. 'unknown' skips the gate entirely (fail-open). */
function eventTypeSuppresses(ctx: NotificationPolicyContext): boolean {
  if (ctx.eventClass === 'dm') return ctx.prefs?.notifyDms === false
  if (ctx.eventClass === 'mention') return ctx.prefs?.notifyMentions === false
  if (ctx.eventClass === 'channel') return ctx.prefs?.notifyMessages === false
  return false
}

/**
 * Gate 8 — per-channel level. WHY the 'mentions' branch only suppresses
 * 'channel': DM events classify as 'dm', so a stale `mentions` row on a DM
 * behaves as 'all' by construction (D14); 'unknown' also passes (fail-open).
 */
function channelLevelSuppresses(ctx: NotificationPolicyContext): boolean {
  if (ctx.channelLevel === 'none') return true
  return ctx.channelLevel === 'mentions' && MENTIONS_FEATURE_LIVE && ctx.eventClass === 'channel'
}

export function shouldSuppress(ctx: NotificationPolicyContext): boolean {
  // Gate 1 — DND overrides everything.
  if (ctx.prefs?.dndEnabled === true) return true

  // Gate 2 — master switch per pipeline.
  if (masterSwitchSuppresses(ctx)) return true

  // Gates 3-4 — system and own messages never notify.
  if (ctx.isSystem) return true
  if (ctx.isSelf) return true

  // Gate 5 — sound only: the message is on screen RIGHT NOW. WHY not desktop:
  // a focused window already suppresses via gate 6, and an UNfocused window
  // must notify even for the active channel (Discord parity).
  if (ctx.kind === 'sound' && ctx.isActiveChannel && ctx.hasFocus) return true

  // Gate 6 — desktop only: no native popup while the user is looking at the
  // app in this or any other same-origin tab.
  if (ctx.kind === 'desktop' && ctx.anyTabFocused) return true

  // Gates 7-8 — event-type switches, then the per-channel level.
  if (eventTypeSuppresses(ctx)) return true
  if (channelLevelSuppresses(ctx)) return true

  // Gate 9 — per-channel cooldown (caller-managed).
  return ctx.cooldownHit
}
