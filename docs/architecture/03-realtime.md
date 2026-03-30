# Harmony — Real-Time Architecture

> **Chat updates:** Supabase Realtime (Postgres Changes + Broadcast + Presence)
> **Voice/Video:** LiveKit (WebRTC SFU)

---

## 1. Why Supabase Realtime, Not Custom SSE/WebSockets

Supabase Realtime provides the three primitives a chat app needs, battle-tested and production-ready:

| Need | Supabase Feature | Custom SSE Equivalent |
|------|-----------------|----------------------|
| New messages | **Postgres Changes** (listens to INSERT/UPDATE/DELETE, respects RLS) | Custom broadcaster, DashMap, permission filtering |
| Typing indicators | **Broadcast** (ephemeral, no DB writes) | Custom in-memory pub/sub |
| Online status | **Presence** (tracks joins/leaves, conflict resolution) | Custom presence system + heartbeat |
| Auth | JWT-based (same Supabase token) | Custom Bearer token wiring |
| Reconnection | Built-in with exponential backoff | Must implement with polyfill |
| Multi-instance scaling | Built-in (Supabase infra) | Must add Redis Pub/Sub |

**Key principle:** The Rust API handles all **writes** (validation, authorization, business logic). Supabase Realtime handles all **push notifications** (change events, ephemeral broadcasts). The client never writes directly to Supabase.

---

## 2. Architecture

```
WRITES (Client → Rust API → Postgres):
┌──────────────┐     POST /v1/channels/{id}/messages     ┌──────────────┐
│  Tauri App   │ ───────────────────────────────────────► │  Rust API    │
│  (React)     │                                          │  (Axum)      │
└──────────────┘                                          └──────┬───────┘
                                                                 │ INSERT INTO messages
                                                                 ▼
                                                          ┌──────────────┐
                                                          │  Postgres    │
                                                          └──────┬───────┘
                                                                 │
PUSHES (Postgres → Supabase Realtime → Client):                  │ NOTIFY
                                                                 ▼
┌──────────────┐     WebSocket (Supabase Realtime)        ┌──────────────┐
│  Tauri App   │ ◄─────────────────────────────────────── │  Supabase    │
│  (React)     │     message_created event                │  Realtime    │
└──────────────┘                                          └──────────────┘

READS (Client → Rust API → Postgres):
┌──────────────┐     GET /v1/channels/{id}/messages       ┌──────────────┐
│  Tauri App   │ ───────────────────────────────────────► │  Rust API    │
│  (React)     │     Paginated response                   │  (Axum)      │
└──────────────┘ ◄─────────────────────────────────────── └──────────────┘
```

### Why This Split?

- **Writes through Rust API:** Business logic (permission checks, rate limiting, content validation, markdown sanitization) must run server-side. The client cannot INSERT directly into Postgres.
- **Pushes through Supabase Realtime:** Supabase already filters events via RLS policies. No need to build a custom broadcaster. When the Rust API inserts a message, Supabase Realtime automatically pushes it to all authorized subscribers.
- **Reads through Rust API:** Initial data loads, pagination, search, and complex queries go through the API for proper caching headers and response shaping.

---

## 3. Supabase Realtime Channels

### 3.1 Postgres Changes — Message Updates

Subscribe to INSERT/UPDATE/DELETE on the `messages` table, filtered by `channel_id`:

```typescript
// features/chat/hooks/use-realtime-messages.ts

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase-client'
import type { MessageResponse } from '@/lib/api'

export function useRealtimeMessages(channelId: string) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const channel = supabase
      .channel(`messages:${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const message = payload.new as MessageResponse
          // Update TanStack Query cache directly
          queryClient.setQueryData(
            ['messages', channelId],
            (old: { items: MessageResponse[] } | undefined) =>
              old ? { ...old, items: [...old.items, message] } : undefined,
          )
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const updated = payload.new as MessageResponse
          queryClient.setQueryData(
            ['messages', channelId],
            (old: { items: MessageResponse[] } | undefined) =>
              old
                ? {
                    ...old,
                    items: old.items.map((m) => (m.id === updated.id ? updated : m)),
                  }
                : undefined,
          )
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const deletedId = payload.old.id as string
          queryClient.setQueryData(
            ['messages', channelId],
            (old: { items: MessageResponse[] } | undefined) =>
              old
                ? { ...old, items: old.items.filter((m) => m.id !== deletedId) }
                : undefined,
          )
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [channelId, queryClient])
}
```

**RLS Enforcement:** Supabase Realtime respects RLS policies. If a user doesn't have access to a channel (per the `messages_select_member` policy), they won't receive events for it. No server-side filtering code needed.

### 3.2 Broadcast — Typing Indicators

Typing indicators are ephemeral — no database writes, no persistence.

```typescript
// features/chat/hooks/use-typing-indicator.ts

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase-client'

interface TypingUser {
  userId: string
  username: string
}

export function useTypingIndicator(channelId: string, currentUserId: string) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([])
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(() => {
    const channel = supabase.channel(`typing:${channelId}`)

    channel
      .on('broadcast', { event: 'typing' }, (payload) => {
        const user = payload.payload as TypingUser
        if (user.userId === currentUserId) return

        setTypingUsers((prev) => {
          const exists = prev.some((u) => u.userId === user.userId)
          return exists ? prev : [...prev, user]
        })

        // Remove after 5 seconds of no typing event
        setTimeout(() => {
          setTypingUsers((prev) => prev.filter((u) => u.userId !== user.userId))
        }, 5000)
      })
      .subscribe()

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
  }, [channelId, currentUserId])

  // Debounced send (max 1 per 3 seconds)
  const lastSent = useRef(0)
  const sendTyping = useCallback(
    (username: string) => {
      const now = Date.now()
      if (now - lastSent.current < 3000) return
      lastSent.current = now

      channelRef.current?.send({
        type: 'broadcast',
        event: 'typing',
        payload: { userId: currentUserId, username } satisfies TypingUser,
      })
    },
    [currentUserId],
  )

  return { typingUsers, sendTyping }
}
```

### 3.3 Presence — Online Status

```typescript
// features/presence/hooks/use-presence.ts

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase-client'

type UserStatus = 'online' | 'idle' | 'dnd' | 'offline'

interface PresenceState {
  userId: string
  status: UserStatus
  lastSeen: string
}

export function useServerPresence(serverId: string, currentUser: { id: string; username: string }) {
  const [onlineUsers, setOnlineUsers] = useState<Map<string, PresenceState>>(new Map())

  useEffect(() => {
    const channel = supabase.channel(`presence:${serverId}`)

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceState>()
        const users = new Map<string, PresenceState>()
        for (const [, presences] of Object.entries(state)) {
          for (const p of presences) {
            users.set(p.userId, p)
          }
        }
        setOnlineUsers(users)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            userId: currentUser.id,
            status: 'online' as UserStatus,
            lastSeen: new Date().toISOString(),
          } satisfies PresenceState)
        }
      })

    return () => { supabase.removeChannel(channel) }
  }, [serverId, currentUser.id, currentUser.username])

  return onlineUsers
}
```

**Conflict resolution:** Supabase Presence handles multiple tabs/devices automatically. If a user is connected from two devices, both presence entries are tracked and merged.

---

## 4. Supabase Client Setup

The Tauri app uses the Supabase JS SDK for two things only:
1. **Auth** (login/signup/token refresh)
2. **Realtime** (subscriptions)

All data reads/writes go through the Rust API.

```typescript
// lib/supabase-client.ts

import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

export const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
```

**Environment variables** (add to `lib/env.ts`):
```typescript
VITE_SUPABASE_URL: z.string().url(),
VITE_SUPABASE_ANON_KEY: z.string().min(1),
```

---

## 5. Type Safety for Realtime Payloads

Supabase Realtime sends raw Postgres rows. To maintain end-to-end type safety:

1. The Rust API defines the canonical shape via `#[derive(ToSchema)]`
2. The OpenAPI pipeline generates TypeScript types + Zod schemas
3. Realtime payloads are validated against the same Zod schema at the client boundary

```typescript
// lib/realtime-validators.ts

import { messageResponseSchema } from '@/lib/api/zod.gen'

export function parseRealtimeMessage(payload: unknown) {
  return messageResponseSchema.parse(payload)
}
```

This ensures that if the Rust API changes the `MessageResponse` shape, the Zod schema updates, and any mismatched Realtime payload throws at runtime rather than silently corrupting the UI.

---

## 6. Voice & Video (LiveKit)

Voice/video uses LiveKit, completely separate from Supabase Realtime.

### Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Tauri App   │     │  Tauri App   │     │  Tauri App   │
│  (User A)    │     │  (User B)    │     │  (User C)    │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │ WebRTC             │ WebRTC             │ WebRTC
       └───────────┬────────┴────────┬───────────┘
                   │                 │
              ┌────▼─────────────────▼────┐
              │       LiveKit SFU         │
              │   (Selective Forwarding)  │
              └───────────────────────────┘
```

### Join Flow

1. User clicks "Join Voice" on a voice channel
2. Client calls `POST /v1/channels/{id}/voice/join`
3. Rust API checks `CONNECT` permission
4. Rust API generates a LiveKit access token (using LiveKit server SDK)
5. Client receives token + LiveKit server URL
6. Client connects to LiveKit using the JS SDK

### Noise Suppression

- **Client-side:** LiveKit JS SDK has built-in noise suppression (Krisp or RNNoise fallback)
- **Push-to-Talk:** Tauri global hotkey (Rust-side) mutes/unmutes the audio track

### Self-Hosting

LiveKit runs as a Docker container alongside Supabase:

```yaml
livekit:
  image: livekit/livekit-server:v1.7
  ports:
    - "7880:7880"   # HTTP API
    - "7881:7881"   # WebRTC (TCP)
    - "7882:7882/udp" # WebRTC (UDP)
  environment:
    - LIVEKIT_KEYS=devkey:secret
```

---

## 7. What the Rust API Does NOT Do

The Rust API has **no SSE endpoint** and **no custom broadcaster**. Its responsibilities for real-time are:

1. **Write data** to Postgres (INSERT/UPDATE/DELETE messages)
2. **Generate LiveKit tokens** for voice channel access
3. **Validate permissions** on write operations

Supabase Realtime handles the push/notification layer entirely.

---

## 8. Scaling Considerations

| Scale | Supabase Realtime | LiveKit |
|-------|-------------------|---------|
| Small (< 1000 users) | Supabase Cloud free/pro tier | Self-hosted single instance |
| Medium (1K–50K users) | Supabase Cloud pro/team tier | LiveKit Cloud or multi-node |
| Large (50K+ users) | Supabase Cloud enterprise | LiveKit Cloud with geo-distribution |

Supabase Realtime scales horizontally within their infrastructure. No custom scaling code needed on our side.
