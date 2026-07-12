import { describe, expect, it } from 'vitest'

import upgradeEn from '@/lib/locales/en/upgrade.json'

// SSoT: harmony-api `ResourceKind::key()` (domain/models/plan.rs). Every plan-gated
// resource the API can name in a FEATURE_NOT_IN_PLAN / limit gate MUST have a human
// label here — otherwise the UpgradeModal renders the raw key `resources.<x>` to the
// user (regression: `banner` shipped without a label, 2026-07). Adding a resource to
// the backend enum without a label here fails this test.
const PLAN_GATED_RESOURCE_KEYS = [
  'owned_servers',
  'joined_servers',
  'members',
  'channels',
  'categories',
  'roles',
  'voice_concurrent',
  'active_invites',
  'open_dms',
  'attachments_per_message',
  'attachment_size',
  'custom_emoji',
  'banner',
] as const

describe('upgrade resource labels', () => {
  it('has a non-empty label for every plan-gated resource', () => {
    const labeled = new Set(Object.keys(upgradeEn.resources))
    for (const key of PLAN_GATED_RESOURCE_KEYS) {
      expect(labeled.has(key), `missing upgrade label for resource "${key}"`).toBe(true)
    }
  })

  it('has no empty resource labels', () => {
    for (const [key, label] of Object.entries(upgradeEn.resources)) {
      expect(label, `empty upgrade label for resource "${key}"`).toBeTruthy()
    }
  })
})
