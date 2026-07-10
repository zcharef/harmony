/**
 * Server-Sent Event type definitions — mirrors the Rust `ServerEvent` enum.
 *
 * WHY: The SSE endpoint (`GET /v1/events`) sends events with:
 * - `event:` field = dot-separated name (e.g., `message.created`)
 * - `data:` field = JSON with `"type"` discriminator tag (e.g., `"messageCreated"`)
 *
 * Source of truth: harmony-api/src/domain/models/server_event.rs
 * Serde config: `#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]`
 *
 * WHY Zod: SSE payloads are external data from an event stream. CLAUDE.md §1.2
 * mandates Zod validation for all external data. Without it, a malformed event
 * would produce a corrupt object silently dispatched to handlers.
 */

import { z } from 'zod'
import { zChannelType, zMessageType, zUserStatus, zVoiceAction } from '@/lib/api/zod.gen'

// ── SSE event names (dot-separated, as sent in the `event:` field) ───

export const SSE_EVENT_NAMES = [
  'message.created',
  'message.updated',
  'message.deleted',
  'member.joined',
  'member.removed',
  'member.banned',
  'member.role_updated',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'channel.access_updated',
  'server.moderation_settings_updated',
  'server.updated',
  'dm.created',
  'profile.updated',
  'typing.started',
  'presence.changed',
  'presence.sync',
  'unread.sync',
  'reaction.added',
  'reaction.removed',
  'mention.received',
  'voice.state_update',
  'force.disconnect',
] as const

export type SseEventName = (typeof SSE_EVENT_NAMES)[number]

// ── Zod schemas for payload structs ──────────────────────────────────
// WHY: Separate payload schemas enable reuse across event variants and
// keep the discriminated union schema readable.

export const messagePayloadSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  content: z.string(),
  authorId: z.string(),
  authorUsername: z.string(),
  // WHY optional: older API instances omit the field during rollout.
  authorDisplayName: z.string().optional().nullable(),
  authorAvatarUrl: z.string().nullable(),
  encrypted: z.boolean(),
  senderDeviceId: z.string().nullable(),
  editedAt: z.string().nullable(),
  parentMessageId: z.string().nullable().optional(),
  messageType: zMessageType,
  systemEventKey: z.string().nullable().optional(),
  moderatedAt: z.string().nullable().optional(),
  moderationReason: z.string().nullable().optional(),
  // WHY optional: older API instances omit the field during rollout (spec §4.4).
  mentions: z
    .array(
      z.object({
        userId: z.string(),
        username: z.string(),
        displayName: z.string().nullable().optional(),
        nickname: z.string().nullable().optional(),
      }),
    )
    .optional(),
  // WHY optional: older API instances omit the field during rollout
  // (attachments T1.3 — same rollout contract as `mentions`).
  attachments: z
    .array(
      z.object({
        id: z.string(),
        url: z.string(),
        mime: z.string(),
        size: z.number(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
      }),
    )
    .optional(),
  createdAt: z.string(),
})

const memberPayloadSchema = z.object({
  userId: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  nickname: z.string().nullable(),
  role: z.string(),
  // WHY optional: rollout-safe — an event minted by a pre-deploy API instance
  // omits it; the cache handler defaults it to false until the next refetch.
  isFounding: z.boolean().optional(),
  joinedAt: z.string(),
})

const banPayloadSchema = z.object({
  reason: z.string().nullable(),
  bannedBy: z.string().nullable(),
  createdAt: z.string(),
})

const channelPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.string().nullable().optional(),
  channelType: zChannelType,
  position: z.number(),
  isPrivate: z.boolean(),
  isReadOnly: z.boolean(),
  encrypted: z.boolean(),
  slowModeSeconds: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const serverPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  iconUrl: z.string().nullable(),
  ownerId: z.string(),
})

const dmPayloadSchema = z.object({
  serverId: z.string(),
  channelId: z.string(),
  otherUserId: z.string(),
  otherUsername: z.string(),
  otherDisplayName: z.string().nullable(),
  otherAvatarUrl: z.string().nullable(),
})

const userStatusSchema = zUserStatus

// ── Discriminated union schema ───────────────────────────────────────
// WHY: The Rust enum serializes with `"type"` as the discriminator field.
// z.discriminatedUnion validates the correct payload shape per event type.

export const serverEventSchema = z.discriminatedUnion('type', [
  // Messages
  z.object({
    type: z.literal('messageCreated'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    message: messagePayloadSchema,
  }),
  z.object({
    type: z.literal('messageUpdated'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    message: messagePayloadSchema,
  }),
  z.object({
    type: z.literal('messageDeleted'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
    deletedBy: z.string().optional(),
  }),

  // Members
  z.object({
    type: z.literal('memberJoined'),
    senderId: z.string(),
    serverId: z.string(),
    member: memberPayloadSchema,
  }),
  z.object({
    type: z.literal('memberRemoved'),
    senderId: z.string(),
    serverId: z.string(),
    userId: z.string(),
  }),
  z.object({
    type: z.literal('memberBanned'),
    senderId: z.string(),
    serverId: z.string(),
    targetUserId: z.string(),
    ban: banPayloadSchema,
  }),
  z.object({
    type: z.literal('memberRoleUpdated'),
    senderId: z.string(),
    serverId: z.string(),
    member: memberPayloadSchema,
  }),

  // Channels
  z.object({
    type: z.literal('channelCreated'),
    senderId: z.string(),
    serverId: z.string(),
    channel: channelPayloadSchema,
  }),
  z.object({
    type: z.literal('channelUpdated'),
    senderId: z.string(),
    serverId: z.string(),
    channel: channelPayloadSchema,
  }),
  z.object({
    type: z.literal('channelDeleted'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
  }),
  // WHY only moderator/member: admin/owner hold implicit access and are never
  // stored as grants, so the wire set is bounded to the two grantable roles.
  z.object({
    type: z.literal('channelAccessUpdated'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    authorizedRoles: z.array(z.enum(['moderator', 'member'])),
  }),

  // Server
  z.object({
    type: z.literal('moderationSettingsUpdated'),
    senderId: z.string(),
    serverId: z.string(),
    categories: z.record(z.string(), z.boolean()),
  }),
  z.object({
    type: z.literal('serverUpdated'),
    senderId: z.string(),
    serverId: z.string(),
    server: serverPayloadSchema,
  }),

  // DMs
  z.object({
    type: z.literal('dmCreated'),
    senderId: z.string(),
    targetUserId: z.string(),
    dm: dmPayloadSchema,
  }),

  // Profiles — live identity rehydration (display name / avatar / custom status
  // / bio / banner). WHY optional+nullable: the fields are a FULL snapshot, so
  // `null` means cleared; older API instances may omit a field during a rolling
  // deploy.
  z.object({
    type: z.literal('profileUpdated'),
    senderId: z.string(),
    userId: z.string(),
    displayName: z.string().optional().nullable(),
    avatarUrl: z.string().optional().nullable(),
    customStatus: z.string().optional().nullable(),
    bio: z.string().optional().nullable(),
    bannerUrl: z.string().optional().nullable(),
  }),

  // Ephemeral
  z.object({
    type: z.literal('typingStarted'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    username: z.string(),
    // WHY optional+nullable: resolved display name for the typing indicator;
    // omitted by older API instances during a rolling deploy.
    displayName: z.string().optional().nullable(),
  }),
  z.object({
    type: z.literal('presenceChanged'),
    senderId: z.string(),
    userId: z.string(),
    status: userStatusSchema,
  }),
  // WHY: Per-connection synthetic event (not broadcast). Server sends this as
  // the first SSE event on connect with a full snapshot of online users across
  // the user's servers. Handles both initial connect and reconnect.
  z.object({
    type: z.literal('presenceSynced'),
    users: z.record(z.string(), userStatusSchema),
  }),
  // WHY: Per-connection synthetic event (not broadcast). Server sends this as
  // the second SSE event on connect with a full snapshot of unread counts across
  // all channels the user has unread messages in. Handles both initial connect
  // and reconnect. Same pattern as presenceSynced.
  z.object({
    type: z.literal('unreadSynced'),
    channels: z.record(z.string(), z.number()),
    // WHY optional: older API instances omit the mentions map during rollout.
    mentions: z.record(z.string(), z.number()).optional(),
  }),

  // Reactions
  z.object({
    type: z.literal('reactionAdded'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
    emoji: z.string(),
    userId: z.string(),
    username: z.string(),
    // WHY nullish: the reactor's display name is omitted when unset (older API
    // instances never send it). Lets the "who reacted" list patch live.
    displayName: z.string().nullish(),
  }),
  z.object({
    type: z.literal('reactionRemoved'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
    emoji: z.string(),
    userId: z.string(),
    // WHY: the "who reacted" list is keyed by username, so removal needs it to
    // drop the matching entry.
    username: z.string(),
  }),

  // Mentions (user-targeted)
  z.object({
    type: z.literal('mentionReceived'),
    senderId: z.string(),
    targetUserId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
  }),

  // Voice
  z.object({
    type: z.literal('voiceStateUpdate'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string().uuid(),
    userId: z.string().uuid(),
    action: zVoiceAction,
    displayName: z.string(),
    isMuted: z.boolean().optional(),
    isDeafened: z.boolean().optional(),
  }),

  // System
  z.object({
    type: z.literal('forceDisconnect'),
    senderId: z.string(),
    serverId: z.string(),
    targetUserId: z.string(),
    reason: z.string(),
  }),
])

// ── Derived TypeScript types ─────────────────────────────────────────

export type ServerEvent = z.infer<typeof serverEventSchema>

/** Extract a single event variant by its `type` discriminator. */
export type ServerEventOf<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>

// ── Payload types (inferred from Zod, not manually defined) ──────────

export type MessagePayload = z.infer<typeof messagePayloadSchema>
export type MemberPayload = z.infer<typeof memberPayloadSchema>
export type BanPayload = z.infer<typeof banPayloadSchema>
export type ChannelPayload = z.infer<typeof channelPayloadSchema>
export type ServerPayload = z.infer<typeof serverPayloadSchema>
export type DmPayload = z.infer<typeof dmPayloadSchema>
