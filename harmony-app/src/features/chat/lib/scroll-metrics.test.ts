import { distanceFromBottom, isNearBottom, STICK_TO_BOTTOM_THRESHOLD_PX } from './scroll-metrics'

describe('distanceFromBottom', () => {
  it('is 0 when scrolled fully to the bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(0)
  })

  it('measures the unseen content below the viewport', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 500 })).toBe(400)
  })
})

describe('isNearBottom', () => {
  it('is true at the exact bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(true)
  })

  it('is true just inside the default threshold', () => {
    // distance = 199 < 200
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 301, clientHeight: 500 })).toBe(true)
  })

  it('is false exactly at the threshold (strict <)', () => {
    // distance = 200, threshold = 200
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 })).toBe(false)
  })

  it('is false when scrolled up to read history', () => {
    expect(isNearBottom({ scrollHeight: 5000, scrollTop: 100, clientHeight: 500 })).toBe(false)
  })

  it('honours a custom threshold', () => {
    // distance = 400
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 500 }, 500)).toBe(true)
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 500 }, 300)).toBe(false)
  })

  it('exposes the default threshold as a constant', () => {
    expect(STICK_TO_BOTTOM_THRESHOLD_PX).toBe(200)
  })
})
