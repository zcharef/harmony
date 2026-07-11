import { configure, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/lib/i18n'
import { createQueryWrapper } from '@/tests/test-utils'
import { AddFriendBar } from './add-friend-bar'

configure({ testIdAttribute: 'data-test' })

const mutate = vi.fn()

vi.mock('../hooks/use-send-friend-request', () => ({
  addFriendErrorKey: () => 'friends:cannotAddUser',
  useSendFriendRequest: () => ({ mutate, isPending: false }),
}))

function renderBar() {
  const Wrapper = createQueryWrapper()
  return render(
    <Wrapper>
      <AddFriendBar />
    </Wrapper>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddFriendBar', () => {
  it('lowercases typed input', () => {
    renderBar()
    const input = screen.getByTestId('add-friend-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'BoB' } })
    expect(input.value).toBe('bob')
  })

  it('shows an inline error and does not call the API on an invalid username', () => {
    renderBar()
    const input = screen.getByTestId('add-friend-input')
    fireEvent.change(input, { target: { value: 'ab' } }) // too short
    fireEvent.click(screen.getByTestId('add-friend-submit'))

    expect(mutate).not.toHaveBeenCalled()
    expect(screen.getByTestId('add-friend-feedback')).toBeTruthy()
  })

  it('submits a valid username and renders the success line', () => {
    mutate.mockImplementation((_body, opts) => opts.onSuccess({ state: 'pendingOutgoing' }))
    renderBar()
    const input = screen.getByTestId('add-friend-input')
    fireEvent.change(input, { target: { value: 'alice' } })
    fireEvent.click(screen.getByTestId('add-friend-submit'))

    expect(mutate).toHaveBeenCalledWith({ username: 'alice' }, expect.anything())
    expect(screen.getByTestId('add-friend-feedback').textContent).toContain('alice')
  })
})
