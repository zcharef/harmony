import { vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { User } from '@supabase/supabase-js'

vi.mock('@/lib/api', () => ({
  registerDevice: vi.fn(),
  uploadOneTimeKeys: vi.fn(),
}))

vi.mock('@/lib/crypto', () => ({
  initCrypto: vi.fn(),
}))

vi.mock('@/lib/crypto-cache', () => ({
  initCache: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { registerDevice, uploadOneTimeKeys } = await import('@/lib/api')
const { initCrypto } = await import('@/lib/crypto')
const { initCache } = await import('@/lib/crypto-cache')
const { isTauri } = await import('@/lib/platform')
const { logger } = await import('@/lib/logger')

// WHY: Import stores after mocks to get proper mock wiring.
const { useAuthStore } = await import('@/features/auth/stores/auth-store')
const { useCryptoStore } = await import('@/features/crypto/stores/crypto-store')
const { useCryptoInit } = await import('./use-crypto-init')

const authInitialState = useAuthStore.getState()
const cryptoInitialState = useCryptoStore.getState()

const mockUser = {
  id: 'user-123',
  email: 'test@example.com',
  aud: 'authenticated',
  created_at: '2025-01-01T00:00:00Z',
  app_metadata: {},
  user_metadata: {},
} as unknown as User

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState(authInitialState, true)
  useCryptoStore.setState(cryptoInitialState, true)
  vi.stubGlobal('crypto', {
    ...crypto,
    randomUUID: () => 'device-uuid-000',
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useCryptoInit', () => {
  it('does nothing on web (isTauri returns false)', () => {
    vi.mocked(isTauri).mockReturnValue(false)
    useAuthStore.getState().setUser(mockUser)
    useAuthStore.getState().setLoading(false)

    renderHook(() => useCryptoInit())

    expect(initCrypto).not.toHaveBeenCalled()
  })

  it('does nothing when auth is still loading', () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useAuthStore.getState().setUser(mockUser)
    // isLoading defaults to true

    renderHook(() => useCryptoInit())

    expect(initCrypto).not.toHaveBeenCalled()
  })

  it('does nothing when user is null', () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useAuthStore.getState().setLoading(false)
    // user defaults to null

    renderHook(() => useCryptoInit())

    expect(initCrypto).not.toHaveBeenCalled()
  })

  it('does nothing when already initialized', () => {
    vi.mocked(isTauri).mockReturnValue(true)
    useAuthStore.getState().setUser(mockUser)
    useAuthStore.getState().setLoading(false)
    useCryptoStore.getState().setInitialized(true)

    renderHook(() => useCryptoInit())

    expect(initCrypto).not.toHaveBeenCalled()
  })

  it('bootstraps E2EE on desktop with authenticated user', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(initCrypto).mockResolvedValueOnce({
      identity_key: 'id-key',
      signing_key: 'sign-key',
      one_time_keys: [{ key_id: 'otk-1', public_key: 'pub-1' }],
    })
    vi.mocked(registerDevice).mockResolvedValueOnce({ data: undefined } as never)
    vi.mocked(uploadOneTimeKeys).mockResolvedValueOnce({ data: undefined } as never)
    vi.mocked(initCache).mockResolvedValueOnce(undefined)

    useAuthStore.getState().setUser(mockUser)
    useAuthStore.getState().setLoading(false)

    renderHook(() => useCryptoInit())

    await waitFor(() => {
      expect(useCryptoStore.getState().isInitialized).toBe(true)
    })

    expect(initCrypto).toHaveBeenCalledWith('user-123')
    expect(registerDevice).toHaveBeenCalledWith({
      body: {
        deviceId: 'device-uuid-000',
        deviceName: expect.any(String),
        identityKey: 'id-key',
        signingKey: 'sign-key',
      },
      throwOnError: true,
    })
    expect(uploadOneTimeKeys).toHaveBeenCalledWith({
      body: {
        deviceId: 'device-uuid-000',
        keys: [{ keyId: 'otk-1', publicKey: 'pub-1', isFallback: false }],
      },
      throwOnError: true,
    })
    expect(initCache).toHaveBeenCalledWith('user-123')
    expect(logger.info).toHaveBeenCalledWith('E2EE initialized', {
      deviceId: 'device-uuid-000',
      keyCount: 1,
    })
  })

  it('skips key upload when there are zero one-time keys', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(initCrypto).mockResolvedValueOnce({
      identity_key: 'id-key',
      signing_key: 'sign-key',
      one_time_keys: [],
    })
    vi.mocked(registerDevice).mockResolvedValueOnce({ data: undefined } as never)
    vi.mocked(initCache).mockResolvedValueOnce(undefined)

    useAuthStore.getState().setUser(mockUser)
    useAuthStore.getState().setLoading(false)

    renderHook(() => useCryptoInit())

    await waitFor(() => {
      expect(useCryptoStore.getState().isInitialized).toBe(true)
    })

    expect(uploadOneTimeKeys).not.toHaveBeenCalled()
  })

  it('reuses existing deviceId from store instead of generating a new one', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(initCrypto).mockResolvedValueOnce({
      identity_key: 'id-key',
      signing_key: 'sign-key',
      one_time_keys: [],
    })
    vi.mocked(registerDevice).mockResolvedValueOnce({ data: undefined } as never)
    vi.mocked(initCache).mockResolvedValueOnce(undefined)

    useCryptoStore.getState().setDeviceId('existing-device-id')
    useAuthStore.getState().setUser(mockUser)
    useAuthStore.getState().setLoading(false)

    renderHook(() => useCryptoInit())

    await waitFor(() => {
      expect(useCryptoStore.getState().isInitialized).toBe(true)
    })

    expect(registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ deviceId: 'existing-device-id' }),
      }),
    )
  })

  it('sets initFailed and logs error when bootstrap fails', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(initCrypto).mockRejectedValueOnce(new Error('Olm init failed'))

    useAuthStore.getState().setUser(mockUser)
    useAuthStore.getState().setLoading(false)

    renderHook(() => useCryptoInit())

    await waitFor(() => {
      expect(useCryptoStore.getState().initFailed).toBe(true)
    })

    expect(useCryptoStore.getState().isInitialized).toBe(false)
    expect(logger.error).toHaveBeenCalledWith('e2ee_init_failed', {
      step: 'init_olm',
      error: 'Olm init failed',
    })
  })
})
