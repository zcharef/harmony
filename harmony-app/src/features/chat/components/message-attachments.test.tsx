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
