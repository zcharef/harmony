import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { z } from 'zod'
import { useServerEvent } from '@/hooks/use-server-event'
import type {
  DmListItem,
  MemberListResponse,
  MessageListResponse,
  ProfileResponse,
} from '@/lib/api'
import { logger } from '@/lib/logger'
import { queryKeys } from '@/lib/query-keys'

/**
 * WHY local schema: use-fetch-sse already validates the full discriminated
 * union via serverEventSchema. This local schema validates only the subset of
 * fields needed for cache mutation, mirroring the pattern in
 * use-realtime-messages / use-realtime-members.
 *
 * The three identity fields are a FULL snapshot (`null` = cleared), so we
 * coerce them to `string | null` and write them verbatim into every cache.
 */
const profileUpdatedSchema = z.object({
  userId: z.string(),
  displayName: z.string().optional().nullable(),
  avatarUrl: z.string().optional().nullable(),
  customStatus: z.string().optional().nullable(),
})

/** The subject's new identity, normalized so cleared fields are `null`. */
interface Identity {
  userId: string
  displayName: string | null
  avatarUrl: string | null
  customStatus: string | null
}

// ── Cache patchers (module-level so the hook stays under Biome's complexity cap) ──

/**
 * Member lists across every cached server. The member-list key is
 * ['servers', serverId, 'members'] — serverId sits in the middle, so there is
 * no narrower shared prefix. We match the `servers` prefix, then keep only the
 * member-list caches (key[2] === 'members'). The per-server `nickname` is left
 * untouched — it outranks the account display name.
 */
function patchMemberLists(queryClient: QueryClient, id: Identity) {
  for (const [key, data] of queryClient.getQueriesData<MemberListResponse>({
    queryKey: queryKeys.servers.all,
  })) {
    if (key[2] !== 'members' || data === undefined) continue
    if (!data.items.some((m) => m.userId === id.userId)) continue

    queryClient.setQueryData<MemberListResponse>(key, (old) => {
      if (old === undefined) return old
      return {
        ...old,
        items: old.items.map((m) =>
          m.userId === id.userId
            ? { ...m, displayName: id.displayName, avatarUrl: id.avatarUrl }
            : m,
        ),
      }
    })
  }
}

/** DM list (covers the active-DM header, which derives from this cache). */
function patchDmList(queryClient: QueryClient, id: Identity) {
  queryClient.setQueryData<DmListItem[]>(queryKeys.dms.list(), (old) => {
    if (old === undefined) return old
    let changed = false
    const next = old.map((dm) => {
      if (dm.recipient.id !== id.userId) return dm
      changed = true
      return {
        ...dm,
        recipient: { ...dm.recipient, displayName: id.displayName, avatarUrl: id.avatarUrl },
      }
    })
    return changed ? next : old
  })
}

/** Message pages across every cached channel (key ['messages', 'channel', id]). */
function patchMessagePages(queryClient: QueryClient, id: Identity) {
  for (const [key, data] of queryClient.getQueriesData<InfiniteData<MessageListResponse>>({
    queryKey: queryKeys.messages.all,
  })) {
    if (key[1] !== 'channel' || data === undefined) continue
    if (!data.pages.some((p) => p.items.some((m) => m.authorId === id.userId))) continue

    queryClient.setQueryData<InfiniteData<MessageListResponse>>(key, (old) => {
      if (old === undefined) return old
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.map((m) =>
            m.authorId === id.userId
              ? { ...m, authorDisplayName: id.displayName, authorAvatarUrl: id.avatarUrl }
              : m,
          ),
        })),
      }
    })
  }
}

/**
 * Own profile (multi-tab sync). WHY also customStatus: the profiles.me cache is
 * the only one that carries it — member/DM/message shapes have no such field.
 */
function patchOwnProfile(queryClient: QueryClient, id: Identity) {
  queryClient.setQueryData<ProfileResponse>(queryKeys.profiles.me(), (old) => {
    if (old === undefined) return old
    return {
      ...old,
      displayName: id.displayName,
      avatarUrl: id.avatarUrl,
      customStatus: id.customStatus,
    }
  })
}

/**
 * Live rehydration of a user's identity (display name / avatar / custom status)
 * everywhere it is cached — Discord-style. On `profile.updated` (delivered only
 * to users sharing a server or DM with the subject, plus the subject's own
 * tabs), this patches every identity cache via `setQueryData` (never
 * `invalidateQueries`, per CLAUDE.md §4.5) so the UI updates without a refetch:
 * member lists, the DM list, message pages, and — for the current user — the
 * own-profile cache.
 *
 * WHY mounted in MainLayout (§4.6): it must survive DM/server view switches.
 */
export function useRealtimeProfile(currentUserId: string | null) {
  const queryClient = useQueryClient()

  const handleProfileUpdated = useCallback(
    (payload: unknown) => {
      const parsed = profileUpdatedSchema.safeParse(payload)
      if (!parsed.success) {
        logger.error('Malformed profile.updated SSE payload', {
          error: parsed.error.message,
        })
        return
      }

      const id: Identity = {
        userId: parsed.data.userId,
        displayName: parsed.data.displayName ?? null,
        avatarUrl: parsed.data.avatarUrl ?? null,
        customStatus: parsed.data.customStatus ?? null,
      }

      patchMemberLists(queryClient, id)
      patchDmList(queryClient, id)
      patchMessagePages(queryClient, id)

      // WHY guard: only the current user's own-profile cache should track this.
      if (currentUserId !== null && id.userId === currentUserId) {
        patchOwnProfile(queryClient, id)
      }
    },
    [queryClient, currentUserId],
  )

  useServerEvent('profile.updated', handleProfileUpdated)
}
