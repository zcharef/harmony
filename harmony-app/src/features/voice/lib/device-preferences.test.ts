import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import {
  clearPreferredDeviceId,
  loadPreferredDeviceId,
  savePreferredDeviceId,
} from './device-preferences'

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('device-preferences', () => {
  it('returns null when no preference is stored', () => {
    expect(loadPreferredDeviceId('audioinput')).toBeNull()
    expect(loadPreferredDeviceId('audiooutput')).toBeNull()
  })

  it('round-trips a saved input device id', () => {
    savePreferredDeviceId('audioinput', 'mic-123')

    expect(loadPreferredDeviceId('audioinput')).toBe('mic-123')
    // Output preference is independent
    expect(loadPreferredDeviceId('audiooutput')).toBeNull()
  })

  it('round-trips a saved output device id', () => {
    savePreferredDeviceId('audiooutput', 'speaker-456')

    expect(loadPreferredDeviceId('audiooutput')).toBe('speaker-456')
    expect(loadPreferredDeviceId('audioinput')).toBeNull()
  })

  it('clears a stored preference', () => {
    savePreferredDeviceId('audioinput', 'mic-123')

    clearPreferredDeviceId('audioinput')

    expect(loadPreferredDeviceId('audioinput')).toBeNull()
  })

  it('overwrites an existing preference', () => {
    savePreferredDeviceId('audioinput', 'mic-old')
    savePreferredDeviceId('audioinput', 'mic-new')

    expect(loadPreferredDeviceId('audioinput')).toBe('mic-new')
  })

  it('returns null and logs when localStorage.getItem throws', async () => {
    const { logger } = await import('@/lib/logger')
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    expect(loadPreferredDeviceId('audioinput')).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      'voice_device_preference_load_failed',
      expect.objectContaining({ kind: 'audioinput' }),
    )

    spy.mockRestore()
  })

  it('logs when localStorage.setItem throws', async () => {
    const { logger } = await import('@/lib/logger')
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() => savePreferredDeviceId('audiooutput', 'speaker-1')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      'voice_device_preference_save_failed',
      expect.objectContaining({ kind: 'audiooutput' }),
    )

    spy.mockRestore()
  })
})
