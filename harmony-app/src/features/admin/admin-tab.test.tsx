import { configure, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { AdminUserQuotaResponse, AdminUserSummaryResponse } from '@/lib/api'
// WHY side-effect import: initializes real i18n so the `admin` namespace keys
// resolve to text instead of raw keys.
import '@/lib/i18n'
import { AdminTab } from './admin-tab'

configure({ testIdAttribute: 'data-test' })

const user: AdminUserSummaryResponse = {
  id: 'user-42',
  username: 'zayd',
  displayName: 'Zayed',
  plan: 'free',
  isFounding: true,
  isOfficial: false,
}

const quota: AdminUserQuotaResponse = {
  plan: 'free',
  limits: { maxOwnedServers: 3, maxJoinedServers: 20, maxOpenDms: 20 },
  usage: { ownedServers: 1, joinedServers: 4, openDms: 2 },
}

const mutate = vi.fn()

vi.mock('./hooks/use-search-users', () => ({
  useSearchUsers: () => ({ data: { items: [user], total: 1 }, isFetching: false, isError: false }),
}))
vi.mock('./hooks/use-user-quota', () => ({
  useUserQuota: () => ({ data: quota, isPending: false, isError: false }),
}))
vi.mock('./hooks/use-set-user-plan', () => ({
  useSetUserPlan: () => ({ mutate, isPending: false }),
}))

beforeEach(() => {
  mutate.mockReset()
})

test('search → select → view quota → set plan (with confirmation)', () => {
  render(<AdminTab />)

  // Results render from the (mocked) search.
  const result = screen.getByTestId('admin-result')
  expect(result.textContent).toContain('@zayd')

  // Selecting the user reveals the detail + quota.
  fireEvent.click(result)
  expect(screen.getByTestId('admin-user-detail')).toBeTruthy()
  expect(screen.getByTestId('admin-quota').textContent).toContain('1 / 3') // owned / max

  // Apply is disabled while the chosen plan equals the current plan.
  expect((screen.getByTestId('admin-plan-apply') as HTMLButtonElement).disabled).toBe(true)

  // Choose a different plan → Apply enables → confirm → mutate fires.
  const supporterBtn = screen
    .getAllByTestId('admin-plan-option')
    .find((b) => b.getAttribute('data-plan') === 'supporter')
  if (supporterBtn === undefined) throw new Error('supporter option missing')
  fireEvent.click(supporterBtn)

  const apply = screen.getByTestId('admin-plan-apply') as HTMLButtonElement
  expect(apply.disabled).toBe(false)
  fireEvent.click(apply)

  fireEvent.click(screen.getByTestId('admin-plan-confirm-yes'))

  expect(mutate).toHaveBeenCalledTimes(1)
  expect(mutate).toHaveBeenCalledWith({ userId: 'user-42', plan: 'supporter' }, expect.anything())
})

test('confirmation can be cancelled without mutating', () => {
  render(<AdminTab />)
  fireEvent.click(screen.getByTestId('admin-result'))

  const creatorBtn = screen
    .getAllByTestId('admin-plan-option')
    .find((b) => b.getAttribute('data-plan') === 'creator')
  if (creatorBtn === undefined) throw new Error('creator option missing')
  fireEvent.click(creatorBtn)
  fireEvent.click(screen.getByTestId('admin-plan-apply'))
  fireEvent.click(screen.getByTestId('admin-plan-confirm-cancel'))

  expect(mutate).not.toHaveBeenCalled()
})
