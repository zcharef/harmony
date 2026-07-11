import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const { logger } = await import('@/lib/logger')
const { renderOverlayBadgePng } = await import('./overlay-badge')

/** 1x1 transparent PNG — enough to exercise the data-URL → bytes decode. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

interface FakeContext {
  clearRect: ReturnType<typeof vi.fn>
  beginPath: ReturnType<typeof vi.fn>
  arc: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  fillText: ReturnType<typeof vi.fn>
  fillStyle: string
  font: string
  textAlign: string
  textBaseline: string
}

function stubCanvas(ctx: FakeContext | null) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    // WHY as unknown: jsdom has no real 2D context — the fake records the
    // calls the renderer makes; the DOM lib type is unsatisfiable here.
    ctx as unknown as ReturnType<HTMLCanvasElement['getContext']>,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    `data:image/png;base64,${TINY_PNG_BASE64}`,
  )
}

function makeFakeContext(): FakeContext {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
  }
}

describe('renderOverlayBadgePng', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns PNG bytes and draws the exact count', () => {
    const ctx = makeFakeContext()
    stubCanvas(ctx)

    const bytes = renderOverlayBadgePng(7)

    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes?.length).toBeGreaterThan(0)
    expect(ctx.fillText).toHaveBeenCalledExactlyOnceWith(
      '7',
      expect.any(Number),
      expect.any(Number),
    )
  })

  it('clamps counts above 99 to "99+"', () => {
    const ctx = makeFakeContext()
    stubCanvas(ctx)

    renderOverlayBadgePng(1234)

    expect(ctx.fillText).toHaveBeenCalledExactlyOnceWith(
      '99+',
      expect.any(Number),
      expect.any(Number),
    )
  })

  it('returns null and warns when the 2D context is unavailable', () => {
    stubCanvas(null)

    expect(renderOverlayBadgePng(3)).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith('overlay_badge_canvas_unavailable', {})
  })
})
