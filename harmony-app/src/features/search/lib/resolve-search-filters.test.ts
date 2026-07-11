import type { ChannelResponse, MemberResponse } from '@/lib/api'
import { parseSearchQuery } from './parse-search-query'
import { resolveSearchFilters } from './resolve-search-filters'

function member(over: Partial<MemberResponse>): MemberResponse {
  return {
    userId: 'u-default',
    username: 'user',
    displayName: null,
    nickname: null,
    avatarUrl: null,
    role: 'member',
    isFounding: false,
    joinedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function channel(over: Partial<ChannelResponse>): ChannelResponse {
  return {
    id: 'c-default',
    serverId: 's1',
    name: 'general',
    channelType: 'text',
    position: 0,
    isPrivate: false,
    isReadOnly: false,
    encrypted: false,
    slowModeSeconds: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const members: MemberResponse[] = [
  member({ userId: 'u-alice', username: 'alice', displayName: 'Alice Doe' }),
  member({ userId: 'u-bob', username: 'bob', displayName: 'Bobby' }),
]
const channels: ChannelResponse[] = [
  channel({ id: 'c-gen', name: 'general' }),
  channel({ id: 'c-rand', name: 'random' }),
]

describe('resolveSearchFilters', () => {
  it('resolves from: against username or display name', () => {
    const byUsername = resolveSearchFilters(parseSearchQuery('from:@alice hi'), members, channels)
    expect(byUsername.authorId).toBe('u-alice')
    expect(byUsername.unresolved.from).toBeUndefined()

    const byDisplay = resolveSearchFilters(parseSearchQuery('from:Bobby hi'), members, channels)
    expect(byDisplay.authorId).toBe('u-bob')
  })

  it('resolves in: against a channel name', () => {
    const resolved = resolveSearchFilters(parseSearchQuery('in:#random hi'), members, channels)
    expect(resolved.channelId).toBe('c-rand')
    expect(resolved.unresolved.in).toBeUndefined()
  })

  it('returns unresolved tokens (never as free text) when nothing matches', () => {
    const resolved = resolveSearchFilters(
      parseSearchQuery('from:@nobody in:#ghost hi'),
      members,
      channels,
    )
    expect(resolved.authorId).toBeUndefined()
    expect(resolved.channelId).toBeUndefined()
    expect(resolved.unresolved).toEqual({ from: 'nobody', in: 'ghost' })
  })

  it('matches names case-insensitively', () => {
    const resolved = resolveSearchFilters(
      parseSearchQuery('from:ALICE in:#GENERAL'),
      members,
      channels,
    )
    expect(resolved.authorId).toBe('u-alice')
    expect(resolved.channelId).toBe('c-gen')
  })

  it('leaves both filters empty when the query has none', () => {
    const resolved = resolveSearchFilters(parseSearchQuery('just text'), members, channels)
    expect(resolved).toEqual({ unresolved: {} })
  })
})
