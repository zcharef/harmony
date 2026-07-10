import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { logger } = await import('@/lib/logger')
const { readStorage, writeStorage } = await import('./storage')

describe('storage helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips a value and removes on null', () => {
    writeStorage('harmony:test', 'value')
    expect(readStorage('harmony:test')).toBe('value')

    writeStorage('harmony:test', null)
    expect(readStorage('harmony:test')).toBeNull()
  })

  it('swallows write failures (quota/denied) and logs the preserved key', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    // WHY: the vitest.setup localStorage mock is a plain object — patch it too.
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => writeStorage('harmony:test', 'value')).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(
      'write_storage_failed',
      expect.objectContaining({ key: 'harmony:test' }),
    )
  })

  it('returns null when reads are denied', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(readStorage('harmony:test')).toBeNull()
  })
})
