import { configure, fireEvent, render, screen } from '@testing-library/react'
// WHY: side-effect import initializes the real i18n instance so labels resolve.
import '@/lib/i18n'
import { MediaLightbox } from './media-lightbox'

configure({ testIdAttribute: 'data-test' })

const SRC = 'https://cdn.example.com/pic.webp'

describe('MediaLightbox', () => {
  it('renders the image viewport-capped at natural size when open (kind=image)', async () => {
    render(
      <MediaLightbox
        isOpen
        src={SRC}
        alt="cat"
        kind="image"
        onClose={() => {}}
        onOpenOriginal={() => {}}
      />,
    )
    const img = await screen.findByTestId('lightbox-image')
    expect(img.getAttribute('src')).toBe(SRC)
    expect(img.getAttribute('alt')).toBe('cat')
    // Natural size, capped to the viewport — no inline max-h-80 shrink.
    expect(img.className).toContain('max-h-[90vh]')
    expect(img.className).toContain('max-w-[90vw]')
    expect(img.className).not.toContain('max-h-80')
    expect(screen.queryByTestId('lightbox-video')).toBeNull()
  })

  it('renders a native-controls video when open (kind=video)', async () => {
    render(
      <MediaLightbox
        isOpen
        src={SRC}
        alt=""
        kind="video"
        onClose={() => {}}
        onOpenOriginal={() => {}}
      />,
    )
    const video = await screen.findByTestId('lightbox-video')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('src')).toBe(SRC)
    // Native controls must stay on so scrubbing works inside the lightbox.
    expect(video.hasAttribute('controls')).toBe(true)
    expect(screen.queryByTestId('lightbox-image')).toBeNull()
  })

  it('renders nothing while closed', () => {
    render(
      <MediaLightbox
        isOpen={false}
        src={SRC}
        alt="cat"
        kind="image"
        onClose={() => {}}
        onOpenOriginal={() => {}}
      />,
    )
    expect(screen.queryByTestId('lightbox-image')).toBeNull()
  })

  it('closes on the close button', async () => {
    const onClose = vi.fn()
    render(
      <MediaLightbox
        isOpen
        src={SRC}
        alt="cat"
        kind="image"
        onClose={onClose}
        onOpenOriginal={() => {}}
      />,
    )
    fireEvent.click(await screen.findByTestId('lightbox-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <MediaLightbox
        isOpen
        src={SRC}
        alt="cat"
        kind="image"
        onClose={onClose}
        onOpenOriginal={() => {}}
      />,
    )
    // WHY fire on the overlay (not document): HeroUI/react-aria binds Escape to
    // the dialog's onKeyDown; the event bubbles up from the media element.
    const img = await screen.findByTestId('lightbox-image')
    fireEvent.keyDown(img, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens the original only from the secondary button, never from viewing', async () => {
    const onOpenOriginal = vi.fn()
    render(
      <MediaLightbox
        isOpen
        src={SRC}
        alt="cat"
        kind="image"
        onClose={() => {}}
        onOpenOriginal={onOpenOriginal}
      />,
    )
    // Merely viewing (clicking the media) must not fire the secondary gate.
    fireEvent.click(await screen.findByTestId('lightbox-image'))
    expect(onOpenOriginal).not.toHaveBeenCalled()
    // The explicit secondary action does.
    fireEvent.click(screen.getByTestId('lightbox-open-original'))
    expect(onOpenOriginal).toHaveBeenCalledTimes(1)
  })
})
