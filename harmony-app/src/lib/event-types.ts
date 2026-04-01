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
import type { ChannelType, UserStatus } from '@/lib/api'

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
  'server.updated',
  'dm.created',
  'typing.started',
  'presence.changed',
  'reaction.added',
  'reaction.removed',
  'force.disconnect',
] as const

export type SseEventName = (typeof SSE_EVENT_NAMES)[number]

// ── Zod schemas for payload structs ──────────────────────────────────
// WHY: Separate payload schemas enable reuse across event variants and
// keep the discriminated union schema readable.

const messagePayloadSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  content: z.string(),
  authorId: z.string(),
  authorUsername: z.string(),
  authorAvatarUrl: z.string().nullable(),
  encrypted: z.boolean(),
  senderDeviceId: z.string().nullable(),
  editedAt: z.string().nullable(),
  parentMessageId: z.string().nullable().optional(),
  createdAt: z.string(),
})

const memberPayloadSchema = z.object({
  userId: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  nickname: z.string().nullable(),
  role: z.string(),
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
  channelType: z.enum(['text', 'voice'] satisfies [ChannelType, ...ChannelType[]]),
  position: z.number(),
  isPrivate: z.boolean(),
  isReadOnly: z.boolean(),
  encrypted: z.boolean(),
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

const userStatusSchema = z.enum(['online', 'idle', 'dnd', 'offline'] satisfies [
  UserStatus,
  ...UserStatus[],
])

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

  // Server
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

  // Ephemeral
  z.object({
    type: z.literal('typingStarted'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    username: z.string(),
  }),
  z.object({
    type: z.literal('presenceChanged'),
    senderId: z.string(),
    userId: z.string(),
    status: userStatusSchema,
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
  }),
  z.object({
    type: z.literal('reactionRemoved'),
    senderId: z.string(),
    serverId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
    emoji: z.string(),
    userId: z.string(),
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
