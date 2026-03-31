import { expect, test } from '@playwright/test'
import { z } from 'zod'
import { createServer, createServerRaw, syncProfile } from './fixtures/test-data-factory'
import { createTestUser, type TestUser } from './fixtures/user-factory'

/** RFC 9457 ProblemDetails shape for plan limit errors. */
const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
  upgrade_url: z.string().optional(),
})

/**
 * Plan Limits E2E tests.
 *
 * Validates that server-level plan limits are enforced by the API and that
 * the error response uses RFC 9457 ProblemDetails with an upgrade_url field.
 *
 * Free plan limits under test:
 *   §1 Owned Servers: 3 per user
 *
 * WHY owned servers and not channels?
 *   V4 pricing set channels to 10,000 (effectively unlimited). Owned servers
 *   remain at 3 — a small, testable boundary that exercises the same
 *   COUNT-before-POST enforcement path (PgPlanLimitChecker).
 *
 * WHY API-only (no UI test)?
 *   Plan limits are enforced by the Rust API, not the UI. Testing via direct
 *   API calls is deterministic and fast. Same rationale as rate-limits.spec.ts.
 *
 * All tests use real API calls — no mocks, no direct DB access.
 */
test.describe('Plan Limits — Owned Server Enforcement (§1)', () => {
  let owner: TestUser

  test.beforeAll(async () => {
    owner = await createTestUser('plan-limit')
    await syncProfile(owner.token)

    // WHY: Fill to exactly the free limit (3 owned servers).
    // Sequential to avoid TOCTOU race in the COUNT-before-POST limit check.
    for (let i = 1; i <= 3; i++) {
      await createServer(owner.token, `limit-fill-${i}-${Date.now()}`)
    }
  })

  // ── API rejects the 4th server with 403 + RFC 9457 ─────────────────

  test('API returns 403 with upgrade_url when owned server limit is exceeded', async () => {
    // ACT: Try to create the 4th server (free limit = 3)
    const result = await createServerRaw(owner.token, `over-limit-${Date.now()}`)

    // ASSERT: 403 Forbidden with ProblemDetails
    expect(result.status).toBe(403)

    const body = problemDetailsSchema.parse(result.body)
    expect(body.type).toBe('about:blank')
    expect(body.title).toBe('Plan Limit Exceeded')
    expect(body.status).toBe(403)

    // RFC 9457 detail message mentions the plan, limit, and resource
    expect(body.detail).toContain('free')
    expect(body.detail).toContain('3')
    expect(body.detail).toContain('owned servers')

    // upgrade_url drives the upsell CTA
    expect(body.upgrade_url).toBeDefined()
    expect(body.upgrade_url).toContain('pricing')
  })

  // ── Verify the limit is exactly 3 (3 succeeds, 4 fails) ───────────

  test('server 3 succeeds but server 4 fails on a fresh user', async () => {
    // WHY: Verifies the boundary condition — exactly at the limit vs one over.
    const freshUser = await createTestUser('plan-boundary')
    await syncProfile(freshUser.token)

    // Create 2 servers (total will be 2)
    for (let i = 1; i <= 2; i++) {
      await createServer(freshUser.token, `b-${i}-${Date.now()}`)
    }

    // Server 3 should succeed
    const server3 = await createServerRaw(freshUser.token, `b-3-${Date.now()}`)
    expect(server3.status).toBe(201)

    // Server 4 should fail
    const server4 = await createServerRaw(freshUser.token, `b-4-${Date.now()}`)
    expect(server4.status).toBe(403)

    const body = problemDetailsSchema.parse(server4.body)
    expect(body.title).toBe('Plan Limit Exceeded')
  })
})
