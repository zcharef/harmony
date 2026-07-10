import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { vi } from 'vitest'
// WHY: side-effect import initializes the real i18n instance so the picker's
// translated labels/placeholders resolve (mirrors message-item.test.tsx).
import '@/lib/i18n'

// WHY: the app tags elements with `data-test`, not the default `data-testid`.
configure({ testIdAttribute: 'data-test' })

import type { GifItem, GifListResponse } from '@/lib/api'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { GifPickerPopover } from './gif-picker-popover'

vi.mock('@/lib/api', () => ({
  trendingGifs: vi.fn(),
  searchGifs: vi.fn(),
}))

const { trendingGifs, searchGifs } = await import('@/lib/api')

function gif(id: string): GifItem {
  return {
    id,
    title: `${id} title`,
    url: `https://static.klipy.com/${id}.gif`,
    previewUrl: `https://static.klipy.com/${id}.webp`,
    width: 100,
    height: 100,
  }
}

function page(items: GifItem[], hasNext = false): GifListResponse {
  return { items, hasNext, page: 1 }
}

function Harness({ onGifSelect }: { onGifSelect: (url: string) => void }) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <GifPickerPopover isOpen={isOpen} onOpenChange={setIsOpen} onGifSelect={onGifSelect}>
      <button type="button" data-test="gif-trigger">
        trigger
      </button>
    </GifPickerPopover>
  )
}

async function renderPicker(onGifSelect = vi.fn()) {
  const wrapper = createQueryWrapper(createTestQueryClient())
  render(<Harness onGifSelect={onGifSelect} />, { wrapper })
  // Open the popover the way a user does — the body (and its hooks) only mount
  // once the popover is open.
  fireEvent.click(screen.getByTestId('gif-trigger'))
  await screen.findByTestId('gif-picker')
  return { onGifSelect }
}

describe('GifPickerPopover', () => {
  beforeEach(() => vi.clearAllMocks())

  it('auto-fetches trending on open and renders the grid', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('t1'), gif('t2')]) } as never)
    await renderPicker()

    await waitFor(() => expect(screen.getAllByTestId('gif-item')).toHaveLength(2))
    expect(trendingGifs).toHaveBeenCalledWith({ query: { page: 1 }, throwOnError: true })
    expect(searchGifs).not.toHaveBeenCalled()
  })

  it('always renders the KLIPY attribution', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('t1')]) } as never)
    await renderPicker()
    const link = await screen.findByTestId('gif-attribution')
    expect(link.textContent).toMatch(/KLIPY/i)
    expect(link.getAttribute('href')).toBe('https://klipy.com')
  })

  it('switches to search when the user types', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('t1')]) } as never)
    vi.mocked(searchGifs).mockResolvedValueOnce({ data: page([gif('s1')]) } as never)
    await renderPicker()

    await screen.findByTestId('gif-grid')
    fireEvent.change(screen.getByTestId('gif-search-input'), { target: { value: 'cats' } })

    await waitFor(() =>
      expect(searchGifs).toHaveBeenCalledWith({
        query: { q: 'cats', page: 1 },
        throwOnError: true,
      }),
    )
  })

  it('shows the empty state for a search with no results', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('t1')]) } as never)
    vi.mocked(searchGifs).mockResolvedValueOnce({ data: page([]) } as never)
    await renderPicker()

    await screen.findByTestId('gif-grid')
    fireEvent.change(screen.getByTestId('gif-search-input'), { target: { value: 'zzzzz' } })

    // findBy throws on timeout, so reaching the next line is the assertion.
    await screen.findByTestId('gif-empty')
  })

  it('shows an inline error with a retry button when trending fails', async () => {
    vi.mocked(trendingGifs).mockRejectedValueOnce({ status: 502, detail: 'down' })
    await renderPicker()

    await screen.findByTestId('gif-error')
    screen.getByTestId('gif-retry')
  })

  it('calls onGifSelect with the hosted URL when a GIF is clicked', async () => {
    vi.mocked(trendingGifs).mockResolvedValueOnce({ data: page([gif('pick')]) } as never)
    const { onGifSelect } = await renderPicker()

    const item = await screen.findByTestId('gif-item')
    fireEvent.click(item)
    expect(onGifSelect).toHaveBeenCalledWith('https://static.klipy.com/pick.gif')
  })
})
