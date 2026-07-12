import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// WHY side-effect import: initializes the real i18n instance so the servers
// namespace copy (Your Invite Link, ...) resolves to text.
import '@/lib/i18n'
import { createQueryWrapper } from '@/tests/test-utils'
import { CreateInviteDialog } from './create-invite-dialog'

configure({ testIdAttribute: 'data-test' })

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Stub the mutation: submitting the form yields a fixed invite code so the
// dialog transitions to the share-link view.
const createInviteMutate = vi.fn(
  (_input: unknown, opts?: { onSuccess?: (data: { code: string }) => void }) =>
    opts?.onSuccess?.({ code: 'abc123XY' }),
)
vi.mock('./hooks/use-create-invite', () => ({
  useCreateInvite: () => ({ mutate: createInviteMutate, isPending: false }),
}))

const EXPECTED_URL = 'https://joinharmony.app/i/abc123XY'

function renderDialog() {
  const onClose = vi.fn()
  render(<CreateInviteDialog serverId="srv-1" isOpen onClose={onClose} />, {
    wrapper: createQueryWrapper(),
  })
  return { onClose }
}

/** Drives the create form to reveal the generated share link. */
function generateInvite() {
  const form = screen.getByTestId('invite-submit-button').closest('form')
  expect(form).not.toBeNull()
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
  fireEvent.submit(form!)
}

let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('CreateInviteDialog invite link', () => {
  it('displays the full /i/ share URL, not the bare code', async () => {
    renderDialog()
    generateInvite()

    const display = await screen.findByTestId('invite-code-display')
    await waitFor(() => expect((display as HTMLInputElement).value).toBe(EXPECTED_URL))
    // The bare code alone must never be what we show.
    expect((display as HTMLInputElement).value).not.toBe('abc123XY')
  })

  it('copies the full share URL to the clipboard', async () => {
    renderDialog()
    generateInvite()

    fireEvent.click(await screen.findByTestId('invite-copy-button'))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText).toHaveBeenCalledWith(EXPECTED_URL)
  })
})
