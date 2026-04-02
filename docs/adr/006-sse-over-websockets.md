# ADR-006: ~~SSE Over WebSockets for Real-Time~~ → Supabase Realtime

**Status:** Superseded
**Date:** 2026-01-29
**Superseded:** 2026-02-15

## Original Decision

Use SSE via `GET /v1/events/stream` for server→client push.

## Why Superseded

Harmony uses **Supabase** as its database layer. Supabase provides a built-in
real-time engine that handles all three real-time concerns out of the box:

| Need | Supabase Feature |
|------|------------------|
| Data change notifications | Postgres Changes (listens to WAL) |
| Ephemeral events (typing) | Broadcast (pub/sub, no persistence) |
| Online status | Presence (CRDT-based, auto-cleanup) |

Building a custom SSE endpoint would duplicate what Supabase already provides,
add operational complexity (connection management, heartbeats, scaling), and
bypass Supabase's RLS-based authorization on real-time subscriptions.

## Current Decision

- **No SSE or WebSocket endpoints** in the Rust API
- Real-time is handled entirely by **Supabase Realtime** client-side
- The Rust API is REST-only: writes go through the API, pushes come from Supabase
- See [03-realtime.md](../architecture/03-realtime.md) for full architecture
