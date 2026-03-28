import type { Session, User } from '@supabase/supabase-js'

import { useAuthStore } from '@/features/auth/stores/auth-store'

const initialState = useAuthStore.getState()

const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  aud: 'authenticated',
  created_at: '2025-01-01T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
} as User

const mockSession = {
  access_token: 'mock-access-token',
  refresh_token: 'mock-refresh-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 9999999999,
  user: mockUser,
} as Session

beforeEach(() => {
  useAuthStore.setState(initialState, true)
})

describe('useAuthStore', () => {
  describe('initial state', () => {
    it('has session as null', () => {
      expect(useAuthStore.getState().session).toBeNull()
    })

    it('has user as null', () => {
      expect(useAuthStore.getState().user).toBeNull()
    })

    it('has isLoading as true', () => {
      expect(useAuthStore.getState().isLoading).toBe(true)
    })
  })

  describe('setSession', () => {
    it('sets the session to a valid session object', () => {
      useAuthStore.getState().setSession(mockSession)

      expect(useAuthStore.getState().session).toBe(mockSession)
    })

    it('sets the session to null', () => {
      useAuthStore.getState().setSession(mockSession)
      useAuthStore.getState().setSession(null)

      expect(useAuthStore.getState().session).toBeNull()
    })
  })

  describe('setUser', () => {
    it('sets the user to a valid user object', () => {
      useAuthStore.getState().setUser(mockUser)

      expect(useAuthStore.getState().user).toBe(mockUser)
    })

    it('sets the user to null', () => {
      useAuthStore.getState().setUser(mockUser)
      useAuthStore.getState().setUser(null)

      expect(useAuthStore.getState().user).toBeNull()
    })
  })

  describe('setLoading', () => {
    it('sets isLoading to false', () => {
      useAuthStore.getState().setLoading(false)

      expect(useAuthStore.getState().isLoading).toBe(false)
    })

    it('sets isLoading back to true', () => {
      useAuthStore.getState().setLoading(false)
      useAuthStore.getState().setLoading(true)

      expect(useAuthStore.getState().isLoading).toBe(true)
    })
  })

  describe('clear', () => {
    it('resets session and user to null and isLoading to false', () => {
      useAuthStore.getState().clear()

      const state = useAuthStore.getState()
      expect(state.session).toBeNull()
      expect(state.user).toBeNull()
      expect(state.isLoading).toBe(false)
    })

    it('resets everything after session and user were set', () => {
      useAuthStore.getState().setSession(mockSession)
      useAuthStore.getState().setUser(mockUser)
      useAuthStore.getState().setLoading(false)

      useAuthStore.getState().clear()

      const state = useAuthStore.getState()
      expect(state.session).toBeNull()
      expect(state.user).toBeNull()
      expect(state.isLoading).toBe(false)
    })
  })
})
