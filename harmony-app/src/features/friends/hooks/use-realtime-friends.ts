import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { usePresenceStore } from '@/features/presence'
import { useServerEvent } from '@/hooks/use-server-event'
import type { BlockedUserResponse, FriendRequestResponse, FriendResponse } from '@/lib/api'
import { friendPayloadSchema, friendRequestPayloadSchema } from '@/lib/event-types'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'
import { useBlocks } from './use-blocks'
import { useFriendRequests } from './use-friend-requests'
import { useFriends } from './use-friends'

const requestEventSchema = z.object({ request: friendRequestPayloadSchema })
const friendEventSchema = z.object({ friend: friendPayloadSchema })
const userIdEventSchema = z.object({ userId: z.string() })

function toFriend(friend: z.infer<typeof friendPayloadSchema>): FriendResponse {
  return {
    user: {
      id: friend.userId,
      username: friend.username,
      displayName: friend.displayName ?? undefined,
      avatarUrl: friend.avatarUrl ?? undefined,
    },
    friendsSince: friend.friendsSince,
  }
}

function toRequest(request: z.infer<typeof friendRequestPayloadSchema>): FriendRequestResponse {
  return {
    user: {
      id: request.userId,
      username: request.username,
      displayName: request.displayName ?? undefined,
      avatarUrl: request.avatarUrl ?? undefined,
    },
    direction: request.direction,
    createdAt: request.createdAt,
  }
}

/**
 * Subscribes to the six friend/block SSE events and patches the TanStack Query
 * caches directly (no refetch), mirroring `use-realtime-dms`.
 *
 * WHY it also mounts the three list queries (§5.2, EAGER-MOUNT CONTRACT): every
 * `setQueryData` below no-ops on a cold cache (`if (!old) return`). The
 * ServerList / DmSidebar badges and the context-menu relationship derivation
 * all read these caches, so they must be warm. Mounting them HERE — one place —
 * makes that impossible to forget. Mounted once in `MainLayout` so friends
 * events survive DM-view switches (CLAUDE.md §4.6).
 */
export function useRealtimeFriends() {
  const queryClient = useQueryClient()

  // Eager-mount contract: warm the three (four) list caches.
  useFriends()
  useFriendRequests('incoming')
  useFriendRequests('outgoing')
  useBlocks()

  const listKey = queryKeys.friends.list()
  const incomingKey = queryKeys.friends.requests('incoming')
  const outgoingKey = queryKeys.friends.requests('outgoing')
  const blocksKey = queryKeys.friends.blocks()

  const handleRequestCreated = useCallback(
    (payload: unknown) => {
      const parsed = requestEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('friend_request_created_parse_failed', { error: parsed.error.message })
        return
      }
      const request = toRequest(parsed.data.request)
      const key = request.direction === 'incoming' ? incomingKey : outgoingKey
      queryClient.setQueryData<FriendRequestResponse[]>(key, (old) => {
        if (!old) return old
        if (old.some((r) => r.user.id === request.user.id)) return old
        return [request, ...old] // newest first
      })
    },
    [queryClient, incomingKey, outgoingKey],
  )

  const handleRequestRemoved = useCallback(
    (payload: unknown) => {
      const parsed = userIdEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('friend_request_removed_parse_failed', { error: parsed.error.message })
        return
      }
      const { userId } = parsed.data
      for (const key of [incomingKey, outgoingKey]) {
        queryClient.setQueryData<FriendRequestResponse[]>(key, (old) =>
          old ? old.filter((r) => r.user.id !== userId) : old,
        )
      }
    },
    [queryClient, incomingKey, outgoingKey],
  )

  const handleFriendAdded = useCallback(
    (payload: unknown) => {
      const parsed = friendEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('friend_added_parse_failed', { error: parsed.error.message })
        return
      }
      const { friend } = parsed.data
      const entry = toFriend(friend)

      // Insert + re-sort by username (≤1000 rows is cheap, keeps §1.3 order).
      queryClient.setQueryData<FriendResponse[]>(listKey, (old) => {
        if (!old) return old
        if (old.some((f) => f.user.id === entry.user.id)) return old
        return [...old, entry].sort((a, b) => a.user.username.localeCompare(b.user.username))
      })
      // Drop any matching pending entries in both directions.
      for (const key of [incomingKey, outgoingKey]) {
        queryClient.setQueryData<FriendRequestResponse[]>(key, (old) =>
          old ? old.filter((r) => r.user.id !== entry.user.id) : old,
        )
      }
      // Seed presence so a new friend never renders offline while online (§4.1).
      // Absence = offline, so an offline status needs no write.
      if (friend.status !== 'offline') {
        usePresenceStore.getState().setUserStatus(friend.userId, friend.status)
      }
    },
    [queryClient, listKey, incomingKey, outgoingKey],
  )

  const handleFriendRemoved = useCallback(
    (payload: unknown) => {
      const parsed = userIdEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('friend_removed_parse_failed', { error: parsed.error.message })
        return
      }
      const { userId } = parsed.data
      queryClient.setQueryData<FriendResponse[]>(listKey, (old) =>
        old ? old.filter((f) => f.user.id !== userId) : old,
      )
    },
    [queryClient, listKey],
  )

  const handleBlockCreated = useCallback(
    (payload: unknown) => {
      const parsed = userIdEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('block_created_parse_failed', { error: parsed.error.message })
        return
      }
      // WHY invalidate (not setQueryData): the block payload carries only the id,
      // not the profile the Blocked tab renders — refetch fills it. Friendship /
      // requests / DMs may also have been torn down for the blocker's other tabs.
      queryClient.invalidateQueries({ queryKey: blocksKey })
      queryClient.invalidateQueries({ queryKey: listKey })
      queryClient.invalidateQueries({ queryKey: incomingKey })
      queryClient.invalidateQueries({ queryKey: outgoingKey })
      queryClient.invalidateQueries({ queryKey: queryKeys.dms.all })
    },
    [queryClient, blocksKey, listKey, incomingKey, outgoingKey],
  )

  const handleBlockRemoved = useCallback(
    (payload: unknown) => {
      const parsed = userIdEventSchema.safeParse(payload)
      if (!parsed.success) {
        logger.warn('block_removed_parse_failed', { error: parsed.error.message })
        return
      }
      const { userId } = parsed.data
      queryClient.setQueryData<BlockedUserResponse[]>(blocksKey, (old) =>
        old ? old.filter((b) => b.user.id !== userId) : old,
      )
    },
    [queryClient, blocksKey],
  )

  useServerEvent('friend.request_created', handleRequestCreated)
  useServerEvent('friend.request_removed', handleRequestRemoved)
  useServerEvent('friend.added', handleFriendAdded)
  useServerEvent('friend.removed', handleFriendRemoved)
  useServerEvent('block.created', handleBlockCreated)
  useServerEvent('block.removed', handleBlockRemoved)
}
