//! SSE event stream handler.
//!
//! `GET /v1/events` — single persistent connection per user that delivers
//! all real-time events (messages, members, channels, DMs, presence).
//!
//! Auth: Bearer JWT via the `require_auth` middleware (same as all endpoints).

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio::sync::watch;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::state::AppState;
use crate::domain::models::{ServerEvent, ServerId, UserId, UserStatus};

/// Guard that decrements a user's connection count when the SSE stream is dropped.
///
/// WHY: Without this, offline detection relies on the background sweep (60s interval,
/// 90s `max_age` = up to 150s delay). The guard fires instantly on disconnect.
///
/// Uses `PresenceTracker::disconnect()` which decrements the connection counter.
/// The offline event is only published when the last connection drops (count → 0),
/// so closing one tab while another is still open does NOT mark the user offline.
struct PresenceGuard {
    user_id: UserId,
    state: AppState,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let went_offline = self.state.presence_tracker().disconnect(&self.user_id);
        if went_offline {
            let event = ServerEvent::PresenceChanged {
                sender_id: self.user_id.clone(),
                user_id: self.user_id.clone(),
                status: UserStatus::Offline,
            };
            self.state.event_bus().publish(event);
            tracing::info!(user_id = %self.user_id.0, "last SSE connection dropped, user marked offline");
        } else {
            tracing::debug!(user_id = %self.user_id.0, "SSE connection dropped, other connections remain");
        }
    }
}

/// SSE event stream — delivers real-time events to the authenticated user.
///
/// The stream filters events based on:
/// 1. **Server scope**: only events for servers the user is a member of.
/// 2. **User scope**: user-targeted events (DMs, bans) only for this user.
/// 3. **Sender exclusion**: message events skip the sender (client has
///    optimistic UI).
///
/// **Dynamic `server_ids`**: The filter set is updated in-flight when the user
/// joins/leaves a server or a DM is created targeting them. This eliminates
/// the need for client-side reconnects on membership changes.
///
/// The stream pipeline has two stages:
/// - **Stage 1 (intercept)**: `.map()` — detects membership-change events
///   affecting this user and updates the `watch` channel.
/// - **Stage 2 (filter + serialize)**: `.filter_map()` — reads the latest
///   `server_ids` from the `watch` channel to filter and serialize events.
///
/// On reconnect, the client invalidates all queries (ADR-SSE-006) — no
/// event buffering or `Last-Event-ID` replay needed.
///
/// **Presence lifecycle**: On connect, the user is marked online in the
/// `PresenceTracker` and a `PresenceChanged` event is emitted. A heartbeat
/// stream calls `touch()` every 30s so the background sweep (in main.rs)
/// knows the connection is still alive.
///
/// # Errors
/// Returns `ApiError` if the user's server list cannot be fetched.
#[utoipa::path(
    get,
    path = "/v1/events",
    tag = "Events",
    security(("bearer_auth" = [])),
    responses(
        (status = 200, description = "SSE event stream (text/event-stream)", content_type = "text/event-stream"),
        (status = 401, description = "Unauthorized", body = ProblemDetails),
    )
)]
#[tracing::instrument(skip(state), fields(user_id = %user_id.0))]
pub async fn sse_events(
    AuthUser(user_id): AuthUser,
    State(state): State<AppState>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // Fetch the user's server memberships to build the filter set.
    // WHY list_all_memberships (not list_for_user): list_for_user excludes DMs
    // (correct for the sidebar API), but the SSE stream must include DM events.
    let server_ids: HashSet<ServerId> = state
        .server_service()
        .list_all_memberships(&user_id)
        .await?
        .into_iter()
        .collect();

    // WHY: watch channel allows Stage 1 (intercept) to update server_ids
    // in-flight when the user joins/leaves a server or receives a DM. Stage 2
    // (filter) reads the latest value via borrow(). This eliminates the need
    // for client-side SSE reconnects on membership changes.
    let (watch_tx, watch_rx) = watch::channel(server_ids.clone());

    // ── Presence: mark user online ──────────────────────────────
    let server_id_vec: Vec<ServerId> = server_ids.iter().cloned().collect();
    state
        .presence_tracker()
        .connect(user_id.clone(), server_id_vec);

    let online_event = ServerEvent::PresenceChanged {
        sender_id: user_id.clone(),
        user_id: user_id.clone(),
        status: UserStatus::Online,
    };

    // WHY: Subscribe BEFORE publish so the new subscriber does not miss
    // events published between publish() and subscribe() (race condition).
    let rx = state.event_bus().subscribe();

    let receivers = state.event_bus().publish(online_event);
    tracing::info!(
        server_count = server_ids.len(),
        receivers,
        "SSE connection established, user marked online"
    );

    // Clone user_id for the heartbeat stream and guard before moving into event closures.
    let heartbeat_user_id = user_id.clone();
    let guard_user_id = user_id.clone();
    let intercept_user_id = user_id.clone();

    // ── Stage 1 (intercept): update server_ids on membership changes ──
    // WHY: MemberJoined for a server the user just joined has server_id = X,
    // but X is NOT in the snapshot yet. Without this intercept, Stage 2 would
    // drop the event before the user ever sees it. By updating the watch
    // channel BEFORE filtering, Stage 2 sees the updated set for THIS event.
    let intercept_stream = BroadcastStream::new(rx).map(move |result| {
        let event = match result {
            Ok(ref event) => event,
            Err(_) => return result,
        };

        match event {
            // WHY: When THIS user joins a server, add the server_id so
            // subsequent events (and this MemberJoined itself) pass the filter.
            ServerEvent::MemberJoined {
                server_id, member, ..
            } if member.user_id == intercept_user_id => {
                let sid = server_id.clone();
                watch_tx.send_modify(|set| {
                    if set.insert(sid.clone()) {
                        tracing::debug!(
                            %sid,
                            "server_ids watch: added (MemberJoined)"
                        );
                    }
                });
            }
            // WHY: When THIS user is removed from a server, remove the
            // server_id so subsequent events are no longer delivered.
            ServerEvent::MemberRemoved {
                server_id, user_id, ..
            } if *user_id == intercept_user_id => {
                let sid = server_id.clone();
                watch_tx.send_modify(|set| {
                    if set.remove(&sid) {
                        tracing::debug!(
                            %sid,
                            "server_ids watch: removed (MemberRemoved)"
                        );
                    }
                });
            }
            // WHY: DmCreated carries sender_id (creator) and target_user_id
            // (recipient). Both participants need the DM server_id in their
            // filter sets to receive messages. The recipient matches on
            // target_user_id; the creator matches on sender_id.
            ServerEvent::DmCreated {
                sender_id,
                target_user_id,
                dm,
            } if *target_user_id == intercept_user_id || *sender_id == intercept_user_id => {
                let sid = dm.server_id.clone();
                watch_tx.send_modify(|set| {
                    if set.insert(sid.clone()) {
                        tracing::debug!(
                            %sid,
                            "server_ids watch: added (DmCreated)"
                        );
                    }
                });
            }
            _ => {}
        }

        result
    });

    // ── Stage 2 (filter + serialize): apply server_ids filter ─────────
    let event_stream = intercept_stream.filter_map(move |result| {
        let event = match result {
            Ok(event) => event,
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(count)) => {
                // WHY: Slow consumer missed events. Log and continue —
                // client will catch up via query invalidation on next
                // reconnect (ADR-SSE-006).
                tracing::warn!(
                    missed_events = count,
                    "SSE consumer lagged behind broadcast"
                );
                return None;
            }
        };

        // WHY: Read the LATEST server_ids from the watch channel. Stage 1
        // may have just updated it for this very event (e.g. MemberJoined
        // adding a new server_id), so borrow() reflects the new state.
        let current_server_ids = watch_rx.borrow();

        // ── Filter: target_user_id BEFORE server scope ────────────
        // WHY: Events like ForceDisconnect and MemberBanned have BOTH
        // server_id and target_user_id. If the server-scope filter ran
        // first, it would pass the event through to all server members.
        // But these are directed — only the target should receive them.
        // Checking target_user_id first also handles the race where
        // a kicked/banned user's server_ids snapshot no longer contains
        // the server (the event would be dropped before reaching them).
        if let Some(target) = event.target_user_id() {
            // WHY: DmCreated carries both sender_id and target_user_id.
            // Both participants need the event — the recipient (target)
            // and the creator on their OTHER devices (multi-device support).
            // Other targeted events (ForceDisconnect, MemberBanned) only
            // go to the target, so this check is DmCreated-specific.
            let is_dm_sender = matches!(
                &event,
                ServerEvent::DmCreated { sender_id, .. } if *sender_id == user_id
            );
            if *target != user_id && !is_dm_sender {
                return None; // Not for this user
            }
            // IS for this user — bypass server_ids check
        } else if let Some(event_server_id) = event.server_id()
            && !current_server_ids.contains(event_server_id)
        {
            return None; // User not in this server
        }

        // Explicitly drop the borrow before serialization to release the lock.
        drop(current_server_ids);

        // ── Filter: user-scoped events without server_id ──────────
        // DmCreated always has target_user_id (handled above).
        // PresenceChanged has no target — it broadcasts to all. For now,
        // let it through (presence is global). The client filters by
        // displayed server.

        // ── Filter: sender exclusion (message events only) ────────
        // WHY: The sender already has optimistic UI. Receiving their own
        // event would cause duplicate renders.
        let is_message_event = matches!(
            event.event_name(),
            "message.created" | "message.updated" | "message.deleted"
        );
        if is_message_event && *event.sender_id() == user_id {
            return None;
        }

        // Serialize the event payload as JSON for the SSE `data:` field.
        let data = match serde_json::to_string(&event) {
            Ok(json) => json,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    event_type = event.event_name(),
                    "Failed to serialize SSE event"
                );
                return None;
            }
        };

        Some(Ok(Event::default().event(event.event_name()).data(data)))
    });

    // ── Heartbeat stream: calls touch() every 30s ───────────────
    // WHY: The background sweep task (main.rs) removes presence entries
    // with last_heartbeat older than 90s. This touch keeps the entry
    // alive as long as the SSE connection is open. The 30s interval
    // matches the SSE keep-alive, giving a 60s buffer before sweep.
    // WHY: AppState is cheap to clone (all fields are Arc).
    let heartbeat_state = state.clone();
    let heartbeat_interval = tokio::time::interval(Duration::from_secs(30));
    let heartbeat_stream = tokio_stream::wrappers::IntervalStream::new(heartbeat_interval)
        .filter_map(move |_| {
            heartbeat_state.presence_tracker().touch(&heartbeat_user_id);
            // WHY: Return None — heartbeat touches are side-effects only.
            // The SSE keep-alive (Axum KeepAlive) handles the actual comment
            // sent to the client. This stream just refreshes the presence entry.
            None::<Result<Event, Infallible>>
        });

    // ── Presence snapshot: initial sync event ───────────────────
    // WHY: Clients that connect after other users are already online have no
    // way to learn their status — PresenceChanged events are ephemeral.
    // Emitting a presence.sync event as the first SSE event gives every client
    // a full snapshot on connect (and reconnect). This is the "initial snapshot
    // + incremental deltas" pattern (à la Discord READY).
    // WHY not in ServerEvent enum: this is a per-connection synthetic event,
    // never published to the broadcast bus.
    let mut presence_users: HashMap<String, UserStatus> = HashMap::new();
    for sid in &server_ids {
        for (uid, status) in state.presence_tracker().get_server_presence(sid) {
            presence_users.insert(uid.0.to_string(), status);
        }
    }
    let sync_data = serde_json::json!({
        "type": "presenceSynced",
        "users": presence_users,
    });
    let initial_event = Event::default()
        .event("presence.sync")
        .data(sync_data.to_string());
    let initial_stream = tokio_stream::once(Ok::<Event, Infallible>(initial_event));

    // ── Disconnect guard: instant offline on stream drop ─────────
    // WHY: Capturing the guard in a `.map()` closure ties its lifetime to the
    // stream. When Axum drops the stream (client disconnect), the closure is
    // dropped, which drops the guard, which calls `disconnect()`. If the
    // connection count reaches 0, it publishes the offline event. The
    // background sweep remains as a safety net (e.g., process crash).
    let guard = PresenceGuard {
        user_id: guard_user_id,
        state: state.clone(),
    };

    // Merge event delivery with heartbeat touches, prepend presence snapshot.
    let merged = initial_stream
        .chain(event_stream.merge(heartbeat_stream))
        .map(move |item| {
            let _guard = &guard;
            item
        });

    Ok(Sse::new(merged).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("heartbeat"),
    ))
}
