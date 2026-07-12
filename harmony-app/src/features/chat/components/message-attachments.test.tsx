import { configure, fireEvent, render, screen } from '@testing-library/react'
// WHY: side-effect import initializes the real i18n instance so the render
// helpers resolve their aria-labels/keys (mirrors message-item.test).
import '@/lib/i18n'
import type { AttachmentResponse } from '@/lib/api'
import { MessageAttachments } from './message-attachments'

// The components tag test hooks with `data-test`, not the default `data-testid`.
configure({ testIdAttribute: 'data-test' })

function image(moderationStatus: AttachmentResponse['moderationStatus']): AttachmentResponse {
  return {
    id: `att-${moderationStatus}`,
    url: 'https://xyz.supabase.co/storage/v1/object/public/attachments/u/pic.webp',
    mime: 'image/webp',
    size: 2048,
    width: 800,
    height: 600,
    moderationStatus,
  }
}

const VIDEO_URL = 'https://xyz.supabase.co/storage/v1/object/public/attachments/u/clip.mp4'

function video(moderationStatus: AttachmentResponse['moderationStatus']): AttachmentResponse {
  return {
    id: `vid-${moderationStatus}`,
    url: VIDEO_URL,
    mime: 'video/mp4',
    size: 4096,
    width: null,
    height: null,
    moderationStatus,
  }
}

describe('MessageAttachments moderation render (image-moderation §c.4)', () => {
  it('renders a scanning skeleton while pending (never the bytes)', () => {
    render(<MessageAttachments attachments={[image('pending')]} />)
    expect(screen.getByTestId('attachment-scanning')).toBeTruthy()
    expect(screen.queryByTestId('attachment-image')).toBeNull()
  })

  it('renders the inline image when approved', () => {
    render(<MessageAttachments attachments={[image('approved')]} />)
    expect(screen.getByTestId('attachment-image')).toBeTruthy()
  })

  it('gates NSFW behind a spoiler until the viewer reveals it', () => {
    render(<MessageAttachments attachments={[image('gated')]} />)
    // Blurred spoiler first — the image bytes are not rendered.
    expect(screen.getByTestId('attachment-gated')).toBeTruthy()
    expect(screen.queryByTestId('attachment-image')).toBeNull()
    // Click to reveal → the inline image appears (per-viewer, session-only).
    fireEvent.click(screen.getByTestId('attachment-gated'))
    expect(screen.getByTestId('attachment-image')).toBeTruthy()
  })

  it('shows a removed placeholder when blocked, with no reveal', () => {
    render(<MessageAttachments attachments={[image('blocked')]} />)
    expect(screen.getByTestId('attachment-removed')).toBeTruthy()
    expect(screen.queryByTestId('attachment-image')).toBeNull()
    expect(screen.queryByTestId('attachment-gated')).toBeNull()
  })
})

describe('MessageAttachments media lightbox (E2)', () => {
  it('clicking an approved image opens the lightbox and NOT the old open-link popup', async () => {
    render(<MessageAttachments attachments={[image('approved')]} />)
    fireEvent.click(screen.getByTestId('attachment-image'))
    expect(await screen.findByTestId('lightbox-image')).toBeTruthy()
    // The security popup must no longer fire on a primary media click.
    expect(screen.queryByTestId('external-link-continue')).toBeNull()
  })

  it('the lightbox secondary "open original" still routes through ExternalLinkWarning', async () => {
    render(<MessageAttachments attachments={[image('approved')]} />)
    fireEvent.click(screen.getByTestId('attachment-image'))
    fireEvent.click(await screen.findByTestId('lightbox-open-original'))
    // Now — and only now — the security gate appears for the arbitrary URL.
    expect(await screen.findByTestId('external-link-continue')).toBeTruthy()
  })

  it('a gated image is not click-to-enlarge before reveal', () => {
    render(<MessageAttachments attachments={[image('gated')]} />)
    expect(screen.getByTestId('attachment-gated')).toBeTruthy()
    // No inline image, so nothing opens the lightbox until the viewer reveals.
    expect(screen.queryByTestId('attachment-image')).toBeNull()
    expect(screen.queryByTestId('lightbox-image')).toBeNull()
  })

  it('renders an approved video inline (not a file chip) and opens the video lightbox on click', async () => {
    render(<MessageAttachments attachments={[video('approved')]} />)
    // Inline <video> element, not the download chip.
    expect(screen.getByTestId('attachment-video')).toBeTruthy()
    expect(screen.queryByTestId('attachment-file-chip')).toBeNull()
    fireEvent.click(screen.getByTestId('attachment-video'))
    const player = await screen.findByTestId('lightbox-video')
    expect(player.getAttribute('src')).toBe(VIDEO_URL)
    expect(player.hasAttribute('controls')).toBe(true)
  })

  it('gates an NSFW video behind a spoiler until revealed, then plays it in the lightbox', async () => {
    render(<MessageAttachments attachments={[video('gated')]} />)
    expect(screen.getByTestId('attachment-gated')).toBeTruthy()
    expect(screen.queryByTestId('attachment-video')).toBeNull()
    fireEvent.click(screen.getByTestId('attachment-gated'))
    fireEvent.click(screen.getByTestId('attachment-video'))
    expect(await screen.findByTestId('lightbox-video')).toBeTruthy()
  })
})
