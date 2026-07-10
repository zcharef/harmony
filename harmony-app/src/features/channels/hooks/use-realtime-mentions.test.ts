import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { vi } from 'vitest'
import { SSE_EVENT_PREFIX } from '@/hooks/use-server-event'
import type { DmListItem } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { createQueryWrapper, createTestQueryClient } from '@/tests/test-utils'
import { useUnreadStore } from '../stores/unread-store'
import { useRealtimeMentions } from './use-realtime-mentions'

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { logger } = await import('@/lib/logger')

const USER_ID = 'user-me'
const ACTIVE_CHANNEL = 'channel-active'
const OTHER_CHANNEL = 'channel-other'
const DM_SERVER = 'server-dm'
const DM_CHANNEL = 'channel-dm'

function fireSse(eventName: string, payload: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(`${SSE_EVENT_PREFIX}${eventName}`, { detail: payload }))
  })
}

function buildDmList(): DmListItem[] {
  return [
    {
      serverId: DM_SERVER,
      channelId: DM_CHANNEL,
      recipient: { id: 'user-other', username: 'alice' },
    },
  ]
}

function buildDmMessage(overrides: Record<string, unknown> = {}) {
  return {
    senderId: 'user-other',
    serverId: DM_SERVER,
    channelId: DM_CHANNEL,
    message: { messageType: 'default' },
    ...overrides,
  }
}

function renderMentionsHook(activeChannelId: string | null = ACTIVE_CHANNEL) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(queryKeys.dms.list(), buildDmList())
  renderHook(() => useRealtimeMentions(activeChannelId, USER_ID), {
    wrapper: createQueryWrapper(queryClient),
  })
  return queryClient
}

function mentionCount(channelId: string): number {
  return useUnreadStore.getState().mentionCounts[channelId] ?? 0
}

describe('useRealtimeMentions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUnreadStore.setState({ counts: {}, mentionCounts: {} })
  })

  describe('rule 1 — mention.received', () => {
    it('increments the mention count for a non-active channel (SSE-live, no refresh)', () => {
      renderMentionsHook()

      fireSse('mention.received', { channelId: OTHER_CHANNEL })
      fireSse('mention.received', { channelId: OTHER_CHANNEL })

      expect(mentionCount(OTHER_CHANNEL)).toBe(2)
    })

    it('skips the active channel (user sees the message live)', () => {
      renderMentionsHook(ACTIVE_CHANNEL)

      fireSse('mention.received', { channelId: ACTIVE_CHANNEL })

      expect(mentionCount(ACTIVE_CHANNEL)).toBe(0)
    })

    it('warns and changes nothing on a malformed payload (ADR-027)', () => {
      renderMentionsHook()

      fireSse('mention.received', { nope: true })

      expect(logger.warn).toHaveBeenCalledWith(
        'malformed_mention_received_event',
        expect.objectContaining({ error: expect.any(String) }),
      )
      expect(useUnreadStore.getState().mentionCounts).toEqual({})
    })
  })

  describe('rule 2 — DM mention-equivalence via message.created', () => {
    it('increments for a DM message WITHOUT the current user in mentions', () => {
      renderMentionsHook()

      fireSse('message.created', buildDmMessage())

      expect(mentionCount(DM_CHANNEL)).toBe(1)
    })

    it('does NOT increment for a DM message WITH the current user in mentions (rule 1 owns it)', () => {
      renderMentionsHook()

      fireSse(
        'message.created',
        buildDmMessage({
          message: { messageType: 'default', mentions: [{ userId: USER_ID }] },
        }),
      )

      expect(mentionCount(DM_CHANNEL)).toBe(0)
    })

    it('never increments for a non-DM server message', () => {
      renderMentionsHook()

      fireSse('message.created', buildDmMessage({ serverId: 'server-regular' }))

      expect(useUnreadStore.getState().mentionCounts).toEqual({})
    })

    it('skips DM system messages', () => {
      renderMentionsHook()

      fireSse('message.created', buildDmMessage({ message: { messageType: 'system' } }))

      expect(mentionCount(DM_CHANNEL)).toBe(0)
    })

    it('skips the active DM channel', () => {
      renderMentionsHook(DM_CHANNEL)

      fireSse('message.created', buildDmMessage())

      expect(mentionCount(DM_CHANNEL)).toBe(0)
    })

    it('warns and changes nothing on a malformed payload (ADR-027)', () => {
      renderMentionsHook()

      fireSse('message.created', { serverId: DM_SERVER })

      expect(logger.warn).toHaveBeenCalledWith(
        'malformed_message_created_for_mentions',
        expect.objectContaining({ error: expect.any(String) }),
      )
      expect(useUnreadStore.getState().mentionCounts).toEqual({})
    })
  })

  describe('channel.deleted cleanup', () => {
    it('clears both counts for the deleted channel', () => {
      renderMentionsHook()
      act(() => {
        useUnreadStore.getState().increment(OTHER_CHANNEL)
        useUnreadStore.getState().incrementMention(OTHER_CHANNEL)
      })

      fireSse('channel.deleted', { channelId: OTHER_CHANNEL })

      expect(useUnreadStore.getState().counts[OTHER_CHANNEL]).toBe(0)
      expect(mentionCount(OTHER_CHANNEL)).toBe(0)
    })
  })
})
