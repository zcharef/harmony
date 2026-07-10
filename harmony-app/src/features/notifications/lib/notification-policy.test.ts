import { describe, expect, it } from 'vitest'
import {
  classifyEvent,
  MENTIONS_FEATURE_LIVE,
  type NotificationPolicyContext,
  shouldSuppress,
} from './notification-policy'

const ME = 'user-me'

function buildPrefs(
  overrides: Partial<NonNullable<NotificationPolicyContext['prefs']>> = {},
): NonNullable<NotificationPolicyContext['prefs']> {
  return {
    dndEnabled: false,
    notificationsEnabled: true,
    notifyMessages: true,
    notifyDms: true,
    notifyMentions: true,
    notificationSoundsEnabled: true,
    ...overrides,
  }
}

/** Eligible baseline: nothing suppresses — each test flips ONE gate. */
function buildCtx(overrides: Partial<NotificationPolicyContext> = {}): NotificationPolicyContext {
  return {
    kind: 'desktop',
    prefs: buildPrefs(),
    channelLevel: undefined,
    eventClass: 'channel',
    isSelf: false,
    isSystem: false,
    isActiveChannel: false,
    hasFocus: false,
    anyTabFocused: false,
    cooldownHit: false,
    ...overrides,
  }
}

describe('classifyEvent', () => {
  it('classifies a DM server as dm — even when the message mentions me (dm wins)', () => {
    expect(classifyEvent({ serverIsDm: true, mentionedUserIds: [ME], currentUserId: ME })).toBe(
      'dm',
    )
    expect(classifyEvent({ serverIsDm: true, currentUserId: ME })).toBe('dm')
  })

  it('classifies a server message mentioning me as mention', () => {
    expect(
      classifyEvent({ serverIsDm: false, mentionedUserIds: ['other', ME], currentUserId: ME }),
    ).toBe('mention')
  })

  it('classifies a plain server message as channel', () => {
    expect(classifyEvent({ serverIsDm: false, currentUserId: ME })).toBe('channel')
    expect(
      classifyEvent({ serverIsDm: false, mentionedUserIds: ['other'], currentUserId: ME }),
    ).toBe('channel')
  })

  it('classifies an unresolvable server as unknown (cache race, fail-open)', () => {
    expect(classifyEvent({ serverIsDm: undefined, currentUserId: ME })).toBe('unknown')
  })

  it('classifies a mention in an unresolvable server as mention (still notifies)', () => {
    expect(
      classifyEvent({ serverIsDm: undefined, mentionedUserIds: [ME], currentUserId: ME }),
    ).toBe('mention')
  })
})

describe('shouldSuppress — gate table (§5.2)', () => {
  it('baseline: all-defaults context is NOT suppressed (behavior-neutral rollout)', () => {
    expect(shouldSuppress(buildCtx())).toBe(false)
    expect(shouldSuppress(buildCtx({ kind: 'sound' }))).toBe(false)
  })

  it('loading preferences (undefined) do NOT suppress — loading ≠ suppress', () => {
    expect(shouldSuppress(buildCtx({ prefs: undefined }))).toBe(false)
    expect(shouldSuppress(buildCtx({ kind: 'sound', prefs: undefined }))).toBe(false)
  })

  // Gate 1 — DND
  it('gate 1: DND suppresses both pipelines', () => {
    expect(shouldSuppress(buildCtx({ prefs: buildPrefs({ dndEnabled: true }) }))).toBe(true)
    expect(
      shouldSuppress(buildCtx({ kind: 'sound', prefs: buildPrefs({ dndEnabled: true }) })),
    ).toBe(true)
  })

  // Gate 2 — master switches, per pipeline
  it('gate 2: notificationsEnabled=false suppresses desktop only', () => {
    const prefs = buildPrefs({ notificationsEnabled: false })
    expect(shouldSuppress(buildCtx({ prefs }))).toBe(true)
    expect(shouldSuppress(buildCtx({ kind: 'sound', prefs }))).toBe(false)
  })

  it('gate 2: notificationSoundsEnabled=false suppresses sound only', () => {
    const prefs = buildPrefs({ notificationSoundsEnabled: false })
    expect(shouldSuppress(buildCtx({ kind: 'sound', prefs }))).toBe(true)
    expect(shouldSuppress(buildCtx({ prefs }))).toBe(false)
  })

  // Gates 3-4
  it('gate 3: system messages suppress both pipelines', () => {
    expect(shouldSuppress(buildCtx({ isSystem: true }))).toBe(true)
    expect(shouldSuppress(buildCtx({ kind: 'sound', isSystem: true }))).toBe(true)
  })

  it('gate 4: own messages suppress both pipelines', () => {
    expect(shouldSuppress(buildCtx({ isSelf: true }))).toBe(true)
    expect(shouldSuppress(buildCtx({ kind: 'sound', isSelf: true }))).toBe(true)
  })

  // Gate 5 — sound only, BOTH conditions required
  it('gate 5: sound suppresses only when active channel AND focused', () => {
    expect(shouldSuppress(buildCtx({ kind: 'sound', isActiveChannel: true, hasFocus: true }))).toBe(
      true,
    )
    // Active channel + blurred window → still plays (Discord parity fix).
    expect(
      shouldSuppress(buildCtx({ kind: 'sound', isActiveChannel: true, hasFocus: false })),
    ).toBe(false)
    expect(
      shouldSuppress(buildCtx({ kind: 'sound', isActiveChannel: false, hasFocus: true })),
    ).toBe(false)
  })

  it('gate 5 deleted for desktop: active channel + unfocused + no tab focused → fires', () => {
    expect(
      shouldSuppress(buildCtx({ isActiveChannel: true, hasFocus: false, anyTabFocused: false })),
    ).toBe(false)
  })

  // Gate 6 — desktop only, cross-tab
  it('gate 6: any focused same-origin tab suppresses desktop, not sound', () => {
    expect(shouldSuppress(buildCtx({ anyTabFocused: true }))).toBe(true)
    expect(shouldSuppress(buildCtx({ kind: 'sound', anyTabFocused: true, hasFocus: false }))).toBe(
      false,
    )
  })

  // Gate 7 — event-type switches
  it('gate 7: notifyDms=false suppresses dm events only', () => {
    const prefs = buildPrefs({ notifyDms: false })
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'dm' }))).toBe(true)
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'channel' }))).toBe(false)
  })

  it('gate 7: notifyMentions=false suppresses mention events only', () => {
    const prefs = buildPrefs({ notifyMentions: false })
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'mention' }))).toBe(true)
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'channel' }))).toBe(false)
  })

  it('gate 7: notifyMessages=false suppresses channel events only', () => {
    const prefs = buildPrefs({ notifyMessages: false })
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'channel' }))).toBe(true)
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'dm' }))).toBe(false)
  })

  it("gate 7: 'unknown' skips the gate entirely (fail-open)", () => {
    const prefs = buildPrefs({ notifyMessages: false, notifyDms: false, notifyMentions: false })
    expect(shouldSuppress(buildCtx({ prefs, eventClass: 'unknown' }))).toBe(false)
  })

  // Gate 8 — per-channel level
  it("gate 8: level 'none' suppresses every class, both pipelines", () => {
    for (const eventClass of ['dm', 'mention', 'channel', 'unknown'] as const) {
      expect(shouldSuppress(buildCtx({ channelLevel: 'none', eventClass }))).toBe(true)
      expect(shouldSuppress(buildCtx({ kind: 'sound', channelLevel: 'none', eventClass }))).toBe(
        true,
      )
    }
  })

  it("gate 8: level 'mentions' suppresses ONLY plain channel messages (feature live)", () => {
    expect(MENTIONS_FEATURE_LIVE).toBe(true)
    expect(shouldSuppress(buildCtx({ channelLevel: 'mentions', eventClass: 'channel' }))).toBe(true)
    // Mention in a mentions-level channel → notifies.
    expect(shouldSuppress(buildCtx({ channelLevel: 'mentions', eventClass: 'mention' }))).toBe(
      false,
    )
    // Stale 'mentions' row on a DM channel behaves as 'all' (D14).
    expect(shouldSuppress(buildCtx({ channelLevel: 'mentions', eventClass: 'dm' }))).toBe(false)
    // Unknown class passes (fail-open).
    expect(shouldSuppress(buildCtx({ channelLevel: 'mentions', eventClass: 'unknown' }))).toBe(
      false,
    )
  })

  it("gate 8: no override (undefined) and 'all' never suppress", () => {
    expect(shouldSuppress(buildCtx({ channelLevel: undefined }))).toBe(false)
    expect(shouldSuppress(buildCtx({ channelLevel: 'all' }))).toBe(false)
  })

  // Gate 9 — cooldown
  it('gate 9: cooldown suppresses both pipelines', () => {
    expect(shouldSuppress(buildCtx({ cooldownHit: true }))).toBe(true)
    expect(shouldSuppress(buildCtx({ kind: 'sound', cooldownHit: true }))).toBe(true)
  })
})
