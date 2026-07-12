import { QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper } from '@/tests/test-utils'
import type { VirtualItem } from '../lib/build-virtual-items'
import { useJumpToMessage } from './use-jump-to-message'

// The hook talks to the generated SDK, the toast facade, the logger and i18n.
// Mock each so the tests assert branch behaviour (scroll vs fetch, which toast)
// without a live API, HeroUI toast host, or bundled translations.
vi.mock('@/lib/api', () => ({ listMessages: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() }, toastApiError: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('react-i18next', () => ({
  // Identity `t` → assert against raw i18n keys.
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { listMessages } = await import('@/lib/api')
const { toast } = await import('@/lib/toast')

const CHANNEL_ID = 'chan-1'
// The around page body is opaque to the hook — it only forwards it into the
// cache — so any object stands in for a real MessageListResponse.
const AROUND_PAGE = { items: [], total: 0, nextCursor: '2026-01-01T00:00:00Z' }

// The hook reads only `msg.id`; a bare id satisfies the row shape it inspects.
function messageItem(id: string): VirtualItem {
  return { type: 'message', msg: { id } as never, isGrouped: false }
}

function setup(initialItems: VirtualItem[]) {
  const scrollToIndex = vi.fn()
  // The hook only calls `scrollToIndex`; a stub with that method is enough.
  const virtualizer = { scrollToIndex } as never
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = createQueryWrapper(queryClient)
  const utils = renderHook(
    (props: { virtualItems: VirtualItem[] }) =>
      useJumpToMessage({
        channelId: CHANNEL_ID,
        virtualItems: props.virtualItems,
        virtualizer,
      }),
    { wrapper, initialProps: { virtualItems: initialItems } },
  )
  return { ...utils, scrollToIndex, queryClient }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useJumpToMessage', () => {
  it('scrolls to an already-loaded target and flashes it without fetching', async () => {
    const { result, scrollToIndex } = setup([messageItem('m1')])

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })

    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: 'center' })
    expect(result.current.flashMessageId).toBe('m1')
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('fetches the window around an unloaded target, resets the cache, then scrolls once it renders', async () => {
    vi.mocked(listMessages).mockResolvedValue({ data: AROUND_PAGE } as never)
    const { result, rerender, scrollToIndex, queryClient } = setup([])
    const setQueryData = vi.spyOn(queryClient, 'setQueryData')

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })

    expect(listMessages).toHaveBeenCalledWith({
      path: { id: CHANNEL_ID },
      query: { around: 'm1', limit: 50 },
      throwOnError: true,
    })
    // Cache is reset to a single around-page (not merged) so the virtualizer
    // stays contiguous and the target is guaranteed present.
    expect(setQueryData).toHaveBeenCalledWith(queryKeys.messages.byChannel(CHANNEL_ID), {
      pages: [AROUND_PAGE],
      pageParams: [undefined],
    })
    // The target isn't in the current rows yet, so no scroll has happened.
    expect(scrollToIndex).not.toHaveBeenCalled()

    // The infinite query re-renders with the around-page; the target now exists.
    await act(async () => {
      rerender({ virtualItems: [messageItem('m1')] })
    })

    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: 'center' })
    await waitFor(() => {
      expect(result.current.flashMessageId).toBe('m1')
    })
  })

  it('shows the target-gone toast and never mutates the cache on 404', async () => {
    vi.mocked(listMessages).mockRejectedValue({ status: 404, detail: 'gone' })
    const { result, queryClient } = setup([])
    const setQueryData = vi.spyOn(queryClient, 'setQueryData')

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })

    expect(toast.error).toHaveBeenCalledWith('chat:jumpTargetGone')
    expect(setQueryData).not.toHaveBeenCalled()
  })

  it('shows the target-gone toast on 403 (lost access)', async () => {
    vi.mocked(listMessages).mockRejectedValue({ status: 403, detail: 'forbidden' })
    const { result } = setup([])

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })

    expect(toast.error).toHaveBeenCalledWith('chat:jumpTargetGone')
  })

  it('shows the network-error toast on a 5xx', async () => {
    vi.mocked(listMessages).mockRejectedValue({ status: 500, detail: 'boom' })
    const { result } = setup([])

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })

    expect(toast.error).toHaveBeenCalledWith('common:networkError')
  })

  it('shows the network-error toast on a non-ProblemDetails failure', async () => {
    vi.mocked(listMessages).mockRejectedValue(new Error('offline'))
    const { result } = setup([])

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })

    expect(toast.error).toHaveBeenCalledWith('common:networkError')
  })

  it('ignores a second jump while a previous around-target is still pending', async () => {
    vi.mocked(listMessages).mockResolvedValue({ data: AROUND_PAGE } as never)
    // The target never enters virtualItems, so the pending guard stays armed.
    const { result } = setup([])

    await act(async () => {
      await result.current.jumpToMessage('m1')
    })
    expect(listMessages).toHaveBeenCalledTimes(1)

    // A concurrent jump before the first target renders must be dropped, not
    // overwrite the pending target with a second fetch.
    await act(async () => {
      await result.current.jumpToMessage('m2')
    })
    expect(listMessages).toHaveBeenCalledTimes(1)
  })
})
