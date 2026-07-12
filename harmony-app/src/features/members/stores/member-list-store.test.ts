import { beforeEach, describe, expect, it } from 'vitest'
import { useMemberListStore } from './member-list-store'

// Reset the singleton store between tests.
beforeEach(() => {
  useMemberListStore.setState({ isOpen: true })
})

describe('member-list-store', () => {
  it('defaults to open (server view shows the members panel by default)', () => {
    expect(useMemberListStore.getState().isOpen).toBe(true)
  })

  it('toggle flips the panel visibility', () => {
    const { toggle } = useMemberListStore.getState()

    toggle()
    expect(useMemberListStore.getState().isOpen).toBe(false)

    toggle()
    expect(useMemberListStore.getState().isOpen).toBe(true)
  })
})
