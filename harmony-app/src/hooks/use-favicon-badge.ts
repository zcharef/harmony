import { useEffect, useRef } from 'react'
import { useTotalUnread } from '@/features/channels'
import { logger } from '@/lib/logger'

const CANVAS_SIZE = 32
const DOT_RADIUS = 7
// WHY hardcoded: Canvas 2D context cannot read CSS variables directly.
// getComputedStyle would add runtime complexity for a 7px dot that must
// be universally red regardless of theme. This matches the system red
// used by macOS/iOS notification badges.
const DOT_COLOR = '#ff3b30'
const FAVICON_SRC = '/favicon-96x96.png'

interface SavedLink {
  element: HTMLLinkElement
  originalHref: string
}

// WHY: Extracted to reduce useEffect cognitive complexity below Biome's limit of 15.
function drawBadgedFavicon(img: HTMLImageElement, canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null

  try {
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE)

    const dotX = CANVAS_SIZE - DOT_RADIUS
    const dotY = CANVAS_SIZE - DOT_RADIUS
    ctx.beginPath()
    ctx.arc(dotX, dotY, DOT_RADIUS, 0, 2 * Math.PI)
    ctx.fillStyle = DOT_COLOR
    ctx.fill()

    return canvas.toDataURL('image/png')
  } catch (err: unknown) {
    logger.warn('favicon_badge_draw_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

// WHY: Extracted to reduce useEffect cognitive complexity below Biome's limit of 15.
function applyBadgeDataUrl(
  dataUrl: string,
  savedLinks: SavedLink[],
  badgeLinkRef: React.RefObject<HTMLLinkElement | null>,
) {
  // Suppress other icon links so browser doesn't prefer them
  for (const saved of savedLinks) {
    saved.element.href = ''
  }

  if (badgeLinkRef.current === null) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    document.head.appendChild(link)
    badgeLinkRef.current = link
  }
  badgeLinkRef.current.href = dataUrl
}

// WHY: Extracted to reduce useEffect cognitive complexity below Biome's limit of 15.
function restoreOriginalFavicons(
  savedLinks: SavedLink[],
  badgeLinkRef: React.RefObject<HTMLLinkElement | null>,
) {
  for (const saved of savedLinks) {
    saved.element.href = saved.originalHref
  }
  badgeLinkRef.current?.remove()
  badgeLinkRef.current = null
}

/**
 * Draws a red dot overlay on the favicon when there are unread messages.
 *
 * WHY: A visual badge on the browser tab favicon provides an at-a-glance
 * unread indicator when the user has switched to another tab. Uses PNG
 * source (not SVG) because SVG rendering on canvas is inconsistent across
 * browsers. Manages all <link rel="icon"> tags to prevent the browser from
 * preferring an unchanged one over our canvas-generated badge.
 */
export function useFaviconBadge(): void {
  const totalUnread = useTotalUnread()
  const imgRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const savedLinksRef = useRef<SavedLink[]>([])
  const badgeLinkRef = useRef<HTMLLinkElement | null>(null)

  // WHY: Load the source image and create the canvas once on mount.
  // Also snapshot all existing icon links so we can restore them on cleanup.
  useEffect(() => {
    const img = new Image()
    img.onerror = () => logger.warn('favicon_image_load_failed', { src: FAVICON_SRC })
    img.src = FAVICON_SRC
    imgRef.current = img

    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_SIZE
    canvas.height = CANVAS_SIZE
    canvasRef.current = canvas

    const links = document.querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="shortcut icon"]',
    )
    savedLinksRef.current = Array.from(links).map((el) => ({
      element: el,
      originalHref: el.href,
    }))

    return () => {
      img.onload = null
      img.onerror = null
      restoreOriginalFavicons(savedLinksRef.current, badgeLinkRef)
    }
  }, [])

  // WHY: Redraw the favicon on every totalUnread change. When 0, restore
  // originals. When > 0, draw the favicon + red dot and suppress other links.
  // Uses a `cancelled` flag + cleanup to prevent a stale img.onload callback
  // from re-applying the badge after totalUnread has already dropped to 0.
  useEffect(() => {
    const img = imgRef.current
    const canvas = canvasRef.current
    if (img === null || canvas === null) return

    if (totalUnread === 0) {
      // WHY: Kill any pending onload from a previous effect run that would
      // re-draw the badge after we restore originals.
      img.onload = null
      restoreOriginalFavicons(savedLinksRef.current, badgeLinkRef)
      return
    }

    let cancelled = false

    function applyBadge() {
      if (cancelled || img === null || canvas === null) return
      const dataUrl = drawBadgedFavicon(img, canvas)
      if (dataUrl !== null) {
        applyBadgeDataUrl(dataUrl, savedLinksRef.current, badgeLinkRef)
      }
    }

    if (img.complete) {
      applyBadge()
    } else {
      img.onload = applyBadge
    }

    return () => {
      cancelled = true
      if (img !== null) img.onload = null
    }
  }, [totalUnread])
}
