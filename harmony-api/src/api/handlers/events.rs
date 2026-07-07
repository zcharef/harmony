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
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;

use crate::api::errors::{ApiError, ProblemDetails};
use crate::api::extractors::AuthUser;
use crate::api::state::AppState;
use crate::domain::models::{ServerEvent, ServerId, UserId, UserStatus};

/// Ends the wrapped broadcast stream at the first `Lagged` error.
///
/// WHY: A lagged consumer has permanently MISSED events — the broadcast
/// channel already overwrote them and there is no replay buffer. Skipping
/// the error and continuing would leave the client silently out of sync
/// until some unrelated reconnect. Terminating the stream instead makes the
/// client auto-reconnect, and reconnect IS the resync mechanism: the client
/// invalidates all queries on reconnect (ADR-SSE-006).
fn take_until_lagged<T>(
    stream: impl tokio_stream::Stream<Item = Result<T, BroadcastStreamRecvError>>,
) -> impl tokio_stream::Stream<Item = T> {
    stream
        .take_while(|result| match result {
            Ok(_) => true,
            Err(BroadcastStreamRecvError::Lagged(count)) => {
                tracing::warn!(
                    missed_events = *count,
                    "SSE consumer lagged behind broadcast — terminating stream to force client resync"
                );
                false
            }
        })
        .filter_map(Result::ok)
}

/// Guard that decrements a user's connection count when the SSE stream is dropped.
///
/// WHY: Without this, offline detection relies on the background sweep (60s interval,
/// 90s `max_age` = up to 150s delay). The guard fires instantly on disconnect.
///
/// Uses `PgPresenceTracker::disconnect()` which decrements the connection counter.
/// The offline event is only published when the last connection drops (count → 0),
/// so closing one tab while another is still open does NOT mark the user offline.
struct PresenceGuard {
    user_id: UserId,
    state: AppState,
    /// Live view of the user's server memberships (kept current by Stage 1),
    /// so the offline event carries accurate routing scope at drop time.
    server_ids: watch::Receiver<HashSet<ServerId>>,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let went_offline = self.state.presence_tracker().disconnect(&self.user_id);
        if went_offline {
            let event = ServerEvent::PresenceChanged {
                sender_id: self.user_id.clone(),
                user_id: self.user_id.clone(),
                status: UserStatus::Offline,
                server_ids: self.server_ids.borrow().iter().cloned().collect(),
            };
            self.state.event_bus().publish(event);
            tracing::info!(user_id = %self.user_id.0, "last SSE connection dropped, user marked offline");
        } else {
            tracing::debug!(user_id = %self.user_id.0, "SSE connection dropped, other connections remain");
        }
    }
}

/// Decides whether a `PresenceChanged` for `subject` is visible to `receiver`.
///
/// Visible when the receiver IS the subject (own status must sync across
/// tabs/devices), or when they share at least one server (DMs are servers, so
/// DM partners are covered). An EMPTY `subject_servers` means the publisher
/// could not scope the event (older instance during a rolling deploy, or a
/// membership lookup failure) — fail OPEN to the previous broadcast behavior
/// rather than silently dropping presence updates.
fn presence_visible_to(
    subject: &UserId,
    subject_servers: &[ServerId],
    receiver: &UserId,
    receiver_servers: &HashSet<ServerId>,
) -> bool {
    if receiver == subject {
        return true;
    }
    if subject_servers.is_empty() {
        return true;
    }
    subject_servers
        .iter()
        .any(|sid| receiver_servers.contains(sid))
}

/// Aborts the wrapped task when dropped.
///
/// WHY: The presence-touch heartbeat runs as a spawned task, NOT as a stream
/// merged into the SSE response. A merged `IntervalStream` never completes, and
/// `merge` only ends when BOTH sides end — it would keep the HTTP response open
/// after `take_until_lagged` terminates the event stream, defeating the forced
/// reconnect (the client's keep-alive watchdog stays happy on `:heartbeat`
/// comments alone). Tying the task to the stream's drop keeps its lifetime
/// identical to the old merged version.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
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
/// `PgPresenceTracker` and a `PresenceChanged` event is emitted. A heartbeat
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
    // Second receiver for the disconnect guard: the offline event must carry
    // the CURRENT membership set, not the connect-time snapshot.
    let guard_watch_rx = watch_rx.clone();

    // ── Presence: register connection, broadcast effective status ──
    // WHY: connect() returns the EFFECTIVE status atomically — a brand-new
    // presence is Online, but a reconnect or second-tab user who is dnd/idle
    // keeps that status. Broadcasting a hardcoded Online here would silently reset
    // DND to online for every observer on every SSE reconnect (routine on the
    // ~50-min JWT-rotation timer). Using connect()'s return value — rather than a
    // separate get_status() — guarantees this local broadcast matches the value
    // the cross-instance NOTIFY carries (no TOCTOU on a concurrent status change).
    let server_id_vec: Vec<ServerId> = server_ids.iter().cloned().collect();
    let effective_status = state
        .presence_tracker()
        .connect(user_id.clone(), server_id_vec);

    let presence_event = ServerEvent::PresenceChanged {
        sender_id: user_id.clone(),
        user_id: user_id.clone(),
        status: effective_status.clone(),
        server_ids: server_ids.iter().cloned().collect(),
    };

    // WHY: Subscribe BEFORE publish so the new subscriber does not miss
    // events published between publish() and subscribe() (race condition).
    let rx = state.event_bus().subscribe();

    let receivers = state.event_bus().publish(presence_event);
    tracing::info!(
        server_count = server_ids.len(),
        receivers,
        status = ?effective_status,
        "SSE connection established, presence broadcast"
    );

    // Clone user_id for the heartbeat stream, guard, and unread query before moving into event closures.
    let heartbeat_user_id = user_id.clone();
    let guard_user_id = user_id.clone();
    let intercept_user_id = user_id.clone();
    let unread_user_id = user_id.clone();

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
    // WHY take_until_lagged between the stages: on broadcast lag the stream
    // must END (forcing the client to reconnect and resync, ADR-SSE-006)
    // rather than skip the error and keep a permanently out-of-sync client.
    let event_stream = take_until_lagged(intercept_stream).filter_map(move |event| {
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

        // ── Filter: presence scope (shared server / DM / self) ─────
        // WHY: PresenceChanged has neither target_user_id nor server_id, so it
        // used to reach EVERY connected user — leaking online status (and its
        // timing) to strangers with no shared server or DM. The event now
        // carries the subject's memberships as routing metadata; deliver only
        // on overlap with this receiver's memberships (or to the subject
        // itself). The metadata is redacted below before serialization.
        if let ServerEvent::PresenceChanged {
            user_id: subject,
            server_ids: subject_servers,
            ..
        } = &event
            && !presence_visible_to(subject, subject_servers, &user_id, &current_server_ids)
        {
            return None;
        }

        // Explicitly drop the borrow before serialization to release the lock.
        drop(current_server_ids);

        // ── Redact routing metadata from the client payload ────────
        // WHY: server_ids exists for cross-instance routing (pg_notify) only.
        // An empty vec is skipped by serde, so the client-facing JSON stays
        // identical to the pre-scoping payload and the subject's full server
        // list never leaks to receivers.
        let event = match event {
            ServerEvent::PresenceChanged {
                sender_id,
                user_id,
                status,
                ..
            } => ServerEvent::PresenceChanged {
                sender_id,
                user_id,
                status,
                server_ids: Vec::new(),
            },
            other => other,
        };

        // ── Filter: sender exclusion (create/update only) ──────────
        // WHY: The sender already has optimistic UI for create and update.
        // message.deleted is NOT suppressed because moderation-triggered
        // deletions use the message author as sender_id — suppressing them
        // would prevent the author from seeing their message disappear.
        // The frontend handler (handleMessageDeleted) is idempotent, so
        // user-initiated deletes arriving twice (optimistic + SSE) are harmless.
        let is_self_echo = matches!(event.event_name(), "message.created" | "message.updated");
        if is_self_echo && *event.sender_id() == user_id {
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

    // ── Heartbeat task: calls touch() every 30s ─────────────────
    // WHY: The background sweep task (main.rs) removes presence entries
    // with last_heartbeat older than 90s. This touch keeps the entry
    // alive as long as the SSE connection is open. The 30s interval
    // matches the SSE keep-alive, giving a 60s buffer before sweep.
    // WHY a spawned task and not a stream merged into the response: see
    // `AbortOnDrop` — a merged interval stream never ends and would hold the
    // response open after the event stream terminates on broadcast lag.
    // WHY: AppState is cheap to clone (all fields are Arc).
    let heartbeat_state = state.clone();
    let heartbeat_guard = AbortOnDrop(tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            heartbeat_state.presence_tracker().touch(&heartbeat_user_id);
        }
    }));

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
    let presence_data = serde_json::json!({
        "type": "presenceSynced",
        "users": presence_users,
    });
    let presence_event = Event::default()
        .event("presence.sync")
        .data(presence_data.to_string());

    // ── Unread snapshot: initial sync event ──────────────────────
    // WHY: Clients need full unread counts on connect (and reconnect) without
    // N per-server REST calls. Same "initial snapshot + incremental deltas"
    // pattern as presence.sync (à la Discord READY).
    // WHY after subscribe(): the broadcast subscription (line 126) captures
    // events from this point. Running the SQL query after ensures no gap where
    // events are missed. Brief under-count window is accepted (see plan).
    // WHY synthetic (not ServerEvent): per-user data, cannot go through broadcast bus.
    let unread_states = state
        .read_state_service()
        .list_all_for_user(&unread_user_id)
        .await?;
    let mut unread_channels: HashMap<String, i64> = HashMap::new();
    for rs in &unread_states {
        unread_channels.insert(rs.channel_id.0.to_string(), rs.unread_count);
    }
    let unread_data = serde_json::json!({
        "type": "unreadSynced",
        "channels": unread_channels,
    });
    let unread_event = Event::default()
        .event("unread.sync")
        .data(unread_data.to_string());

    // WHY iter(vec![...]): both synthetic events must be emitted BEFORE any
    // broadcast events. chain() guarantees this ordering, preventing the
    // client from receiving message.created deltas before the snapshot.
    let initial_stream = tokio_stream::iter(vec![
        Ok::<Event, Infallible>(presence_event),
        Ok::<Event, Infallible>(unread_event),
    ]);

    // ── Disconnect guard: instant offline on stream drop ─────────
    // WHY: Capturing the guard in a `.map()` closure ties its lifetime to the
    // stream. When Axum drops the stream (client disconnect), the closure is
    // dropped, which drops the guard, which calls `disconnect()`. If the
    // connection count reaches 0, it publishes the offline event. The
    // background sweep remains as a safety net (e.g., process crash).
    let guard = PresenceGuard {
        user_id: guard_user_id,
        state: state.clone(),
        server_ids: guard_watch_rx,
    };

    // Prepend the snapshot events to the live event stream. The composed
    // stream ENDS when `event_stream` ends (broadcast lag) — that EOF is what
    // makes the client reconnect and resync (ADR-SSE-006). Both guards ride
    // the closure so presence disconnect + heartbeat abort fire on drop.
    let merged = initial_stream.chain(event_stream).map(move |item| {
        let _guard = &guard;
        let _heartbeat = &heartbeat_guard;
        item
    });

    Ok(Sse::new(merged).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("heartbeat"),
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn uid(n: u128) -> UserId {
        UserId::new(Uuid::from_u128(n))
    }
    fn sid(n: u128) -> ServerId {
        ServerId::new(Uuid::from_u128(n))
    }

    #[test]
    fn presence_hidden_from_users_with_no_shared_server() {
        let receiver_servers: HashSet<ServerId> = [sid(1), sid(2)].into();
        // Disjoint memberships — the stranger must not learn the status.
        assert!(!presence_visible_to(
            &uid(10),
            &[sid(3), sid(4)],
            &uid(20),
            &receiver_servers
        ));
    }

    #[test]
    fn presence_visible_with_shared_server_or_dm() {
        let receiver_servers: HashSet<ServerId> = [sid(1), sid(2)].into();
        // sid(2) is shared — DMs are servers too, so this covers DM partners.
        assert!(presence_visible_to(
            &uid(10),
            &[sid(2), sid(9)],
            &uid(20),
            &receiver_servers
        ));
    }

    #[test]
    fn presence_always_visible_to_self() {
        // Multi-device self-sync: even with zero shared/known servers.
        let receiver_servers: HashSet<ServerId> = HashSet::new();
        assert!(presence_visible_to(
            &uid(10),
            &[],
            &uid(10),
            &receiver_servers
        ));
    }

    #[test]
    fn presence_with_empty_scope_broadcasts() {
        // Empty routing metadata = older instance or lookup failure — fail
        // open to the legacy broadcast behavior, never drop the event.
        let receiver_servers: HashSet<ServerId> = [sid(1)].into();
        assert!(presence_visible_to(
            &uid(10),
            &[],
            &uid(20),
            &receiver_servers
        ));
    }

    #[test]
    fn presence_routing_metadata_is_omitted_when_redacted() {
        // The Stage-2 redaction empties server_ids; serde must then omit the
        // field entirely so the client payload is unchanged from pre-scoping.
        let redacted = ServerEvent::PresenceChanged {
            sender_id: uid(1),
            user_id: uid(1),
            status: UserStatus::Online,
            server_ids: Vec::new(),
        };
        let json = serde_json::to_string(&redacted).unwrap();
        assert!(
            !json.contains("serverIds"),
            "redacted payload leaked: {json}"
        );

        // The unredacted event (bus/pg_notify path) must carry it and survive
        // a serde round-trip so remote instances can scope delivery.
        let routed = ServerEvent::PresenceChanged {
            sender_id: uid(1),
            user_id: uid(1),
            status: UserStatus::Online,
            server_ids: vec![sid(7)],
        };
        let json = serde_json::to_string(&routed).unwrap();
        assert!(json.contains("serverIds"));
        let back: ServerEvent = serde_json::from_str(&json).unwrap();
        assert!(
            matches!(
                back,
                ServerEvent::PresenceChanged { ref server_ids, .. } if *server_ids == vec![sid(7)]
            ),
            "routing metadata must survive the bus round-trip"
        );
    }

    #[tokio::test]
    async fn take_until_lagged_terminates_stream_on_broadcast_lag() {
        // Tiny capacity so a burst of sends overflows the receiver.
        let (tx, rx) = tokio::sync::broadcast::channel::<u32>(2);
        let mut stream = std::pin::pin!(take_until_lagged(BroadcastStream::new(rx)));

        // Within capacity: events pass through unchanged.
        tx.send(1).unwrap();
        assert_eq!(stream.next().await, Some(1));

        // Overflow: capacity 2, three sends → the oldest is overwritten and
        // the receiver observes Lagged on its next poll.
        tx.send(2).unwrap();
        tx.send(3).unwrap();
        tx.send(4).unwrap();

        // The stream must END at the lag (None), not skip it and continue
        // delivering the still-buffered events.
        assert_eq!(stream.next().await, None);

        // Terminated for good — later events never resurrect the stream.
        tx.send(5).unwrap();
        assert_eq!(stream.next().await, None);
    }

    /// Pins the RESPONSE-BODY composition: snapshot prefix chained onto the
    /// lag-terminating live stream, with NO merged side-stream. A previous
    /// version merged an infinite heartbeat interval here, which kept the
    /// response open after lag and defeated the forced reconnect entirely.
    #[tokio::test]
    async fn chained_response_stream_ends_on_broadcast_lag() {
        let (tx, rx) = tokio::sync::broadcast::channel::<u32>(2);
        let initial = tokio_stream::iter(vec![100_u32, 101]);
        let mut stream = std::pin::pin!(initial.chain(take_until_lagged(BroadcastStream::new(rx))));

        // Snapshot events flow first, in order.
        assert_eq!(stream.next().await, Some(100));
        assert_eq!(stream.next().await, Some(101));

        // Live events flow after the snapshot.
        tx.send(1).unwrap();
        assert_eq!(stream.next().await, Some(1));

        // Overflow the capacity-2 channel → the composed stream must reach
        // EOF (None), because EOF is what triggers the client reconnect.
        tx.send(2).unwrap();
        tx.send(3).unwrap();
        tx.send(4).unwrap();
        assert_eq!(stream.next().await, None);
    }
}
