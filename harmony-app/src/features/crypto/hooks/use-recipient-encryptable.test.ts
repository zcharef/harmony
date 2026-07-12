import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import type { DeviceResponse } from '@/lib/api'
import { createQueryWrapper } from '@/tests/test-utils'
import { useRecipientEncryptable } from './use-recipient-encryptable'

vi.mock('@/lib/api', () => ({
  listDevices: vi.fn(),
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(),
}))

const { listDevices } = await import('@/lib/api')
const { isTauri } = await import('@/lib/platform')

const RECIPIENT_ID = 'recipient-1'

function buildDevice(overrides: Partial<DeviceResponse> = {}): DeviceResponse {
  return {
    id: 'device-key-1',
    deviceId: 'device-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as DeviceResponse
}

describe('useRecipientEncryptable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined on web without probing (encryption is desktop-only)', async () => {
    vi.mocked(isTauri).mockReturnValue(false)

    const { result } = renderHook(() => useRecipientEncryptable(RECIPIENT_ID), {
      wrapper: createQueryWrapper(),
    })

    // Never fires the request on web.
    expect(listDevices).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
  })

  it('returns undefined when there is no recipient', async () => {
    vi.mocked(isTauri).mockReturnValue(true)

    const { result } = renderHook(() => useRecipientEncryptable(null), {
      wrapper: createQueryWrapper(),
    })

    expect(listDevices).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
  })

  it('returns true when the recipient has at least one registered device (encryptable)', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(listDevices).mockResolvedValue({
      data: { items: [buildDevice()] },
    } as never)

    const { result } = renderHook(() => useRecipientEncryptable(RECIPIENT_ID), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current).toBe(true))
    expect(listDevices).toHaveBeenCalledWith({
      path: { user_id: RECIPIENT_ID },
      throwOnError: true,
    })
  })

  it('returns false when the recipient has zero devices (confirmed keyless → plaintext)', async () => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(listDevices).mockResolvedValue({
      data: { items: [] },
    } as never)

    const { result } = renderHook(() => useRecipientEncryptable(RECIPIENT_ID), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current).toBe(false))
  })

  it('stays undefined (unknown) when the probe errors — never downgrades a possible key-holder', async () => {
    // WHY confidentiality invariant: a transient listDevices failure must NOT be
    // read as "keyless". Only a successful empty list flips the gate to plaintext.
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(listDevices).mockRejectedValue(new Error('network down'))

    const { result } = renderHook(() => useRecipientEncryptable(RECIPIENT_ID), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(listDevices).toHaveBeenCalled())
    // Give the query a tick to settle into its error state.
    await waitFor(() => expect(result.current).toBeUndefined())
    expect(result.current).not.toBe(false)
  })
})
