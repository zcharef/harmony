//! Postgres-backed presence tracker with local `DashMap` read cache.
//!
//! Writes go to Postgres via a background worker (mpsc channel); reads come
//! from the local `DashMap` for zero-latency lookups. Cross-instance sync
//! happens via LISTEN/NOTIFY on the `harmony_presence` channel.
//!
//! Replaces the in-memory-only `PresenceTracker` to support multi-instance
//! deployments (ADR-SSE-002).

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::domain::models::{ServerId, UserId, UserStatus};

/// Postgres LISTEN/NOTIFY channel name for cross-instance presence sync.
pub const PRESENCE_CHANNEL: &str = "harmony_presence";

/// A single user's presence state (local cache entry).
#[derive(Debug, Clone)]
pub struct PresenceEntry {
    /// Current status (Online, Idle, `DoNotDisturb`).
    pub status: UserStatus,
    /// Servers this user belongs to (for broadcasting presence to co-members).
    pub server_ids: Vec<ServerId>,
    /// Monotonic timestamp of last heartbeat (for stale-entry sweeps).
    pub last_heartbeat: Instant,
    /// Number of active SSE connections for this user.
    /// WHY: Multi-tab / multi-device support. The user goes offline only when
    /// the last connection drops (count reaches 0).
    pub connection_count: u32,
}

/// Commands sent to the background write worker via mpsc.
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

/// Wire format for Postgres NOTIFY payloads on the presence channel.
///
/// WHY: Short field names (`i`, `u`, `a`, `s`) to minimize payload size —
/// Postgres NOTIFY has an 8 KB limit.
#[derive(Debug, Serialize, Deserialize)]
pub struct PresenceEnvelope {
    /// Originating instance ID — used to skip self-originated events.
    pub i: Uuid,
    /// User ID.
    pub u: Uuid,
    /// Action: "online", "idle", "dnd", "offline".
    pub a: String,
    /// Server IDs the user belongs to.
    pub s: Vec<Uuid>,
}

/// Postgres-backed presence tracker with local `DashMap` read cache.
///
/// All sync methods update the `DashMap` immediately (instant local reads)
/// and send a command to the mpsc channel for async Postgres persistence.
#[derive(Debug)]
pub struct PgPresenceTracker {
    instance_id: Uuid,
    pool: PgPool,
    local_cache: Arc<DashMap<UserId, PresenceEntry>>,
    write_tx: mpsc::UnboundedSender<PresenceCommand>,
}

impl PgPresenceTracker {
    /// Create a new tracker and return the mpsc receiver for the write worker.
    ///
    /// The caller must spawn `presence_write_worker` with the returned receiver.
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

    /// Register a new SSE connection for a user.
    ///
    /// Updates `DashMap` immediately, then sends Connect command to the write worker
    /// for async Postgres persistence.
    pub fn connect(&self, user_id: UserId, server_ids: Vec<ServerId>) {
        self.local_cache
            .entry(user_id.clone())
            .and_modify(|entry| {
                entry.connection_count += 1;
                entry.server_ids = server_ids.clone();
                entry.last_heartbeat = Instant::now();
            })
            .or_insert(PresenceEntry {
                status: UserStatus::Online,
                server_ids: server_ids.clone(),
                last_heartbeat: Instant::now(),
                connection_count: 1,
            });

        if let Err(err) = self.write_tx.send(PresenceCommand::Connect {
            user_id,
            server_ids,
        }) {
            tracing::warn!(
                error = %err,
                "presence write_tx send failed — write worker may have stopped"
            );
        }
    }

    /// Unregister an SSE connection for a user.
    ///
    /// Decrements `connection_count` in `DashMap`. Returns `true` if the user went
    /// fully offline (count reached 0 and entry was removed). Uses the same
    /// two-step pattern as the old `PresenceTracker`.
    #[must_use]
    pub fn disconnect(&self, user_id: &UserId) -> bool {
        // WHY two-step: DashMap doesn't support "decrement then conditionally
        // remove" atomically. The `remove_if` re-acquires the shard lock and
        // checks the count, so a concurrent `connect()` between the two steps
        // would bump the count back above 0 and `remove_if` would correctly
        // keep the entry.
        if let Some(mut entry) = self.local_cache.get_mut(user_id) {
            entry.connection_count = entry.connection_count.saturating_sub(1);
        }

        let went_offline = self
            .local_cache
            .remove_if(user_id, |_, entry| entry.connection_count == 0)
            .is_some();

        if went_offline
            && let Err(err) = self.write_tx.send(PresenceCommand::Disconnect {
                user_id: user_id.clone(),
            })
        {
            tracing::warn!(
                error = %err,
                "presence write_tx send failed — write worker may have stopped"
            );
        }

        went_offline
    }

    /// Update a user's status without changing `server_ids`.
    ///
    /// No-op if the user has no presence entry (not connected).
    pub fn set_status(&self, user_id: &UserId, status: UserStatus) {
        if let Some(mut entry) = self.local_cache.get_mut(user_id) {
            entry.status = status.clone();
            entry.last_heartbeat = Instant::now();
        }

        if let Err(err) = self.write_tx.send(PresenceCommand::SetStatus {
            user_id: user_id.clone(),
            status,
        }) {
            tracing::warn!(
                error = %err,
                "presence write_tx send failed — write worker may have stopped"
            );
        }
    }

    /// Get a user's current status, or `None` if they have no presence entry.
    #[must_use]
    pub fn get_status(&self, user_id: &UserId) -> Option<UserStatus> {
        self.local_cache.get(user_id).map(|e| e.status.clone())
    }

    /// Return all online users for a given server with their current status.
    ///
    /// Iterates the full map — acceptable at small-to-medium scale.
    #[must_use]
    pub fn get_server_presence(&self, server_id: &ServerId) -> Vec<(UserId, UserStatus)> {
        self.local_cache
            .iter()
            .filter(|entry| entry.value().server_ids.contains(server_id))
            .map(|entry| (entry.key().clone(), entry.value().status.clone()))
            .collect()
    }

    /// Refresh a user's heartbeat timestamp to now.
    ///
    /// No-op if the user has no presence entry.
    pub fn touch(&self, user_id: &UserId) {
        if let Some(mut entry) = self.local_cache.get_mut(user_id) {
            entry.last_heartbeat = Instant::now();
        }

        if let Err(err) = self.write_tx.send(PresenceCommand::Touch {
            user_id: user_id.clone(),
        }) {
            tracing::warn!(
                error = %err,
                "presence write_tx send failed — write worker may have stopped"
            );
        }
    }

    /// Populate the local `DashMap` cache from Postgres on startup.
    ///
    /// # Errors
    /// Returns `sqlx::Error` if the SELECT query fails.
    pub async fn hydrate(&self) -> Result<(), sqlx::Error> {
        let rows = sqlx::query!(r#"SELECT user_id, status, server_ids FROM presence_sessions"#)
            .fetch_all(&self.pool)
            .await?;

        for row in rows {
            let user_id = UserId(row.user_id);
            let status = match row.status.as_str() {
                "online" => UserStatus::Online,
                "idle" => UserStatus::Idle,
                "dnd" => UserStatus::DoNotDisturb,
                _ => UserStatus::Offline,
            };
            let server_ids: Vec<ServerId> = row.server_ids.into_iter().map(ServerId).collect();

            self.local_cache
                .entry(user_id)
                .and_modify(|entry| {
                    entry.status = status.clone();
                    entry.server_ids = server_ids.clone();
                    entry.last_heartbeat = Instant::now();
                    entry.connection_count += 1;
                })
                .or_insert(PresenceEntry {
                    status,
                    server_ids,
                    last_heartbeat: Instant::now(),
                    connection_count: 1,
                });
        }

        tracing::info!(
            entries = self.local_cache.len(),
            "presence cache hydrated from postgres"
        );

        Ok(())
    }

    /// Remove stale presence entries from Postgres and local cache.
    ///
    /// WHY: Uses a fixed 90-second interval in SQL rather than the caller's
    /// `max_age` — the Postgres heartbeat cadence is the authoritative timeout.
    /// The `_max_age` parameter preserves API compatibility with the old
    /// `PresenceTracker::sweep_stale` signature.
    pub async fn sweep_stale(&self, _max_age: Duration) -> Vec<UserId> {
        let rows = match sqlx::query!(
            r#"DELETE FROM presence_sessions
               WHERE last_heartbeat < now() - INTERVAL '90 seconds'
               RETURNING user_id"#
        )
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(error = %err, "sweep_stale SQL failed");
                return Vec::new();
            }
        };

        let removed: Vec<UserId> = rows.iter().map(|r| UserId(r.user_id)).collect();

        for uid in &removed {
            self.local_cache.remove(uid);
        }

        if !removed.is_empty() {
            tracing::info!(count = removed.len(), "swept stale presence entries");
        }

        removed
    }

    /// Delete all presence rows for this instance (graceful shutdown cleanup).
    pub async fn cleanup_instance(&self) {
        if let Err(err) = sqlx::query!(
            r#"DELETE FROM presence_sessions WHERE instance_id = $1"#,
            self.instance_id
        )
        .execute(&self.pool)
        .await
        {
            tracing::warn!(
                error = %err,
                instance_id = %self.instance_id,
                "cleanup_instance SQL failed"
            );
        }
    }

    /// Clone the Arc<DashMap> for sharing with the listen worker.
    #[must_use]
    pub fn local_cache_handle(&self) -> Arc<DashMap<UserId, PresenceEntry>> {
        Arc::clone(&self.local_cache)
    }

    /// This instance's unique ID.
    #[must_use]
    pub fn instance_id(&self) -> Uuid {
        self.instance_id
    }
}

// ── Background Workers ───────────────────────────────────────────────

/// Helper: serialize and send a presence notification via `pg_notify`.
async fn notify_presence(pool: &PgPool, envelope: &PresenceEnvelope) {
    let payload = match serde_json::to_string(envelope) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(error = %err, "failed to serialize presence envelope");
            return;
        }
    };

    // WHY: Uses runtime sqlx::query (not macro) for pg_notify — matches the
    // existing pattern in pg_notify_event_bus.rs. pg_notify is a function call,
    // not a table query, so compile-time checking adds no value.
    if let Err(err) = sqlx::query("SELECT pg_notify($1, $2)")
        .bind(PRESENCE_CHANNEL)
        .bind(&payload)
        .execute(pool)
        .await
    {
        tracing::warn!(
            error = %err,
            "pg_notify failed for presence — remote instances will miss this update"
        );
    }
}

/// Convert a `UserStatus` to its wire-format action string.
fn status_to_action(status: &UserStatus) -> &'static str {
    match status {
        UserStatus::Online => "online",
        UserStatus::Idle => "idle",
        UserStatus::DoNotDisturb => "dnd",
        UserStatus::Offline => "offline",
    }
}

/// Background worker: drains the mpsc queue and persists presence changes to Postgres.
///
/// Exits when the mpsc sender is dropped (`PgPresenceTracker` dropped).
pub async fn presence_write_worker(
    pool: PgPool,
    instance_id: Uuid,
    mut rx: mpsc::UnboundedReceiver<PresenceCommand>,
) {
    tracing::info!(%instance_id, "presence write worker started");

    while let Some(cmd) = rx.recv().await {
        match cmd {
            PresenceCommand::Connect {
                user_id,
                server_ids,
            } => {
                let server_id_uuids: Vec<Uuid> = server_ids.iter().map(|s| s.0).collect();

                if let Err(err) = sqlx::query!(
                    r#"INSERT INTO presence_sessions (user_id, instance_id, server_ids, last_heartbeat)
                       VALUES ($1, $2, $3, now())
                       ON CONFLICT (user_id, instance_id) DO UPDATE SET
                           connection_count = presence_sessions.connection_count + 1,
                           server_ids = $3,
                           last_heartbeat = now()"#,
                    user_id.0,
                    instance_id,
                    &server_id_uuids,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(
                        error = %err,
                        user_id = %user_id,
                        "presence connect upsert failed"
                    );
                }

                notify_presence(
                    &pool,
                    &PresenceEnvelope {
                        i: instance_id,
                        u: user_id.0,
                        a: "online".to_owned(),
                        s: server_id_uuids,
                    },
                )
                .await;
            }

            PresenceCommand::Disconnect { user_id } => {
                // WHY: Decrement first, then delete if count reached zero.
                // This mirrors the local DashMap two-step pattern.
                if let Err(err) = sqlx::query!(
                    r#"UPDATE presence_sessions
                       SET connection_count = connection_count - 1
                       WHERE user_id = $1 AND instance_id = $2"#,
                    user_id.0,
                    instance_id,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(
                        error = %err,
                        user_id = %user_id,
                        "presence disconnect decrement failed"
                    );
                }

                if let Err(err) = sqlx::query!(
                    r#"DELETE FROM presence_sessions
                       WHERE user_id = $1 AND instance_id = $2 AND connection_count <= 0"#,
                    user_id.0,
                    instance_id,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(
                        error = %err,
                        user_id = %user_id,
                        "presence disconnect delete failed"
                    );
                }

                // WHY: Check if the user still has connections on ANY instance
                // before broadcasting offline. Only notify offline if fully gone.
                let still_connected = sqlx::query!(
                    r#"SELECT 1 as "exists!" FROM presence_sessions WHERE user_id = $1 LIMIT 1"#,
                    user_id.0,
                )
                .fetch_optional(&pool)
                .await;

                match still_connected {
                    Ok(None) => {
                        // Fully offline — notify other instances.
                        notify_presence(
                            &pool,
                            &PresenceEnvelope {
                                i: instance_id,
                                u: user_id.0,
                                a: "offline".to_owned(),
                                s: Vec::new(),
                            },
                        )
                        .await;
                    }
                    Ok(Some(_)) => {
                        // Still connected on another instance — no notification.
                    }
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            user_id = %user_id,
                            "presence disconnect existence check failed"
                        );
                    }
                }
            }

            PresenceCommand::Touch { user_id } => {
                if let Err(err) = sqlx::query!(
                    r#"UPDATE presence_sessions
                       SET last_heartbeat = now()
                       WHERE user_id = $1 AND instance_id = $2"#,
                    user_id.0,
                    instance_id,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(
                        error = %err,
                        user_id = %user_id,
                        "presence touch update failed"
                    );
                }
            }

            PresenceCommand::SetStatus { user_id, status } => {
                let action = status_to_action(&status);

                if let Err(err) = sqlx::query!(
                    r#"UPDATE presence_sessions
                       SET status = $1, last_heartbeat = now()
                       WHERE user_id = $2 AND instance_id = $3"#,
                    action,
                    user_id.0,
                    instance_id,
                )
                .execute(&pool)
                .await
                {
                    tracing::warn!(
                        error = %err,
                        user_id = %user_id,
                        "presence set_status update failed"
                    );
                }

                // WHY: Fetch server_ids for the notification envelope so
                // remote instances can update their caches with full context.
                let server_ids = match sqlx::query!(
                    r#"SELECT server_ids FROM presence_sessions
                       WHERE user_id = $1 AND instance_id = $2"#,
                    user_id.0,
                    instance_id,
                )
                .fetch_optional(&pool)
                .await
                {
                    Ok(Some(row)) => row.server_ids,
                    Ok(None) => Vec::new(),
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            user_id = %user_id,
                            "presence set_status server_ids fetch failed"
                        );
                        Vec::new()
                    }
                };

                notify_presence(
                    &pool,
                    &PresenceEnvelope {
                        i: instance_id,
                        u: user_id.0,
                        a: action.to_owned(),
                        s: server_ids,
                    },
                )
                .await;
            }
        }
    }

    tracing::info!(%instance_id, "presence write worker exiting — mpsc closed");
}

/// Background worker: listens for Postgres NOTIFY on the presence channel
/// and updates the local `DashMap` cache for remote instance events.
///
/// Uses the same exponential backoff reconnect pattern as `event_listen_worker`.
pub async fn presence_listen_worker(
    pool: PgPool,
    instance_id: Uuid,
    local_cache: Arc<DashMap<UserId, PresenceEntry>>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(30);

    tracing::info!(%instance_id, "presence listen worker started");

    loop {
        if cancel.is_cancelled() {
            break;
        }

        let mut listener = match PgListener::connect_with(&pool).await {
            Ok(l) => {
                backoff = Duration::from_secs(1);
                l
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    backoff_secs = backoff.as_secs(),
                    "failed to connect PgListener for presence — retrying"
                );
                tokio::select! {
                    () = tokio::time::sleep(backoff) => {}
                    () = cancel.cancelled() => break,
                }
                backoff = (backoff * 2).min(max_backoff);
                continue;
            }
        };

        if let Err(err) = listener.listen(PRESENCE_CHANNEL).await {
            tracing::warn!(
                error = %err,
                "failed to LISTEN on presence channel — reconnecting"
            );
            tokio::select! {
                () = tokio::time::sleep(backoff) => {}
                () = cancel.cancelled() => break,
            }
            backoff = (backoff * 2).min(max_backoff);
            continue;
        }

        tracing::info!("presence listener subscribed to {PRESENCE_CHANNEL}");

        // WHY: Inner loop handles notifications until a recv error triggers reconnect.
        loop {
            tokio::select! {
                result = listener.recv() => {
                    match result {
                        Ok(notification) => {
                            let envelope = match serde_json::from_str::<PresenceEnvelope>(notification.payload()) {
                                Ok(env) => env,
                                Err(err) => {
                                    tracing::warn!(
                                        error = %err,
                                        payload_len = notification.payload().len(),
                                        "failed to deserialize presence envelope — skipping"
                                    );
                                    continue;
                                }
                            };

                            // WHY: Skip events from this instance — already applied locally.
                            if envelope.i == instance_id {
                                continue;
                            }

                            let user_id = UserId(envelope.u);
                            let server_ids: Vec<ServerId> = envelope.s.into_iter().map(ServerId).collect();

                            if envelope.a == "offline" {
                                local_cache.remove(&user_id);
                            } else {
                                let status = match envelope.a.as_str() {
                                    "online" => UserStatus::Online,
                                    "idle" => UserStatus::Idle,
                                    "dnd" => UserStatus::DoNotDisturb,
                                    _ => UserStatus::Online,
                                };

                                local_cache
                                    .entry(user_id)
                                    .and_modify(|entry| {
                                        entry.status = status.clone();
                                        entry.server_ids = server_ids.clone();
                                        entry.last_heartbeat = Instant::now();
                                    })
                                    .or_insert(PresenceEntry {
                                        status,
                                        server_ids,
                                        last_heartbeat: Instant::now(),
                                        connection_count: 1,
                                    });
                            }
                        }
                        Err(err) => {
                            tracing::warn!(
                                error = %err,
                                "presence listener recv error — reconnecting"
                            );
                            break;
                        }
                    }
                }
                () = cancel.cancelled() => {
                    tracing::info!("presence listen worker shutting down");
                    return;
                }
            }
        }

        // WHY: After inner loop breaks (recv error), apply backoff before reconnect.
        tokio::select! {
            () = tokio::time::sleep(backoff) => {}
            () = cancel.cancelled() => break,
        }
        backoff = (backoff * 2).min(max_backoff);
    }

    tracing::info!(%instance_id, "presence listen worker exiting");
}
