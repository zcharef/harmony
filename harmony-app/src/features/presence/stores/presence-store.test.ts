import { renderHook } from '@testing-library/react'
import { usePresenceStore, useUserStatus } from '@/features/presence/stores/presence-store'
import type { UserStatus } from '@/lib/api'

const initialState = usePresenceStore.getState()

beforeEach(() => {
  usePresenceStore.setState(initialState, true)
})

describe('usePresenceStore', () => {
  describe('initial state', () => {
    it('has an empty presenceMap', () => {
      const { presenceMap } = usePresenceStore.getState()

      expect(presenceMap).toBeInstanceOf(Map)
      expect(presenceMap.size).toBe(0)
    })
  })

  describe('setUserStatus', () => {
    it('adds a new user status entry', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')

      const { presenceMap } = usePresenceStore.getState()
      expect(presenceMap.get('user-1')).toBe('online')
      expect(presenceMap.size).toBe(1)
    })

    it('updates an existing user status', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')
      usePresenceStore.getState().setUserStatus('user-1', 'idle')

      expect(usePresenceStore.getState().presenceMap.get('user-1')).toBe('idle')
    })

    it('handles multiple users independently', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')
      usePresenceStore.getState().setUserStatus('user-2', 'dnd')
      usePresenceStore.getState().setUserStatus('user-3', 'idle')

      const { presenceMap } = usePresenceStore.getState()
      expect(presenceMap.size).toBe(3)
      expect(presenceMap.get('user-1')).toBe('online')
      expect(presenceMap.get('user-2')).toBe('dnd')
      expect(presenceMap.get('user-3')).toBe('idle')
    })
  })

  describe('syncPresenceState', () => {
    it('replaces the entire presenceMap', () => {
      usePresenceStore.getState().setUserStatus('old-user', 'online')

      const newMap = new Map<string, UserStatus>([
        ['user-a', 'online'],
        ['user-b', 'idle'],
      ])
      usePresenceStore.getState().syncPresenceState(newMap)

      const { presenceMap } = usePresenceStore.getState()
      expect(presenceMap.size).toBe(2)
      expect(presenceMap.get('user-a')).toBe('online')
      expect(presenceMap.get('user-b')).toBe('idle')
      expect(presenceMap.has('old-user')).toBe(false)
    })

    it('replaces with an empty map', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')
      usePresenceStore.getState().syncPresenceState(new Map())

      expect(usePresenceStore.getState().presenceMap.size).toBe(0)
    })
  })

  describe('removeUser', () => {
    it('removes a specific user without affecting others', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')
      usePresenceStore.getState().setUserStatus('user-2', 'dnd')

      usePresenceStore.getState().removeUser('user-1')

      const { presenceMap } = usePresenceStore.getState()
      expect(presenceMap.has('user-1')).toBe(false)
      expect(presenceMap.get('user-2')).toBe('dnd')
      expect(presenceMap.size).toBe(1)
    })

    it('is a no-op when removing a non-existent user', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')

      usePresenceStore.getState().removeUser('non-existent')

      expect(usePresenceStore.getState().presenceMap.size).toBe(1)
      expect(usePresenceStore.getState().presenceMap.get('user-1')).toBe('online')
    })
  })

  describe('clearAll', () => {
    it('empties the presenceMap', () => {
      usePresenceStore.getState().setUserStatus('user-1', 'online')
      usePresenceStore.getState().setUserStatus('user-2', 'idle')
      usePresenceStore.getState().setUserStatus('user-3', 'dnd')

      usePresenceStore.getState().clearAll()

      expect(usePresenceStore.getState().presenceMap.size).toBe(0)
    })
  })
})

describe('useUserStatus', () => {
  beforeEach(() => {
    usePresenceStore.setState(initialState, true)
  })

  it('returns the correct status for a known user', () => {
    usePresenceStore.getState().setUserStatus('user-1', 'dnd')

    const { result } = renderHook(() => useUserStatus('user-1'))

    expect(result.current).toBe('dnd')
  })

  it('returns "offline" as the default for an unknown user', () => {
    const { result } = renderHook(() => useUserStatus('unknown-user'))

    expect(result.current).toBe('offline')
  })
})
