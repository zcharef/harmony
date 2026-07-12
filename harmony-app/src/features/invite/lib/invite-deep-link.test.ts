import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const deepLinkState = vi.hoisted(() => ({
  currentUrls: null as string[] | null,
  openUrlHandler: null as ((urls: string[]) => void) | null,
}))

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: vi.fn(async () => deepLinkState.currentUrls),
  onOpenUrl: vi.fn(async (handler: (urls: string[]) => void) => {
    deepLinkState.openUrlHandler = handler
    return () => {
      deepLinkState.openUrlHandler = null
    }
  }),
}))

const { listenForInviteDeepLinks, parseInviteDeepLink } = await import('./invite-deep-link')

describe('parseInviteDeepLink', () => {
  it.each([
    ['harmony://invite/abc123', 'abc123'],
    ['harmony://invite/ABCxyz09', 'ABCxyz09'],
    ['harmony://invite/a', 'a'],
    // Trailing slash tolerated (mirrors invite-path.ts).
    ['harmony://invite/abc123/', 'abc123'],
    [`harmony://invite/${'a'.repeat(32)}`, 'a'.repeat(32)],
    // Short /i/ shape — mirrors the /i/ web links.
    ['harmony://i/abc123', 'abc123'],
    ['harmony://i/ABCxyz09', 'ABCxyz09'],
    ['harmony://i/abc123/', 'abc123'],
  ])('accepts %s', (url, code) => {
    expect(parseInviteDeepLink(url)).toBe(code)
  })

  it.each([
    // Wrong scheme / host — must never match.
    ['https://invite/abc123'],
    ['harmony://auth/callback?code=x&state=y'],
    ['harmony://invite'],
    ['harmony://invite/'],
    // Charset violations — codes are strictly alphanumeric.
    ['harmony://invite/abc-123'],
    ['harmony://invite/abc_123'],
    ['harmony://invite/abc%2F123'],
    // No open paths: extra segments and traversal are rejected.
    ['harmony://invite/abc123/extra'],
    ['harmony://invite/../etc'],
    // No query strings or fragments.
    ['harmony://invite/abc123?next=/admin'],
    ['harmony://invite/abc123#frag'],
    // Over-length code.
    [`harmony://invite/${'a'.repeat(33)}`],
    // Short shape stays just as strict — no bare host, no extra segments.
    ['harmony://i'],
    ['harmony://i/'],
    ['harmony://i/abc-123'],
    ['harmony://i/abc123/extra'],
    [`harmony://i/${'a'.repeat(33)}`],
  ])('rejects %s', (url) => {
    expect(parseInviteDeepLink(url)).toBeNull()
  })
})

describe('listenForInviteDeepLinks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deepLinkState.currentUrls = null
    deepLinkState.openUrlHandler = null
  })

  it('fires for a cold-start invite URL from getCurrent()', async () => {
    deepLinkState.currentUrls = ['harmony://invite/cold42']
    const onInvite = vi.fn()

    await listenForInviteDeepLinks(onInvite)

    expect(onInvite).toHaveBeenCalledExactlyOnceWith('cold42')
  })

  it('fires for a warm-start invite URL via onOpenUrl', async () => {
    const onInvite = vi.fn()
    await listenForInviteDeepLinks(onInvite)
    expect(onInvite).not.toHaveBeenCalled()

    deepLinkState.openUrlHandler?.(['harmony://invite/warm42'])

    expect(onInvite).toHaveBeenCalledExactlyOnceWith('warm42')
  })

  it('ignores non-invite URLs (auth callbacks belong to the auth listener)', async () => {
    const onInvite = vi.fn()
    await listenForInviteDeepLinks(onInvite)

    deepLinkState.openUrlHandler?.(['harmony://auth/callback?code=x&state=y'])

    expect(onInvite).not.toHaveBeenCalled()
  })

  it('unsubscribes via the returned cleanup function', async () => {
    const onInvite = vi.fn()
    const unlisten = await listenForInviteDeepLinks(onInvite)

    unlisten()

    expect(deepLinkState.openUrlHandler).toBeNull()
  })
})
