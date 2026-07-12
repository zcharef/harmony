import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// WHY side-effect import: initializes the real i18n instance so the servers
// namespace keys (Add a Server, Create My Own, ...) resolve to text.
import '@/lib/i18n'
import { createQueryWrapper } from '@/tests/test-utils'
import { AddServerDialog } from './add-server-dialog'

// WHY: The repo uses data-test (not data-testid).
configure({ testIdAttribute: 'data-test' })

// WHY mock the mutation hooks (not the whole SDK): the dialog's contract is
// "submitting Create calls useCreateServer, confirming Join calls useJoinServer".
// Stub mutations invoke onSuccess so the navigation callbacks fire.
const mocks = vi.hoisted(() => ({
  createServerMutate: vi.fn(
    (_values: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) =>
      opts?.onSuccess?.({ id: 'srv-created' }),
  ),
  joinServerMutate: vi.fn((_input: unknown, opts?: { onSuccess?: (data: unknown) => void }) =>
    opts?.onSuccess?.(undefined),
  ),
  previewInvite: vi.fn(async () => ({
    data: { serverId: 'srv-joined', serverName: 'Preview Server', memberCount: 7 },
  })),
}))

vi.mock('./hooks/use-create-server', () => ({
  useCreateServer: () => ({ mutate: mocks.createServerMutate, isPending: false }),
}))
vi.mock('./hooks/use-join-server', () => ({
  useJoinServer: () => ({
    mutate: mocks.joinServerMutate,
    isPending: false,
    isError: false,
    reset: vi.fn(),
  }),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, previewInvite: mocks.previewInvite }
})

function renderDialog(overrides: { initialStep?: 'choose' | 'create' | 'join' } = {}) {
  const onClose = vi.fn()
  const onCreated = vi.fn()
  const onJoined = vi.fn()
  render(
    <AddServerDialog
      isOpen
      onClose={onClose}
      onCreated={onCreated}
      onJoined={onJoined}
      initialStep={overrides.initialStep ?? 'choose'}
    />,
    { wrapper: createQueryWrapper() },
  )
  return { onClose, onCreated, onJoined }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('AddServerDialog', () => {
  it('renders the chooser with Create and Join options and NO template section', async () => {
    renderDialog()

    expect(await screen.findByTestId('add-server-create-option')).toBeTruthy()
    expect(screen.getByTestId('add-server-join-option')).toBeTruthy()
    // No "Start from a template" path exists (explicit exclusion).
    expect(screen.queryByText(/template/i)).toBeNull()
    expect(screen.queryByTestId('add-server-template-option')).toBeNull()
  })

  it('routes the Create option to the server-name form (not templates)', async () => {
    renderDialog()

    fireEvent.click(await screen.findByTestId('add-server-create-option'))

    expect(await screen.findByTestId('server-name-input')).toBeTruthy()
    expect(screen.getByTestId('create-server-submit-button')).toBeTruthy()
    // The join input must not be present on the create step.
    expect(screen.queryByTestId('invite-code-input')).toBeNull()
  })

  it('routes the Join option to the invite input (not templates)', async () => {
    renderDialog()

    fireEvent.click(await screen.findByTestId('add-server-join-option'))

    expect(await screen.findByTestId('invite-code-input')).toBeTruthy()
    expect(screen.getByTestId('join-server-preview-button')).toBeTruthy()
    expect(screen.queryByTestId('server-name-input')).toBeNull()
  })

  it('submitting Create calls useCreateServer and reports the new server', async () => {
    const { onCreated } = renderDialog({ initialStep: 'create' })

    const nameInput = await screen.findByTestId('server-name-input')
    fireEvent.change(nameInput, { target: { value: 'My Server' } })
    fireEvent.click(screen.getByTestId('create-server-submit-button'))

    await waitFor(() => expect(mocks.createServerMutate).toHaveBeenCalledTimes(1))
    expect(mocks.createServerMutate.mock.calls[0]?.[0]).toEqual({ name: 'My Server' })
    expect(onCreated).toHaveBeenCalledWith('srv-created')
  })

  it('previewing then confirming Join calls useJoinServer with the previewed server', async () => {
    const { onJoined } = renderDialog({ initialStep: 'join' })

    const codeInput = await screen.findByTestId('invite-code-input')
    fireEvent.change(codeInput, { target: { value: 'abc123XY' } })
    fireEvent.click(screen.getByTestId('join-server-preview-button'))

    // Preview card resolves with the mocked server.
    expect((await screen.findByTestId('join-server-name')).textContent).toContain('Preview Server')

    fireEvent.click(screen.getByTestId('join-server-confirm-button'))

    await waitFor(() => expect(mocks.joinServerMutate).toHaveBeenCalledTimes(1))
    expect(mocks.joinServerMutate.mock.calls[0]?.[0]).toEqual({
      serverId: 'srv-joined',
      body: { inviteCode: 'abc123XY' },
    })
    expect(onJoined).toHaveBeenCalledWith('srv-joined')
  })

  it('Back returns from the Create step to the chooser', async () => {
    renderDialog({ initialStep: 'create' })

    fireEvent.click(await screen.findByTestId('create-server-cancel-button'))

    expect(await screen.findByTestId('add-server-create-option')).toBeTruthy()
    expect(screen.queryByTestId('server-name-input')).toBeNull()
  })

  it('Back returns from the Join step to the chooser', async () => {
    renderDialog({ initialStep: 'join' })

    fireEvent.click(await screen.findByTestId('join-server-cancel-button'))

    expect(await screen.findByTestId('add-server-join-option')).toBeTruthy()
    expect(screen.queryByTestId('invite-code-input')).toBeNull()
  })

  it('initialStep opens the dialog straight to that step', async () => {
    renderDialog({ initialStep: 'join' })

    expect(await screen.findByTestId('invite-code-input')).toBeTruthy()
    // The chooser is skipped when opened directly to a step.
    expect(screen.queryByTestId('add-server-create-option')).toBeNull()
  })
})
