import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NAVIGATE_EVENT, navigateDetailSchema } from '@/lib/navigation-events'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/platform', () => ({
  isTauri: vi.fn(() => false),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
}))

const { logger } = await import('@/lib/logger')
const { isTauri } = await import('@/lib/platform')
const { sendNotification } = await import('@tauri-apps/plugin-notification')
const { consumeRecentTauriTarget, sendPlatformNotification, TAURI_CLICK_WINDOW_MS } = await import(
  './notifications-adapter'
)

const OUTGOING = {
  title: 'alice',
  body: 'hello world',
  tag: 'channel:channel-1',
  target: { serverId: 'server-1', channelId: 'channel-1' },
}

/** Minimal Notification constructor stub recording instances. */
function installNotificationStub(options: { permission?: string; throws?: boolean } = {}) {
  const instances: Array<{
    title: string
    options: Record<string, unknown>
    close: ReturnType<typeof vi.fn>
    onclick: (() => void) | null
  }> = []

  class NotificationStub {
    static permission = options.permission ?? 'granted'
    title: string
    options: Record<string, unknown>
    close = vi.fn()
    onclick: (() => void) | null = null

    constructor(title: string, opts: Record<string, unknown>) {
      if (options.throws === true) throw new Error('constructor exploded')
      this.title = title
      this.options = opts
      instances.push(this)
    }
  }

  vi.stubGlobal('Notification', NotificationStub)
  return instances
}

describe('sendPlatformNotification (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauri).mockReturnValue(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('constructs a Notification with tag and silent: true', async () => {
    const instances = installNotificationStub()

    await sendPlatformNotification(OUTGOING)

    expect(instances).toHaveLength(1)
    expect(instances[0]?.title).toBe('alice')
    expect(instances[0]?.options).toMatchObject({
      body: 'hello world',
      tag: 'channel:channel-1',
      silent: true,
    })
  })

  it('onclick dispatches NAVIGATE_EVENT with a schema-valid detail and closes', async () => {
    const instances = installNotificationStub()
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {})
    const received: unknown[] = []
    const listener = (e: Event) => {
      if (e instanceof CustomEvent) received.push(e.detail)
    }
    window.addEventListener(NAVIGATE_EVENT, listener)

    await sendPlatformNotification(OUTGOING)
    instances[0]?.onclick?.()

    expect(received).toHaveLength(1)
    expect(navigateDetailSchema.safeParse(received[0]).success).toBe(true)
    expect(instances[0]?.close).toHaveBeenCalledOnce()
    expect(focusSpy).toHaveBeenCalledOnce()

    window.removeEventListener(NAVIGATE_EVENT, listener)
    focusSpy.mockRestore()
  })

  it('does not construct when permission is not granted', async () => {
    const instances = installNotificationStub({ permission: 'denied' })

    await sendPlatformNotification(OUTGOING)

    expect(instances).toHaveLength(0)
  })

  it('logs a warning and does not crash when the constructor throws', async () => {
    installNotificationStub({ throws: true })

    await expect(sendPlatformNotification(OUTGOING)).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledWith(
      'notification_send_failed',
      expect.objectContaining({ error: 'constructor exploded' }),
    )
  })
})

describe('sendPlatformNotification (Tauri)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    vi.mocked(isTauri).mockReturnValue(true)
    // Drain any leftover target from a previous test.
    consumeRecentTauriTarget()
  })

  it('delegates to the plugin (title + body only) and records the click target', async () => {
    await sendPlatformNotification(OUTGOING)

    expect(sendNotification).toHaveBeenCalledWith({ title: 'alice', body: 'hello world' })
    expect(consumeRecentTauriTarget()).toEqual({ serverId: 'server-1', channelId: 'channel-1' })
    // Consumed exactly once.
    expect(consumeRecentTauriTarget()).toBeNull()
  })

  it('expires the click target after the focus window', async () => {
    vi.useFakeTimers()
    await sendPlatformNotification(OUTGOING)

    vi.advanceTimersByTime(TAURI_CLICK_WINDOW_MS + 1)
    expect(consumeRecentTauriTarget()).toBeNull()
    vi.useRealTimers()
  })

  it('logs a warning when the plugin send fails', async () => {
    vi.mocked(sendNotification).mockImplementationOnce(() => {
      throw new Error('plugin dead')
    })

    await sendPlatformNotification(OUTGOING)

    expect(logger.warn).toHaveBeenCalledWith(
      'notification_send_failed',
      expect.objectContaining({ error: 'plugin dead' }),
    )
    expect(consumeRecentTauriTarget()).toBeNull()
  })
})
