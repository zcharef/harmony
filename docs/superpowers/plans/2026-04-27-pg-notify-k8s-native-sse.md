# PG LISTEN/NOTIFY K8s-Native SSE & Presence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-instance BroadcastEventBus and PresenceTracker with Postgres LISTEN/NOTIFY-backed adapters for K8s-native multi-instance SSE.

**Architecture:** Dual-path publish — `publish()` stays sync, sends to local broadcast (instant) and async pg_notify (cross-instance). PgListener on each instance forwards remote events to local broadcast, deduplicating via instance_id. PresenceTracker uses Postgres `presence_sessions` table as SSoT with local DashMap read cache synced via LISTEN/NOTIFY.

**Tech Stack:** Rust, SQLx (PgListener, PgPool), tokio (broadcast, mpsc, spawn), DashMap, Postgres LISTEN/NOTIFY.

**Spec:** `docs/superpowers/specs/2026-04-27-pg-notify-k8s-native-sse-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `harmony-api/src/infra/pg_notify_event_bus.rs` | **Create** | PgNotifyEventBus struct, EventBus trait impl, notify/listen worker functions |
| `harmony-api/src/infra/pg_presence_tracker.rs` | **Create** | PgPresenceTracker struct, PresenceCommand enum, write/listen worker functions, cache hydration |
| `harmony-api/src/infra/broadcast_event_bus.rs` | **Delete** | Replaced by pg_notify_event_bus |
| `harmony-api/src/infra/presence_tracker.rs` | **Delete** | Replaced by pg_presence_tracker |
| `harmony-api/src/infra/mod.rs` | **Modify** | Update module declarations and re-exports |
| `harmony-api/src/domain/models/server_event.rs` | **Modify** | Add `Deserialize` derive to ServerEvent + all payload structs |
| `harmony-api/src/api/state.rs` | **Modify** | Swap `PresenceTracker` → `PgPresenceTracker` type |
| `harmony-api/src/main.rs` | **Modify** | Instance ID, new constructors, 4 bg tasks, shutdown cleanup, sweep rewrite |
| `supabase/migrations/20260427000000_create_presence_sessions.sql` | **Create** | presence_sessions table + index + RLS |

---

### Task 1: Add Deserialize to ServerEvent and Payload Structs

PgListener receives JSON from Postgres notifications and must deserialize it back into `ServerEvent`. Currently only `Serialize` is derived.

**Files:**
- Modify: `harmony-api/src/domain/models/server_event.rs`

- [ ] **Step 1: Add `Deserialize` to all payload structs and ServerEvent**

In `harmony-api/src/domain/models/server_event.rs`, add `Deserialize` to every derive block. The referenced types (`MessageType`, `ChannelType`, `VoiceAction`, `Role`, `UserStatus`, `MessageId`, `ChannelId`, `ServerId`, `UserId`) already derive `Deserialize`.

Change line 10 import:

```rust
use serde::{Deserialize, Serialize};
```

Change each derive attribute (6 payload structs + 1 enum):

`MessagePayload` (line 24):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

`MemberPayload` (line 75):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

`BanPayload` (line 87):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

`ChannelPayload` (line 96):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

`ServerPayload` (line 130):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

`DmPayload` (line 140):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

`ServerEvent` enum (line 159):
```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
```

- [ ] **Step 2: Add round-trip serialization test**

Add to the existing `#[cfg(test)]` module at the bottom of `server_event.rs`:

```rust
#[test]
fn server_event_round_trip_serialization() {
    let event = ServerEvent::MessageCreated {
        sender_id: test_user_id(),
        server_id: test_server_id(),
        channel_id: test_channel_id(),
        message: MessagePayload {
            id: MessageId::new(Uuid::new_v4()),
            channel_id: test_channel_id(),
            content: "round-trip test".to_string(),
            author_id: test_user_id(),
            author_username: "alice".to_string(),
            author_avatar_url: None,
            encrypted: false,
            sender_device_id: None,
            edited_at: None,
            parent_message_id: None,
            message_type: crate::domain::models::MessageType::Default,
            system_event_key: None,
            moderated_at: None,
            moderation_reason: None,
            created_at: Utc::now(),
        },
    };

    let json = serde_json::to_string(&event).unwrap();
    let deserialized: ServerEvent = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.event_name(), "message.created");
    assert_eq!(deserialized.sender_id(), event.sender_id());
}
```

- [ ] **Step 3: Run tests**

Run: `cd harmony-api && cargo test server_event -- --nocapture`

Expected: All existing tests pass + new round-trip test passes.

- [ ] **Step 4: Commit**

```bash
git add harmony-api/src/domain/models/server_event.rs
git commit -m "feat(sse): add deserialize to server event for pg notify"
```

---

### Task 2: Create presence_sessions Migration

**Files:**
- Create: `supabase/migrations/20260427000000_create_presence_sessions.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260427000000_create_presence_sessions.sql`:

```sql
-- Presence sessions table for multi-instance presence tracking.
-- Each API instance maintains its own rows (composite PK: user_id + instance_id).
-- The sweep background task cleans stale entries across all instances.

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

-- RLS required by ADR-040. Service role bypasses via default policies.
ALTER TABLE presence_sessions ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Apply migration locally**

Run: `cd /Users/zayd/Projects/SaaS/harmony && npx supabase db reset`

Expected: Migration applies without errors. Verify with:

```bash
npx supabase db lint
```

- [ ] **Step 3: Regenerate sqlx prepare metadata**

Run: `cd harmony-api && cargo sqlx prepare`

Expected: `.sqlx/` metadata updated (may have no changes yet — queries come in later tasks).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260427000000_create_presence_sessions.sql
git commit -m "feat(db): add presence_sessions table for multi-instance tracking"
```

---

### Task 3: Create PgNotifyEventBus

The core EventBus adapter. Implements dual-path publish: local broadcast (instant) + async pg_notify (cross-instance).

**Files:**
- Create: `harmony-api/src/infra/pg_notify_event_bus.rs`

- [ ] **Step 1: Write the PgNotifyEventBus struct and EventBus impl**

Create `harmony-api/src/infra/pg_notify_event_bus.rs`:

```rust
//! Event bus backed by Postgres LISTEN/NOTIFY for multi-instance delivery.
//!
//! Dual-path publish: local `tokio::sync::broadcast` for instant same-instance
//! delivery, plus async `pg_notify` for cross-instance fan-out. A background
//! `PgListener` on each instance forwards remote events to the local broadcast,
//! skipping self via `instance_id` (dedup).

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::domain::models::ServerEvent;
use crate::domain::ports::EventBus;

const BROADCAST_CAPACITY: usize = 1024;

/// Maximum pg_notify payload size (safety margin under Postgres 8000-byte limit).
const MAX_PG_NOTIFY_PAYLOAD: usize = 7500;

/// PG notification channel name for server events.
pub const EVENT_CHANNEL: &str = "harmony_events";

/// Envelope wrapping a ServerEvent with the originating instance ID.
#[derive(Serialize, Deserialize)]
struct NotifyEnvelope {
    /// Originating instance ID (short key to save bytes).
    i: Uuid,
    /// The server event payload.
    e: ServerEvent,
}

/// Event bus backed by Postgres LISTEN/NOTIFY.
#[derive(Debug)]
pub struct PgNotifyEventBus {
    instance_id: Uuid,
    local_tx: broadcast::Sender<ServerEvent>,
    notify_tx: mpsc::UnboundedSender<ServerEvent>,
}

impl PgNotifyEventBus {
    /// Create a new PG-backed event bus.
    ///
    /// Returns the bus plus the mpsc receiver that the notify worker task consumes.
    /// The caller (main.rs) spawns the background tasks.
    #[must_use]
    pub fn new(instance_id: Uuid) -> (Self, mpsc::UnboundedReceiver<ServerEvent>) {
        let (local_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (notify_tx, notify_rx) = mpsc::unbounded_channel();
        let bus = Self {
            instance_id,
            local_tx,
            notify_tx,
        };
        (bus, notify_rx)
    }

    /// Access the local broadcast sender (for the listen worker to forward remote events).
    pub fn local_sender(&self) -> &broadcast::Sender<ServerEvent> {
        &self.local_tx
    }

    /// The instance ID this bus belongs to.
    #[must_use]
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }
}

impl EventBus for PgNotifyEventBus {
    fn publish(&self, event: ServerEvent) -> usize {
        let receivers = self.local_tx.send(event.clone()).unwrap_or(0);

        if let Err(e) = self.notify_tx.send(event) {
            tracing::warn!(error = %e, "pg_notify mpsc channel closed, event not forwarded to other instances");
        }

        receivers
    }

    fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.local_tx.subscribe()
    }
}

/// Background task: reads events from the mpsc channel and sends them via `pg_notify`.
///
/// Runs until the mpsc sender is dropped (AppState dropped on shutdown).
pub async fn event_notify_worker(
    pool: PgPool,
    instance_id: Uuid,
    mut rx: mpsc::UnboundedReceiver<ServerEvent>,
) {
    while let Some(event) = rx.recv().await {
        let envelope = NotifyEnvelope {
            i: instance_id,
            e: event,
        };

        let payload = match serde_json::to_string(&envelope) {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "failed to serialize event for pg_notify");
                continue;
            }
        };

        if payload.len() > MAX_PG_NOTIFY_PAYLOAD {
            tracing::error!(
                size = payload.len(),
                max = MAX_PG_NOTIFY_PAYLOAD,
                event_type = envelope.e.event_name(),
                "pg_notify payload exceeds size limit, skipping cross-instance delivery"
            );
            continue;
        }

        if let Err(e) = sqlx::query("SELECT pg_notify($1, $2)")
            .bind(EVENT_CHANNEL)
            .bind(&payload)
            .execute(&pool)
            .await
        {
            tracing::error!(error = %e, "pg_notify failed, event delivered locally only");
        }
    }

    tracing::info!("event_notify_worker shutting down (mpsc channel closed)");
}

/// Background task: listens on the PG channel and forwards remote events to local broadcast.
///
/// Uses exponential backoff on PgListener disconnect (1s → 2s → 4s → max 30s).
/// Runs until the cancellation token is cancelled.
pub async fn event_listen_worker(
    pool: PgPool,
    instance_id: Uuid,
    local_tx: broadcast::Sender<ServerEvent>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    loop {
        let mut listener = match sqlx::postgres::PgListener::connect_with(&pool).await {
            Ok(l) => {
                backoff = Duration::from_secs(1);
                l
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    backoff_secs = backoff.as_secs(),
                    "PgListener connect failed, retrying"
                );
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = cancel.cancelled() => {
                        tracing::info!("event_listen_worker cancelled during reconnect backoff");
                        return;
                    }
                }
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };

        if let Err(e) = listener.listen(EVENT_CHANNEL).await {
            tracing::warn!(error = %e, "PgListener LISTEN failed, retrying");
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = cancel.cancelled() => return,
            }
            backoff = (backoff * 2).min(max_backoff);
            continue;
        }

        tracing::info!("event_listen_worker connected and listening on '{EVENT_CHANNEL}'");

        loop {
            tokio::select! {
                notification = listener.recv() => {
                    match notification {
                        Ok(n) => {
                            let payload = n.payload();
                            match serde_json::from_str::<NotifyEnvelope>(payload) {
                                Ok(env) if env.i == instance_id => {
                                    // Skip self — already delivered locally
                                }
                                Ok(env) => {
                                    let _ = local_tx.send(env.e);
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        error = %e,
                                        "failed to deserialize pg_notify event payload"
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "PgListener recv error, reconnecting");
                            break; // break inner loop → reconnect in outer loop
                        }
                    }
                }
                _ = cancel.cancelled() => {
                    tracing::info!("event_listen_worker cancelled");
                    return;
                }
            }
        }
    }
}

use std::time::Duration;
```

- [ ] **Step 2: Run clippy**

Run: `cd harmony-api && cargo clippy --all-targets -- -D warnings 2>&1 | head -30`

Expected: No warnings/errors (file compiles but is not yet wired into the module tree — this verifies syntax only after Step 3).

- [ ] **Step 3: Add to module tree (infra/mod.rs)**

This step only adds the module declaration. Full wiring happens in Task 6.

In `harmony-api/src/infra/mod.rs`, replace:

```rust
pub mod broadcast_event_bus;
```

with:

```rust
pub mod pg_notify_event_bus;
```

And replace:

```rust
pub use broadcast_event_bus::BroadcastEventBus;
```

with:

```rust
pub use pg_notify_event_bus::PgNotifyEventBus;
```

- [ ] **Step 4: Verify compilation**

Run: `cd harmony-api && cargo check 2>&1 | head -30`

Expected: Compilation errors about `BroadcastEventBus` not found in main.rs — expected, will be fixed in Task 6.

- [ ] **Step 5: Commit**

```bash
git add harmony-api/src/infra/pg_notify_event_bus.rs harmony-api/src/infra/mod.rs
git commit -m "feat(sse): add pg notify event bus adapter"
```

---

### Task 4: Create PgPresenceTracker

Replaces the in-memory PresenceTracker with a Postgres-backed version. Local DashMap serves reads; Postgres is SSoT for cross-instance consistency.

**Files:**
- Create: `harmony-api/src/infra/pg_presence_tracker.rs`

- [ ] **Step 1: Write the PgPresenceTracker struct and public API**

Create `harmony-api/src/infra/pg_presence_tracker.rs`:

```rust
//! Presence tracker backed by Postgres `presence_sessions` table.
//!
//! Local `DashMap` serves reads (instant). Writes go through an mpsc channel
//! to a background task that persists to Postgres and notifies other instances
//! via `pg_notify('harmony_presence', ...)`.
//!
//! Replaces the single-instance `PresenceTracker` (DashMap-only).

use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::sync::mpsc;
use uuid::Uuid;

use std::sync::Arc;

use crate::domain::models::{ServerId, UserId, UserStatus};

/// PG notification channel name for presence sync.
pub const PRESENCE_CHANNEL: &str = "harmony_presence";

/// A single user's presence state (same shape as the old PresenceTracker).
#[derive(Debug, Clone)]
pub struct PresenceEntry {
    pub status: UserStatus,
    pub server_ids: Vec<ServerId>,
    pub last_heartbeat: std::time::Instant,
    pub connection_count: u32,
}

/// Commands queued for the background presence write worker.
#[derive(Debug)]
pub enum PresenceCommand {
    Connect {
        user_id: UserId,
        server_ids: Vec<ServerId>,
    },
    Disconnect {
        user_id: UserId,
    },
    Touch {
        user_id: UserId,
    },
    SetStatus {
        user_id: UserId,
        status: UserStatus,
    },
}

/// Envelope for cross-instance presence notifications.
#[derive(Serialize, Deserialize)]
pub struct PresenceEnvelope {
    /// Originating instance ID.
    pub i: Uuid,
    /// User ID.
    pub u: Uuid,
    /// Action: "online", "idle", "dnd", "offline".
    pub a: String,
    /// Server IDs the user belongs to.
    pub s: Vec<Uuid>,
}

/// Postgres-backed presence tracker with local DashMap read cache.
#[derive(Debug)]
pub struct PgPresenceTracker {
    instance_id: Uuid,
    pool: PgPool,
    local_cache: Arc<DashMap<UserId, PresenceEntry>>,
    write_tx: mpsc::UnboundedSender<PresenceCommand>,
}

impl PgPresenceTracker {
    /// Create a new PG-backed presence tracker.
    ///
    /// Returns the tracker plus the mpsc receiver for the write worker.
    /// The caller (main.rs) spawns the background tasks.
    #[must_use]
    pub fn new(
        instance_id: Uuid,
        pool: PgPool,
    ) -> (Self, mpsc::UnboundedReceiver<PresenceCommand>) {
        let (write_tx, write_rx) = mpsc::unbounded_channel();
        let tracker = Self {
            instance_id,
            pool,
            local_cache: Arc::new(DashMap::new()),
            write_tx,
        };
        (tracker, write_rx)
    }

    /// Clone the local cache Arc for the presence listen worker.
    #[must_use]
    pub fn local_cache_handle(&self) -> Arc<DashMap<UserId, PresenceEntry>> {
        Arc::clone(&self.local_cache)
    }

    /// Hydrate the local cache from Postgres on startup.
    ///
    /// Loads all presence_sessions rows so that `get_server_presence()` reflects
    /// users connected to OTHER instances before this instance accepts SSE connections.
    pub async fn hydrate(&self) -> Result<(), sqlx::Error> {
        let rows = sqlx::query!(
            r#"
            SELECT user_id, status, server_ids
            FROM presence_sessions
            "#
        )
        .fetch_all(&self.pool)
        .await?;

        for row in rows {
            let user_id = UserId(row.user_id);
            let status = match row.status.as_str() {
                "online" => UserStatus::Online,
                "idle" => UserStatus::Idle,
                "dnd" => UserStatus::DoNotDisturb,
                _ => UserStatus::Online,
            };
            let server_ids: Vec<ServerId> = row
                .server_ids
                .unwrap_or_default()
                .into_iter()
                .map(ServerId)
                .collect();

            self.local_cache.insert(
                user_id,
                PresenceEntry {
                    status,
                    server_ids,
                    last_heartbeat: std::time::Instant::now(),
                    connection_count: 1,
                },
            );
        }

        tracing::info!(
            entries = self.local_cache.len(),
            "presence cache hydrated from Postgres"
        );
        Ok(())
    }

    /// Register a new SSE connection for a user.
    pub fn connect(&self, user_id: UserId, server_ids: Vec<ServerId>) {
        self.local_cache
            .entry(user_id.clone())
            .and_modify(|entry| {
                entry.connection_count += 1;
                entry.server_ids = server_ids.clone();
                entry.last_heartbeat = std::time::Instant::now();
            })
            .or_insert(PresenceEntry {
                status: UserStatus::Online,
                server_ids: server_ids.clone(),
                last_heartbeat: std::time::Instant::now(),
                connection_count: 1,
            });

        let _ = self.write_tx.send(PresenceCommand::Connect {
            user_id,
            server_ids,
        });
    }

    /// Unregister an SSE connection. Returns `true` if user went fully offline.
    #[must_use]
    pub fn disconnect(&self, user_id: &UserId) -> bool {
        if let Some(mut entry) = self.local_cache.get_mut(user_id) {
            entry.connection_count = entry.connection_count.saturating_sub(1);
        }

        let went_offline = self
            .local_cache
            .remove_if(user_id, |_, entry| entry.connection_count == 0)
            .is_some();

        let _ = self.write_tx.send(PresenceCommand::Disconnect {
            user_id: user_id.clone(),
        });

        went_offline
    }

    /// Update a user's status without changing server_ids.
    pub fn set_status(&self, user_id: &UserId, status: UserStatus) {
        if let Some(mut entry) = self.local_cache.get_mut(user_id) {
            entry.status = status.clone();
            entry.last_heartbeat = std::time::Instant::now();
        }

        let _ = self.write_tx.send(PresenceCommand::SetStatus {
            user_id: user_id.clone(),
            status,
        });
    }

    /// Get a user's current status.
    #[must_use]
    pub fn get_status(&self, user_id: &UserId) -> Option<UserStatus> {
        self.local_cache.get(user_id).map(|e| e.status.clone())
    }

    /// Return all online users for a given server with their current status.
    #[must_use]
    pub fn get_server_presence(&self, server_id: &ServerId) -> Vec<(UserId, UserStatus)> {
        self.local_cache
            .iter()
            .filter(|entry| entry.value().server_ids.contains(server_id))
            .map(|entry| (entry.key().clone(), entry.value().status.clone()))
            .collect()
    }

    /// Refresh a user's heartbeat timestamp.
    pub fn touch(&self, user_id: &UserId) {
        if let Some(mut entry) = self.local_cache.get_mut(user_id) {
            entry.last_heartbeat = std::time::Instant::now();
        }

        let _ = self.write_tx.send(PresenceCommand::Touch {
            user_id: user_id.clone(),
        });
    }

    /// Sweep stale entries via Postgres.
    ///
    /// Unlike the old DashMap-only sweep, this deletes from Postgres and returns
    /// the user IDs that were removed. The caller publishes offline events.
    pub async fn sweep_stale(&self, _max_age: Duration) -> Vec<UserId> {
        let rows = match sqlx::query!(
            r#"
            DELETE FROM presence_sessions
            WHERE last_heartbeat < now() - INTERVAL '90 seconds'
            RETURNING user_id
            "#
        )
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(error = %e, "presence sweep query failed");
                return Vec::new();
            }
        };

        let user_ids: Vec<UserId> = rows.into_iter().map(|r| UserId(r.user_id)).collect();

        // Remove swept users from local cache
        for uid in &user_ids {
            self.local_cache.remove(uid);
        }

        user_ids
    }

    /// Clean up all presence_sessions for this instance (graceful shutdown).
    pub async fn cleanup_instance(&self) {
        if let Err(e) = sqlx::query!(
            "DELETE FROM presence_sessions WHERE instance_id = $1",
            self.instance_id
        )
        .execute(&self.pool)
        .await
        {
            tracing::warn!(error = %e, "failed to clean up presence_sessions on shutdown");
        }
    }

    /// Access the instance ID.
    #[must_use]
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }
}

/// Background task: persists presence commands to Postgres + pg_notify.
///
/// Runs until the mpsc sender is dropped (AppState dropped on shutdown).
pub async fn presence_write_worker(
    pool: PgPool,
    instance_id: Uuid,
    mut rx: mpsc::UnboundedReceiver<PresenceCommand>,
) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            PresenceCommand::Connect {
                user_id,
                server_ids,
            } => {
                let server_id_uuids: Vec<Uuid> =
                    server_ids.iter().map(|s| s.0).collect();

                if let Err(e) = sqlx::query!(
                    r#"
                    INSERT INTO presence_sessions (user_id, instance_id, status, server_ids, connection_count, last_heartbeat)
                    VALUES ($1, $2, 'online', $3, 1, now())
                    ON CONFLICT (user_id, instance_id) DO UPDATE SET
                        server_ids = $3,
                        connection_count = presence_sessions.connection_count + 1,
                        last_heartbeat = now()
                    "#,
                    user_id.0,
                    instance_id,
                    &server_id_uuids,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(error = %e, %user_id, "presence connect write failed");
                }

                // Notify other instances
                let envelope = PresenceEnvelope {
                    i: instance_id,
                    u: user_id.0,
                    a: "online".to_string(),
                    s: server_id_uuids,
                };
                notify_presence(&pool, &envelope).await;
            }

            PresenceCommand::Disconnect { user_id } => {
                // Decrement connection count; delete row if it reaches 0
                if let Err(e) = sqlx::query!(
                    r#"
                    UPDATE presence_sessions
                    SET connection_count = connection_count - 1,
                        last_heartbeat = now()
                    WHERE user_id = $1 AND instance_id = $2
                    "#,
                    user_id.0,
                    instance_id,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(error = %e, %user_id, "presence disconnect update failed");
                }

                // Clean up rows with count <= 0
                let deleted = sqlx::query!(
                    r#"
                    DELETE FROM presence_sessions
                    WHERE user_id = $1 AND instance_id = $2 AND connection_count <= 0
                    RETURNING user_id
                    "#,
                    user_id.0,
                    instance_id,
                )
                .fetch_optional(&pool)
                .await;

                // If row was deleted (last connection on this instance), check if user
                // has connections on other instances
                if let Ok(Some(_)) = deleted {
                    let still_connected = sqlx::query_scalar!(
                        r#"
                        SELECT EXISTS(
                            SELECT 1 FROM presence_sessions WHERE user_id = $1
                        ) as "exists!"
                        "#,
                        user_id.0,
                    )
                    .fetch_one(&pool)
                    .await
                    .unwrap_or(false);

                    if !still_connected {
                        let envelope = PresenceEnvelope {
                            i: instance_id,
                            u: user_id.0,
                            a: "offline".to_string(),
                            s: Vec::new(),
                        };
                        notify_presence(&pool, &envelope).await;
                    }
                }
            }

            PresenceCommand::Touch { user_id } => {
                if let Err(e) = sqlx::query!(
                    r#"
                    UPDATE presence_sessions
                    SET last_heartbeat = now()
                    WHERE user_id = $1 AND instance_id = $2
                    "#,
                    user_id.0,
                    instance_id,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(error = %e, %user_id, "presence touch write failed");
                }
            }

            PresenceCommand::SetStatus { user_id, status } => {
                let status_str = match &status {
                    UserStatus::Online => "online",
                    UserStatus::Idle => "idle",
                    UserStatus::DoNotDisturb => "dnd",
                    UserStatus::Offline => "offline",
                };

                if let Err(e) = sqlx::query!(
                    r#"
                    UPDATE presence_sessions
                    SET status = $3, last_heartbeat = now()
                    WHERE user_id = $1 AND instance_id = $2
                    "#,
                    user_id.0,
                    instance_id,
                    status_str,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(error = %e, %user_id, "presence set_status write failed");
                }

                // Notify other instances of status change
                let server_ids = sqlx::query_scalar!(
                    r#"SELECT server_ids FROM presence_sessions WHERE user_id = $1 AND instance_id = $2"#,
                    user_id.0,
                    instance_id,
                )
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();

                let envelope = PresenceEnvelope {
                    i: instance_id,
                    u: user_id.0,
                    a: status_str.to_string(),
                    s: server_ids,
                };
                notify_presence(&pool, &envelope).await;
            }
        }
    }

    tracing::info!("presence_write_worker shutting down (mpsc channel closed)");
}

/// Send a presence notification via pg_notify.
async fn notify_presence(pool: &PgPool, envelope: &PresenceEnvelope) {
    let payload = match serde_json::to_string(envelope) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "failed to serialize presence envelope");
            return;
        }
    };

    if let Err(e) = sqlx::query("SELECT pg_notify($1, $2)")
        .bind(PRESENCE_CHANNEL)
        .bind(&payload)
        .execute(pool)
        .await
    {
        tracing::warn!(error = %e, "pg_notify for presence failed");
    }
}

/// Background task: listens on the PG presence channel and syncs the local cache.
///
/// Uses exponential backoff on PgListener disconnect.
pub async fn presence_listen_worker(
    pool: PgPool,
    instance_id: Uuid,
    local_cache: Arc<DashMap<UserId, PresenceEntry>>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    loop {
        let mut listener = match sqlx::postgres::PgListener::connect_with(&pool).await {
            Ok(l) => {
                backoff = Duration::from_secs(1);
                l
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    backoff_secs = backoff.as_secs(),
                    "presence PgListener connect failed, retrying"
                );
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = cancel.cancelled() => return,
                }
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };

        if let Err(e) = listener.listen(PRESENCE_CHANNEL).await {
            tracing::warn!(error = %e, "presence PgListener LISTEN failed, retrying");
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = cancel.cancelled() => return,
            }
            backoff = (backoff * 2).min(max_backoff);
            continue;
        }

        tracing::info!("presence_listen_worker connected and listening on '{PRESENCE_CHANNEL}'");

        loop {
            tokio::select! {
                notification = listener.recv() => {
                    match notification {
                        Ok(n) => {
                            let payload = n.payload();
                            match serde_json::from_str::<PresenceEnvelope>(payload) {
                                Ok(env) if env.i == instance_id => {
                                    // Skip self
                                }
                                Ok(env) => {
                                    let user_id = UserId(env.u);
                                    let server_ids: Vec<ServerId> =
                                        env.s.into_iter().map(ServerId).collect();

                                    if env.a == "offline" {
                                        local_cache.remove(&user_id);
                                    } else {
                                        let status = match env.a.as_str() {
                                            "idle" => UserStatus::Idle,
                                            "dnd" => UserStatus::DoNotDisturb,
                                            _ => UserStatus::Online,
                                        };
                                        local_cache
                                            .entry(user_id)
                                            .and_modify(|e| {
                                                e.status = status.clone();
                                                e.server_ids = server_ids.clone();
                                                e.last_heartbeat = std::time::Instant::now();
                                            })
                                            .or_insert(PresenceEntry {
                                                status,
                                                server_ids,
                                                last_heartbeat: std::time::Instant::now(),
                                                connection_count: 1,
                                            });
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(
                                        error = %e,
                                        "failed to deserialize presence notification"
                                    );
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "presence PgListener recv error, reconnecting");
                            break;
                        }
                    }
                }
                _ = cancel.cancelled() => {
                    tracing::info!("presence_listen_worker cancelled");
                    return;
                }
            }
        }
    }
}
```

- [ ] **Step 2: Add module declaration to infra/mod.rs**

In `harmony-api/src/infra/mod.rs`, replace:

```rust
pub mod presence_tracker;
```

with:

```rust
pub mod pg_presence_tracker;
```

And replace:

```rust
pub use presence_tracker::PresenceTracker;
```

with:

```rust
pub use pg_presence_tracker::PgPresenceTracker;
```

- [ ] **Step 3: Commit**

```bash
git add harmony-api/src/infra/pg_presence_tracker.rs harmony-api/src/infra/mod.rs
git commit -m "feat(sse): add pg presence tracker with listen/notify sync"
```

---

### Task 5: Update AppState to Use PgPresenceTracker

**Files:**
- Modify: `harmony-api/src/api/state.rs:20,75,174,328`

- [ ] **Step 1: Update import**

In `harmony-api/src/api/state.rs`, change line 20:

```rust
use crate::infra::PgPresenceTracker;
```

- [ ] **Step 2: Update struct field type**

Change line 75:

```rust
    presence_tracker: Arc<PgPresenceTracker>,
```

- [ ] **Step 3: Update constructor parameter type**

Change the `presence_tracker` parameter in `AppState::new()` (line 174):

```rust
        presence_tracker: Arc<PgPresenceTracker>,
```

- [ ] **Step 4: Update accessor return type**

Change the `presence_tracker()` method (line 328):

```rust
    pub fn presence_tracker(&self) -> &PgPresenceTracker {
        &self.presence_tracker
    }
```

- [ ] **Step 5: Commit**

```bash
git add harmony-api/src/api/state.rs
git commit -m "refactor(state): swap presence tracker type to pg-backed adapter"
```

---

### Task 6: Wire Everything in main.rs

Replace old constructors with new ones, add background tasks, update shutdown logic, and rewrite the presence sweep.

**Files:**
- Modify: `harmony-api/src/main.rs`
- Delete: `harmony-api/src/infra/broadcast_event_bus.rs`
- Delete: `harmony-api/src/infra/presence_tracker.rs`

- [ ] **Step 1: Add `tokio-util` dependency for CancellationToken**

In `harmony-api/Cargo.toml`, add:

```toml
tokio-util = { version = "0.7", features = ["rt"] }
```

- [ ] **Step 2: Rewrite init_app_state event bus + presence wiring**

In `harmony-api/src/main.rs`, replace lines 255-259:

```rust
    // Initialize in-process event bus for SSE real-time delivery
    let event_bus: Arc<dyn domain::ports::EventBus> = Arc::new(infra::BroadcastEventBus::new());

    // Initialize in-memory presence tracker
    let presence_tracker = Arc::new(infra::PresenceTracker::new());
```

With:

```rust
    // Generate unique instance ID for this API process (dedup pg_notify events)
    let instance_id = uuid::Uuid::new_v4();
    tracing::info!(%instance_id, "API instance ID generated");

    // Initialize PG-backed event bus (dual-path: local broadcast + pg_notify)
    let (event_bus_inner, event_notify_rx) = infra::PgNotifyEventBus::new(instance_id);
    let event_local_tx = event_bus_inner.local_sender().clone();
    let event_bus: Arc<dyn domain::ports::EventBus> = Arc::new(event_bus_inner);

    // Initialize PG-backed presence tracker (local DashMap cache + Postgres SSoT)
    let (presence_inner, presence_write_rx) =
        infra::PgPresenceTracker::new(instance_id, pool.clone());
    presence_inner
        .hydrate()
        .await
        .expect("Failed to hydrate presence cache from Postgres");
    let presence_cache_handle = presence_inner.local_cache_handle();
    let presence_tracker = Arc::new(presence_inner);
```

- [ ] **Step 4: Spawn 4 background tasks after AppState construction**

After `spawn_presence_sweep(state.clone());` (line 58), add the 4 new background tasks. Also create a CancellationToken for PgListener tasks:

```rust
    // 5b. Background tasks: PG LISTEN/NOTIFY workers for cross-instance SSE + presence
    let cancel = tokio_util::sync::CancellationToken::new();

    // Event bus: notify worker (mpsc → pg_notify)
    tokio::spawn(infra::pg_notify_event_bus::event_notify_worker(
        state.pool().clone(),
        instance_id,
        event_notify_rx,
    ));

    // Event bus: listen worker (PgListener → local broadcast)
    tokio::spawn(infra::pg_notify_event_bus::event_listen_worker(
        state.pool().clone(),
        instance_id,
        event_local_tx,
        cancel.clone(),
    ));

    // Presence: write worker (mpsc → Postgres + pg_notify)
    tokio::spawn(infra::pg_presence_tracker::presence_write_worker(
        state.pool().clone(),
        instance_id,
        presence_write_rx,
    ));

    // Presence: listen worker (PgListener → local DashMap cache)
    tokio::spawn(infra::pg_presence_tracker::presence_listen_worker(
        state.pool().clone(),
        instance_id,
        presence_cache_handle,
        cancel.clone(),
    ));
```

Note: `instance_id`, `event_notify_rx`, `event_local_tx`, `presence_write_rx`, and `presence_cache_handle` need to be passed through. They are created inside `init_app_state` but the background tasks are spawned in `main()`. Restructure: return these alongside `AppState` from `init_app_state`, or move background task spawning inside `init_app_state`.

The cleaner approach: have `init_app_state` return a struct with all the pieces:

```rust
struct AppInit {
    state: AppState,
    instance_id: uuid::Uuid,
    event_notify_rx: tokio::sync::mpsc::UnboundedReceiver<domain::models::ServerEvent>,
    event_local_tx: tokio::sync::broadcast::Sender<domain::models::ServerEvent>,
    presence_write_rx: tokio::sync::mpsc::UnboundedReceiver<infra::pg_presence_tracker::PresenceCommand>,
    presence_cache_handle: std::sync::Arc<dashmap::DashMap<domain::models::UserId, infra::pg_presence_tracker::PresenceEntry>>,
}
```

Update `init_app_state` return type to `AppInit`.

In `main()`, destructure:

```rust
    let AppInit {
        state,
        instance_id,
        event_notify_rx,
        event_local_tx,
        presence_write_rx,
        presence_cache_handle,
    } = init_app_state(&config).await;
```

Then spawn the 4 background tasks as shown above.

- [ ] **Step 5: Rewrite `spawn_presence_sweep` for async sweep**

The `sweep_stale()` method is now async (SQL query). Update the sweep function:

Replace the existing `spawn_presence_sweep` function (lines 344-374):

```rust
fn spawn_presence_sweep(state: api::AppState) {
    use domain::models::{ServerEvent, UserStatus};

    const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;

            let stale_users = state.presence_tracker().sweep_stale(SWEEP_INTERVAL).await;
            if stale_users.is_empty() {
                continue;
            }

            tracing::info!(count = stale_users.len(), "Swept stale presence entries");

            for user_id in stale_users {
                let event = ServerEvent::PresenceChanged {
                    sender_id: user_id.clone(),
                    user_id,
                    status: UserStatus::Offline,
                };
                state.event_bus().publish(event);
            }
        }
    });
}
```

- [ ] **Step 6: Add graceful shutdown cleanup**

Update `shutdown_signal()` or add a cleanup block after `axum::serve(...).await`. The cleanest spot is after the server stops:

After line 81 (`expect("Server error")`), add:

```rust
    // Clean up presence sessions for this instance (graceful departure)
    state.presence_tracker().cleanup_instance().await;
    cancel.cancel();
    tracing::info!("PgListener tasks cancelled, presence cleaned up");
```

This requires `state` and `cancel` to be accessible in the main scope. Move the variable bindings as needed.

- [ ] **Step 7: Delete old implementation files**

```bash
rm harmony-api/src/infra/broadcast_event_bus.rs
rm harmony-api/src/infra/presence_tracker.rs
```

- [ ] **Step 8: Run full quality wall**

Run: `cd harmony-api && just wall`

Expected: fmt, clippy, all tests pass. Fix any compilation errors from the wiring changes.

- [ ] **Step 9: Run sqlx prepare**

Run: `cd harmony-api && cargo sqlx prepare`

Expected: `.sqlx/` metadata updated with the new presence_sessions queries.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(sse): wire pg notify event bus and presence tracker

Replace BroadcastEventBus and PresenceTracker with PG LISTEN/NOTIFY-backed
adapters. Adds 4 background tasks for cross-instance event delivery and
presence sync. Delete old single-instance implementations."
```

---

### Task 7: Unit Tests for PgNotifyEventBus

**Files:**
- Modify: `harmony-api/src/infra/pg_notify_event_bus.rs`

- [ ] **Step 1: Add unit tests module**

Add to the bottom of `harmony-api/src/infra/pg_notify_event_bus.rs`:

```rust
#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::domain::models::{MessageId, ServerId, UserId};
    use crate::domain::models::server_event::MessagePayload;
    use chrono::Utc;

    fn test_user_id() -> UserId {
        UserId::new(uuid::Uuid::new_v4())
    }

    fn test_server_id() -> ServerId {
        ServerId::new(uuid::Uuid::new_v4())
    }

    fn test_channel_id() -> crate::domain::models::ChannelId {
        crate::domain::models::ChannelId::new(uuid::Uuid::new_v4())
    }

    fn make_message_event() -> ServerEvent {
        ServerEvent::MessageCreated {
            sender_id: test_user_id(),
            server_id: test_server_id(),
            channel_id: test_channel_id(),
            message: MessagePayload {
                id: MessageId::new(uuid::Uuid::new_v4()),
                channel_id: test_channel_id(),
                content: "test message".to_string(),
                author_id: test_user_id(),
                author_username: "alice".to_string(),
                author_avatar_url: None,
                encrypted: false,
                sender_device_id: None,
                edited_at: None,
                parent_message_id: None,
                message_type: crate::domain::models::MessageType::Default,
                system_event_key: None,
                moderated_at: None,
                moderation_reason: None,
                created_at: Utc::now(),
            },
        }
    }

    #[test]
    fn publish_sends_to_local_broadcast_and_mpsc() {
        let instance_id = Uuid::new_v4();
        let (bus, mut notify_rx) = PgNotifyEventBus::new(instance_id);

        let mut local_rx = bus.subscribe();
        let event = make_message_event();

        let receivers = bus.publish(event);
        assert_eq!(receivers, 1);

        // Local broadcast received the event
        let received = local_rx.try_recv().unwrap();
        assert_eq!(received.event_name(), "message.created");

        // mpsc channel received the event
        let queued = notify_rx.try_recv().unwrap();
        assert_eq!(queued.event_name(), "message.created");
    }

    #[test]
    fn subscribe_returns_working_receiver() {
        let (bus, _rx) = PgNotifyEventBus::new(Uuid::new_v4());
        let mut sub1 = bus.subscribe();
        let mut sub2 = bus.subscribe();

        bus.publish(make_message_event());

        assert!(sub1.try_recv().is_ok());
        assert!(sub2.try_recv().is_ok());
    }

    #[test]
    fn notify_envelope_round_trip() {
        let instance_id = Uuid::new_v4();
        let event = make_message_event();

        let envelope = NotifyEnvelope {
            i: instance_id,
            e: event,
        };

        let json = serde_json::to_string(&envelope).unwrap();
        let deserialized: NotifyEnvelope = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.i, instance_id);
        assert_eq!(deserialized.e.event_name(), "message.created");
    }

    #[test]
    fn notify_envelope_dedup_skip_self() {
        let self_id = Uuid::new_v4();
        let other_id = Uuid::new_v4();

        let self_envelope = NotifyEnvelope {
            i: self_id,
            e: make_message_event(),
        };
        assert_eq!(self_envelope.i, self_id); // would skip

        let other_envelope = NotifyEnvelope {
            i: other_id,
            e: make_message_event(),
        };
        assert_ne!(other_envelope.i, self_id); // would forward
    }

    #[test]
    fn payload_size_check() {
        let event = make_message_event();
        let envelope = NotifyEnvelope {
            i: Uuid::new_v4(),
            e: event,
        };
        let payload = serde_json::to_string(&envelope).unwrap();

        assert!(
            payload.len() <= MAX_PG_NOTIFY_PAYLOAD,
            "typical event payload ({} bytes) should be under limit ({} bytes)",
            payload.len(),
            MAX_PG_NOTIFY_PAYLOAD
        );
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd harmony-api && cargo test pg_notify_event_bus -- --nocapture`

Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add harmony-api/src/infra/pg_notify_event_bus.rs
git commit -m "test(sse): add unit tests for pg notify event bus"
```

---

### Task 8: Unit Tests for PgPresenceTracker (Local Cache Behavior)

Tests for the sync local-cache operations (no PG needed).

**Files:**
- Modify: `harmony-api/src/infra/pg_presence_tracker.rs`

- [ ] **Step 1: Add unit tests module**

Add to the bottom of `harmony-api/src/infra/pg_presence_tracker.rs`:

```rust
#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::domain::models::UserStatus;

    fn user(n: u128) -> UserId {
        UserId(Uuid::from_u128(n))
    }

    fn server(n: u128) -> ServerId {
        ServerId(Uuid::from_u128(n))
    }

    /// Create a tracker with a no-op write channel (for local-only tests).
    fn test_tracker() -> PgPresenceTracker {
        let (write_tx, _write_rx) = mpsc::unbounded_channel();
        PgPresenceTracker {
            instance_id: Uuid::new_v4(),
            pool: PgPool::connect_lazy("postgres://unused").unwrap(),
            local_cache: Arc::new(DashMap::new()),
            write_tx,
        }
    }

    #[test]
    fn connect_and_get_status() {
        let tracker = test_tracker();
        let uid = user(1);

        assert!(tracker.get_status(&uid).is_none());

        tracker.connect(uid.clone(), vec![server(10)]);
        assert_eq!(tracker.get_status(&uid).unwrap(), UserStatus::Online);
    }

    #[test]
    fn set_status_updates_without_changing_servers() {
        let tracker = test_tracker();
        let uid = user(2);
        let sid = server(20);

        tracker.connect(uid.clone(), vec![sid.clone()]);
        tracker.set_status(&uid, UserStatus::DoNotDisturb);

        assert_eq!(tracker.get_status(&uid).unwrap(), UserStatus::DoNotDisturb);

        let presence = tracker.get_server_presence(&sid);
        assert_eq!(presence.len(), 1);
        assert_eq!(presence[0].1, UserStatus::DoNotDisturb);
    }

    #[test]
    fn disconnect_single_connection_goes_offline() {
        let tracker = test_tracker();
        let uid = user(3);

        tracker.connect(uid.clone(), vec![server(30)]);
        let went_offline = tracker.disconnect(&uid);

        assert!(went_offline);
        assert!(tracker.get_status(&uid).is_none());
    }

    #[test]
    fn disconnect_multi_connection_stays_online() {
        let tracker = test_tracker();
        let uid = user(4);

        tracker.connect(uid.clone(), vec![server(40)]);
        tracker.connect(uid.clone(), vec![server(40)]);

        let went_offline = tracker.disconnect(&uid);
        assert!(!went_offline);
        assert_eq!(tracker.get_status(&uid).unwrap(), UserStatus::Online);

        let went_offline = tracker.disconnect(&uid);
        assert!(went_offline);
        assert!(tracker.get_status(&uid).is_none());
    }

    #[test]
    fn get_server_presence_filters_by_server() {
        let tracker = test_tracker();
        let s1 = server(100);
        let s2 = server(200);

        tracker.connect(user(1), vec![s1.clone(), s2.clone()]);
        tracker.connect(user(2), vec![s1.clone()]);
        tracker.connect(user(3), vec![s2.clone()]);

        let s1_presence = tracker.get_server_presence(&s1);
        assert_eq!(s1_presence.len(), 2);

        let s2_presence = tracker.get_server_presence(&s2);
        assert_eq!(s2_presence.len(), 2);

        let empty = tracker.get_server_presence(&server(999));
        assert!(empty.is_empty());
    }

    #[test]
    fn touch_refreshes_heartbeat() {
        let tracker = test_tracker();
        let uid = user(5);

        tracker.connect(uid.clone(), vec![server(50)]);
        let before = tracker.local_cache.get(&uid).unwrap().last_heartbeat;

        std::thread::sleep(std::time::Duration::from_millis(10));
        tracker.touch(&uid);

        let after = tracker.local_cache.get(&uid).unwrap().last_heartbeat;
        assert!(after > before);
    }

    #[test]
    fn presence_envelope_round_trip() {
        let envelope = PresenceEnvelope {
            i: Uuid::new_v4(),
            u: Uuid::new_v4(),
            a: "online".to_string(),
            s: vec![Uuid::new_v4(), Uuid::new_v4()],
        };

        let json = serde_json::to_string(&envelope).unwrap();
        let deserialized: PresenceEnvelope = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.i, envelope.i);
        assert_eq!(deserialized.u, envelope.u);
        assert_eq!(deserialized.a, "online");
        assert_eq!(deserialized.s.len(), 2);
    }

    #[test]
    fn local_cache_handle_shares_same_map() {
        let tracker = test_tracker();
        let handle = tracker.local_cache_handle();

        tracker.connect(user(1), vec![server(10)]);

        // The handle sees the same data
        assert!(handle.contains_key(&user(1)));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd harmony-api && cargo test pg_presence_tracker -- --nocapture`

Expected: All 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add harmony-api/src/infra/pg_presence_tracker.rs
git commit -m "test(sse): add unit tests for pg presence tracker local cache"
```

---

### Task 9: Full Quality Wall + sqlx prepare

Final verification that everything compiles, lints, and passes.

**Files:** All modified files from previous tasks.

- [ ] **Step 1: Run sqlx prepare**

Run: `cd harmony-api && cargo sqlx prepare`

Expected: `.sqlx/` metadata updated with new presence_sessions queries.

- [ ] **Step 2: Run full quality wall**

Run: `cd harmony-api && just wall`

Expected: fmt-check, clippy, all tests (unit + integration + arch) pass.

- [ ] **Step 3: Fix any issues found**

If clippy or tests fail, fix the issues. Common things to watch for:
- Missing `use` imports after file deletions
- Doc comment references to `BroadcastEventBus` or `PresenceTracker` in other files (grep and update)
- Architecture boundary tests may flag `tokio_util` in infra layer

Run: `grep -rn "BroadcastEventBus\|infra::PresenceTracker\|use crate::infra::PresenceTracker" harmony-api/src --include="*.rs"` to find stale references.

- [ ] **Step 4: Update doc comments referencing old implementations**

Grep for stale references and update them:

```bash
grep -rn "BroadcastEventBus\|broadcast_event_bus\|presence_tracker::\|PresenceTracker" harmony-api/src --include="*.rs" | grep -v "pg_presence_tracker\|pg_notify_event_bus\|test"
```

Update any found references in doc comments, module-level docs, and CLAUDE.md.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(sse): update stale references and sqlx metadata"
```

---

### Task 10: Update ADR-SSE-002 and CLAUDE.md

Update documentation to reflect the new architecture.

**Files:**
- Modify: `harmony-api/CLAUDE.md`
- Modify: `dev/active/sse-realtime-migration/sse-realtime-migration-plan.md`

- [ ] **Step 1: Update CLAUDE.md real-time invariant**

In `harmony-api/CLAUDE.md`, find the Critical Invariants section, invariant #5 (line mentioning "Real-Time"). Update to:

```
5. **Real-Time:** `GET /v1/events` SSE endpoint streams events to connected clients. Mutation handlers publish events via the EventBus (PG LISTEN/NOTIFY for multi-instance delivery). PresenceTracker uses Postgres `presence_sessions` table with local DashMap cache. K8s-ready with zero additional infrastructure. See ADR-SSE-001 through ADR-SSE-007 in `dev/active/sse-realtime-migration/`.
```

- [ ] **Step 2: Update the migration plan ADR-SSE-002**

In `dev/active/sse-realtime-migration/sse-realtime-migration-plan.md`, update the ADR-SSE-002 section (around line 377) to note the decision was changed:

```markdown
### ADR-SSE-002: Event Emission from Handlers via PG LISTEN/NOTIFY

**Decision (updated 2026-04-27):** Handlers emit events to an in-process
broadcast channel + async `pg_notify()`. PgListener on each instance forwards
remote events to the local broadcast, deduplicating via instance_id.
**Original decision:** In-process broadcast only, with Redis Pub/Sub planned.
**Why changed:** Postgres LISTEN/NOTIFY provides multi-instance support with
zero new infrastructure. See `docs/superpowers/specs/2026-04-27-pg-notify-k8s-native-sse-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add harmony-api/CLAUDE.md dev/active/sse-realtime-migration/sse-realtime-migration-plan.md
git commit -m "docs: update sse architecture docs for pg listen/notify"
```
