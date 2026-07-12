import { configure, fireEvent, render, screen } from '@testing-library/react'
// WHY: side-effect import initializes the real i18n instance so aria-labels resolve.
import '@/lib/i18n'
import { MeasureRowContext } from '../lib/measure-row-context'
import { EmbeddedImage } from './message-attachments'

configure({ testIdAttribute: 'data-test' })

const SRC = 'https://cdn.example.com/anim.gif'

describe('EmbeddedImage height reservation', () => {
  it('reserves a min-height box when intrinsic dimensions are unknown (no CLS)', () => {
    render(<EmbeddedImage src={SRC} alt="" onOpen={() => {}} />)
    const img = screen.getByTestId('attachment-image').querySelector('img')
    expect(img).not.toBeNull()
    // The reserved box keeps the row a stable height from first paint.
    expect(img?.className).toContain('min-h-48')
    expect(img?.getAttribute('width')).toBeNull()
  })

  it('reserves via the intrinsic aspect ratio when dimensions are known (no min-height)', () => {
    render(<EmbeddedImage src={SRC} alt="" width={480} height={320} onOpen={() => {}} />)
    const img = screen.getByTestId('attachment-image').querySelector('img')
    expect(img?.getAttribute('width')).toBe('480')
    expect(img?.getAttribute('height')).toBe('320')
    expect(img?.className).not.toContain('min-h-48')
  })
})

describe('EmbeddedImage onLoad re-measure', () => {
  it('re-measures the owning virtual row when the real image loads', () => {
    const measured: Element[] = []
    render(
      <MeasureRowContext.Provider value={(node) => measured.push(node)}>
        <div data-index={3}>
          <EmbeddedImage src={SRC} alt="" onOpen={() => {}} />
        </div>
      </MeasureRowContext.Provider>,
    )
    const img = screen.getByTestId('attachment-image').querySelector('img')
    expect(img).not.toBeNull()
    if (img !== null) fireEvent.load(img)
    // The row carrying data-index is handed back to the measure callback so the
    // virtualizer corrects its cached height immediately.
    expect(measured).toHaveLength(1)
    expect(measured[0]?.getAttribute('data-index')).toBe('3')
  })

  it('no-ops on load when rendered outside a virtualized list (null context)', () => {
    render(<EmbeddedImage src={SRC} alt="" onOpen={() => {}} />)
    const img = screen.getByTestId('attachment-image').querySelector('img')
    // Must not throw when there is no measure provider (isolated render).
    expect(() => {
      if (img !== null) fireEvent.load(img)
    }).not.toThrow()
  })
})
