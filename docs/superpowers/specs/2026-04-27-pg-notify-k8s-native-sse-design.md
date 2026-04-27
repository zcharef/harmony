# PG LISTEN/NOTIFY — K8s-Native SSE & Presence

**Date:** 2026-04-27
**Status:** Approved
**Supersedes:** ADR-SSE-002 (which specified Redis Pub/Sub for multi-instance)

## Summary

Replace `BroadcastEventBus` (tokio::sync::broadcast, single-instance) and
`PresenceTracker` (DashMap, single-instance) with Postgres LISTEN/NOTIFY-backed
adapters. Zero new infrastructure — uses existing Postgres. Enables horizontal
scaling across K8s pods without Redis.

## Context

Harmony's SSE real-time pipeline currently uses in-process primitives:

- **EventBus:** `tokio::sync::broadcast` — events only reach SSE connections on
  the same API instance.
- **PresenceTracker:** `DashMap` — presence data is invisible to other instances.

ADR-SSE-002 anticipated this, specifying Redis Pub/Sub as the future adapter.
Postgres LISTEN/NOTIFY achieves the same goal with zero new infra:

| Approach | New infra | K8s-ready | Payload limit | Latency |
|----------|-----------|-----------|---------------|---------|
| tokio::broadcast | None | Single instance only | None | ~μs |
| Postgres LISTEN/NOTIFY | None (already have PG) | Yes | 8KB | ~1-5ms |
| Redis pub/sub | Redis cluster | Yes | 512MB | ~1ms |
| NATS/RabbitMQ | Broker cluster | Yes | Configurable | ~1ms |

Harmony's event payloads (message + author metadata) serialize to ~3-6KB worst
case — well under the 8KB limit.

## Decision

**Approach: Dual-Path Publish.** `publish()` stays sync. Locally: instant
broadcast. Cross-instance: async pg_notify via background task. PgListener on
each instance forwards remote events to local broadcast (skips self via
instance_id).

**Scope:** Both EventBus and PresenceTracker in one change.

**Old impls:** Deleted entirely. PgNotify works in dev (local Postgres supports
LISTEN/NOTIFY). One code path, no config toggles.

## Design

### 1. EventBus — PgNotifyEventBus

**Replaces:** `src/infra/broadcast_event_bus.rs`
**New file:** `src/infra/pg_notify_event_bus.rs`

#### Trait (unchanged)

```rust
// domain/ports/event_bus.rs — NO CHANGE
pub trait EventBus: Send + Sync + std::fmt::Debug {
    fn publish(&self, event: ServerEvent) -> usize;
    fn subscribe(&self) -> broadcast::Receiver<ServerEvent>;
}
```

#### Internal State

```rust
pub struct PgNotifyEventBus {
    instance_id: Uuid,
    local_tx: broadcast::Sender<ServerEvent>,
    notify_tx: mpsc::UnboundedSender<ServerEvent>,
}
```

#### publish(event)

1. `local_tx.send(event.clone())` — instant local delivery, returns receiver
   count.
2. `notify_tx.send(event)` — queues for background PG notify. Fire-and-forget.

#### subscribe()

`local_tx.subscribe()` — identical to BroadcastEventBus.

#### Background Task 1: Notify Worker

- Reads from `mpsc::UnboundedReceiver<ServerEvent>`
- Serializes: `{"i": "<instance_id>", "e": <ServerEvent JSON>}`
- Validates `payload.len() <= 7500` (safety margin under 8KB limit)
- If over limit: `tracing::error!` with event type + size, skip. No truncation.
- Calls `SELECT pg_notify('harmony_events', $1)` via pool

#### Background Task 2: Listen Worker

- `PgListener::connect()` → `LISTEN harmony_events`
- On notification: deserialize JSON → extract instance_id
- If `instance_id == self` → skip (dedup)
- Otherwise → `local_tx.send(deserialized_event)`
- On disconnect: exponential backoff reconnect (1s → 2s → 4s → max 30s),
  `tracing::warn!` per retry

#### Data Flow

```
Handler → publish(event)
            ├─ local_broadcast.send() ──→ local SSE connections (instant)
            └─ mpsc.send() ──→ notify_worker ──→ pg_notify('harmony_events')
                                                       │
                                                       ▼ (all instances)
                                                  PgListener
                                                       │ (skip self)
                                                       ▼
                                             other instance's local_broadcast
                                                       │
                                                       ▼
                                             remote SSE connections
```

#### PG Notify Payload Format

```json
{"i": "550e8400-e29b-41d4-a716-446655440000", "e": {"type": "messageCreated", ...}}
```

- `i`: instance_id (short key to save bytes within 8KB limit)
- `e`: full ServerEvent (same serialization as SSE data field)

### 2. PresenceTracker — PgPresenceTracker

**Replaces:** `src/infra/presence_tracker.rs`
**New file:** `src/infra/pg_presence_tracker.rs`

#### Storage: `presence_sessions` Table

```sql
CREATE TABLE IF NOT EXISTS presence_sessions (
    user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    instance_id      UUID NOT NULL,
    status           TEXT NOT NULL DEFAULT 'online',
    server_ids       UUID[] NOT NULL DEFAULT '{}',
    connection_count INT  NOT NULL DEFAULT 1,
    last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_presence_sessions_heartbeat
    ON presence_sessions (last_heartbeat);
```

**Composite PK `(user_id, instance_id)`:** Same user on two pods = two rows.
Each instance manages its own row. User goes fully offline when no rows remain.

RLS: enabled (required by ADR-040). Service role bypasses for API access.

#### Internal State

```rust
pub struct PgPresenceTracker {
    instance_id: Uuid,
    pool: PgPool,
    local_cache: DashMap<UserId, PresenceEntry>,
    write_tx: mpsc::UnboundedSender<PresenceCommand>,
}

enum PresenceCommand {
    Connect { user_id: UserId, server_ids: Vec<ServerId> },
    Disconnect { user_id: UserId },
    Touch { user_id: UserId },
    SetStatus { user_id: UserId, status: UserStatus },
}
```

#### Operations

| Method | Sync (immediate) | Async (background) |
|--------|------------------|--------------------|
| `connect()` | Insert local DashMap + send command | UPSERT `presence_sessions` + `pg_notify('harmony_presence', ...)` |
| `disconnect()` | Update/remove local DashMap + send command. Returns `bool`. | UPDATE/DELETE `presence_sessions` + `pg_notify('harmony_presence', ...)` |
| `touch()` | Update local DashMap timestamp + send command | `UPDATE last_heartbeat` |
| `set_status()` | Update local DashMap + send command | `UPDATE status` + `pg_notify('harmony_presence', ...)` |
| `get_status()` | Read local DashMap | — |
| `get_server_presence()` | Read local DashMap | — |

#### Cross-Instance Sync

LISTEN on `harmony_presence` channel. Payload:

```json
{"i": "instance_id", "u": "user_id", "a": "online", "s": ["server_id_1", ...]}
```

Listen worker:
- Skip if `instance_id == self`
- `online`/`idle`/`dnd` → upsert local DashMap
- `offline` → remove from local DashMap

#### Sweep (async — called from main.rs background task)

The `sweep_stale()` method becomes async (SQL query). The `main.rs` sweep task
already runs in an async context (`tokio::spawn`), so this is a signature change
only — no structural refactor needed.

Background sweep changes from DashMap iteration to SQL:

```sql
DELETE FROM presence_sessions
WHERE last_heartbeat < now() - INTERVAL '90 seconds'
RETURNING user_id
```

Returned user_ids → publish `PresenceChanged { offline }` events + pg_notify to
sync all instance caches.

**Crash recovery:** Pod crash leaves stale rows. Any surviving instance's sweep
cleans them within 90s. Better than today (DashMap entries orphaned until that
specific pod restarts).

#### PresenceGuard (Drop)

Unchanged pattern. `disconnect()` stays sync: writes to DashMap + sends mpsc
command. Async PG write happens in background. Offline `ServerEvent` published
via EventBus (now also propagates cross-instance via pg_notify).

#### Cache Hydration on Startup

When a new pod starts, its local DashMap is empty. Before accepting SSE
connections, hydrate from PG:

```sql
SELECT user_id, status, server_ids FROM presence_sessions
```

This populates the local cache so that `get_server_presence()` (used for the
`presence.sync` initial SSE event) reflects all currently online users, not just
those connected to this pod.

### 3. Wiring & Lifecycle

#### Shared Instance ID

```rust
let instance_id = Uuid::new_v4();
tracing::info!(%instance_id, "API instance starting");
```

Passed to both `PgNotifyEventBus::new()` and `PgPresenceTracker::new()`.

#### Background Tasks (4 new, spawned in main.rs)

| Task | Reads from | Writes to | Shutdown |
|------|-----------|-----------|----------|
| `event_notify_worker` | mpsc Receiver | `pg_notify('harmony_events')` | mpsc sender drop |
| `event_listen_worker` | `PgListener('harmony_events')` | local broadcast | CancellationToken |
| `presence_write_worker` | mpsc Receiver | `presence_sessions` table + `pg_notify('harmony_presence')` | mpsc sender drop |
| `presence_listen_worker` | `PgListener('harmony_presence')` | local DashMap | CancellationToken |

#### Graceful Shutdown

1. Cancel PgListener tasks (stop accepting cross-instance events)
2. Drain mpsc queues (flush pending writes)
3. `DELETE FROM presence_sessions WHERE instance_id = $1` (clean departure)
4. Drop AppState

Clean shutdown = immediate offline for all users on this pod. No 90s sweep wait.

### 4. Files Changed

| File | Action |
|------|--------|
| `src/infra/pg_notify_event_bus.rs` | **Create** |
| `src/infra/pg_presence_tracker.rs` | **Create** |
| `src/infra/broadcast_event_bus.rs` | **Delete** |
| `src/infra/presence_tracker.rs` | **Delete** |
| `src/infra/mod.rs` | Update exports |
| `src/domain/ports/event_bus.rs` | No change |
| `src/api/state.rs` | Type: `PresenceTracker` → `PgPresenceTracker` |
| `src/api/handlers/events.rs` | No change |
| `src/api/handlers/presence.rs` | Minimal (method signatures stay sync) |
| `src/main.rs` | instance_id, new constructors, 4 bg tasks, shutdown cleanup |
| `supabase/migrations/YYYYMMDD_presence_sessions.sql` | **Create** |

### 5. What Does NOT Change

- EventBus trait signature
- SSE handler (`events.rs`) — consumes `subscribe()` which returns same type
- All 41 `publish()` call sites — stays sync, same signature
- ServerEvent enum
- Frontend — zero changes, SSE contract identical

### 6. Error Handling

| Failure | Behavior |
|---------|----------|
| `pg_notify` fails (PG down) | `tracing::error!`, event still delivered locally. Other instances miss it. Recovers on PG reconnect. |
| PgListener disconnects | Exponential backoff reconnect (1s→2s→4s→max 30s). `tracing::warn!` per retry. Gap = local-only delivery. |
| Presence write fails | `tracing::warn!`, local DashMap still accurate for this instance. Retry on next touch. |
| Payload > 7500 bytes | `tracing::error!` with event type + size. Delivered locally, NOT sent to PG. |

### 7. Testing Strategy

**Unit tests (no PG):**
- `publish()` sends to both local_broadcast and mpsc
- Payload serialization round-trip
- Instance ID dedup logic (skip self, pass others)
- 8KB guard triggers on oversized payload

**Integration tests (testcontainers PG):**
- Two `PgNotifyEventBus` instances, different instance_ids, same pool
  - Instance A publishes → B receives via PgListener
  - Instance A publishes → A does NOT receive via PgListener (dedup)
- `PgPresenceTracker`:
  - Connect on instance A → visible from instance B after sync
  - Sweep removes stale entries across instances
  - Graceful shutdown cleans presence_sessions for departing instance
