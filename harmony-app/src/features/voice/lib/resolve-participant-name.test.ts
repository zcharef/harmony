import { describe, expect, it } from 'vitest'
import type { MemberResponse } from '@/lib/api'
import { resolveParticipantAvatarUrl, resolveParticipantName } from './resolve-participant-name'

const UNKNOWN = 'Unknown user'
const USER_ID = '4f5b8a3e-9c2d-4e1f-8a7b-6c5d4e3f2a1b'
const CAROL_ID = 'd4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80'

const members: MemberResponse[] = [
  {
    userId: USER_ID,
    username: 'alice',
    nickname: 'Ali',
    avatarUrl: 'https://cdn.example.com/alice.webp',
    role: 'member',
    joinedAt: '2026-03-01T00:00:00Z',
  },
  {
    userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    username: 'bob',
    nickname: null,
    role: 'member',
    joinedAt: '2026-03-02T00:00:00Z',
  },
  {
    userId: CAROL_ID,
    username: 'carol',
    nickname: null,
    displayName: 'Carol Danvers',
    role: 'member',
    joinedAt: '2026-03-03T00:00:00Z',
  },
]

describe('resolveParticipantName', () => {
  it('returns displayName when non-empty', () => {
    const result = resolveParticipantName({ userId: USER_ID, displayName: 'Ali' }, members, UNKNOWN)
    expect(result).toBe('Ali')
  })

  it('prefers displayName over the member list', () => {
    const result = resolveParticipantName(
      { userId: USER_ID, displayName: 'FromServer' },
      members,
      UNKNOWN,
    )
    expect(result).toBe('FromServer')
  })

  it('resolves nickname from the member list when displayName is empty', () => {
    const result = resolveParticipantName({ userId: USER_ID, displayName: '' }, members, UNKNOWN)
    expect(result).toBe('Ali')
  })

  it('falls back to username when the member has no nickname', () => {
    const result = resolveParticipantName(
      { userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', displayName: '' },
      members,
      UNKNOWN,
    )
    expect(result).toBe('bob')
  })

  it('resolves the account displayName when the member has no nickname', () => {
    // WHY: Shared resolver adds the displayName tier between nickname and username.
    const result = resolveParticipantName({ userId: CAROL_ID, displayName: '' }, members, UNKNOWN)
    expect(result).toBe('Carol Danvers')
  })

  it('returns the neutral placeholder when the user is not in the member list', () => {
    const strangerId = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'
    const result = resolveParticipantName({ userId: strangerId, displayName: '' }, members, UNKNOWN)
    expect(result).toBe(UNKNOWN)
  })

  it('returns the neutral placeholder when the member list is undefined', () => {
    const result = resolveParticipantName({ userId: USER_ID, displayName: '' }, undefined, UNKNOWN)
    expect(result).toBe(UNKNOWN)
  })

  it('never returns the raw userId as a display value', () => {
    // WHY regression: the previous implementation rendered participant.userId
    // (a raw UUID) when displayName was empty.
    const result = resolveParticipantName({ userId: USER_ID, displayName: '' }, undefined, UNKNOWN)
    expect(result).not.toBe(USER_ID)
    expect(result).not.toContain(USER_ID.slice(0, 8))
  })
})

describe('resolveParticipantAvatarUrl', () => {
  it('resolves the avatar URL from the member cache', () => {
    expect(resolveParticipantAvatarUrl({ userId: USER_ID }, members)).toBe(
      'https://cdn.example.com/alice.webp',
    )
  })

  it('returns undefined when the member has no avatar', () => {
    expect(
      resolveParticipantAvatarUrl({ userId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e' }, members),
    ).toBeUndefined()
  })

  it('returns undefined when the user is not in the member cache', () => {
    const strangerId = 'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f'
    expect(resolveParticipantAvatarUrl({ userId: strangerId }, members)).toBeUndefined()
  })

  it('returns undefined when the member list is undefined', () => {
    expect(resolveParticipantAvatarUrl({ userId: USER_ID }, undefined)).toBeUndefined()
  })
})
