import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import {
  clearPreferredDeviceId,
  loadPreferredDeafened,
  loadPreferredDeviceId,
  loadPreferredMuted,
  savePreferredDeafened,
  savePreferredDeviceId,
  savePreferredMuted,
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

  it('returns null when localStorage.getItem throws', () => {
    // WHY: readStorage swallows storage failures — a missing preference is
    // not an error, the caller falls back to system defaults.
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    expect(loadPreferredDeviceId('audioinput')).toBeNull()

    spy.mockRestore()
  })

  it('does not throw and logs when localStorage.setItem throws', async () => {
    const { logger } = await import('@/lib/logger')
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() => savePreferredDeviceId('audiooutput', 'speaker-1')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      'write_storage_failed',
      expect.objectContaining({ key: 'voice_preferred_audio_output' }),
    )

    spy.mockRestore()
  })
})

describe('audio-state-preferences (pre-call mute/deafen)', () => {
  it('defaults to unmuted/undeafened when nothing is stored', () => {
    expect(loadPreferredMuted()).toBe(false)
    expect(loadPreferredDeafened()).toBe(false)
  })

  it('round-trips the muted preference', () => {
    savePreferredMuted(true)
    expect(loadPreferredMuted()).toBe(true)
    expect(localStorage.getItem('voice_preferred_muted')).toBe('true')
    // Deafen is independent.
    expect(loadPreferredDeafened()).toBe(false)

    savePreferredMuted(false)
    expect(loadPreferredMuted()).toBe(false)
    expect(localStorage.getItem('voice_preferred_muted')).toBe('false')
  })

  it('round-trips the deafened preference', () => {
    savePreferredDeafened(true)
    expect(loadPreferredDeafened()).toBe(true)
    expect(loadPreferredMuted()).toBe(false)
  })

  it('treats any non-"true" stored value as false', () => {
    localStorage.setItem('voice_preferred_muted', 'garbage')
    expect(loadPreferredMuted()).toBe(false)
  })

  it('returns false when localStorage.getItem throws', () => {
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    expect(loadPreferredMuted()).toBe(false)
    expect(loadPreferredDeafened()).toBe(false)

    spy.mockRestore()
  })
})
